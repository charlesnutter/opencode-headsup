// Validates universal.ts — the tier built from OpenCode's own events, with no
// engine endpoint involved.
//
// The anchor case is a real turn against Splash (incoai/Qwen3.8-27B-Splash),
// where the engine's own log and this plugin's panel disagreed by 3.5x. The
// engine reported `output 1,247 · TTFT 0.6s · 39.7 tok/s`; the panel showed
// `358 tok (+889 think)` at `11.4 tok/s`. 358 + 889 == 1247, so the token
// counts never disagreed — only the rate's numerator did.
// Run with: bun test/universal.test.mjs
import { strict as assert } from "node:assert"
import { turnRate, universalLine, DEFAULT_DISPLAY } from "../universal.ts"

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

// The observed Splash turn. The decode window is the 31.41s implied by the
// engine's own 1247 / 39.7, and TTFT 0.66s sits before it.
const START = 1_000_000
const splashTurn = { startAt: START, firstAt: START + 660, lastAt: START + 660 + 31_410 }
const splashInfo = {
  tokens: { output: 358, reasoning: 889 },
  time: { created: START, completed: START + 31_960 },
}

test("reasoning tokens count toward the decode rate", () => {
  // 1247 tokens over the 31.41s window the engine measured the same turn over.
  const { decodeTokS } = turnRate(358 + 889, splashInfo, splashTurn)
  assert.ok(Math.abs(decodeTokS - 39.7) < 0.2, `expected ~39.7 tok/s, got ${decodeTokS}`)
})

test("the regression: visible output alone reproduces the wrong 11.4 tok/s", () => {
  // Pinning the old behaviour so the fix cannot silently revert.
  const { decodeTokS } = turnRate(358, splashInfo, splashTurn)
  assert.ok(Math.abs(decodeTokS - 11.4) < 0.1, `expected the old 11.4, got ${decodeTokS}`)
})

test("universalLine reports the engine's rate, not the visible-only one", () => {
  const line = universalLine("splash", "incoai/Qwen3.8-27B-Splash", splashInfo, splashTurn)
  assert.ok(/39\.\d tok\/s/.test(line), `rate should be ~39.7 tok/s:\n${line}`)
  assert.ok(!line.includes("11.4 tok/s"), `must not report the understated rate:\n${line}`)
})

test("the totals line is the topline total with thinking as a subset", () => {
  const line = universalLine("splash", "incoai/Qwen3.8-27B-Splash", splashInfo, splashTurn)
  // Topline is everything decoded, matching the engine's own `output 1,247`.
  assert.ok(line.includes("1247 tok (889 think)"), line)
  // Never the additive form: `(+889 think)` invites summing to 2136.
  assert.ok(!line.includes("(+"), line)
  // And never the old visible-only topline.
  assert.ok(!line.includes("358 tok"), line)
  assert.ok(line.includes("ttft 0.66s"), line)
})

test("a non-reasoning turn is unaffected by the fix", () => {
  const info = { tokens: { output: 100, reasoning: 0 }, time: { created: START, completed: START + 5_000 } }
  const turn = { startAt: START, firstAt: START + 500, lastAt: START + 5_000 }
  const { decodeTokS } = turnRate(100 + 0, info, turn)
  assert.ok(Math.abs(decodeTokS - 100 / 4.5) < 0.01)
  assert.ok(!universalLine("x", "m", info, turn).includes("think"))
})

test("missing token counts yield no rate rather than zero", () => {
  const info = { time: { created: START, completed: START + 5_000 } }
  assert.equal(turnRate(0, info, undefined).decodeTokS, undefined)
})

test("a zero-length stream window falls back to whole-request time", () => {
  const info = { tokens: { output: 50 }, time: { created: START, completed: START + 2_000 } }
  // firstAt == lastAt: nothing to measure across, so the fallback applies.
  const turn = { startAt: START, firstAt: START + 100, lastAt: START + 100 }
  const { decodeTokS } = turnRate(50, info, turn)
  assert.ok(Math.abs(decodeTokS - 25) < 0.01, `expected 50/2s, got ${decodeTokS}`)
})

test("TTFT comes from the first delta, not from completion", () => {
  assert.ok(Math.abs(turnRate(1247, splashInfo, splashTurn).ttft - 0.66) < 0.001)
})

// ---- the rate is named for the window it measured ---------------------------
// A live run showed our 38.2 tok/s beside OpenCode's own 3.7 tok/s for the
// same turn. Both were right: 37 tokens over a 0.97s decode window vs over
// 10.03s total. Unlabelled, they read as a contradiction.

test("a streamed turn leaves its decode rate unqualified", () => {
  const info = { time: { created: 1000, completed: 11030 }, tokens: { input: 0, output: 37, reasoning: 0, cache: { read: 0, write: 0 } } }
  const turn = { firstAt: 10060, lastAt: 11030 }
  const r = turnRate(37, info, turn)
  assert.equal(r.rateWindow, "decode")
  // 37 tokens over the 0.97s stream window, not the 10.03s total.
  assert.ok(Math.abs(r.decodeTokS - 38.1) < 0.5, String(r.decodeTokS))
  // Unqualified: the ttft beside it does the explaining.
  assert.ok(!universalLine("mtplx", "m", info, turn).includes("overall"))
})

test("a whole-turn fallback rate is qualified as overall", () => {
  const info = { time: { created: 1000, completed: 11030 }, tokens: { input: 0, output: 37, reasoning: 0, cache: { read: 0, write: 0 } } }
  const r = turnRate(37, info, undefined)
  assert.equal(r.rateWindow, "whole")
  // 37 over the full 10.03s — a different number entirely, so it must not
  // claim to be a decode rate.
  assert.ok(Math.abs(r.decodeTokS - 3.7) < 0.1, String(r.decodeTokS))
  assert.ok(universalLine("mtplx", "m", info, undefined).includes("tok/s overall"))
})

