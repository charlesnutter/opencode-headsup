// Validates dialog.ts where an error can be reliably triggered in isolation:
// arithmetic with a known wrong answer, and layout that can overflow or
// misalign. The tabs as a whole are covered end to end (test/e2e/dialog.e2e.mjs).
// Run with: bun test/dialog.test.mjs
import { strict as assert } from "node:assert"
import { bar, share, alignedRows, columns, turnLines, width } from "../dialog.ts"

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
const cells = (l) => l.reduce((n, [t]) => n + t.length, 0)

test("a bar fills exactly its cells, however its parts round", () => {
  for (const n of [7, 20, 61]) {
    assert.equal(cells(bar([[1, "gen", "■"], [1, "wait", "■"], [1, "tool", "■"]], n)), n)
    assert.equal(cells(bar([[73.2, "wait", "■"], [25.1, "gen", "■"], [1.6, "tool", "■"], [0.1, "dim", "■"]], n)), n)
  }
})

test("a small but real part keeps a cell of its bar", () => {
  const b = bar([[99.9, "gen", "■"], [0.1, "tool", "■"]], 20)
  assert.ok(b.some(([t, st]) => st === "tool" && t.length === 1), JSON.stringify(b))
})

test("shares never round a real part to 0% or the rest to 100%", () => {
  assert.equal(share(18369, 18398), "99.8%")
  assert.equal(share(0.06, 81), "<1%")
  assert.equal(share(0, 10), "0%")
  assert.equal(share(5, 10), "50%")
})

test("aligned rows: values end, and bars start and end, at the same columns", () => {
  const rows = alignedRows(
    [
      { label: "input", value: "13,797", qual: "fresh", bar: [[1, "gen", "■"], [1, "wait", "■"]], note: "8,241 cached" },
      { label: "context", value: "8,726", qual: "of 262,144", bar: [[1, "gen", "■"], [9, "wait", "■"]], note: "3%" },
    ],
    24,
    80
  )
  const text = rows.map((l) => l.map(([t]) => t).join(""))
  const barAt = text.map((t) => t.indexOf("■"))
  const barEnd = text.map((t) => t.lastIndexOf("■"))
  assert.equal(barAt[0], barAt[1], text.join("\n"))
  assert.equal(barEnd[0], barEnd[1], text.join("\n"))
  assert.equal(text[0].indexOf("13,797") + 6, text[1].indexOf("8,726") + 5, "values right-aligned")
})

test("aligned rows give up bar length before they overflow", () => {
  const rows = alignedRows([{ label: "input", value: "13,797", qual: "fresh", bar: [[1, "gen", "■"]], note: "91,498 cached (92% hit)" }], 40, 60)
  assert.ok(width(rows[0]) <= 60, String(width(rows[0])))
})

test("a column grid drops to fewer columns rather than overflow", () => {
  const items = ["speed", "prefill", "ttft", "MTP", "verify", "accepted"].map((l) => ({ label: l, value: [["x".repeat(18), "bold"]] }))
  const three = columns(items, 120, 3)
  assert.equal(three.length, 2)
  const narrow = columns(items, 60, 3)
  assert.ok(narrow.length > 2, "fewer columns, more rows")
  for (const l of narrow) assert.ok(width(l) <= 60, String(width(l)))
})

// Regression: `■ sub-agents15m 02s` -- the longest legend name ran into its time.
test("a long legend name keeps a space before its time", () => {
  const T0 = 1_000_000
  const d = {
    engine: "MTPLX", totalS: 1155, steps: [], tokens: { output: 0, reasoning: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, engineRows: [],
    time: { waiting: 72, generating: 181, tools: 0.04, subagents: 902, compaction: 0, other: 0.38 },
  }
  const text = turnLines(d, 80).map((l) => l.map(([t]) => t).join("")).join("\n")
  assert.ok(/sub-agents\s+15m 02s/.test(text), text)
  void T0
})

console.log(`\n${passed} passed`)
