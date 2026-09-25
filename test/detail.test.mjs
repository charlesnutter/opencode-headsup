// Validates detail.ts -- a turn's full detail, for the details dialog.
// Run with: bun test/detail.test.mjs
import { strict as assert } from "node:assert"
import { buildTurnDetail, unionSeconds, percents, turnSections } from "../detail.ts"

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

const T0 = 1_000_000
const tool = (name, ran, completed, status = "completed") => ({ type: "tool", name, state: { status }, time: { created: ran, ran, completed } })
const step = (id, created, over = {}) => ({
  type: "assistant",
  id,
  time: { created },
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 0 } },
  content: [],
  ...over,
})
// Step 1: request at T0, first token 2s later, streams 1s, then `read` runs 1s.
// Step 2: request at T0+4s, first token 1s later, streams 2s, `task` (a
// sub-agent) runs 10s, and `bash` runs alongside it for 3s.
// Step 3: request at T0+18s, first token 0.5s later, streams 1.5s, stops.
const steps = [
  step("a", T0, { finish: "tool-calls", content: [tool("read", T0 + 3_000, T0 + 4_000)] }),
  step("b", T0 + 4_000, { finish: "tool-calls", content: [tool("task", T0 + 7_000, T0 + 17_000), tool("bash", T0 + 7_000, T0 + 10_000)] }),
  step("c", T0 + 18_000, { finish: "stop", tokens: { input: 5, output: 200, reasoning: 0, cache: { read: 1200, write: 30 } } }),
]
const marks = new Map([
  ["a", { firstAt: T0 + 2_000, lastAt: T0 + 3_000 }],
  ["b", { firstAt: T0 + 5_000, lastAt: T0 + 7_000, attempts: 2 }],
  ["c", { firstAt: T0 + 18_500, lastAt: T0 + 20_000 }],
])
const base = { sessionID: "s", provider: "mtplx", model: "m", engine: "MTPLX", at: T0, totalS: 20, contextLimit: 10_000 }

test("overlapping intervals count once", () => {
  assert.equal(unionSeconds([[0, 3000], [1000, 4000], [6000, 7000]]), 5)
  assert.equal(unionSeconds([]), 0)
})

test("shares add up to exactly 100", () => {
  const p = percents([21.96, 9.72, 47.01, 6.94, 2.56, 11.81])
  assert.equal(p.reduce((a, b) => a + b, 0), 100)
  assert.deepEqual(percents([0, 0]), [0, 0])
})

test("the time split names each part and adds up to the total", () => {
  const d = buildTurnDetail(steps, marks, base)
  assert.equal(d.time.waiting, 2 + 1 + 0.5)
  assert.equal(d.time.generating, 1 + 2 + 1.5)
  // read's 1s. bash ran inside the sub-agent's 10s, so it is not counted
  // again: the parts would otherwise add up to more than the turn.
  assert.equal(d.time.tools, 1)
  assert.equal(d.time.subagents, 10)
  const sum = d.time.waiting + d.time.generating + d.time.tools + d.time.subagents + d.time.other
  assert.ok(Math.abs(sum - 20) < 1e-9, String(sum))
})

test("every step keeps its tools, their times, and its retries", () => {
  const d = buildTurnDetail(steps, marks, base)
  assert.deepEqual(d.steps[1].tools.map((t) => [t.name, t.seconds]), [["task", 10], ["bash", 3]])
  assert.equal(d.steps[1].retries, 1)
  assert.equal(d.steps[0].ttftS, 2)
  assert.equal(d.steps[2].streamS, 1.5)
})

test("tokens are kept in all five buckets", () => {
  const d = buildTurnDetail(steps, marks, base)
  assert.deepEqual(d.tokens, { output: 300, reasoning: 20, input: 205, cacheRead: 3200, cacheWrite: 30 })
})

test("context is the last step's prompt plus its output", () => {
  const d = buildTurnDetail(steps, marks, base)
  assert.deepEqual(d.context, { used: 5 + 1200 + 30 + 200, limit: 10_000 })
})

test("no total, no split: nothing is made up", () => {
  assert.equal(buildTurnDetail(steps, marks, { ...base, totalS: undefined }).time, undefined)
})

test("sections fit a 46-cell column", () => {
  const d = buildTurnDetail(steps, marks, base)
  for (const s of turnSections(d)) {
    for (const [l, v] of s.rows ?? []) assert.ok(12 + v.length <= 46, `${l}: ${v}`)
    for (const line of s.lines ?? []) assert.ok(line.length <= 46, line)
  }
})

test("the steps table lists each tool call on its own line", () => {
  const steps_ = turnSections(buildTurnDetail(steps, marks, base)).find((s) => s.title.startsWith("Steps"))
  assert.ok(steps_.lines.some((l) => l.includes("task") && l.includes("10.00s")), steps_.lines.join("\n"))
  assert.ok(steps_.lines.some((l) => l.includes("— stop")), steps_.lines.join("\n"))
  assert.ok(steps_.lines.some((l) => l.includes("1 retry")), steps_.lines.join("\n"))
})

test("the engine section is marked, and says why when there are no engine figures", () => {
  const withEngine = turnSections(buildTurnDetail(steps, marks, { ...base, engineRows: [["speed", "36.1 tok/s"]] }))
  assert.ok(withEngine.some((s) => s.title === "◆ Engine · MTPLX"), withEngine.map((s) => s.title).join(", "))
  const skipped = turnSections(buildTurnDetail(steps, marks, { ...base, engineNote: ["engine data skipped:", "overlapping requests"] }))
  const e = skipped.find((s) => s.title === "Engine · MTPLX")
  assert.deepEqual(e.lines, ["no engine figures:", "engine data skipped:", "overlapping requests"])
})

test("per-step engine rates are listed when the engine read each step", () => {
  const d = buildTurnDetail(steps, marks, {
    ...base,
    engineRows: [["speed", "36.1 tok/s"]],
    stepEngine: [{ decodeTokS: 35.2, prefillTokS: 452 }, { decodeTokS: 36.9 }, undefined],
  })
  const e = turnSections(d).find((s) => s.title.startsWith("◆ Engine"))
  assert.ok(e.lines.includes("step 1  35.2 tok/s  prefill 452 tok/s"), e.lines.join("\n"))
  assert.ok(e.lines.includes("step 2  36.9 tok/s"), e.lines.join("\n"))
})

test("retry reasons are listed in full, wrapped to the column", () => {
  const long = "Rate limited by the provider; retrying after the backoff window elapses"
  const retried = [steps[0], { ...steps[1], retry: { attempt: 2, at: 0, error: { type: "x", message: long } } }, steps[2]]
  const sec = turnSections(buildTurnDetail(retried, marks, base)).find((s) => s.title === "Retries and errors")
  assert.equal(sec.lines.join(" "), `step 2: ${long}`)
  sec.lines.forEach((l) => assert.ok(l.length <= 46, l))
})

console.log(`\n${passed} passed`)
