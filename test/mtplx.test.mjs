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
import { formatMtplxLine } from "../adapters/mtplx.ts"

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

test("a completed turn renders all five lines from the live receipt", () => {
  const out = formatMtplxLine(completed.latest, MODEL).split("\n")
  assert.equal(out.length, 5, out.join(" | "))
  assert.ok(out[0].startsWith("MTPLX  "))
  assert.ok(/^\d+\.\d tok\/s {2}ttft \d\.\d{2}s$/.test(out[1]), out[1])
  assert.ok(/^prefill \d+ tok\/s$/.test(out[2]), out[2])
  assert.ok(out[3].startsWith(`${completed.latest.completion_tokens} tok`))
  assert.ok(/^MTP \d+\.\d{2}x( \d+(\/\d+)*%)?$/.test(out[4]), out[4])
})

test("completion_tokens already includes reasoning — no separate think subset is claimed", () => {
  // The turn's usage reported 23 of 64 tokens as reasoning; latest has no
  // field carrying that split, so the topline is the bare total, matching
  // what tokensLabel(total, 0) would render — never a fabricated "(N think)".
  const out = formatMtplxLine(completed.latest, MODEL)
  assert.ok(out.includes(`${completed.latest.completion_tokens} tok`), out)
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
  const out = formatMtplxLine(interrupted.latest, MODEL).split("\n")
  const l = interrupted.latest
  assert.ok(out[1].startsWith(`${l.decode_tok_s.toFixed(1)} tok/s`))
  assert.ok(out.some((line) => line.startsWith(`${l.completion_tokens} tok`)))
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
  const out = formatMtplxLine({}, MODEL)
  assert.equal(out, "MTPLX  arsis-dev-ukisai-swift-…")
  assert.ok(!out.includes("?"))
})

test("NaN is treated as absent, not rendered", () => {
  const out = formatMtplxLine({ decode_tok_s: NaN, prefill_tok_s: NaN, completion_tokens: 22 }, MODEL)
  assert.ok(!out.includes("?"), out)
  assert.ok(!out.includes("prefill"))
})

console.log(`\n${passed} passed`)
