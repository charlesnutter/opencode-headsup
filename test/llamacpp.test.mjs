// Validates adapters/llamacpp.ts against a live capture from llama-server
// (fixtures/llamacpp-*.prom), taken with --metrics around one generation whose
// own usage block is recorded in the fixture header: 35 prompt, 32 completion.
//
// The same adapter serves llamafile, which publishes the identical metric
// names — confirmed live earlier by pointing it at this code unchanged.
// Run with: bun test/llamacpp.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  parseLlamaCppCounters,
  diffLlamaCppCounters,
  formatLlamaCppLine,
} from "../adapters/llamacpp.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const fixture = (n) => readFileSync(path.join(dir, "..", "fixtures", n), "utf8")
const before = parseLlamaCppCounters(fixture("llamacpp-before.prom"))
const after = parseLlamaCppCounters(fixture("llamacpp-after.prom"))

// From the fixture's own provenance header.
const USAGE = { prompt_tokens: 35, completion_tokens: 32 }

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log("  ok ", name)
  } catch (e) {
    console.log("  FAIL", name, "\n      ", e.message)
    process.exitCode = 1
  }
}

// ---- the bare, unlabelled metric format ------------------------------------
test("reads bare unlabelled names, which no other engine here uses", () => {
  assert.ok(before && after)
  // vLLM et al. label every series; llama.cpp writes `name value`.
  assert.equal(after.predictedTokens, 32)
  assert.equal(after.promptTokens, 35)
  assert.ok(Math.abs(after.predictedSeconds - 0.094) < 1e-9)
})

test("another engine's metrics text is rejected", () => {
  assert.equal(parseLlamaCppCounters("vllm:generation_tokens_total{x=\"1\"} 10.0\n"), null)
  assert.equal(parseLlamaCppCounters(""), null)
})

// ---- the turn diff ----------------------------------------------------------
test("the turn diff matches the response's own usage", () => {
  const t = diffLlamaCppCounters(before, after)
  assert.ok(t)
  assert.equal(t.completionTokens, USAGE.completion_tokens)
  assert.equal(t.promptTokens, USAGE.prompt_tokens)
})

test("both rates are the engine's own timings, not a wall clock", () => {
  const t = diffLlamaCppCounters(before, after)
  // 32 tokens over 0.094s, 35 prompt tokens over 0.032s.
  assert.ok(Math.abs(t.decodeTokS - t.completionTokens / t.decodeS) < 1e-9)
  assert.ok(Math.abs(t.prefillTokS - t.promptTokens / t.prefillS) < 1e-9)
  assert.ok(t.prefillTokS > t.decodeTokS, "prefill should outpace decode")
})

// ---- guards -----------------------------------------------------------------
test("no generated token means no turn, rather than a zero-token line", () => {
  // Answered from cache faster than we sampled, or a concurrent caller's turn
  // already moved the counters.
  assert.equal(diffLlamaCppCounters(after, after), null)
})

test("counters running backwards yield nothing, not negatives", () => {
  assert.equal(diffLlamaCppCounters(after, before), null)
})

test("a zero-length phase yields no rate rather than Infinity", () => {
  const instant = { ...after, predictedSeconds: before.predictedSeconds, promptSeconds: before.promptSeconds }
  const t = diffLlamaCppCounters(before, instant)
  assert.equal(t.decodeTokS, undefined)
  assert.equal(t.prefillTokS, undefined)
  // The token counts survive; only the undefendable rates are dropped.
  assert.equal(t.completionTokens, 32)
})

test("a full cache hit reports no prefill rate", () => {
  // Prompt counter does not advance when nothing was recomputed.
  const cached = { ...after, promptTokens: before.promptTokens }
  const t = diffLlamaCppCounters(before, cached)
  assert.equal(t.prefillTokS, undefined)
  assert.equal(t.promptTokens, 0)
  assert.ok(t.decodeTokS > 0, "decode is unaffected")
})

// ---- E2/E4 audit: real timer-resolution and cache-hit edge cases -----------
// Checked live against a running server whether a KoboldCpp-style timer-floor
// bug (a short window quantising to an inflated rate) reproduces here. It
// does not: the server itself reports exactly 0.0s for a single decoded
// token — not a tiny nonzero value — and the existing `> 0` guard already
// converts that correctly to "no rate" rather than Infinity or a huge number.
test("a real 1-token decode reports exactly 0s, correctly yielding no rate", () => {
  const b = parseLlamaCppCounters(fixture("llamacpp-minimal-before.prom"))
  const a = parseLlamaCppCounters(fixture("llamacpp-minimal-after.prom"))
  const t = diffLlamaCppCounters(b, a)
  assert.equal(t.completionTokens, 1)
  assert.equal(t.decodeS, 0, "the server itself reports this as exactly zero")
  assert.equal(t.decodeTokS, undefined, "must not become Infinity or an inflated rate")
})

test("a near-total prefix-cache hit yields a plausible rate, not an absurd one", () => {
  // usage reported cached_tokens: 40 of 41 prompt tokens -- only 1 recomputed.
  const b = parseLlamaCppCounters(fixture("llamacpp-cachehit-before.prom"))
  const a = parseLlamaCppCounters(fixture("llamacpp-cachehit-after.prom"))
  const t = diffLlamaCppCounters(b, a)
  assert.equal(t.promptTokens, 1)
  assert.ok(t.prefillTokS > 0 && t.prefillTokS < 5000, `expected a plausible rate, got ${t.prefillTokS}`)
})

// ---- rendering --------------------------------------------------------------
test("renders four lines, labelled for whichever server it is", () => {
  const t = diffLlamaCppCounters(before, after)
  const out = formatLlamaCppLine(t, "llama.cpp", "qwen2.5-0.5b-instruct-q4_k_m").split("\n")
  assert.equal(out.length, 4)
  assert.ok(out[0].startsWith("llama.cpp  "))
  assert.ok(/^\d+\.\d tok\/s$/.test(out[1]), out[1])
  assert.ok(out[2].startsWith("prefill "))
  assert.ok(out[3].startsWith("32 tok"))
  // llamafile shares this adapter; only the label changes.
  assert.ok(formatLlamaCppLine(t, "llamafile", "m").startsWith("llamafile  "))
})

test("missing rates are omitted, never rendered as placeholders", () => {
  const t = diffLlamaCppCounters(before, {
    ...after,
    predictedSeconds: before.predictedSeconds,
    promptSeconds: before.promptSeconds,
  })
  const out = formatLlamaCppLine(t, "llama.cpp", "m")
  assert.ok(!out.includes("?"), out)
  assert.equal(out.split("\n").length, 2)
})

console.log(`\n${passed} passed`)
