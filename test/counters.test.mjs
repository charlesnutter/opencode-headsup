// Validates counters.ts -- taking a bracketed request out of a counter window.
// Run with: bun test/counters.test.mjs
import { strict as assert } from "node:assert"
import { counterDelta, shiftBaseline } from "../counters.ts"

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

// Splash-shaped: a turn of 2 requests (500 tokens), with a compaction of 1
// request (40 tokens out, 23,000 in) between them.
const prev = { requestsCompleted: 10, decodeTokens: 1_000, prefillTokens: 50_000, model: "q" }
const before = { requestsCompleted: 11, decodeTokens: 1_200, prefillTokens: 60_000, model: "q" }
const after = { requestsCompleted: 12, decodeTokens: 1_240, prefillTokens: 83_000, model: "q" }
const now = { requestsCompleted: 13, decodeTokens: 1_540, prefillTokens: 93_000, model: "q" }

test("a delta is field-wise, numeric fields only", () => {
  assert.deepEqual(counterDelta(before, after), { requestsCompleted: 1, decodeTokens: 40, prefillTokens: 23_000 })
})

test("shifting the baseline leaves only the turn's own requests in the window", () => {
  const shifted = shiftBaseline(prev, [{ before, after }])
  assert.deepEqual(counterDelta(shifted, now), { requestsCompleted: 2, decodeTokens: 500, prefillTokens: 20_000 })
  assert.equal(shifted.model, "q")
})

test("no brackets, no change", () => {
  assert.deepEqual(shiftBaseline(prev, []), prev)
})

test("a bracket that went backwards (engine restarted) is ignored", () => {
  const restarted = { requestsCompleted: 0, decodeTokens: 0, prefillTokens: 0, model: "q" }
  assert.deepEqual(shiftBaseline(prev, [{ before, after: restarted }]), prev)
})

console.log(`\n${passed} passed`)
