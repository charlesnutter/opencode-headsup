// Validates prometheus.ts against real captured /metrics text (fixtures/,
// taken from the inference-hud VS Code extension's own verified captures).
//
// vLLM and Aphrodite are CUDA-only, so those are validated against captured
// fixtures — real bytes those engines produced, not hand-written text. The
// vllm-mlx and SGLang fixtures are different: they were captured live from a
// local server on this machine, before and after a single real generation, so
// their assertions check values cross-checked against that response's own
// `usage`. Run with: bun test/prometheus.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  parsePromSample,
  diffPromSamples,
  VLLM_SPEC,
  SGLANG_SPEC,
  APHRODITE_SPEC,
  VLLM_MLX_SPEC,
  LMDEPLOY_SPEC,
} from "../adapters/prometheus.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(path.join(dir, "..", "fixtures", name), "utf8")

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    console.error(`FAIL  ${name}`)
    console.error(`      ${e.message}`)
    process.exitCode = 1
  }
}

// ---- vLLM: parse a real idle capture exactly -------------------------------
test("vLLM: parses the real idle capture's counters exactly", () => {
  const text = fixture("vllm-idle.prom")
  const s = parsePromSample(text, VLLM_SPEC)
  assert.ok(s, "expected a sample (prefix present)")
  assert.equal(s.prompt, 78)
  assert.equal(s.generation, 700)
  assert.equal(s.cached, 0)
  assert.equal(s.ttftCount, 2)
  assert.ok(Math.abs(s.ttftSum - 4.6046302318573) < 1e-9)
})

// ---- vLLM: a turn diffed across two synthetic-but-realistic snapshots -----
test("vLLM: diff across a turn gives exact tokens and a TTFT average", () => {
  const idle = fixture("vllm-idle.prom")
  // Bump generation +50, prompt +12, and one more TTFT sample (0.30s) landed —
  // the same technique the extension's own test suite uses: a real capture,
  // with only the counters a turn would advance edited by exact amounts.
  const after = idle
    .replace(/(vllm:generation_tokens_total\{[^}]*\}) 700\.0/, "$1 750.0")
    .replace(/(vllm:prompt_tokens_total\{[^}]*\}) 78\.0/, "$1 90.0")
    .replace(/(vllm:time_to_first_token_seconds_count\{[^}]*\}) 2\.0/, "$1 3.0")
    .replace(/(vllm:time_to_first_token_seconds_sum\{[^}]*\}) 4\.6046302318573/, "$1 4.9046302318573")
  assert.notEqual(after, idle, "the fixture lines this test relies on are present")

  const before = parsePromSample(idle, VLLM_SPEC)
  const now = parsePromSample(after, VLLM_SPEC)
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  assert.equal(diff.completionTokens, 50)
  assert.equal(diff.promptTokens, 12)
  assert.equal(diff.cachedTokens, 0)
  assert.ok(Math.abs(diff.ttft - 0.3) < 1e-9, `ttft=${diff.ttft}`)
})

// ---- vLLM: nothing landed -> no completion (not a zero-token turn) --------
test("vLLM: an unchanged read reports no completion", () => {
  const s = parsePromSample(fixture("vllm-idle.prom"), VLLM_SPEC)
  assert.equal(diffPromSamples(s, s), null)
})

// ---- vLLM: a server restart (counters go backwards) is not a negative rate
test("vLLM: counters running backwards are treated as a restart, not a turn", () => {
  const before = parsePromSample(fixture("vllm-idle.prom"), VLLM_SPEC)
  const after = { ...before, generation: before.generation - 10 }
  assert.equal(diffPromSamples(before, after), null)
})

