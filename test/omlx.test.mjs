// Validates omlx.ts against LIVE CAPTURES from a running oMLX server
// (fixtures/omlx-before.json, -after-one.json, -after-two.json), plus the
// pure recovery arithmetic that a live capture can't usefully exercise on its
// own (it's the same four lines regardless of which server produced the
// numbers going into it).
//
// oMLX publishes only running averages, so a turn's rate has to be recovered
// from how the mean moved. That arithmetic is easy to get subtly wrong and
// impossible to notice by eye: a plausible-looking tok/s that is actually the
// server's lifetime average, or a negative rate from a counter reset rendered
// as if measured.
//
// A real finding from capturing the three-fixture sequence: when more than
// one request lands in a sampling window (an agentic turn issuing several
// tool round trips — the same real scenario Splash's `requests > 1` case
// exists for), the code fell back to oMLX's raw `avg_generation_tps` field
// with NO qualifying label, right next to an exact window-delta token count.
// That's inconsistent with how this codebase treats the identical situation
// everywhere else (Splash's "N requests this turn", vLLM/SGLang's ttftExact
// "(avg)" suffix) and worse here specifically, because the fallback figure
// isn't even a windowed average — it's the FULL LIFETIME average across every
// request since the server started. Fixed to reuse the "(avg)" suffix the
// no-baseline branch already carries.
//
// Run with: bun test/omlx.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { recoverLatest, formatOmlxLine, toOmlxSample } from "../adapters/omlx.ts"

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

const before = toOmlxSample(fixture("omlx-before.json").status)
const afterOne = toOmlxSample(fixture("omlx-after-one.json").status)
const afterTwo = toOmlxSample(fixture("omlx-after-two.json").status)

// ---- the recovery arithmetic (pure function; not a server-behaviour claim) --
test("recovers a single new observation from the running mean", () => {
  // Ten requests averaging 30 tok/s, then an eleventh at 85: the new mean is
  // (10*30 + 85) / 11 = 35. Recovery must return 85, not 35.
  const newAvg = (10 * 30 + 85) / 11
  assert.ok(Math.abs(recoverLatest(30, 10, newAvg, 11) - 85) < 1e-9)
})

test("refuses when more than one request landed in the window", () => {
  assert.equal(recoverLatest(30, 10, 33, 12), undefined)
})

test("refuses when no request landed", () => {
  assert.equal(recoverLatest(30, 10, 30, 10), undefined)
})

test("refuses a non-positive result rather than reporting it", () => {
  // A mean that fell far enough implies a negative contribution — impossible
  // for a rate, so it is a reset or a concurrent writer, not a measurement.
  assert.equal(recoverLatest(30, 10, 20, 11), undefined)
})

test("refuses when counters ran backwards", () => {
  assert.equal(recoverLatest(30, 10, 30, 9), undefined)
})

// ---- against the real captures: no baseline --------------------------------
test("with no prior request this session, shows the server average, labelled", () => {
  // omlx-before: total_requests 0, avg_generation_tps 0 — server just started.
  const out = formatOmlxLine(before, undefined)
  assert.ok(out.includes("(server avg)"), out)
  assert.ok(out.includes("(avg)"), out)
  assert.ok(!out.includes("tok  ("), "no per-turn token count is known yet")
})

// ---- against the real captures: exactly one new request --------------------
test("one real request recovers the exact rate the server measured", () => {
  // before: requests 0, avgGen 0. after: requests 1, avgGen 80, avgPrefill 72.3.
  // recoverLatest(0,0,80,1) = 80*1 - 0*0 = 80 exactly.
  const out = formatOmlxLine(afterOne, before).split("\n")
  assert.equal(out.length, 4, out.join(" | "))
  assert.equal(out[1], "80.0 tok/s")
  assert.equal(out[2], "prefill 72 tok/s")
  assert.ok(!out.some((l) => l.includes("avg")), "a single recovered request carries no avg label")
})

test("the single-request token deltas match the response's own usage", () => {
  const usage = JSON.parse(fixture("omlx-after-one.json")._provenance.generation_usage)
  assert.equal(afterOne.completion - before.completion, usage.completion_tokens)
  assert.equal(afterOne.prompt - before.prompt, usage.prompt_tokens)
})

// ---- against the real captures: two requests landed together --------------
test("two real requests in one window fall back to the lifetime average, labelled", () => {
  // 3 - 1 = 2 new requests: recovery refuses, so this exercises the fallback
  // this fixture pair exists for.
  const out = formatOmlxLine(afterTwo, afterOne).split("\n")
  assert.equal(out[1], "70.9 tok/s (avg)", out.join(" | "))
  assert.equal(out[2], "prefill 66 tok/s (avg)")
})

test("even in the fallback, the token counts are the window's own exact deltas", () => {
  // Two requests' own usage summed: completion 60+60=120, prompt 14+14=28.
  const usage = JSON.parse(fixture("omlx-after-two.json")._provenance.generation_usage)
  const wantCompletion = usage.req2.completion_tokens + usage.req3.completion_tokens
  const wantPrompt = usage.req2.prompt_tokens + usage.req3.prompt_tokens
  assert.equal(afterTwo.completion - afterOne.completion, wantCompletion)
  assert.equal(afterTwo.prompt - afterOne.prompt, wantPrompt)
  const out = formatOmlxLine(afterTwo, afterOne)
  assert.ok(out.includes(`${wantCompletion} tok  (${wantPrompt} prompt)`), out)
})

// ---- synthetic edge cases: real data can't exercise these on demand --------
test("a model switch falls back to averages rather than differencing", () => {
  // Differencing across a model change would attribute one model's tokens to
  // another. Kept synthetic: triggering a real model swap mid-session is
  // slow and not worth the wall-clock cost of this one code path.
  const switched = { ...afterOne, model: "some-other-model" }
  assert.ok(formatOmlxLine(switched, before).includes("(server avg)"))
})

test("cached is omitted when the prefix cache did not move", () => {
  assert.ok(!formatOmlxLine(afterOne, before).includes("cached"))
})

test("a status payload missing fields maps to zeros, not NaN", () => {
  const s = toOmlxSample({})
  assert.deepEqual(
    { r: s.requests, p: s.prompt, c: s.completion, g: s.avgGen },
    { r: 0, p: 0, c: 0, g: 0 }
  )
  assert.equal(s.model, undefined)
})

test("the loaded model wins over the configured default", () => {
  // Confirmed against the real capture too: loaded_models was
  // ["mlx-community--Qwen3.6-35B-A3B-4bit"] while default_model was the
  // unrelated "Qwen3.8-27B-MTPLX" — the loaded one is what actually answered.
  const real = fixture("omlx-after-one.json").status
  assert.equal(toOmlxSample(real).model, real.loaded_models[0])
  assert.notEqual(real.loaded_models[0], real.default_model)

  assert.equal(toOmlxSample({ loaded_models: ["a"], default_model: "b" }).model, "a")
  assert.equal(toOmlxSample({ default_model: "b" }).model, "b")
})

console.log(`\n${passed} passed`)
