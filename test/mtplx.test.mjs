// Validates mtplx.ts against LIVE CAPTURES from a running MTPLX server
// (fixtures/mtplx-completed.json, fixtures/mtplx-interrupted.json), not
// hand-transcribed screenshot values.
//
// The two captures are the two shapes that matter:
//
//   - completed: every field present, `latest` reflects a full turn.
//   - interrupted: the client aborted the stream mid-generation
//     (AbortController.abort()). ttft_s and prefill_tok_s come back
//     genuinely ABSENT — not null, no key at all — while decode_tok_s,
//     completion_tokens and request_elapsed_s survive. Rendering the
//     missing pair unguarded is what put "ttft ?s" and "prefill ? tok/s"
//     in the sidebar; this module exists to prevent that.
//
// A real finding from capturing the completed fixture: MTPLX's `/metrics`
// `latest` receipt has NO reasoning/answer token split anywhere in its 342
// keys, checked exhaustively including nested objects. The turn's own
// response `usage.completion_tokens_details.reasoning_tokens` was 23 of 64
// completion tokens, and no field in `latest` held that number under any
// name. So the adapter cannot show a "(N think)" subset for MTPLX — that
// split is only in the per-response `usage` body, which this endpoint
// doesn't expose. completion_tokens itself is still correct (it already
// includes reasoning, confirmed: 64 matches usage.completion_tokens exactly).
//
// Run with: bun test/mtplx.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { formatMtplxLine, combineMtplxSteps, mtplxView } from "../adapters/mtplx.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(path.join(dir, "..", "fixtures", name), "utf8"))

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

const MODEL = "arsis-dev-ukisai-swift-qwen3.8-27b-mtplx"

const completed = fixture("mtplx-completed.json")
const interrupted = fixture("mtplx-interrupted.json")

// ---- the completed turn, against the response's own usage -----------------
test("a completed turn's completion_tokens matches the response's own usage", () => {
  const usage = JSON.parse(completed._provenance.generation_usage)
  assert.equal(completed.latest.completion_tokens, usage.completion_tokens)
})

test("a completed turn renders a row per figure from the live receipt", () => {
  const v = mtplxView(completed.latest)
  assert.equal(v.engine, "MTPLX", "the heading names the engine, not the model")
  const rows = Object.fromEntries(v.rows)
  // The rate carries no qualifier; the ttft beside it explains the rest.
  assert.ok(/^\d+\.\d tok\/s$/.test(rows.speed), rows.speed)
  assert.ok(/^\d\.\d{2}s$/.test(rows.ttft), rows.ttft)
  assert.ok(/^\d+ tok\/s$/.test(rows.prefill), rows.prefill)
  assert.equal(rows.tokens, String(completed.latest.completion_tokens))
  assert.ok(/^\d+\.\d{2}x$/.test(rows.MTP), rows.MTP)
  assert.ok(/^\d+(\/\d+)*%$/.test(rows.accepted), rows.accepted)
  assert.equal(v.key, rows.speed, "collapsed, the heading keeps the speed")
})

test("completion_tokens already includes reasoning — no separate think subset is claimed", () => {
  // The turn's usage reported 23 of 64 tokens as reasoning; latest has no
  // field carrying that split, so the topline is the bare total, matching
  // what tokensLabel(total, 0) would render — never a fabricated "(N think)".
  const out = formatMtplxLine(completed.latest, MODEL)
  assert.ok(out.includes(`tokens ${completed.latest.completion_tokens}`), out)
  assert.ok(!out.includes("think"), "no think breakdown is available from /metrics")
})

// ---- the interrupted turn, real shape from a real abort --------------------
test("an interrupted turn genuinely lacks ttft_s and prefill_tok_s (not just null)", () => {
  assert.ok(!("ttft_s" in interrupted.latest), "ttft_s should be absent, not present-as-null")
  assert.ok(!("prefill_tok_s" in interrupted.latest), "prefill_tok_s should be absent")
  assert.ok(typeof interrupted.latest.decode_tok_s === "number")
  assert.ok(typeof interrupted.latest.completion_tokens === "number")
})

test("an interrupted turn omits the missing figures instead of printing ?", () => {
  const out = formatMtplxLine(interrupted.latest, MODEL)
  assert.ok(!out.includes("?"), `no placeholder may reach the panel:\n${out}`)
  assert.ok(!out.includes("ttft"))
  assert.ok(!out.includes("prefill"))
})

test("an interrupted turn still shows decode rate, tokens and elapsed time", () => {
  const rows = Object.fromEntries(mtplxView(interrupted.latest).rows)
  const l = interrupted.latest
  assert.equal(rows.speed, `${l.decode_tok_s.toFixed(1)} tok/s`)
  assert.equal(rows.tokens, String(l.completion_tokens))
  assert.ok(rows.time, "elapsed time survives the interruption")
})

test("no verify_calls on the interrupted turn means no MTP line", () => {
  assert.ok(!("verify_calls" in interrupted.latest))
  const mtpLine = formatMtplxLine(interrupted.latest, MODEL)
    .split("\n")
    .find((x) => x.startsWith("MTP "))
  assert.equal(mtpLine, undefined)
})

