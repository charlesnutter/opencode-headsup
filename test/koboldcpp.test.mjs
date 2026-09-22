// Validates koboldcpp.ts against live captures from a real KoboldCpp v1.121
// server on Apple Silicon (fixtures/koboldcpp-*.json). Every assertion below
// is cross-checked against the `generation_usage` block recorded in the
// fixture's own _provenance, which is the response body the server returned
// for the generation those two captures bracket.
// Run with: bun test/koboldcpp.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { parseKoboldPerf, koboldTurn, formatKoboldLine } from "../adapters/koboldcpp.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const raw = (name) => JSON.parse(readFileSync(path.join(dir, "..", "fixtures", name), "utf8"))
const usageOf = (name) => JSON.parse(raw(name)._provenance.generation_usage)

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

// ---- the endpoint's own numbers agree with the response body ---------------
test("KoboldCpp: live turn matches the response's own usage exactly", () => {
  const before = parseKoboldPerf(raw("koboldcpp-before.json"))
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  assert.ok(before && after)
  const t = koboldTurn(after, before.total_gens)
  assert.ok(t)
  const usage = usageOf("koboldcpp-after.json")
  assert.equal(t.completionTokens, usage.completion_tokens) // 83
  assert.equal(t.promptTokens, usage.prompt_tokens) // 16
})

test("KoboldCpp: decode rate is the engine's own, not recomputed", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  const t = koboldTurn(after, 2)
  // 83 tokens in 0.303s. The engine reported 273.927 tok/s and we pass it
  // through rather than dividing, so the two must agree.
  assert.ok(Math.abs(t.decodeTokS - 273.9273979122942) < 1e-9)
  assert.ok(Math.abs(t.decodeTokS - t.completionTokens / t.decodeS) < 0.5)
})

// ---- the timer-resolution floor -------------------------------------------
test("KoboldCpp: a 1ms-floor prefill is dropped, not reported as 16000 tok/s", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  // The server really did report this. It is an artefact of the ~1ms timer
  // resolution on a 16-token prompt, not a measurement.
  assert.equal(after.last_process_time, 0.001)
  assert.equal(after.last_process_speed, 16000)
  const t = koboldTurn(after, 2)
  assert.equal(t.prefillTokS, undefined)
})

test("KoboldCpp: a well-timed prefill on a novel prompt IS reported", () => {
  const before = parseKoboldPerf(raw("koboldcpp-novel-before.json"))
  const after = parseKoboldPerf(raw("koboldcpp-novel-after.json"))
  const t = koboldTurn(after, before.total_gens)
  const usage = usageOf("koboldcpp-novel-after.json")
  assert.equal(t.promptTokens, usage.prompt_tokens) // 2818
  // 0.197s is well above the 10ms floor, so the rate survives.
  assert.ok(after.last_process_time > 0.01)
  assert.ok(t.prefillTokS > 1000, `expected a real prefill rate, got ${t.prefillTokS}`)
})

// ---- prefix-cache behaviour ------------------------------------------------
test("KoboldCpp: a full prefix-cache hit reports no prefill rate", () => {
  const after = parseKoboldPerf(raw("koboldcpp-cachehit-after.json"))
  // Re-sending an identical prompt: the server recomputed nothing, and says so
  // with a zeroed timer rather than an enormous rate.
  assert.equal(after.last_process_time, 0)
  assert.equal(after.last_process_speed, 0)
  const t = koboldTurn(after, 0)
  assert.equal(t.prefillTokS, undefined)
  // Tokens are still real, and still match the response body.
  assert.equal(t.promptTokens, usageOf("koboldcpp-cachehit-after.json").prompt_tokens)
})

test("KoboldCpp: a partial cache hit inflates prefill — documented, not fixed", () => {
  // 2016-token prompt sharing a prefix with an earlier one: input_count is the
  // whole prompt, process_time only the recomputed suffix. The result passes
  // the floor and is reported, so this test pins the known overstatement
  // rather than pretending it is handled.
  const after = parseKoboldPerf(raw("koboldcpp-longprompt-after.json"))
  const t = koboldTurn(after, 3)
  assert.ok(t.prefillTokS > 15000, `got ${t.prefillTokS}`)
})

// ---- staleness guard -------------------------------------------------------
test("KoboldCpp: an unadvanced total_gens yields nothing for this turn", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  // Same count as the sample already attributed to a previous turn: these
  // numbers describe that generation, not this one.
  assert.equal(koboldTurn(after, after.total_gens), null)
  assert.equal(koboldTurn(after, after.total_gens + 1), null)
})

