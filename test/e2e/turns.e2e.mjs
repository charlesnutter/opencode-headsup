// End-to-end: whole turns through the real entry file, against a fake
// OpenCode and a fixture engine server. See harness.mjs.
// Run with: bun test/e2e/turns.e2e.mjs
import { strict as assert } from "node:assert"
import { startPlugin, engineServer, settle, test, done, rowsOf } from "./harness.mjs"

const MTPLX = { provider: "mtplx", model: "qwen" }
// An MTPLX receipt for a step of `tokens` generated at `tokS`.
const receipt = (tokens, tokS) => ({
  latest: { completion_tokens: tokens, decode_tok_s: tokS, prefill_tok_s: 450, ttft_s: 2, verify_calls: Math.round(tokens / 3), mean_accept_probability_by_depth: [0.9, 0.8, 0.6] },
})

await test("an MTPLX tool turn: engine figures in the sidebar, each tool in the detail", async () => {
  const eng = engineServer()
  const h = await startPlugin({ mtplxMetricsUrl: `${eng.url}/metrics` })
  try {
    const sid = h.session("ses_a")
    h.user(sid)
    h.executionStarted(sid)
    await h.step(sid, {
      ...MTPLX, ttftMs: 2_000, streamMs: 4_000, finish: "tool-calls",
      tokens: { input: 900, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
      tools: [{ name: "bash", ms: 3_000 }],
      beforeStreamed: () => { eng.routes["/metrics"] = receipt(120, 30) },
    })
    await h.step(sid, {
      ...MTPLX, ttftMs: 500, streamMs: 2_000, finish: "stop",
      tokens: { input: 50, output: 60, reasoning: 0, cache: { read: 900, write: 0 } },
      beforeStreamed: () => { eng.routes["/metrics"] = receipt(60, 30) },
    })
    h.executionSucceeded(sid)
    await settle()

    const v = h.sidebar(sid)
    assert.equal(v.engine, "MTPLX")
    const r = rowsOf(v)
    assert.equal(r.tokens, "180")
    assert.equal(r.speed, "30.0 tok/s")
    assert.equal(r.time, "11.50s")
    const row = h.history().at(0)
    assert.equal(row.source, "engine")
    assert.equal(row.steps, 2)
    assert.deepEqual(row.tools, { bash: { s: 3, n: 1 } })
    const d = h.detail(sid)
    assert.equal(d.time.tools, 3)
    assert.equal(d.time.waiting, 2.5)
    assert.equal(d.time.generating, 6)
    assert.ok(d.engineRows.some(([, val]) => val.includes("at depth 3")), JSON.stringify(d.engineRows))
    assert.ok(!d.engineRows.some(([, val]) => val.includes("11.50s")), "OpenCode's total is not the engine's")
  } finally {
    h.restore()
    eng.stop()
  }
})

// ---- one execution, two replies (a message queued while the first ran) ------
// Measured 2026-09-25: reply 1 ended `stop`, the queued message's step began
// 1s later in the same execution, and the execution only succeeded after it.
await test("a queued message: each reply is its own turn, timed from the one before", async () => {
  const eng = engineServer()
  const h = await startPlugin({ mtplxMetricsUrl: `${eng.url}/metrics` })
  try {
    const sid = h.session("ses_q")
    h.user(sid, "first")
    h.executionStarted(sid)
    await h.step(sid, { ...MTPLX, ttftMs: 1_000, streamMs: 9_000, finish: "stop",
      tokens: { input: 10, output: 270, reasoning: 0, cache: { read: 0, write: 0 } },
      beforeStreamed: () => { eng.routes["/metrics"] = receipt(270, 30) } })
    await settle()
    // Reply 1 is shown before the execution ends.
    assert.equal(rowsOf(h.sidebar(sid)).tokens, "270")
    assert.equal(rowsOf(h.sidebar(sid)).time, "10.00s")
    h.user(sid, "queued")
    await h.step(sid, { ...MTPLX, ttftMs: 1_000, streamMs: 4_000, finish: "stop",
      tokens: { input: 10, output: 120, reasoning: 0, cache: { read: 0, write: 0 } },
      beforeStreamed: () => { eng.routes["/metrics"] = receipt(120, 30) } })
    h.executionSucceeded(sid)
    await settle()
    assert.equal(h.history().length, 2, "each reply recorded once")
    assert.equal(rowsOf(h.sidebar(sid)).tokens, "120")
    // From reply 1's end, not from when the message was typed.
    assert.equal(h.history()[0].totalS, 5)
  } finally {
    h.restore()
    eng.stop()
  }
})

// ---- an interrupted reply --------------------------------------------------
// Measured: OpenCode records 0 tokens for a step it stopped mid-stream.
await test("an interrupted reply is shown and marked, with no made-up token count", async () => {
  const h = await startPlugin({})
  try {
    const sid = h.session("ses_i")
    h.user(sid)
    h.executionStarted(sid)
    await h.step(sid, { provider: "lmstudio", model: "m", ttftMs: 900, interruptAfterMs: 6_000 })
    h.executionInterrupted(sid)
    await settle()
    const v = h.sidebar(sid)
    assert.ok(v.notes.includes("interrupted"), JSON.stringify(v))
    assert.equal(rowsOf(v).tokens, undefined, "0 tokens here means unknown")
    assert.equal(h.history()[0].outcome, "interrupted")
    assert.equal(h.history()[0].skip, "unfinished")
  } finally {
    h.restore()
  }
})

// ---- tool-call arguments are generation time --------------------------------
// Measured: argument deltas never reach a plugin; the start/end events do.
// Unwatched, a write step read 162.9 tok/s against the engine's 36.4.
await test("time spent writing a tool call's arguments counts as generating", async () => {
  const h = await startPlugin({})
  try {
    const sid = h.session("ses_w")
    h.user(sid)
    h.executionStarted(sid)
    await h.step(sid, { provider: "lmstudio", model: "m", ttftMs: 1_000, streamMs: 10_000, argsMs: 6_000,
      finish: "tool-calls", tokens: { input: 10, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
      tools: [{ name: "write", ms: 10 }] })
    await h.step(sid, { provider: "lmstudio", model: "m", ttftMs: 500, streamMs: 1_000, finish: "stop",
      tokens: { input: 10, output: 30, reasoning: 0, cache: { read: 0, write: 0 } } })
    h.executionSucceeded(sid)
    await settle()
    // 330 tokens over 11s of streaming, arguments included: 30, not 66.
    assert.equal(rowsOf(h.sidebar(sid)).speed, "30.0 tok/s")
  } finally {
    h.restore()
  }
})

// ---- an engine that isn't there ----------------------------------------------
await test("an unreachable engine falls back to OpenCode's figures, never a blank box", async () => {
  const h = await startPlugin({ mtplxMetricsUrl: "http://127.0.0.1:9/metrics" })
  try {
    const sid = h.session("ses_u")
    h.user(sid)
    h.executionStarted(sid)
    await h.step(sid, { ...MTPLX, ttftMs: 1_000, streamMs: 2_000, finish: "stop",
      tokens: { input: 10, output: 60, reasoning: 0, cache: { read: 0, write: 0 } } })
    h.executionSucceeded(sid)
    await settle(300)
    const r = rowsOf(h.sidebar(sid))
    assert.equal(r.tokens, "60")
    assert.equal(r.speed, "30.0 tok/s")
    assert.equal(h.history()[0].source, "host")
  } finally {
    h.restore()
  }
})

done()
