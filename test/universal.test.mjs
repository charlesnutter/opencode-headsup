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
import { turnRate, universalLine, universalView, turnSteps, lastModel, aggregateTurn, DEFAULT_DISPLAY } from "../universal.ts"

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
  assert.ok(line.includes("tokens 1,247\n889 thinking"), line)
  // Never the additive form: `(+889 think)` invites summing to 2136.
  assert.ok(!line.includes("(+"), line)
  // And never the old visible-only topline.
  assert.ok(!line.includes("tokens 358"), line)
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

// The rate is generation only: tokens over the time spent streaming after the
// first token. A turn that cannot be timed that way gets no rate. A whole-turn
// figure (tokens over total time) once stood in, labelled `overall`, but it
// counts prefill and everything before the first token, so it is not a rate
// in the sense this panel means (decided 2026-09-23).

test("a zero-length stream window yields no rate, not a whole-request one", () => {
  const info = { tokens: { output: 50 }, time: { created: START, completed: START + 2_000 } }
  const turn = { startAt: START, firstAt: START + 100, lastAt: START + 100 }
  const r = turnRate(50, info, turn)
  assert.equal(r.decodeTokS, undefined, `50/2s would include prefill: ${r.decodeTokS}`)
  assert.equal(r.total, 2, "the total is still shown")
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

test("with no stream marks at all there is no rate, and nothing says overall", () => {
  const info = { time: { created: 1000, completed: 11030 }, tokens: { input: 0, output: 37, reasoning: 0, cache: { read: 0, write: 0 } } }
  const r = turnRate(37, info, undefined)
  assert.equal(r.decodeTokS, undefined)
  const line = universalLine("mtplx", "m", info, undefined)
  assert.ok(!line.includes("tok/s"), line)
  assert.ok(line.includes("tokens 37\ntime 10.03s"), line)
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
  assert.ok(out.includes("cached 2,048"), out)
})

test("a free model shows no cost line rather than $0.00", () => {
  const free = { ...metered, cost: 0 }
  const out = universalLine("mtplx", "local", free, { firstAt: 1500, lastAt: 2662 })
  assert.ok(!out.includes("$"), out)
  // the cache figure is independent and survives
  assert.ok(out.includes("cached 2,048"), out)
})

test("a cold prompt shows no cache line rather than 0 cached", () => {
  const cold = { ...metered, tokens: { ...metered.tokens, cache: { read: 0, write: 0 } } }
  const out = universalLine("opencode-go", "m", cold, { firstAt: 1500, lastAt: 2662 })
  assert.ok(!out.includes("cached"), out)
  assert.ok(out.includes("$0.0006"), "cost is independent and survives")
})

test("with neither, the rows are exactly speed, ttft, tokens and time", () => {
  const bare = { time: { created: 1000, completed: 2662 },
    tokens: { input: 10, output: 11, reasoning: 0, cache: { read: 0, write: 0 } } }
  const v = universalView("mtplx", bare, { firstAt: 1500, lastAt: 2662 })
  assert.deepEqual(v.rows.map(([l]) => l), ["speed", "ttft", "tokens", "time"])
  assert.equal(v.engine, "mtplx", "the heading names the provider, not the model")
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

// ---- the whole turn, not its last step --------------------------------------
// Measured (vllm-mlx, 2026-09-23): a tool-using turn was three assistant
// messages -- 71/tool-calls, 105/tool-calls, 140/stop -- spanning 37.13s, and
// OpenCode's own footer said 37.2s. The sidebar showed `140 tok  10.20s`: the
// last step only, because it read one message.

const T0 = 2_000_000
const toolTurn = [
  { type: "user", id: "u1" },
  { type: "assistant", id: "a1", finish: "tool-calls", cost: 0.01,
    tokens: { input: 7000, output: 50, reasoning: 21, cache: { read: 6000, write: 0 } },
    time: { created: T0, completed: T0 + 12_000 } },
  { type: "assistant", id: "a2", finish: "tool-calls", cost: 0.02,
    tokens: { input: 7200, output: 80, reasoning: 25, cache: { read: 7000, write: 0 } },
    time: { created: T0 + 14_000, completed: T0 + 26_930 } },
  { type: "assistant", id: "a3", finish: "stop", cost: 0.03,
    tokens: { input: 7500, output: 120, reasoning: 20, cache: { read: 7200, write: 0 } },
    time: { created: T0 + 26_930, completed: T0 + 37_130 } },
]
const marks = new Map([
  ["a1", { startAt: T0, firstAt: T0 + 7_400, lastAt: T0 + 12_000 }],
  ["a2", { startAt: T0 + 14_000, firstAt: T0 + 20_000, lastAt: T0 + 26_930 }],
  ["a3", { startAt: T0 + 26_930, firstAt: T0 + 34_000, lastAt: T0 + 37_130 }],
])

test("a turn is every assistant message since the last user message", () => {
  const steps = turnSteps([{ type: "user", id: "u0" }, { type: "assistant", id: "old" }, ...toolTurn])
  assert.deepEqual(steps.map((m) => m.id), ["a1", "a2", "a3"])
})

test("non-assistant entries inside a turn are skipped, not counted", () => {
  const steps = turnSteps([...toolTurn.slice(0, 2), { type: "idle" }, ...toolTurn.slice(2)])
  assert.equal(steps.length, 3)
})

test("the whole turn's tokens are summed, not the last step's", () => {
  const { info } = aggregateTurn(turnSteps(toolTurn), marks)
  assert.equal(info.tokens.output + info.tokens.reasoning, 316)
  assert.equal(info.tokens.reasoning, 66)
})

test("the turn spans the first step's start to the last step's end", () => {
  const { info } = aggregateTurn(turnSteps(toolTurn), marks)
  assert.equal(info.time.completed - info.time.created, 37_130)
  const line = universalLine("vllmmlx", "m", info, aggregateTurn(turnSteps(toolTurn), marks).turn)
  assert.ok(line.includes("37.13s"), line)
  assert.ok(line.includes("tokens 316"), line)
})

test("ttft is the first step's, not the last step's", () => {
  const { info, turn } = aggregateTurn(turnSteps(toolTurn), marks)
  assert.ok(Math.abs(turnRate(316, info, turn).ttft - 7.4) < 0.001)
})

test("the decode rate is over the steps' own stream windows, excluding tool time", () => {
  // 316 tokens over (4.6 + 6.93 + 3.13) = 14.66s of streaming, not 37.13s.
  const { info, turn } = aggregateTurn(turnSteps(toolTurn), marks)
  const r = turnRate(316, info, turn)
  assert.equal(r.rateWindow, "decode")
  assert.ok(Math.abs(r.decodeTokS - 316 / 14.66) < 0.01, String(r.decodeTokS))
})

test("cost and cache reuse are summed per turn; the prompt is the last step's", () => {
  const { info } = aggregateTurn(turnSteps(toolTurn), marks)
  assert.ok(Math.abs(info.cost - 0.06) < 1e-9)
  assert.equal(info.tokens.cache.read, 20_200)
  // The context the turn ended at, which is what a prompt/limit figure means.
  assert.equal(info.tokens.input, 7500)
})

test("a step with no stream marks leaves the turn with no rate", () => {
  const partial = new Map([...marks].filter(([k]) => k !== "a2"))
  const { info, turn } = aggregateTurn(turnSteps(toolTurn), partial)
  assert.equal(turnRate(316, info, turn).decodeTokS, undefined)
})

// Turn time is the total the user waited: from the execution starting to the
// last step ending, retries and all. Measured: vllm-mlx retried one step six
// times over ~52s; the messages alone spanned 14.87s of a 60s turn.
test("the total runs from the execution start when one is known", () => {
  const { info, turn } = aggregateTurn(turnSteps(toolTurn), marks, { execStart: T0 - 23_000 })
  assert.ok(Math.abs(turnRate(316, info, turn).total - 60.13) < 0.001)
})

test("ttft runs from the request, not from when the engine began responding", () => {
  // Measured on MTPLX: execution.started 17:22:56.8, step.started 17:23:14.8,
  // engine TTFT 17.63s at 447 tok/s prefill over 7,816 prompt tokens. So
  // step.started fires when the response BEGINS -- after prefill on an engine
  // that holds its response until the first token. Measuring ttft from it
  // would drop the prefill that ttft exists to show.
  const info = { time: { created: T0, completed: T0 + 28_120 }, tokens: { output: 97, reasoning: 272 } }
  const steps = [{ type: "user" }, { type: "assistant", id: "m1", ...info }]
  const lateStart = new Map([["m1", { startAt: T0 + 18_000, firstAt: T0 + 17_700, lastAt: T0 + 28_100, attempts: 1 }]])
  const { info: agg, turn } = aggregateTurn(turnSteps(steps), lateStart, { execStart: T0 })
  const r = turnRate(369, agg, turn)
  assert.ok(Math.abs(r.ttft - 17.7) < 0.001, `ttft should include prefill, got ${r.ttft}`)
})

test("retries are counted per step and shown beside the total", () => {
  const retried = new Map(marks)
  retried.set("a1", { ...marks.get("a1"), attempts: 7 })
  const { info, turn } = aggregateTurn(turnSteps(toolTurn), retried, { execStart: T0 - 23_000 })
  assert.equal(turn.retries, 6)
  const line = universalLine("vllmmlx", "m", info, turn)
  assert.ok(line.includes("time 60.13s\n6 retries"), line)
})

test("one retry is singular, and none says nothing", () => {
  const once = new Map(marks)
  once.set("a2", { ...marks.get("a2"), attempts: 2 })
  const r1 = aggregateTurn(turnSteps(toolTurn), once)
  assert.ok(universalLine("x", "m", r1.info, r1.turn).includes("\n1 retry"))
  const r0 = aggregateTurn(turnSteps(toolTurn), marks)
  assert.ok(!universalLine("x", "m", r0.info, r0.turn).includes("retr"))
})

test("a one-step turn aggregates to exactly that step", () => {
  const one = [{ type: "user" }, toolTurn[3]]
  const { info, turn } = aggregateTurn(turnSteps(one), marks)
  assert.equal(info.tokens.output + info.tokens.reasoning, 140)
  assert.equal(info.time.completed - info.time.created, 10_200)
  assert.ok(Math.abs(turnRate(140, info, turn).decodeTokS - 140 / 3.13) < 0.01)
})

// ---- what the Session section adds up ----------------------------------------
test("the turn records time spent waiting for each step's first token", () => {
  // a1: created T0, first token T0+7.4s; a2: T0+14s -> T0+20s; a3: T0+26.93s -> T0+34s.
  const { turn } = aggregateTurn(turnSteps(toolTurn), marks)
  assert.equal(turn.waitMs, 7_400 + 6_000 + 7_070)
})

test("the turn records the prompt tokens of every step, not just the last", () => {
  // The last step's input is the context the turn ended at (info.tokens.input);
  // a cache hit rate needs every step's prompt, since each step read one.
  const { turn } = aggregateTurn(turnSteps(toolTurn), marks)
  assert.equal(turn.promptTokens, 7000 + 7200 + 7500)
})

test("a step with no first token contributes no waiting time and marks it incomplete", () => {
  const partial = new Map([...marks].filter(([k]) => k !== "a2"))
  const { turn } = aggregateTurn(turnSteps(toolTurn), partial)
  assert.equal(turn.waitMs, undefined)
})

// ---- the model a turn is about to use (for priming a baseline) --------------
test("the last model is the newest assistant's or model switch's", () => {
  const a = (providerID) => ({ type: "assistant", model: { providerID, id: "m" } })
  assert.deepEqual(lastModel([a("mtplx"), { type: "user" }]), { providerID: "mtplx", id: "m" })
  assert.deepEqual(
    lastModel([a("mtplx"), { type: "model-switched", model: { providerID: "vllmmlx", id: "q" } }, { type: "user" }]),
    { providerID: "vllmmlx", id: "q" }
  )
})

test("a session with no model named yet gives none, not a guess", () => {
  assert.equal(lastModel([{ type: "user" }]), undefined)
  assert.equal(lastModel([]), undefined)
})

console.log(`\n${passed} passed`)
