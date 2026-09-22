#!/usr/bin/env bun
//
// Memory soak for the pure modules — audit step C5.
//
//   bun scripts/soak.mjs [iterations]
//
// Every adapter runs once per turn, for the whole life of a TUI session. A few
// bytes retained per turn is invisible in a test and obvious after eight hours,
// so the question is not "how much does this allocate" (transient allocation is
// free) but "how much does it KEEP".
//
// That distinction drives the method: force a collection and sample the heap
// before and after, so only RETAINED bytes are counted. Fixtures are parsed to
// strings once up front, outside the measured window, or their own size would
// read as growth.
//
// The two stateful patterns from tui.tsx are modelled here rather than
// imported — tui.tsx needs the TUI runtime and cannot be loaded. They are
// labelled as models, because that is what they are: they show the pattern is
// sound, not that the file implements it correctly. C1-C3 cover the real file,
// live.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { parsePromSample, diffPromSamples, SGLANG_SPEC, VLLM_SPEC } from "../adapters/prometheus.ts"
import { parseSplashSample, diffSplashSamples } from "../adapters/splash.ts"
import { parseKoboldPerf, koboldTurn } from "../adapters/koboldcpp.ts"
import { parseMlxServeRequests, mlxServeTurn } from "../adapters/mlxserve.ts"
import { formatMtplxLine } from "../adapters/mtplx.ts"
import { turnRate, universalLine } from "../universal.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const fx = (n) => readFileSync(path.join(dir, "..", "fixtures", n), "utf8")
const json = (n) => JSON.parse(fx(n))

const N = Number(process.argv[2] ?? 100_000)

// ---- fixtures loaded once, outside every measured window --------------------
const F = {
  sglangBefore: fx("sglang-stream-before.prom"),
  sglangAfter: fx("sglang-stream-after.prom"),
  vllmBefore: fx("vllm-metal-before.prom"),
  vllmAfter: fx("vllm-metal-after.prom"),
  splashBefore: fx("splash-before.prom"),
  splashAfter: fx("splash-after.prom"),
  koboldBefore: json("koboldcpp-before.json"),
  koboldAfter: json("koboldcpp-after.json"),
  mlxserve: json("mlxserve-streamed.json"),
}

const MTPLX_LATEST = {
  decode_tok_s: 30.3, ttft_s: 0.89, prefill_tok_s: 401, completion_tokens: 1247,
  request_elapsed_s: 1.62, verify_calls: 7,
  mean_accept_probability_by_depth: [0.79, 0.83, 0.67],
}
const INFO = {
  tokens: { input: 10, output: 358, reasoning: 889, cache: { read: 0, write: 0 } },
  time: { created: 1_000_000, completed: 1_031_960 },
}
const TURN = { startAt: 1_000_000, firstAt: 1_000_660, lastAt: 1_032_070 }

// ---- the workloads ----------------------------------------------------------
const workloads = {
  "prometheus (sglang)": () => {
    const b = parsePromSample(F.sglangBefore, SGLANG_SPEC)
    const a = parsePromSample(F.sglangAfter, SGLANG_SPEC)
    return diffPromSamples(b, a)
  },
  "prometheus (vllm)": () => {
    const b = parsePromSample(F.vllmBefore, VLLM_SPEC)
    const a = parsePromSample(F.vllmAfter, VLLM_SPEC)
    return diffPromSamples(b, a)
  },
  splash: () => diffSplashSamples(parseSplashSample(F.splashBefore), parseSplashSample(F.splashAfter)),
  koboldcpp: () => koboldTurn(parseKoboldPerf(F.koboldAfter), parseKoboldPerf(F.koboldBefore).total_gens),
  "mlx-serve": () => mlxServeTurn(parseMlxServeRequests(F.mlxserve), undefined),
  mtplx: () => formatMtplxLine(MTPLX_LATEST, "some/model-name-that-is-long"),
  universal: () => universalLine("mtplx", "some/model-name", INFO, TURN) + turnRate(1247, INFO, TURN).ttft,
}

