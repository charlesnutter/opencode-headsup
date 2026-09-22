// Validates prometheus-text.ts — reading the exposition format, nothing about
// any engine.
//
// Three adapters depend on this one function, so a defect here is a defect in
// vLLM, SGLang, vllm-mlx, Aphrodite, LMDeploy, Splash and llama.cpp at once.
// It lives at root rather than inside an adapter for that reason.
// Run with: bun test/prometheus-text.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { sumLabeledMetric } from "../prometheus-text.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const fixture = (n) => readFileSync(path.join(dir, "..", "fixtures", n), "utf8")

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

// ---- the `_created` trap ----------------------------------------------------
test("a name that is a prefix of another metric is not conflated with it", () => {
  // Prometheus clients emit a `_created` line per counter holding a unix
  // timestamp. Swallowing it would make a token counter read ~1.8 billion.
  const text = [
    'vllm:generation_tokens_total{engine="0"} 10.0',
    'vllm:generation_tokens_total_extra_metric{engine="0"} 99999.0',
    'vllm:generation_tokens_created{engine="0"} 1789775000.0',
  ].join("\n")
  assert.equal(sumLabeledMetric(text, "vllm:generation_tokens_total"), 10)
})

// ---- summing across label sets ----------------------------------------------
test("sums across multiple label sets (data-parallel ranks)", () => {
  const text = [
    'vllm:generation_tokens_total{engine="0"} 10.0',
    'vllm:generation_tokens_total{engine="1"} 25.0',
  ].join("\n")
  assert.equal(sumLabeledMetric(text, "vllm:generation_tokens_total"), 35)
})

test("sums across cache sources, as SGLang splits them", () => {
  const text = [
    'sglang:cached_tokens_total{cache_source="device"} 34.0',
    'sglang:cached_tokens_total{cache_source="host"} 8.0',
  ].join("\n")
  assert.equal(sumLabeledMetric(text, "sglang:cached_tokens_total"), 42)
})

// ---- bare, unlabelled names -------------------------------------------------
test("reads bare unlabelled names, which is why llama.cpp needs no parser", () => {
  // Accepting a space where a label brace would be is the whole reason one
  // parser serves both formats.
  assert.equal(sumLabeledMetric("llamacpp:prompt_tokens_total 35", "llamacpp:prompt_tokens_total"), 35)
})

test("bare names still reject a longer name sharing the prefix", () => {
  const text = ["llamacpp:n_decode_total 33", "llamacpp:n_decode_total_extra 999"].join("\n")
  assert.equal(sumLabeledMetric(text, "llamacpp:n_decode_total"), 33)
})

// ---- against real captures --------------------------------------------------
test("against a live llama.cpp capture, reads the bare counters", () => {
  const after = fixture("llamacpp-after.prom")
  // The fixture header records usage {prompt_tokens: 35, completion_tokens: 32}.
  assert.equal(sumLabeledMetric(after, "llamacpp:prompt_tokens_total"), 35)
  assert.equal(sumLabeledMetric(after, "llamacpp:tokens_predicted_total"), 32)
})

test("against a live Splash capture, reads the unlabelled splash_ counters", () => {
  const after = fixture("splash-after.prom")
  assert.ok(sumLabeledMetric(after, "splash:decode_output_tokens_total") >= 0)
  assert.ok(sumLabeledMetric(after, "splash_decode_output_tokens_total") > 0)
})

// ---- malformed input --------------------------------------------------------
test("comment lines are skipped", () => {
  const text = ["# HELP foo_total some help text", "# TYPE foo_total counter", "foo_total 7"].join("\n")
  assert.equal(sumLabeledMetric(text, "foo_total"), 7)
})

test("a missing metric sums to zero, not NaN", () => {
  assert.equal(sumLabeledMetric("other_total 5", "foo_total"), 0)
  assert.equal(sumLabeledMetric("", "foo_total"), 0)
})

test("a non-numeric value is ignored rather than poisoning the sum", () => {
  const text = ["foo_total 5", "foo_total NaNish", "foo_total 3"].join("\n")
  assert.equal(sumLabeledMetric(text, "foo_total"), 8)
})

console.log(`\n${passed} passed`)