// ---- synthetic edge cases: code paths a live capture won't naturally hit ---
test("rate and TTFT are independently optional", () => {
  const out = formatMtplxLine({ decode_tok_s: null, ttft_s: 1.2 }, MODEL)
  assert.ok(out.includes("ttft 1.20s"))
  assert.ok(!out.includes("tok/s"))
  assert.ok(!out.includes("?"))
})

test("no verify passes means no MTP line, not a division by zero", () => {
  const mtpLine = (l) => formatMtplxLine(l, MODEL).split("\n").find((x) => x.startsWith("MTP "))
  assert.equal(mtpLine({ completion_tokens: 50, verify_calls: 0 }), undefined)
  assert.ok(mtpLine({ completion_tokens: 50, verify_calls: 10 })?.startsWith("MTP 5.00x"))
})

test("an empty receipt renders the header alone, with no holes", () => {
  const v = mtplxView({})
  assert.equal(v.rows.length, 0)
  assert.equal(formatMtplxLine({}, MODEL), "MTPLX")
  assert.equal(v.key, undefined)
})

test("NaN is treated as absent, not rendered", () => {
  const out = formatMtplxLine({ decode_tok_s: NaN, prefill_tok_s: NaN, completion_tokens: 22 }, MODEL)
  assert.ok(!out.includes("?"), out)
  assert.ok(!out.includes("prefill"))
})

// ---- a turn read step by step ---------------------------------------------
// MTPLX's `latest` is one request. A tool-using turn is one request per step,
// so each step's receipt is read at that step's end (measured: `latest`
// equalled the step's own count at step.ended, 62 then 138, on a live turn)
// and the receipts are combined here. Each must match OpenCode's own count
// for its step, or the turn is declined.

const stepA = completed.latest // live capture: 64 tok, 30.46 tok/s, 24 verifies
// Measured step 2 of a live tool turn (sidebar receipt, 2026-09-23). The
// verify count and depth figures are that receipt's MTP line: 3.45x -> 40.
const stepB = { completion_tokens: 138, decode_tok_s: 36.2, ttft_s: 0.66, prefill_tok_s: 287,
  request_elapsed_s: 4.48, verify_calls: 40, mean_accept_probability_by_depth: [0.92, 0.89, 0.72] }

test("one step combines to exactly that step", () => {
  const c = combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }])
  assert.equal(c.completion_tokens, 64)
  assert.equal(c.decode_tok_s, stepA.decode_tok_s)
  assert.equal(c.ttft_s, stepA.ttft_s)
  assert.equal(c.prefill_tok_s, stepA.prefill_tok_s)
})

test("two steps sum their tokens and verify passes", () => {
  const c = combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: stepB, hostTokens: 138 }])
  assert.equal(c.completion_tokens, 202)
  assert.equal(c.verify_calls, 64)
})

test("the rate is total tokens over total decode time -- generation only", () => {
  const c = combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: stepB, hostTokens: 138 }])
  const decodeS = 64 / stepA.decode_tok_s + 138 / 36.2
  assert.ok(Math.abs(c.decode_tok_s - 202 / decodeS) < 1e-9, String(c.decode_tok_s))
})

test("ttft and prefill are the first step's -- the one that read the context", () => {
  // Decided 2026-09-23: later steps mostly hit the prompt cache, so a blend
  // would be pulled around by tiny prefills; the first step's is exact.
  const c = combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: stepB, hostTokens: 138 }])
  assert.equal(c.ttft_s, stepA.ttft_s)
  assert.equal(c.prefill_tok_s, stepA.prefill_tok_s)
})

test("per-depth acceptance is weighted by each step's verify passes", () => {
  const c = combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: stepB, hostTokens: 138 }])
  const a = stepA.mean_accept_probability_by_depth
  const want = [0, 1, 2].map((i) => (a[i] * 24 + stepB.mean_accept_probability_by_depth[i] * 40) / 64)
  c.mean_accept_probability_by_depth.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9))
})

test("a step whose receipt is not its own declines the whole turn", () => {
  // e.g. OpenCode's title request finished after the step and became `latest`.
  assert.equal(combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: stepB, hostTokens: 100 }]), null)
})

test("a step with no receipt at all declines the whole turn", () => {
  assert.equal(combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: null, hostTokens: 138 }]), null)
  assert.equal(combineMtplxSteps([]), null)
})

test("a step without a decode rate leaves the turn without one, not a partial one", () => {
  const noRate = { ...stepB, decode_tok_s: undefined }
  const c = combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: noRate, hostTokens: 138 }])
  assert.equal(c.completion_tokens, 202)
  assert.equal(c.decode_tok_s, undefined)
})

test("the total shown is OpenCode's -- what you waited -- with retries named", () => {
  // MTPLX's request_elapsed_s is one request; a turn's total spans every
  // step and the tool time between them, which only the host has.
  const c = combineMtplxSteps([{ receipt: stepA, hostTokens: 64 }, { receipt: stepB, hostTokens: 138 }])
  const out = formatMtplxLine(c, MODEL, { total: 7.0, retries: 2 })
  const v = mtplxView(c, { total: 7.0, retries: 2 })
  assert.deepEqual(v.rows.filter(([l]) => l === "tokens" || l === "time" || l === ""),
    [["tokens", "202"], ["time", "7.00s"], ["", "2 retries"]])
  assert.ok(!out.includes("4.48"), out)
})

console.log(`\n${passed} passed`)