// ---- SGLang: live capture from the MLX/Apple-Silicon backend --------------
// Captured from SGLang running with SGLANG_USE_MLX=1 --enable-metrics, which
// confirms the metrics endpoint serves on the MLX path at all — the Apple
// Metal docs page does not mention /metrics.
test("SGLang: live streaming turn matches the response's own usage", () => {
  const before = parsePromSample(fixture("sglang-stream-before.prom"), SGLANG_SPEC)
  const now = parsePromSample(fixture("sglang-stream-after.prom"), SGLANG_SPEC)
  assert.ok(before && now)
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  // The generation between the two captures reported
  // usage {prompt_tokens: 35, completion_tokens: 25}.
  assert.equal(diff.completionTokens, 25)
  assert.equal(diff.promptTokens, 35)
  assert.ok(diff.ttftExact)
  // Prefix-cache hit on a prompt seen earlier in the session.
  assert.equal(diff.cachedTokens, 34)
})

test("SGLang: streaming turn yields a plausible engine-derived decode rate", () => {
  const before = parsePromSample(fixture("sglang-stream-before.prom"), SGLANG_SPEC)
  const now = parsePromSample(fixture("sglang-stream-after.prom"), SGLANG_SPEC)
  const diff = diffPromSamples(before, now)
  // TTFT 0.243s inside a 0.294s request leaves a ~51ms decode window for 25
  // tokens. The point is the order of magnitude: a real rate, not clock noise.
  assert.ok(diff.decodeTokS > 100 && diff.decodeTokS < 5000, `got ${diff.decodeTokS}`)
  assert.ok(diff.durationS > diff.ttft)
})

test("SGLang: a non-streaming turn reports no decode rate rather than a fake one", () => {
  // Non-streaming has no first-token event, so SGLang stamps TTFT at
  // completion: this real capture has TTFT 0.2530297s against an e2e of
  // 0.2530313s. Subtracting gives a 1.6us window and 15.7M tok/s, which the
  // MIN_DECODE_SHARE guard must reject.
  const before = parsePromSample(fixture("sglang-before.prom"), SGLANG_SPEC)
  const now = parsePromSample(fixture("sglang-after.prom"), SGLANG_SPEC)
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  assert.equal(diff.completionTokens, 25)
  assert.equal(diff.decodeTokS, undefined)
})

// ---- an engine's own metrics text is rejected by the other's spec ---------
test("cross-check: vLLM text does not parse against the SGLang spec", () => {
  assert.equal(parsePromSample(fixture("vllm-idle.prom"), SGLANG_SPEC), null)
})
test("cross-check: SGLang text does not parse against the vLLM spec", () => {
  assert.equal(parsePromSample(fixture("sglang-stream-after.prom"), VLLM_SPEC), null)
})

// ---- vllm-mlx: captured LIVE, before/after one real generation ------------
// The turn between these two captures reported, in its own response body:
//   usage: { prompt_tokens: 33, completion_tokens: 50 }
// Both histograms advanced by exactly 1, so TTFT and duration are that single
// request's own values, not an average.
test("vllm-mlx: parses the live capture's counters and histograms", () => {
  const s = parsePromSample(fixture("vllm-mlx-idle.prom"), VLLM_MLX_SPEC)
  assert.ok(s, "expected a sample (vllm_mlx_ prefix present)")
  assert.equal(s.prompt, 72)
  assert.equal(s.generation, 124)
  assert.equal(s.cached, 0) // vllm-mlx publishes no prompt-cache counter
  assert.equal(s.ttftCount, 2)
  assert.equal(s.durationCount, 2)
})

test("vllm-mlx: diff matches the response's own usage, exactly", () => {
  const before = parsePromSample(fixture("vllm-mlx-idle.prom"), VLLM_MLX_SPEC)
  const now = parsePromSample(fixture("vllm-mlx-after.prom"), VLLM_MLX_SPEC)
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  // Cross-checked against the live response body's usage block.
  assert.equal(diff.completionTokens, 50)
  assert.equal(diff.promptTokens, 33)
  // One request in the window -> these are its own values, not an average.
  assert.equal(diff.ttftExact, true)
  assert.ok(Math.abs(diff.ttft - 0.07569008297287) < 1e-6, `ttft=${diff.ttft}`)
  assert.ok(Math.abs(diff.durationS - 0.192384666996076) < 1e-6, `duration=${diff.durationS}`)
  // Engine-measured decode rate: tokens / (duration - ttft), excluding prefill.
  assert.ok(diff.decodeTokS > 400 && diff.decodeTokS < 460, `decodeTokS=${diff.decodeTokS}`)
})

