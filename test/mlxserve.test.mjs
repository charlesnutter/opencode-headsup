// Validates mlxserve.ts against live captures from a real mlx-serve 0.1.0 on
// Apple Silicon (fixtures/mlxserve-*.json). Each fixture's `_provenance`
// records the scenario and, where the server produced one, the response's own
// usage block.
// Run with: bun test/mlxserve.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { parseMlxServeRequests, mlxServeTurn, formatMlxServeLine, combineMlxServeSteps } from "../adapters/mlxserve.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const raw = (name) => JSON.parse(readFileSync(path.join(dir, "..", "fixtures", name), "utf8"))
const records = (name) => parseMlxServeRequests(raw(name))

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

// ---- the streamed path, which is what OpenCode produces --------------------
test("mlx-serve: a streamed turn gives a real TTFT and a decode rate", () => {
  const t = mlxServeTurn(records("mlxserve-streamed.json"), undefined)
  assert.ok(t)
  assert.ok(t.streamed)
  // 94 tokens, 356.2ms total, 96.2ms TTFT -> 361.4 tok/s over the decode window.
  assert.equal(t.completionTokens, 94)
  assert.ok(Math.abs(t.ttft - 0.0962) < 1e-9)
  assert.ok(Math.abs(t.decodeTokS - 361.4) < 0.2)
  // The server's rate excludes prefill: the whole-request rate would be lower.
  assert.ok(t.decodeTokS > t.completionTokens / t.totalS)
  assert.equal(t.overallTokS, undefined)
})

test("mlx-serve: a streamed turn has no prompt count to report", () => {
  // mlx_lm.server reports no prompt tokens when streaming; the field is null.
  const t = mlxServeTurn(records("mlxserve-streamed.json"), undefined)
  assert.equal(t.promptTokens, undefined)
})

// ---- the non-streamed path, where both figures change meaning --------------
test("mlx-serve: a non-streamed turn is detected, not mistaken for streaming", () => {
  const t = mlxServeTurn(records("mlxserve-nonstreamed.json"), undefined)
  assert.ok(t)
  // The server really does report these as equal: TTFT is stamped at completion.
  const r = raw("mlxserve-nonstreamed.json").requests[0]
  assert.equal(r.ttft_ms, r.total_duration_ms)
  assert.equal(t.streamed, false)
  // So no TTFT is claimed, and the rate is not offered as a decode rate.
  assert.equal(t.ttft, undefined)
  assert.equal(t.decodeTokS, undefined)
})

test("mlx-serve: a non-streamed rate is kept, but as a whole-request rate", () => {
  const t = mlxServeTurn(records("mlxserve-nonstreamed.json"), undefined)
  // 114 tokens over the full 403ms, prefill included.
  assert.ok(Math.abs(t.overallTokS - 282.9) < 0.2)
  assert.ok(Math.abs(t.overallTokS - t.completionTokens / t.totalS) < 1)
  assert.equal(t.promptTokens, 36) // non-streaming does report the prompt
})

// ---- the id-keyed freshness guard ------------------------------------------
test("mlx-serve: the same record is never reported for two turns", () => {
  const recs = records("mlxserve-streamed.json")
  const first = mlxServeTurn(recs, undefined)
  assert.ok(first)
  // Having reported it, the same history must yield nothing.
  assert.equal(mlxServeTurn(recs, first.requestId), null)
})

test("mlx-serve: a new request after the last seen one is reported", () => {
  const recs = records("mlxserve-streamed.json")
  const t = mlxServeTurn(recs, "some-older-request-id")
  assert.ok(t)
  assert.notEqual(t.requestId, "some-older-request-id")
})

// ---- skipping records that describe nothing useful -------------------------
test("mlx-serve: failed and empty records are skipped, not reported", () => {
  const recs = records("mlxserve-streamed.json")
  const good = recs[0]
  const failed = { ...good, requestId: "failed", statusCode: 500, error: "boom" }
  const empty = { ...good, requestId: "empty", completionTokens: 0 }
  // Both sit ahead of the good record and must be passed over.
  const t = mlxServeTurn([failed, empty, good], undefined)
  assert.equal(t.requestId, good.requestId)
})

test("mlx-serve: a cold start is flagged so its duration is not misread", () => {
  const recs = records("mlxserve-streamed.json")
  const cold = { ...recs[0], requestId: "cold", coldStart: true }
  assert.equal(mlxServeTurn([cold], undefined).coldStart, true)
  assert.equal(mlxServeTurn(recs, undefined).coldStart, false)
})

// ---- shape guards -----------------------------------------------------------
test("mlx-serve: a response that is not this endpoint is rejected", () => {
  assert.equal(parseMlxServeRequests({ uptime_seconds: 4, models: {} }), null)
  assert.equal(parseMlxServeRequests(null), null)
})

test("mlx-serve: an empty history yields nothing", () => {
  assert.deepEqual(parseMlxServeRequests({ requests: [] }), [])
  assert.equal(mlxServeTurn([], undefined), null)
})

// ---- E1/E3 audit finding: intermediate records between polls were --------
// ---- silently dropped, not just the rate but the TOKEN COUNTS too --------
test("mlx-serve: two real records landing between polls are summed, not dropped", () => {
  // The real fixture holds 3 records. lastSeenId = the oldest -- the two
  // newer real records (94 + 100 completion tokens) must both be counted.
  // Before this fix, only the single newest (94) was ever reported, with
  // the other 100 tokens silently gone and no indication anything was
  // missed -- the same class of bug koboldcpp had, but here recoverable
  // because mlx-serve keeps individual records rather than only the latest.
  const recs = records("mlxserve-streamed.json")
  const oldest = recs[recs.length - 1].requestId
  const t = mlxServeTurn(recs, oldest)
  assert.ok(t)
  assert.equal(t.requests, 2)
  assert.equal(t.completionTokens, 94 + 100)
})