// ---- models of tui.tsx's stateful patterns (see header) ---------------------
const baselines = new Map()
workloads["MODEL: per-engine baseline map"] = (i) => {
  // Keyed by provider id — a fixed, tiny key set, so it must plateau.
  const key = ["mtplx", "vllm", "splash", "kobold"][i % 4]
  baselines.set(key, parseSplashSample(F.splashAfter))
  return baselines.size
}

const turns = new Map()
workloads["MODEL: turn map, create then complete"] = (i) => {
  // Mirrors turn()/turns.delete(): every turn that completes is removed.
  const id = `msg_${i}`
  turns.set(id, { startAt: i, firstAt: i + 1, lastAt: i + 2 })
  turns.delete(id)
  return turns.size
}

// ---- measurement ------------------------------------------------------------
function settle() {
  // Two passes: the first frees, the second collects what the first made
  // unreachable. Bun.gc(true) is synchronous.
  Bun.gc(true)
  Bun.gc(true)
  return process.memoryUsage().heapUsed
}

const WARMUP = Math.min(2000, Math.floor(N / 10))
const ROUNDS = 5
const PER_ROUND = Math.floor(N / ROUNDS)

// A single before/after pair cannot tell retention from noise — the first run
// of this harness reported koboldcpp at -23 B/iteration, and nothing retains
// negative memory. What distinguishes them is the SHAPE over repeated rounds:
// a real leak climbs monotonically and without bound, while allocator noise
// oscillates around a plateau. So sample after every round and look at the
// trend, not at one difference.
console.log(`soak: ${ROUNDS} rounds x ${PER_ROUND.toLocaleString()} iterations (warmup ${WARMUP.toLocaleString()})`)
console.log("verdict is about the TREND across rounds, not any single sample\n")
console.log(`  ${"workload".padEnd(36)} ${"heap after each round (MB)".padEnd(34)} ${"drift".padStart(9)}  verdict`)
console.log(`  ${"-".repeat(36)} ${"-".repeat(34)} ${"-".repeat(9)}  -------`)

let leaks = 0
for (const [name, fn] of Object.entries(workloads)) {
  for (let i = 0; i < WARMUP; i++) fn(i)
  const marks = []
  let sink = 0
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < PER_ROUND; i++) {
      const v = fn(r * PER_ROUND + i)
      if (v) sink += typeof v === "object" ? 1 : 1
    }
    marks.push(settle())
  }
  // Steady state is measured from round 2: round 1 still carries first-call
  // allocation (JIT tiers, lazy internals) that never recurs.
  const steady = marks.slice(1)
  const driftKB = (steady[steady.length - 1] - steady[0]) / 1024
  const perIter = ((steady[steady.length - 1] - steady[0]) / (PER_ROUND * (ROUNDS - 2))) || 0
  const monotonic = steady.every((m, i) => i === 0 || m > marks[i])
  const leaking = monotonic && driftKB > 256
  if (leaking) leaks++
  const series = marks.map((m) => (m / 1048576).toFixed(1).padStart(6)).join(" ")
  const drift = `${driftKB >= 0 ? "+" : ""}${driftKB.toFixed(0)} KB`
  console.log(
    `  ${name.padEnd(36)} ${series.padEnd(34)} ${drift.padStart(9)}  ${
      leaking ? "LEAK" : Math.abs(perIter) < 1 ? "flat" : "noise"
    }` + (sink < 0 ? " " : "")
  )
}

console.log(`\n  baseline map size: ${baselines.size} (expected 4 — bounded by engine count)`)
console.log(`  turn map size:     ${turns.size} (expected 0 — every turn removed on completion)`)
console.log(`\n  ${leaks === 0 ? "No workload leaks." : `${leaks} workload(s) show unbounded growth.`}`)
