// Validates splash.ts against live captures from a real Splash 1.0 server on
// Apple Silicon (fixtures/splash-*.prom). Each fixture's header records the
// response body's own `usage` for the generation the two captures bracket, and
// the assertions below are cross-checked against it.
// Run with: bun test/splash.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { parseSplashSample, diffSplashSamples } from "../adapters/splash.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(path.join(dir, "..", "fixtures", name), "utf8")
const pair = (n) => [parseSplashSample(fixture(`${n}-before.prom`)), parseSplashSample(fixture(`${n}-after.prom`))]

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

// The generation bracketed by both fixture pairs reported
// usage {prompt_tokens: 63, completion_tokens: 200, cached_tokens: 32}.
const USAGE = { prompt_tokens: 63, completion_tokens: 200, cached_tokens: 32 }

test("Splash: completion tokens match the response's own usage", () => {
  const [b, a] = pair("splash")
  const t = diffSplashSamples(b, a)
  assert.ok(t)
  assert.equal(t.completionTokens, USAGE.completion_tokens)
})

test("Splash: prefilled + cached tokens reconstruct the reported prompt", () => {
  // The invariant that makes the prefill rate meaningful: the prefill counter
  // holds only what was RECOMPUTED, with the cache-reuse counter holding the
  // rest. 31 + 32 == 63.
  const [b, a] = pair("splash")
  const t = diffSplashSamples(b, a)
  assert.equal(t.promptTokens + t.cachedTokens, USAGE.prompt_tokens)
  assert.equal(t.cachedTokens, USAGE.cached_tokens)
})

test("Splash: both phase rates are engine-timed, not derived from a wall clock", () => {
  const [b, a] = pair("splash")
  const t = diffSplashSamples(b, a)
  // decode: 200 tokens over 4.041s; prefill: 31 recomputed over 0.209s.
  assert.ok(Math.abs(t.decodeTokS - t.completionTokens / t.decodeS) < 1e-9)
  assert.ok(Math.abs(t.prefillTokS - t.promptTokens / t.prefillS) < 1e-9)
  assert.ok(t.decodeTokS > 20 && t.decodeTokS < 200, `got ${t.decodeTokS}`)
  assert.ok(t.prefillTokS > t.decodeTokS, "prefill should outpace decode")
})

test("Splash: wall times are milliseconds, converted to seconds", () => {
  const [b, a] = pair("splash")
  const t = diffSplashSamples(b, a)
  // Reading the ms totals as seconds would put decode in the hours.
  assert.ok(t.decodeS > 0.5 && t.decodeS < 60, `decodeS looks unscaled: ${t.decodeS}`)
  assert.ok(t.prefillS > 0 && t.prefillS < 10, `prefillS looks unscaled: ${t.prefillS}`)
})

test("Splash: speculative draft acceptance is reported as a ratio", () => {
  const [b, a] = pair("splash")
  const t = diffSplashSamples(b, a)
  // Splash drafts speculatively by default; the ratio must be a real fraction.
  assert.ok(t.draftAcceptRate > 0 && t.draftAcceptRate < 1, `got ${t.draftAcceptRate}`)
})

test("Splash: a second identical prompt still reuses cache and reports a turn", () => {
  const [b, a] = pair("splash-cached")
  const t = diffSplashSamples(b, a)
  assert.ok(t)
  assert.equal(t.completionTokens, USAGE.completion_tokens)
  assert.equal(t.promptTokens + t.cachedTokens, USAGE.prompt_tokens)
})

test("Splash: a single-request turn is labelled as one request", () => {
  const [b, a] = pair("splash")
  assert.equal(diffSplashSamples(b, a).requests, 1)
})

test("Splash: a multi-request turn reports how many, so sums are not misread", () => {
  // An OpenCode turn with tool calls lands several requests between samples.
  const [b, a] = pair("splash")
  const multi = { ...a, requestsCompleted: b.requestsCompleted + 3 }
  const t = diffSplashSamples(b, multi)
  assert.equal(t.requests, 3)
  // Still this turn's window, never the session: the token deltas are unchanged.
  assert.equal(t.completionTokens, diffSplashSamples(b, a).completionTokens)
})

