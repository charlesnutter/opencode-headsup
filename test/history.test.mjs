// Validates history.ts — the drill-down panel's data and rendering.
//
// The panel is the one surface that shows several turns at once, which makes
// it the one place two different measurements can be silently averaged into a
// single meaningless number. Most of these tests are about refusing to do
// that.
// Run with: bun test/history.test.mjs
import { strict as assert } from "node:assert"
import { record, summarise, formatRow, formatHistory, formatCollapsedLine, HISTORY_CAP } from "../history.ts"

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

const turn = (over = {}) => ({
  at: Date.UTC(2026, 8, 21, 20, 34),
  provider: "mtplx",
  model: "arsis-dev-ukisai-swift-qwen3-8-27b",
  tokens: 37,
  rate: 38.1,
  rateWindow: "decode",
  ttft: 9.06,
  totalS: 10.03,
  source: "engine",
  ...over,
})

// ---- recording --------------------------------------------------------------
test("newest turn comes first", () => {
  const h = record(record({ turns: [] }, turn({ tokens: 1 })), turn({ tokens: 2 }))
  assert.equal(h.turns[0].tokens, 2)
  assert.equal(h.turns[1].tokens, 1)
})

test("history is bounded, because this store survives restarts", () => {
  // Durable storage plus an unbounded append grows forever across weeks.
  let h = { turns: [] }
  for (let i = 0; i < 12; i++) h = record(h, turn({ tokens: i }), 10)
  assert.equal(h.turns.length, 10)
  assert.equal(h.turns[0].tokens, 11, "newest kept")
  assert.ok(!h.turns.some((t) => t.tokens === 0), "oldest dropped")
})

test("the default cap is a real number, not undefined", () => {
  assert.ok(Number.isInteger(HISTORY_CAP) && HISTORY_CAP > 0)
})

// ---- summarising: the part that must not lie --------------------------------
test("a whole-turn rate is excluded from the mean decode rate", () => {
  // This is the whole reason rateWindow is carried per row. Averaging 38.1
  // (over a 0.97s decode window) with 3.7 (over the same turn's 10.03s
  // total) produces a number that describes neither.
  const s = summarise([
    turn({ rate: 38.1, rateWindow: "decode" }),
    turn({ rate: 3.7, rateWindow: "whole" }),
    turn({ rate: 38.7, rateWindow: "decode" }),
  ])
  assert.ok(Math.abs(s.meanDecodeTokS - 38.4) < 0.05, String(s.meanDecodeTokS))
})

test("no decode rates at all means no mean, not zero", () => {
  const s = summarise([turn({ rate: 3.7, rateWindow: "whole" }), turn({ rate: undefined })])
  assert.equal(s.meanDecodeTokS, undefined)
})

test("cost sums across turns, and is absent when nothing cost anything", () => {
  const paid = summarise([turn({ cost: 0.0006103944 }), turn({ cost: 0.06499 })])
  assert.ok(Math.abs(paid.cost - 0.0656003944) < 1e-9, String(paid.cost))
  // A session of free turns reports no cost rather than $0.00.
  assert.equal(summarise([turn({ cost: 0 }), turn({})]).cost, undefined)
})

test("tokens sum, and engine rows are counted separately from host rows", () => {
  const s = summarise([
    turn({ tokens: 37, source: "engine" }),
    turn({ tokens: 21, source: "host" }),
    turn({ tokens: 627, source: "engine" }),
  ])
  assert.equal(s.tokens, 685)
  assert.equal(s.engineRows, 2)
  assert.equal(s.turns, 3)
})

// ---- rendering --------------------------------------------------------------
test("a row shows the figures it has and omits the ones it does not", () => {
  const out = formatRow(turn({ cost: undefined, cached: undefined }))
  assert.ok(out.includes("38.1 tok/s"), out)
  assert.ok(out.includes("37 tok"), out)
  assert.ok(out.includes("ttft 9.06s"), out)
  assert.ok(!out.includes("$"), "no cost figure means no cost column")
  assert.ok(!out.includes("cached"), "no cache figure means no cache column")
  assert.ok(!out.includes("?"), out)
})

