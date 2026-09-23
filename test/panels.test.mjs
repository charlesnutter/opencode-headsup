// Validates panels.ts — which line the sidebar shows, per session.
//
// The anchor case is live: with two tabs open, a turn completing in tab B
// replaced tab A's line with the placeholder. The panel held ONE line for the
// whole TUI, gated on its session, so every other tab lost its own. The
// out-of-order guard was TUI-wide too, so a turn in one tab could suppress a
// turn in another as "superseded".
// Run with: bun test/panels.test.mjs
import { strict as assert } from "node:assert"
import { emptyPanels, lineFor, keyFor, setLine, LatestPerKey, PLACEHOLDER, PANEL_CAP } from "../panels.ts"

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

test("a session with no turn yet shows the placeholder", () => {
  assert.equal(lineFor(emptyPanels(), "ses_a"), PLACEHOLDER)
  assert.equal(lineFor(emptyPanels(), undefined), PLACEHOLDER)
})

test("a turn in tab B does not replace tab A's line", () => {
  // The reported bug.
  let p = emptyPanels()
  p = setLine(p, "ses_a", "vllmmlx  A-line", "vllmmlx/m")
  p = setLine(p, "ses_b", "vllmmlx  B-line", "vllmmlx/m")
  assert.equal(lineFor(p, "ses_a"), "vllmmlx  A-line")
  assert.equal(lineFor(p, "ses_b"), "vllmmlx  B-line")
})

test("a later turn in the same session replaces that session's line", () => {
  let p = setLine(emptyPanels(), "ses_a", "first", "k")
  p = setLine(p, "ses_a", "second", "k")
  assert.equal(lineFor(p, "ses_a"), "second")
})

test("the model key is remembered per session", () => {
  // Drives the "model switched" placeholder: a switch in one tab must not
  // count as a switch in another.
  let p = setLine(emptyPanels(), "ses_a", "a", "vllmmlx/m1")
  p = setLine(p, "ses_b", "b", "mtplx/m2")
  assert.equal(keyFor(p, "ses_a"), "vllmmlx/m1")
  assert.equal(keyFor(p, "ses_b"), "mtplx/m2")
  assert.equal(keyFor(p, "ses_c"), undefined)
})

test("the store is bounded, dropping the least recently written session", () => {
  let p = emptyPanels()
  for (let i = 0; i < PANEL_CAP + 5; i++) p = setLine(p, `ses_${i}`, `line ${i}`, "k")
  assert.equal(Object.keys(p.bySession).length, PANEL_CAP)
  assert.equal(lineFor(p, "ses_0"), PLACEHOLDER, "oldest evicted")
  assert.equal(lineFor(p, `ses_${PANEL_CAP + 4}`), `line ${PANEL_CAP + 4}`)
})

test("rewriting an old session keeps it from being evicted next", () => {
  let p = emptyPanels()
  for (let i = 0; i < PANEL_CAP; i++) p = setLine(p, `ses_${i}`, `line ${i}`, "k")
  p = setLine(p, "ses_0", "refreshed", "k") // now the most recent
  p = setLine(p, "ses_new", "new", "k") // forces one eviction
  assert.equal(lineFor(p, "ses_0"), "refreshed")
  assert.equal(lineFor(p, "ses_1"), PLACEHOLDER, "ses_1 was now the oldest")
})

test("setLine does not mutate its input", () => {
  const p = emptyPanels()
  setLine(p, "ses_a", "x", "k")
  assert.equal(Object.keys(p.bySession).length, 0)
})

test("out-of-order guard: a later turn in the SAME session supersedes an earlier one", () => {
  const g = new LatestPerKey()
  const first = g.begin("ses_a")
  const second = g.begin("ses_a")
  assert.equal(g.isLatest("ses_a", first), false)
  assert.equal(g.isLatest("ses_a", second), true)
})

test("out-of-order guard: a turn in ANOTHER session never supersedes this one", () => {
  // The second half of the bug: one TUI-wide counter let tab B's turn
  // suppress tab A's line entirely.
  const g = new LatestPerKey()
  const a = g.begin("ses_a")
  g.begin("ses_b")
  g.begin("ses_b")
  assert.equal(g.isLatest("ses_a", a), true)
})

console.log(`\n${passed} passed`)
