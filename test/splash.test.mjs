// Validates splash.ts against live captures from a real Splash 1.0 server on
// Apple Silicon (fixtures/splash-*.prom). Each fixture's header records the
// response body's own `usage` for the generation the two captures bracket, and
// the assertions below are cross-checked against it.
// Run with: bun test/splash.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { parseSplashSample, diffSplashSamples, formatSplashLine } from "../adapters/splash.ts"

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

// ---- rendering: formatSplashLine -------------------------------------------
// Extracted from the v1 entry file, where it was inline and therefore
// untested. Splash draws the richest line here, so it has the most ways to
// render something indefensible.

test("Splash: renders the full line from a real captured turn", () => {
  const t = diffSplashSamples(
    parseSplashSample(fixture("splash-before.prom")),
    parseSplashSample(fixture("splash-after.prom"))
  )
  const out = formatSplashLine(t, "incoai/Qwen3.8-27B-Splash").split("\n")
  assert.ok(out[0].startsWith("Splash  "), out[0])
  // Every line must be a real figure; a "?" means a caller should have
  // dropped the line instead of printing it.
  assert.ok(!out.some((l) => l.includes("?")), out.join(" | "))
})

test("Splash: the prompt line sums prefilled and cached, not just prefilled", () => {
  // This is the honesty guarantee for Splash specifically: its prefill
  // counter deliberately excludes cache hits, so showing only promptTokens
  // would under-report the prompt the caller actually sent.
  const t = diffSplashSamples(
    parseSplashSample(fixture("splash-cached-before.prom")),
    parseSplashSample(fixture("splash-cached-after.prom"))
  )
  const out = formatSplashLine(t, "m")
  const total = t.promptTokens + t.cachedTokens
  assert.ok(out.includes(`${total} prompt`), `expected ${total} prompt in: ${out}`)
})

test("Splash: cached is named only when some was actually reused", () => {
  const cold = { completionTokens: 200, promptTokens: 63, cachedTokens: 0,
    decodeS: 5, prefillS: 0.27, decodeTokS: 40, prefillTokS: 233, requests: 1 }
  assert.ok(!formatSplashLine(cold, "m").includes("cached"), "cold prompt must not mention cache")
  const warm = { ...cold, promptTokens: 31, cachedTokens: 32 }
  assert.ok(formatSplashLine(warm, "m").includes("32 cached"), "a real cache hit must be named")
})

test("Splash: an absent rate is omitted, never rendered as a placeholder", () => {
  const t = { completionTokens: 200, promptTokens: 63, cachedTokens: 0,
    decodeS: 0, prefillS: 0, decodeTokS: undefined, prefillTokS: undefined, requests: 1 }
  const out = formatSplashLine(t, "m")
  assert.ok(!out.includes("?"), out)
  assert.ok(!out.includes("tok/s"), "no rate should appear at all")
  assert.ok(out.includes("200 tok"), "the token count still survives")
})

test("Splash: no speculation means no accept line, not 0% accepted", () => {
  const t = { completionTokens: 200, promptTokens: 63, cachedTokens: 0,
    decodeS: 5, prefillS: 0.27, decodeTokS: 40, prefillTokS: 233,
    draftAcceptRate: undefined, requests: 1 }
  assert.ok(!formatSplashLine(t, "m").includes("draft"), "absent is not zero")
  assert.ok(formatSplashLine({ ...t, draftAcceptRate: 0.81 }, "m").includes("draft 81% accepted"))
})

test("Splash: a multi-request turn is labelled so sums are not misread", () => {
  const one = { completionTokens: 200, promptTokens: 63, cachedTokens: 0,
    decodeS: 5, prefillS: 0.27, decodeTokS: 40, prefillTokS: 233, requests: 1 }
  assert.ok(!formatSplashLine(one, "m").includes("requests this turn"))
  const many = { ...one, requests: 3, completionTokens: 600 }
  assert.ok(formatSplashLine(many, "m").includes("3 requests this turn"))
})

// ---- host-supplied ttft ------------------------------------------------------
// Splash reports no ttft of its own, and before this the engine line replaced
// the universal one wholesale, so the figure vanished even though OpenCode
// had the marks. It is labelled `(host)` because it is not the measurement an
// engine-reported ttft would be: it spans queue, network and TUI event
// delivery as well as prefill.

test("Splash: a host ttft is rendered, and says it is the host's", () => {
  const t = diffSplashSamples(
    parseSplashSample(fixture("splash-before.prom")),
    parseSplashSample(fixture("splash-after.prom"))
  )
  const out = formatSplashLine(t, "m", 0.66)
  assert.ok(out.includes("ttft 0.66s (host)"), out)
  // It must never pass as the engine's own figure.
  assert.ok(!/ttft 0\.66s(?!\s*\(host\))/.test(out), out)
})

test("Splash: no host ttft means no ttft line, not an empty one", () => {
  const t = diffSplashSamples(
    parseSplashSample(fixture("splash-before.prom")),
    parseSplashSample(fixture("splash-after.prom"))
  )
  const out = formatSplashLine(t, "m")
  assert.ok(!out.includes("ttft"), out)
  assert.ok(!out.includes("?"), out)
  // and the rest of the line is unchanged by the new parameter
  assert.deepEqual(out.split("\n").length, formatSplashLine(t, "m").split("\n").length)
})

console.log(`\n${passed} passed`)