test("vllm-mlx: two requests in one window drops the exact flag and the decode rate", () => {
  const before = parsePromSample(fixture("vllm-mlx-idle.prom"), VLLM_MLX_SPEC)
  // Same generation delta, but both histograms advanced by 2 rather than 1.
  const now = {
    ...parsePromSample(fixture("vllm-mlx-after.prom"), VLLM_MLX_SPEC),
    ttftCount: before.ttftCount + 2,
    durationCount: before.durationCount + 2,
  }
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  assert.equal(diff.ttftExact, false)
  assert.equal(diff.decodeTokS, undefined, "no per-request rate when several requests blend")
  assert.ok(diff.ttft !== undefined, "still reports the window average")
})

// ---- Aphrodite: vLLM's shape under its own prefix -------------------------
test("Aphrodite: parses vLLM-shaped metrics under the aphrodite: prefix", () => {
  // Aphrodite is CUDA-only; this reuses the real vLLM capture with the prefix
  // swapped, which is precisely the documented difference between them.
  const text = fixture("vllm-idle.prom").replace(/vllm:/g, "aphrodite:")
  const s = parsePromSample(text, APHRODITE_SPEC)
  assert.ok(s)
  assert.equal(s.prompt, 78)
  assert.equal(s.generation, 700)
  assert.equal(s.ttftCount, 2)
})

test("cross-check: vLLM text does not parse against the vllm-mlx spec", () => {
  assert.equal(parsePromSample(fixture("vllm-idle.prom"), VLLM_MLX_SPEC), null)
})

// ---- vLLM: validated LIVE, via vllm-metal on Apple Silicon ---------------
// vllm-metal runs upstream vLLM's own server with an MLX/Metal compute
// backend, so its /metrics is vLLM's. These two captures bracket one real
// generation whose response reported usage: { prompt_tokens: 35,
// completion_tokens: 35 } — which is what makes this tier live-validated
// rather than fixtures-only.
test("vLLM (live via vllm-metal): diff matches the response's own usage", () => {
  const before = parsePromSample(fixture("vllm-metal-before.prom"), VLLM_SPEC)
  const now = parsePromSample(fixture("vllm-metal-after.prom"), VLLM_SPEC)
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  assert.equal(diff.completionTokens, 35)
  assert.equal(diff.promptTokens, 35)
  // One request landed, so the TTFT delta is that request's own value.
  assert.equal(diff.ttftExact, true)
  assert.ok(Math.abs(diff.ttft - 1.008126974105835) < 1e-6, `ttft=${diff.ttft}`)
  // vLLM publishes no duration histogram, so no engine-measured decode rate.
  assert.equal(diff.decodeTokS, undefined)
})

// ---- LMDeploy: separate engine-timed prefill and decode phases ------------
// SYNTHETIC fixtures (CUDA-only engine, cannot run here). Metric names and the
// {model_name,engine} label shape are verified against
// lmdeploy/metrics/loggers.py; values chosen to make the arithmetic checkable.
test("LMDeploy: uses the engine's own prefill and decode timings", () => {
  const before = parsePromSample(fixture("lmdeploy-before.prom"), LMDEPLOY_SPEC)
  const now = parsePromSample(fixture("lmdeploy-after.prom"), LMDEPLOY_SPEC)
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  assert.equal(diff.completionTokens, 200)
  assert.equal(diff.promptTokens, 120)
  assert.equal(diff.ttftExact, true)
  assert.ok(Math.abs(diff.ttft - 0.25) < 1e-9, `ttft=${diff.ttft}`)
  // decode: 200 tok over its own 2.0s decode histogram -> 100 tok/s.
  // Not duration-minus-TTFT, which would give a different (worse) number.
  assert.ok(Math.abs(diff.decodeTokS - 100) < 1e-6, `decodeTokS=${diff.decodeTokS}`)
  // prefill: 120 tok over its own 0.2s prefill histogram -> 600 tok/s.
  assert.ok(Math.abs(diff.prefillTokS - 600) < 1e-6, `prefillTokS=${diff.prefillTokS}`)
})

