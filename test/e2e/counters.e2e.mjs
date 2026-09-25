// End-to-end: engines that publish cumulative counters (Splash here), whose
// turn figures are a difference across the turn. See harness.mjs.
// Run with: bun test/e2e/counters.e2e.mjs
import { strict as assert } from "node:assert"
import { startPlugin, engineServer, splashCounters, settle, test, done, rowsOf } from "./harness.mjs"

const SPLASH = { provider: "splash", model: "q27" }

/** A fake Splash, answering /metrics from live counters. */
function fakeSplash() {
  const eng = engineServer()
  const sc = splashCounters()
  Object.defineProperty(eng.routes, "/metrics", { get: sc.text, enumerable: true, configurable: true })
  return { eng, sc }
}

/** A Splash step: the engine completes one request as the step streams. */
const splashStep = (h, sc, sid, output, extra = {}) =>
  h.step(sid, {
    ...SPLASH, ttftMs: 1_000, streamMs: 2_000, finish: "stop",
    tokens: { input: 100, output, reasoning: 0, cache: { read: 0, write: 0 } },
    beforeStreamed: () => sc.add({ output }),
    ...extra,
  })

await test("an existing session's first turn after launch is primed: engine figures on turn one", async () => {
  const { eng, sc } = fakeSplash()
  const h = await startPlugin({ splashBaseUrl: eng.url })
  try {
    const sid = h.session("ses_p")
    h.earlier(sid, "splash", "q27")
    h.user(sid)
    h.executionStarted(sid)
    await settle(60)
    await splashStep(h, sc, sid, 200)
    h.executionSucceeded(sid)
    await settle()
    const v = h.sidebar(sid)
    assert.equal(v.engine, "Splash")
    assert.ok(!v.notes.join(" ").includes("next turn"), JSON.stringify(v))
    assert.equal(h.history()[0].source, "engine")
  } finally {
    h.restore()
    eng.stop()
  }
})

await test("a new session's first turn has no baseline, and says so", async () => {
  const { eng, sc } = fakeSplash()
  const h = await startPlugin({ splashBaseUrl: eng.url })
  try {
    const sid = h.session("ses_n")
    h.user(sid)
    h.executionStarted(sid)
    await splashStep(h, sc, sid, 50)
    h.executionSucceeded(sid)
    await settle()
    assert.deepEqual(h.sidebar(sid).notes, ["engine telemetry", "from the next turn"])
    assert.equal(h.history()[0].skip, "baseline")
  } finally {
    h.restore()
    eng.stop()
  }
})

// Never seen live: a sub-agent on the same engine, nothing else in the window.
await test("a sub-agent on the same engine: the window holds both, and is accepted and labelled", async () => {
  const { eng, sc } = fakeSplash()
  const h = await startPlugin({ splashBaseUrl: eng.url })
  try {
    const sid = h.session("ses_s")
    h.earlier(sid, "splash", "q27")
    h.user(sid)
    h.executionStarted(sid)
    await settle(60)
    await splashStep(h, sc, sid, 80, {
      finish: "tool-calls",
      tools: [{
        name: "subagent", ms: 500,
        run: async () => {
          const child = h.session("ses_s_child", sid)
          h.user(child)
          h.executionStarted(child)
          await splashStep(h, sc, child, 300)
          h.executionSucceeded(child)
          await settle()
          h.session(sid)
        },
      }],
    })
    await splashStep(h, sc, sid, 120)
    h.executionSucceeded(sid)
    await settle()
    const v = h.sidebar(sid)
    assert.equal(v.engine, "Splash", JSON.stringify(v))
    assert.ok(v.rows.some(([, val]) => val === "incl. sub-agents"), JSON.stringify(v))
    assert.equal(h.history()[0].source, "engine")
    assert.equal(h.history()[0].subagents.tokens, 300)
  } finally {
    h.restore()
    eng.stop()
  }
})

// Measured live 2026-09-25: a compaction inside a Splash turn made the window
// hold more than the turn, and it was declined.
await test("a compaction bracketed by readings is taken out of the window", async () => {
  const { eng, sc } = fakeSplash()
  const h = await startPlugin({ splashBaseUrl: eng.url })
  try {
    const sid = h.session("ses_c")
    h.earlier(sid, "splash", "q27")
    h.user(sid)
    h.executionStarted(sid)
    await settle(60)
    await splashStep(h, sc, sid, 150, { finish: "tool-calls", tools: [{ name: "read", ms: 10 }] })
    h.compaction(sid, "started")
    await settle(60)
    h.ctx // the compaction is its own request to the engine
    sc.add({ output: 40, input: 23_000, prefillMs: 20_000 })
    const { clock } = await import("./harness.mjs")
    clock.advance(28_000)
    h.compaction(sid, "ended")
    await settle(60)
    await splashStep(h, sc, sid, 250)
    h.executionSucceeded(sid)
    await settle()
    const v = h.sidebar(sid)
    assert.equal(v.engine, "Splash", JSON.stringify(v))
    assert.equal(rowsOf(v).tokens, "400")
    assert.equal(h.history()[0].source, "engine")
    const d = h.detail(sid)
    assert.ok(d.time.compaction > 27, String(d.time.compaction))
    assert.ok(d.compactionEngine?.[0]?.includes("23,000 tok read"), JSON.stringify(d.compactionEngine))
  } finally {
    h.restore()
    eng.stop()
  }
})

await test("a compaction with no readings of its own declines the window, and names it", async () => {
  const { eng, sc } = fakeSplash()
  const h = await startPlugin({ splashBaseUrl: eng.url })
  try {
    const sid = h.session("ses_d")
    h.earlier(sid, "splash", "q27")
    h.user(sid)
    h.executionStarted(sid)
    await settle(60)
    await splashStep(h, sc, sid, 150, { finish: "tool-calls", tools: [{ name: "read", ms: 10 }] })
    // The engine is unreachable while OpenCode compacts, so neither reading lands.
    const saved = sc.text
    Object.defineProperty(eng.routes, "/metrics", { get: () => undefined, configurable: true })
    h.compaction(sid, "started")
    await settle(60)
    sc.add({ output: 40, input: 23_000 })
    h.compaction(sid, "ended")
    await settle(60)
    Object.defineProperty(eng.routes, "/metrics", { get: saved, configurable: true })
    await splashStep(h, sc, sid, 250)
    h.executionSucceeded(sid)
    await settle()
    assert.deepEqual(h.sidebar(sid).notes, ["engine data skipped:", "compaction ran this turn"])
    assert.equal(h.history()[0].skip, "compaction")
  } finally {
    h.restore()
    eng.stop()
  }
})

done()
