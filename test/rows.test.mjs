// Validates rows.ts -- the labelled-row layout the sidebar draws.
// Run with: bun test/rows.test.mjs
import { strict as assert } from "node:assert"
import { rowsOf, rowLines, viewText, encodeView, decodeView, nt, LABEL_WIDTH } from "../rows.ts"

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

test("a value with parts continues on rows with an empty label", () => {
  assert.deepEqual(rowsOf("ttft", ["17.64s median", "17.64s max"]), [["ttft", "17.64s median"], ["", "17.64s max"]])
})

test("empty parts leave no rows", () => {
  assert.deepEqual(rowsOf("time", ["", "207.37s", ""]), [["time", "207.37s"]])
  assert.deepEqual(rowsOf("time", []), [])
})

test("rows fit the sidebar: 12-cell labels, and a 34-cell box interior", () => {
  // 38 columns, less a 1-cell margin and 1-cell padding each side.
  const lines = rowLines([["sub-agents", "1 · 191 tok"], ["", "23.91s"]])
  assert.equal(lines[0], "sub-agents  1 · 191 tok")
  assert.equal(lines[1], " ".repeat(LABEL_WIDTH) + "23.91s")
  lines.forEach((l) => assert.ok(l.length <= 34, l))
})

test("numbers carry thousands separators", () => {
  assert.equal(nt(1233), "1,233")
  assert.equal(nt(26264.4), "26,264")
  assert.equal(nt(undefined), "?")
})

test("a view round-trips through the per-session store", () => {
  const v = { engine: "MTPLX", rows: [["speed", "34.4 tok/s"]], notes: ["engine data skipped"], key: "34.4 tok/s" }
  assert.deepEqual(decodeView(encodeView(v)), v)
})

test("a legacy plain-text line decodes to its heading and notes, never throws", () => {
  assert.deepEqual(decodeView("inference · —"), { engine: "inference · —", rows: [], notes: [] })
  assert.deepEqual(decodeView("vllm-mlx  m\n60.4 tok/s"), { engine: "vllm-mlx  m", rows: [], notes: ["60.4 tok/s"] })
})

test("as text, a labelled row reads 'label value' and a continuation just its value", () => {
  const t = viewText({ engine: "MTPLX", rows: [["ttft", "0.31s (avg)"], ["", "2.00s max"]], notes: ["note"] })
  assert.equal(t, "MTPLX\nttft 0.31s (avg)\n2.00s max\nnote")
})

console.log(`\n${passed} passed`)
