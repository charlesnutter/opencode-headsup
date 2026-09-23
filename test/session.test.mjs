// Validates session.ts -- the collapsible Session section's figures.
//
// Everything here is an aggregate over one session's history rows. The rules
// it must hold are the per-turn rules, applied across turns: tok/s is
// generation only (tokens over streaming time), averages never mix two
// models, and an engine-only figure is averaged only over turns that had it.
// Run with: bun test/session.test.mjs
import { strict as assert } from "node:assert"
import { summariseSession, sessionHeading, sessionRows, sparkline } from "../session.ts"

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

const SID = "ses_a"
// History is newest first, as `record` keeps it.
const row = (over = {}) => ({
  at: 0,
  provider: "mtplx",
  model: "qwen",
  sessionID: SID,
  tokens: 100,
  rate: 50,
  rateWindow: "decode",
  ttft: 1.0,
  totalS: 10,
  streamS: 2,
  waitS: 1,
  promptTokens: 200,
  cached: 800,
  source: "host",
  ...over,
})

test("only this session's turns are counted", () => {
  const s = summariseSession([row(), row({ sessionID: "ses_b" }), row()], SID)
  assert.equal(s.turns, 2)
  assert.equal(summariseSession([row({ sessionID: "ses_b" })], SID), undefined)
})

test("generation tok/s is total tokens over total streaming time", () => {
  // 100 tok / 2s and 300 tok / 3s -> 400 / 5 = 80, not the mean of 50 and 100.
  const s = summariseSession([row({ tokens: 300, streamS: 3 }), row({ tokens: 100, streamS: 2 })], SID)
  assert.equal(s.genTokS, 80)
})

test("an older row without streaming time contributes through its decode rate", () => {
  // Rows recorded before streamS existed: tokens / rate is their stream time.
  const s = summariseSession([row({ streamS: undefined, tokens: 100, rate: 50 })], SID)
  assert.equal(s.genTokS, 50)
})

test("a whole-turn rate from an older row is never counted as generation", () => {
  const s = summariseSession([row({ streamS: undefined, rateWindow: "whole", rate: 3.7 })], SID)
  assert.equal(s.genTokS, undefined)
})

test("the trend is recent turns' generation rates, oldest first, at most eight", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ rate: 10 + i, streamS: undefined }))
  // newest first: rate 10 is newest, so oldest-first reads 17..10 for the last 8
  const s = summariseSession(rows, SID)
  const want = [17, 16, 15, 14, 13, 12, 11, 10]
  assert.equal(s.trend.length, want.length)
  s.trend.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `${v} vs ${want[i]}`))
})

test("ttft is the median and the worst, not a mean a cold first turn drags up", () => {
  const s = summariseSession([row({ ttft: 0.5 }), row({ ttft: 0.7 }), row({ ttft: 17.6 })], SID)
  assert.equal(s.ttftMedian, 0.7)
  assert.equal(s.ttftMax, 17.6)
})

test("cache hit is cached over all prompt tokens, across turns", () => {
  // (800 + 100) cached of (200+800 + 900+100) prompt = 900 / 2000.
  const s = summariseSession([row(), row({ cached: 100, promptTokens: 900 })], SID)
  assert.equal(s.cacheHit, 900 / 2000)
})

test("the time split is generating, waiting, and everything else", () => {
  // 20s total: 4s streaming, 2s waiting, 14s other (tools, retries, overhead).
  const s = summariseSession([row(), row()], SID)
  assert.equal(s.time.generating, 4 / 20)
  assert.equal(s.time.waiting, 2 / 20)
  assert.equal(s.time.other, 14 / 20)
})

test("averages never mix models: only the current model's turns count", () => {
  const s = summariseSession([row({ model: "b", rate: 200, tokens: 200, streamS: 1 }), row(), row()], SID)
  assert.equal(s.turns, 1)
  assert.equal(s.totalTurns, 3)
  assert.equal(s.model, "b")
  assert.equal(s.genTokS, 200)
})

test("engine-only figures average over the turns that have them", () => {
  const s = summariseSession(
    [row({ engine: { mtpX: 3.0, prefillTokS: 400 } }), row(), row({ engine: { mtpX: 4.0, prefillTokS: 500 } })],
    SID
  )
  assert.equal(s.engine.mtpX, 3.5)
  assert.equal(s.engine.prefillTokS, 450)
  assert.equal(s.engine.draftAccept, undefined)
})

test("retries are summed", () => {
  assert.equal(summariseSession([row({ retries: 2 }), row({ retries: 1 }), row()], SID).retries, 3)
})

test("the collapsed heading keeps its key figure", () => {
  const s = summariseSession([row(), row()], SID)
  assert.equal(sessionHeading(s, false), "▸ Session · 2 turns · 50.0 tok/s avg")
  assert.equal(sessionHeading(s, true), "▾ Session · 2 turns")
})

test("a heading says which turns count when the model changed", () => {
  const s = summariseSession([row({ model: "b" }), row(), row()], SID)
  assert.equal(sessionHeading(s, true), "▾ Session · b · 1 of 3 turns")
})

test("one turn is singular", () => {
  assert.equal(sessionHeading(summariseSession([row()], SID), true), "▾ Session · 1 turn")
})

test("rows are label/value pairs, and an absent figure leaves no row", () => {
  const s = summariseSession([row({ ttft: undefined, cached: undefined, promptTokens: undefined })], SID)
  const labels = sessionRows(s).map(([l]) => l)
  assert.ok(!labels.includes("ttft"), labels.join(","))
  assert.ok(!labels.includes("cache"), labels.join(","))
  assert.ok(labels.includes("generation"))
})

test("rows read as aggregates: avg, median, max, %", () => {
  const s = summariseSession(
    [row({ ttft: 0.5, retries: 2, engine: { mtpX: 3.4, prefillTokS: 449 } }), row({ ttft: 17.6 })],
    SID
  )
  const rows = Object.fromEntries(sessionRows(s))
  assert.ok(rows.generation.startsWith("50.0 tok/s avg"), rows.generation)
  assert.equal(rows.ttft, "9.05s median · 17.60s max")
  assert.equal(rows.cache, "80% hit")
  assert.equal(rows.time, "20% gen · 10% wait · 70% other")
  assert.equal(rows.engine, "MTP 3.40x · prefill 449 tok/s")
  assert.equal(rows.retries, "2")
})

test("the sparkline scales between the lowest and highest rate", () => {
  assert.equal(sparkline([10, 20, 30]), "▁▅█")
  assert.equal(sparkline([5, 5]), "▄▄", "a flat trend sits mid-height")
  assert.equal(sparkline([7]), "", "one point is not a trend")
})

console.log(`\n${passed} passed`)