test("Splash: aggregate rate over several real requests is honest, not a mismatch", () => {
  // E2 audit: unlike LMDeploy's engine-timed branches (prometheus.ts), Splash
  // has no SEPARATE observation-count metric that could diverge from the
  // token/time counters -- decodeWallMs is a running sum incremented
  // alongside decodeTokens for the same requests, always. Proven rather than
  // just reasoned: applies the REAL single-turn delta twice on top of the
  // real baseline, simulating two identical-shaped requests landing in one
  // window. The aggregate rate must equal the per-request rate exactly (both
  // token count and time doubled proportionally), and completionTokens must
  // be exactly 2x -- neither would hold if the numerator and denominator
  // could silently span a different number of requests.
  const [before, after] = pair("splash")
  const single = diffSplashSamples(before, after)
  const d = {
    requestsCompleted: after.requestsCompleted - before.requestsCompleted,
    decodeTokens: after.decodeTokens - before.decodeTokens,
    decodeWallMs: after.decodeWallMs - before.decodeWallMs,
    prefillTokens: after.prefillTokens - before.prefillTokens,
    prefillWallMs: after.prefillWallMs - before.prefillWallMs,
    cacheReusedTokens: after.cacheReusedTokens - before.cacheReusedTokens,
  }
  const twoReqs = {
    ...after,
    requestsCompleted: before.requestsCompleted + d.requestsCompleted * 2,
    decodeTokens: before.decodeTokens + d.decodeTokens * 2,
    decodeWallMs: before.decodeWallMs + d.decodeWallMs * 2,
    prefillTokens: before.prefillTokens + d.prefillTokens * 2,
    prefillWallMs: before.prefillWallMs + d.prefillWallMs * 2,
    cacheReusedTokens: before.cacheReusedTokens + d.cacheReusedTokens * 2,
  }
  const double = diffSplashSamples(before, twoReqs)
  assert.equal(double.requests, 2)
  assert.equal(double.completionTokens, single.completionTokens * 2)
  assert.equal(double.cachedTokens, single.cachedTokens * 2)
  assert.ok(Math.abs(double.decodeTokS - single.decodeTokS) < 1e-9, `${double.decodeTokS} vs ${single.decodeTokS}`)
  assert.ok(Math.abs(double.prefillTokS - single.prefillTokS) < 1e-9)
})

// ---- guards -----------------------------------------------------------------
test("Splash: no completed request in the window yields nothing", () => {
  const [, a] = pair("splash")
  // Same sample on both sides: nothing advanced, so nothing is this turn's.
  assert.equal(diffSplashSamples(a, a), null)
})

test("Splash: a restart (counters reset) yields nothing rather than negatives", () => {
  const [b, a] = pair("splash")
  assert.equal(diffSplashSamples(a, b), null)
})

test("Splash: no speculation means no accept rate, not 0%", () => {
  const [b, a] = pair("splash")
  const flat = { ...a, draftedTokens: b.draftedTokens, acceptedDraftTokens: b.acceptedDraftTokens }
  assert.equal(diffSplashSamples(b, flat).draftAcceptRate, undefined)
})

test("Splash: a near-zero phase yields no rate rather than an absurd one", () => {
  const [b, a] = pair("splash")
  const instant = { ...a, decodeWallMs: b.decodeWallMs + 1, prefillWallMs: b.prefillWallMs }
  const t = diffSplashSamples(b, instant)
  assert.equal(t.decodeTokS, undefined) // 1ms for 200 tokens is not a measurement
  assert.equal(t.prefillTokS, undefined) // zero elapsed prefill
})

test("Splash: another engine's metrics text is rejected", () => {
  assert.equal(parseSplashSample("vllm:generation_tokens_total 10.0\n"), null)
  assert.equal(parseSplashSample(""), null)
})

console.log(`\n${passed} passed`)