test("mlx-serve: a baseline that aged out of the bounded history sums everything visible", () => {
  // The server keeps only `last_n` records. If more requests landed than
  // that between polls, lastSeenId will not be found at all -- but every
  // record currently visible is still provably newer than it, so all of
  // them are summed rather than falling back to just the newest.
  const recs = records("mlxserve-streamed.json")
  const t = mlxServeTurn(recs, "some-id-not-in-the-history-at-all")
  assert.ok(t)
  assert.equal(t.requests, 3)
  assert.equal(t.completionTokens, 94 + 100 + 60)
})

test("mlx-serve: the rate is dropped, not misattributed, when several records are summed", () => {
  const recs = records("mlxserve-streamed.json")
  const oldest = recs[recs.length - 1].requestId
  const t = mlxServeTurn(recs, oldest)
  assert.equal(t.decodeTokS, undefined)
  assert.equal(t.overallTokS, undefined)
  assert.equal(t.ttft, undefined)
})

test("mlx-serve: a mix of streamed and non-streamed records drops promptTokens, not a partial sum", () => {
  // Real fixture: 2 of the 4 records have prompt_tokens: null (streamed).
  // Summing only the defined ones would understate; must be undefined.
  const recs = records("mlxserve-nonstreamed.json")
  const oldest = recs[recs.length - 1].requestId
  const t = mlxServeTurn(recs, oldest)
  assert.equal(t.requests, 3)
  assert.equal(t.completionTokens, 114 + 94 + 100)
  assert.equal(t.promptTokens, undefined)
})

test("mlx-serve: no baseline still means single-newest-only, not the whole visible history", () => {
  // The bug this guards against: conflating 'no baseline yet' (first turn
  // after launch -- report only the newest, matching every other adapter)
  // with 'baseline aged out' (sum everything visible) would have summed
  // the server's pre-existing history from before this plugin ever started
  // watching into the very first turn it ever reported.
  const recs = records("mlxserve-streamed.json")
  const t = mlxServeTurn(recs, undefined)
  assert.equal(t.requests, 1)
  assert.equal(t.completionTokens, 94) // the single newest record only
})

// ---- rendering: formatMlxServeLine, extracted so this is testable at all --
test("mlx-serve: renders a note when several records were summed into one turn", () => {
  const recs = records("mlxserve-streamed.json")
  const oldest = recs[recs.length - 1].requestId
  const t = mlxServeTurn(recs, oldest)
  const out = formatMlxServeLine(t, "qwen05")
  assert.ok(out.includes("2 requests this turn"), out)
  assert.ok(out.includes("tokens 194"), out)
})

test("mlx-serve: a normal single-record turn carries no such note", () => {
  const recs = records("mlxserve-streamed.json")
  const t = mlxServeTurn(recs, undefined)
  const out = formatMlxServeLine(t, "qwen05")
  assert.ok(!out.includes("requests this turn"), out)
})

// ---- a turn read step by step ---------------------------------------------
// Each step's end reads the history; its newest usable record is that step.
// The streamed fixture's two live records stand in for two steps: the older
// (100 tok) as read after step one, then both (newest 94 tok) after step two.
const all = records("mlxserve-streamed.json")
const afterStep1 = all.slice(1)
const afterStep2 = all

test("mlx-serve steps: each step's newest record, summed and checked", () => {
  const t = combineMlxServeSteps([{ records: afterStep1, hostTokens: 100 }, { records: afterStep2, hostTokens: 94 }])
  assert.equal(t.completionTokens, 194)
  assert.equal(t.requestId, all[0].requestId, "the last step's record, stored as the new baseline")
  assert.equal(combineMlxServeSteps([{ records: afterStep1, hostTokens: 100 }, { records: afterStep2, hostTokens: 90 }]), null)
})

test("mlx-serve steps: the same record read for two steps is declined", () => {
  // A step whose read shows no new record: its newest is still the last one.
  assert.equal(combineMlxServeSteps([{ records: afterStep1, hostTokens: 100 }, { records: afterStep1, hostTokens: 100 }]), null)
})

test("mlx-serve steps: a record already reported last turn is not this turn's", () => {
  assert.equal(combineMlxServeSteps([{ records: afterStep1, hostTokens: 100 }], afterStep1[0].requestId), null)
})

test("mlx-serve steps: the rate is total tokens over total decode time, ttft the first step's", () => {
  const t = combineMlxServeSteps([{ records: afterStep1, hostTokens: 100 }, { records: afterStep2, hostTokens: 94 }])
  const decodeS = 100 / all[1].tokensPerSecond + 94 / all[0].tokensPerSecond
  assert.ok(Math.abs(t.decodeTokS - 194 / decodeS) < 1e-9, String(t.decodeTokS))
  assert.ok(Math.abs(t.ttft - all[1].ttftMs / 1000) < 1e-9)
})

test("mlx-serve steps: every request accounted for, so no 'requests this turn' note", () => {
  const t = combineMlxServeSteps([{ records: afterStep1, hostTokens: 100 }, { records: afterStep2, hostTokens: 94 }])
  const out = formatMlxServeLine(t, "qwen05", { total: 12.0, retries: 1 })
  assert.ok(!out.includes("requests this turn"), out)
  assert.ok(out.includes("tokens 194\ntime 12.00s\n1 retry"), out)
})

console.log(`\n${passed} passed`)