test("a whole-turn rate is labelled in the row, not passed off as decode", () => {
  assert.ok(formatRow(turn({ rate: 3.7, rateWindow: "whole" })).includes("3.7 tok/s overall"))
  assert.ok(!formatRow(turn({ rate: 38.1, rateWindow: "decode" })).includes("overall"))
})

test("a row whose sidebar line came from the engine is marked; others are not", () => {
  assert.ok(formatRow(turn({ source: "engine" })).startsWith("*"))
  assert.ok(!formatRow(turn({ source: "host" })).startsWith("*"))
})

const LEGEND = "* sidebar used engine telemetry; rows are OpenCode's figures"

test("the legend appears only when both kinds are actually present", () => {
  const mixed = formatHistory([turn({ source: "engine" }), turn({ source: "host" })])
  assert.ok(mixed.includes(LEGEND), `mixed window needs the legend:\n${mixed}`)
  const allEngine = formatHistory([turn({ source: "engine" }), turn({ source: "engine" })])
  assert.ok(!allEngine.includes(LEGEND), "a legend for an absent distinction is noise")
})

// Every row is built from OpenCode's own figures (`info.tokens`,
// `turnRate(info)`) whatever tier drew the sidebar line; no engine figure is
// ever recorded. The old legend -- "engine-measured; the rest from OpenCode's
// own turn data" -- therefore claimed a provenance no row has ever had.
test("the legend never claims a row's figures are engine-measured", () => {
  const mixed = formatHistory([turn({ source: "engine" }), turn({ source: "host" })])
  assert.ok(!mixed.includes("engine-measured"), mixed)
})

test("an empty history says so rather than rendering an empty frame", () => {
  assert.equal(formatHistory([]), "No turns recorded yet.")
})

test("the summary line carries the session totals", () => {
  const out = formatHistory([turn({ tokens: 37, cost: 0.06499 }), turn({ tokens: 21, cost: 0.0006103944 })])
  const head = out.split("\n")[0]
  assert.ok(head.includes("2 turns"), head)
  assert.ok(head.includes("58 tok"), head)
  // The SUM of the two turns (0.0656), not either one alone — a summary
  // that showed a single turn's cost would be the running-total confusion
  // in reverse.
  assert.ok(head.includes("$0.066"), head)
})

// ---- the collapsed line ------------------------------------------------------
const SID = "ses_current"

test("the collapsed line keeps one glance figure, not just a label", () => {
  const out = formatCollapsedLine(turn({ rate: 38.1, rateWindow: "decode", sessionID: SID }), SID)
  assert.ok(out.includes("view metrics"), out)
  assert.ok(out.includes("38.1 tok/s"), "collapsing must not discard the one number that matters")
})

test("a whole-turn rate stays labelled even when collapsed", () => {
  const out = formatCollapsedLine(turn({ rate: 3.7, rateWindow: "whole", sessionID: SID }), SID)
  assert.ok(out.includes("3.7 tok/s overall"), out)
})

test("with no turn recorded yet, the label alone is shown", () => {
  assert.equal(formatCollapsedLine(undefined, SID), "▸ view metrics")
})

// The reported bug: `history` is durable and outlives a TUI restart, so the
// newest record can belong to a session that is not on screen -- a real
// figure, but describing nothing the reader is looking at, possibly from a
// different model.
test("a turn from another session shows no figure, only the label", () => {
  const stale = turn({ rate: 38.1, rateWindow: "decode", sessionID: "ses_previous" })
  assert.equal(formatCollapsedLine(stale, SID), "▸ view metrics")
})

test("a record predating session tracking shows no figure either", () => {
  // Written before `sessionID` existed: unattributable, so not attributed.
  assert.equal(formatCollapsedLine(turn({ rate: 38.1 }), SID), "▸ view metrics")
})

console.log(`\n${passed} passed`)
