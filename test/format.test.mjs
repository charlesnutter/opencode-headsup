// Validates format.ts — how a figure is rendered, not what it means.
//
// Every adapter and Tier 1 render through these four functions, so their edge
// behaviour is the panel's edge behaviour. Two shipped bugs came from it: the
// "?" placeholders MTPLX put in the sidebar when a figure was absent, and the
// "(+889 think)" form that read as an addition.
// Run with: bun test/format.test.mjs
import { strict as assert } from "node:assert"
import { nn, ni, short, tokensLabel } from "../format.ts"

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

// ---- nn / ni: the "?" contract ---------------------------------------------
test("nn renders one decimal by default, and honours a precision", () => {
  assert.equal(nn(72.4), "72.4")
  assert.equal(nn(0.6614, 2), "0.66")
  assert.equal(nn(0), "0.0")
})

test("ni rounds to a whole number", () => {
  assert.equal(ni(440.6), "441")
  assert.equal(ni(0.4), "0")
})

test('anything non-finite renders "?" — the signal to omit the line', () => {
  // Callers must drop the line rather than print this. MTPLX shipped
  // "ttft ?s" and "prefill ? tok/s" to the sidebar by not doing so.
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, "12", {}]) {
    assert.equal(nn(bad), "?", `nn(${String(bad)})`)
    assert.equal(ni(bad), "?", `ni(${String(bad)})`)
  }
})

test("a negative number is rendered, not rejected", () => {
  // Guarding against nonsense is the caller's job; this only formats.
  assert.equal(nn(-1.25, 2), "-1.25")
})

// ---- short: the model label -------------------------------------------------
test("short keeps only the segment after the last slash", () => {
  assert.equal(short("mlx-community/Qwen2.5-0.5B-Instruct-4bit"), "Qwen2.5-0.5B-Instruct-4…")
  assert.equal(short("qwen05"), "qwen05")
})

test("short truncates to 24 columns with an ellipsis", () => {
  const out = short("incoai/Qwen3.8-27B-Splash-With-A-Very-Long-Suffix")
  assert.equal(out.length, 24)
  assert.ok(out.endsWith("…"))
})

test("short leaves a name that exactly fits alone", () => {
  const exact = "a".repeat(24)
  assert.equal(short(exact), exact)
  assert.equal(short("a".repeat(25)).length, 24)
})

test("short handles an empty name without throwing", () => {
  assert.equal(short(""), "")
})

// ---- tokensLabel: the subset contract ---------------------------------------
test("the topline is the total, with thinking named as a subset", () => {
  // Measured on a Splash turn: 358 visible + 889 reasoning == the engine's own
  // output of 1247. The total is what goes first.
  assert.equal(tokensLabel(1247, 889), "1247 tok (889 think)")
})

test("never the additive form, which invites summing to 2136", () => {
  assert.ok(!tokensLabel(1247, 889).includes("(+"))
})

test("no thinking means no think figure at all", () => {
  assert.equal(tokensLabel(32, 0), "32 tok")
})

test("a non-finite total still renders the ? signal", () => {
  assert.equal(tokensLabel(NaN, 0), "? tok")
})

console.log(`\n${passed} passed`)