test("ttft falls back to the message's created, not only turn.startAt", () => {
  // The v2 entry has no event carrying the request start, so requiring
  // startAt silently produced no ttft at all for every provider without an
  // adapter. `created` is the request start and is always present.
  const info = { time: { created: 1000, completed: 11030 }, tokens: { input: 0, output: 37, reasoning: 0, cache: { read: 0, write: 0 } } }
  const r = turnRate(37, info, { firstAt: 10060, lastAt: 11030 })
  assert.ok(r.ttft !== undefined, "ttft must not require startAt")
  assert.ok(Math.abs(r.ttft - 9.06) < 0.01, String(r.ttft))
})

// ---- cost and cache, from the host rather than any engine -------------------
// Both measured in Phase 0 on real metered turns. These are what a cloud
// user gets, where Tier 2 never fires at all.

const metered = {
  time: { created: 1000, completed: 2662 },
  cost: 0.0006103944,
  tokens: { input: 4277, output: 11, reasoning: 10, cache: { read: 2048, write: 0 } },
}

test("a metered turn shows this turn's cost and its cache reuse", () => {
  const out = universalLine("opencode-go", "mimo-v2.6-flash", metered, { firstAt: 1500, lastAt: 2662 })
  assert.ok(out.includes("$0.0006"), out)
  assert.ok(out.includes("2048 cached"), out)
})

test("a free model shows no cost line rather than $0.00", () => {
  const free = { ...metered, cost: 0 }
  const out = universalLine("mtplx", "local", free, { firstAt: 1500, lastAt: 2662 })
  assert.ok(!out.includes("$"), out)
  // the cache figure is independent and survives
  assert.ok(out.includes("2048 cached"), out)
})

test("a cold prompt shows no cache line rather than 0 cached", () => {
  const cold = { ...metered, tokens: { ...metered.tokens, cache: { read: 0, write: 0 } } }
  const out = universalLine("opencode-go", "m", cold, { firstAt: 1500, lastAt: 2662 })
  assert.ok(!out.includes("cached"), out)
  assert.ok(out.includes("$0.0006"), "cost is independent and survives")
})

test("with neither, the line is exactly the three it always was", () => {
  const bare = { time: { created: 1000, completed: 2662 },
    tokens: { input: 10, output: 11, reasoning: 0, cache: { read: 0, write: 0 } } }
  const out = universalLine("mtplx", "m", bare, { firstAt: 1500, lastAt: 2662 })
  assert.equal(out.split("\n").length, 3, out)
})

test("the per-turn cost is used, never a running session total", () => {
  // Measured: session.cost() and message.cost differ by exactly the previous
  // turn's cost. Only the latter describes this turn, and this line is
  // per-turn like every other figure on it.
  const out = universalLine("opencode-go", "m", { ...metered, cost: 0.06499 }, { firstAt: 1500, lastAt: 2662 })
  assert.ok(out.includes("$0.065"), out)
  assert.ok(!out.includes("0.0656"), "a session total must not leak in")
})

// ---- Display: context is the only real preference ----------------------------
// ttft, cost and cache are not configurable — each already shows exactly
// when its own figure exists and hides exactly when it does not, covered by
// the absent/present tests above. There is nothing to toggle there.

test("context is off by default and opt-in only", () => {
  const withLimit = universalLine("llamacpp", "m", metered, { firstAt: 1500, lastAt: 2662 },
    DEFAULT_DISPLAY, 32768)
  assert.ok(!withLimit.includes("limit"), "default Display must not show it even with a limit available")

  const optedIn = universalLine("llamacpp", "m", metered, { firstAt: 1500, lastAt: 2662 },
    { ...DEFAULT_DISPLAY, context: true }, 32768)
  // 4277 input / 32768 limit
  assert.ok(optedIn.includes("13% prompt/limit"), optedIn)
})

test("context needs both the toggle AND a limit to show anything", () => {
  const noLimit = universalLine("llamacpp", "m", metered, { firstAt: 1500, lastAt: 2662 },
    { ...DEFAULT_DISPLAY, context: true }, undefined)
  assert.ok(!noLimit.includes("limit"), "opting in with no known limit shows nothing, not 0%")
})

// ---- an impossible ttft is no ttft ------------------------------------------
// P1, measured: on a 903ms cloud turn our first delta arrived 13ms AFTER the
// message was marked complete, because these marks are TUI-side event
// arrivals and delivery latency is part of what they measure. Rendering that
// gives `ttft 0.92s` on a 0.90s turn.

test("a ttft at or past the end of the turn is suppressed, not shown small", () => {
  // The real shape: created 1000, completed 1903, first delta at 1915.
  const info = { time: { created: 1000, completed: 1903 }, tokens: { output: 37 } }
  const r = turnRate(37, info, { firstAt: 1915, lastAt: 1903 })
  assert.equal(r.ttft, undefined, `a first token cannot follow completion, got ${r.ttft}`)
  assert.ok(!universalLine("zen", "big-pickle", info, { firstAt: 1915, lastAt: 1903 }).includes("ttft"))
})

test("a negative ttft is suppressed too", () => {
  const info = { time: { created: 5000, completed: 9000 }, tokens: { output: 10 } }
  assert.equal(turnRate(10, info, { firstAt: 4000, lastAt: 9000 }).ttft, undefined)
})

test("a normal ttft still survives the guard", () => {
  // Regression guard on the guard: the Splash turn must be unaffected.
  assert.ok(Math.abs(turnRate(1247, splashInfo, splashTurn).ttft - 0.66) < 0.001)
})

console.log(`\n${passed} passed`)