test("KoboldCpp: the first turn after launch still reports (no baseline yet)", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  assert.ok(koboldTurn(after, undefined))
})

// ---- idle / malformed ------------------------------------------------------
test("KoboldCpp: an idle server (no generation yet) reports nothing", () => {
  const idle = parseKoboldPerf({
    last_input_count: 0, last_token_count: 0, last_process_time: 0, last_eval_time: 0,
    last_process_speed: 0, last_eval_speed: 0, last_draft_success: 0, last_draft_failed: 0,
    total_gens: 0,
  })
  assert.ok(idle)
  assert.equal(koboldTurn(idle, undefined), null)
})

test("KoboldCpp: a response that is not /api/extra/perf is rejected", () => {
  assert.equal(parseKoboldPerf({ some: "other endpoint" }), null)
  assert.equal(parseKoboldPerf(null), null)
  assert.equal(parseKoboldPerf("nope"), null)
})

// ---- speculative decoding --------------------------------------------------
test("KoboldCpp: no draft model means no accept rate, not 0%", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  assert.equal(after.last_draft_success, 0)
  assert.equal(after.last_draft_failed, 0)
  assert.equal(koboldTurn(after, 2).draftAcceptRate, undefined)
})

test("KoboldCpp: draft counters produce an accept rate when a draft model runs", () => {
  const withDraft = parseKoboldPerf({
    ...raw("koboldcpp-after.json"),
    last_draft_success: 30,
    last_draft_failed: 10,
  })
  assert.equal(koboldTurn(withDraft, 2).draftAcceptRate, 0.75)
})

// ---- E1/E3 audit finding: /api/extra/perf keeps no history beyond the -----
// ---- single most recent request, so a multi-request window is silently ---
// ---- under-counted unless this is detected and said so --------------------
test("KoboldCpp: two generations with one poll reports only the last, not a sum", () => {
  // Live-captured: req1 had 12 completion tokens, req2 had 8. total_gens
  // advanced by 2 (only one poll happened after both), but last_token_count
  // is 8 -- exactly req2's own count, req1's 12 tokens are gone from the
  // endpoint entirely. Confirmed before any fix existed: completionTokens
  // read 3 while 12 tokens had genuinely just been generated across two
  // requests in an earlier live reproduction of this exact scenario.
  const before = parseKoboldPerf(raw("koboldcpp-multigen-before.json"))
  const after = parseKoboldPerf(raw("koboldcpp-multigen-after.json"))
  const usage = JSON.parse(raw("koboldcpp-multigen-after.json")._provenance.generation_usage)
  const t = koboldTurn(after, before.total_gens)
  assert.ok(t)
  assert.equal(after.total_gens - before.total_gens, 2, "two generations landed in this window")
  assert.equal(t.completionTokens, usage.req2.completion_tokens, "only the last request's tokens are ever available")
  assert.notEqual(t.completionTokens, usage.req1.completion_tokens + usage.req2.completion_tokens)
  assert.equal(t.generationsInWindow, 2, "the drop must be detectable, even though it cannot be recovered")
})

test("KoboldCpp: a single-generation turn carries no generationsInWindow note", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  const t = koboldTurn(after, after.total_gens - 1)
  assert.equal(t.generationsInWindow, 1)
})

test("KoboldCpp: the first turn after launch has no generationsInWindow (no baseline to diff)", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  assert.equal(koboldTurn(after, undefined).generationsInWindow, undefined)
})

// ---- rendering: formatKoboldLine, extracted so this is testable at all ----
test("KoboldCpp: renders a note when several generations landed in one window", () => {
  const before = parseKoboldPerf(raw("koboldcpp-multigen-before.json"))
  const after = parseKoboldPerf(raw("koboldcpp-multigen-after.json"))
  const t = koboldTurn(after, before.total_gens)
  const out = formatKoboldLine(t, "qwen2.5-0.5b-instruct-q4_k_m")
  assert.ok(out.includes("2 generations this turn (last shown only)"), out)
})

test("KoboldCpp: a normal single-generation turn carries no such note", () => {
  const after = parseKoboldPerf(raw("koboldcpp-after.json"))
  const t = koboldTurn(after, after.total_gens - 1)
  const out = formatKoboldLine(t, "m")
  assert.ok(!out.includes("generations this turn"), out)
})

console.log(`\n${passed} passed`)