test("LMDeploy: engine-timed decode wins over the duration-minus-TTFT fallback", () => {
  const before = parsePromSample(fixture("lmdeploy-before.prom"), LMDEPLOY_SPEC)
  const now = parsePromSample(fixture("lmdeploy-after.prom"), LMDEPLOY_SPEC)
  const diff = diffPromSamples(before, now)
  // duration-minus-TTFT would be 200 / (2.5 - 0.25) = 88.9 tok/s; the engine's
  // own decode timing gives 100. The richer source must be the one used.
  assert.ok(Math.abs(diff.decodeTokS - 100) < 1e-6)
  assert.ok(Math.abs(diff.decodeTokS - 200 / (2.5 - 0.25)) > 1, "must not be the fallback")
})

test("LMDeploy: two requests with only one decode-time sample drops the rate, not just the exact flag", () => {
  // Reproduces a real gap found in E2 review: completionTokens is the WHOLE
  // WINDOW's generation delta. If two requests land but only one records a
  // decode-time histogram observation (plausible on a partial/errored
  // completion), dividing the window's full token count by that one
  // request's decode time silently inflates the rate — confirmed before this
  // guard existed: 400 window tokens / one request's 2.0s decode time
  // reported 200 tok/s instead of the true 100.
  const before = parsePromSample(fixture("lmdeploy-before.prom"), LMDEPLOY_SPEC)
  const realAfter = parsePromSample(fixture("lmdeploy-after.prom"), LMDEPLOY_SPEC)
  const now = {
    ...realAfter,
    generation: before.generation + 400, // two requests' worth
    ttftCount: before.ttftCount + 2, // two requests landed
    ttftSum: before.ttftSum + 0.5,
    // decodeTimeCount/Sum left as realAfter's: still only +1 sample.
  }
  const diff = diffPromSamples(before, now)
  assert.ok(diff)
  assert.equal(diff.ttftExact, false)
  assert.equal(diff.completionTokens, 400, "the token count itself is still exact for the window")
  assert.equal(diff.decodeTokS, undefined, "must not divide the whole window by one request's decode time")
})

test("LMDeploy: the same guard applies to the prefill-time branch", () => {
  const before = parsePromSample(fixture("lmdeploy-before.prom"), LMDEPLOY_SPEC)
  const realAfter = parsePromSample(fixture("lmdeploy-after.prom"), LMDEPLOY_SPEC)
  const now = {
    ...realAfter,
    prompt: before.prompt + 240, // two requests' worth of prompt tokens
    ttftCount: before.ttftCount + 2,
    ttftSum: before.ttftSum + 0.5,
    // prefillTimeCount/Sum left as realAfter's: still only +1 sample.
  }
  const diff = diffPromSamples(before, now)
  assert.equal(diff.ttftExact, false)
  assert.equal(diff.prefillTokS, undefined, "must not divide the whole window by one request's prefill time")
})

test("vLLM keeps no prefill rate (it times no prefill phase)", () => {
  const before = parsePromSample(fixture("vllm-metal-before.prom"), VLLM_SPEC)
  const now = parsePromSample(fixture("vllm-metal-after.prom"), VLLM_SPEC)
  assert.equal(diffPromSamples(before, now).prefillTokS, undefined)
})

console.log(`\n${passed} passed`)
if (process.exitCode) {
  console.error("some tests failed")
}
