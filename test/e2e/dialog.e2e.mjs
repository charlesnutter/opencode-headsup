// End-to-end: the details dialog's three tabs, built from what real turns
// leave behind. Turns run through the entry file (see harness.mjs); each tab
// is then laid out exactly as the entry file lays it out -- dialog.ts's lines
// with the chosen spacing -- and read as the user would read it.
// Run with: bun test/e2e/dialog.e2e.mjs
import { strict as assert } from "node:assert"
import { startPlugin, engineServer, settle, test, done } from "./harness.mjs"
import { turnLines, sessionLines, historyTabLines, spaced, width } from "../../dialog.ts"
import { sessionFigures } from "../../session.ts"

const MTPLX = { provider: "mtplx", model: "qwen3.8-27b" }
const receipt = (tokens, tokS) => ({
  latest: { completion_tokens: tokens, decode_tok_s: tokS, prefill_tok_s: 450, ttft_s: 2, verify_calls: Math.round(tokens / 3), mean_accept_probability_by_depth: [0.93, 0.87, 0.82] },
})
const text = (lines) => lines.map((l) => l.map(([t]) => t).join(""))
const tab = {
  turn: (h, sid, w) => spaced(turnLines(h.detail(sid), w), "roomy"),
  session: (h, sid, w) => spaced(sessionLines(sessionFigures(h.history(), sid), w), "roomy"),
  history: (h, sid, w, scope = "session") => historyTabLines(h.history(), sid, scope, w),
}
const WIDTHS = [72, 80, 106, 130]

/** A turn with a tool call, then a sub-agent, then an answer: three steps. */
async function toolTurn(h, eng, sid) {
  h.user(sid)
  h.executionStarted(sid)
  await h.step(sid, {
    ...MTPLX, ttftMs: 2_000, streamMs: 4_000, finish: "tool-calls",
    tokens: { input: 900, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
    tools: [{ name: "bash", ms: 3_000 }],
    beforeStreamed: () => { eng.routes["/metrics"] = receipt(120, 30) },
  })
  await h.step(sid, {
    ...MTPLX, ttftMs: 500, streamMs: 1_000, finish: "tool-calls",
    tokens: { input: 50, output: 30, reasoning: 0, cache: { read: 900, write: 0 } },
    tools: [{ name: "subagent", ms: 20_000 }],
    beforeStreamed: () => { eng.routes["/metrics"] = receipt(30, 30) },
  })
  await h.step(sid, {
    ...MTPLX, ttftMs: 500, streamMs: 2_000, finish: "stop",
    tokens: { input: 40, output: 60, reasoning: 0, cache: { read: 950, write: 0 } },
    beforeStreamed: () => { eng.routes["/metrics"] = receipt(60, 30) },
  })
  h.executionSucceeded(sid)
  await settle()
}

await test("Turn tab: the time split adds up, and every step, tool and engine figure is there", async () => {
  const eng = engineServer()
  const h = await startPlugin({ mtplxMetricsUrl: `${eng.url}/metrics` })
  try {
    const sid = h.session("ses_t")
    await toolTurn(h, eng, sid)
    const lines = text(tab.turn(h, sid, 80))
    const all = lines.join("\n")
    // 2 + 4 + 3 (bash) + 0.5 + 1 + 20 (sub-agent) + 0.5 + 2 = 33s
    assert.ok(lines[0].startsWith("Where the time went") && lines[0].endsWith("33.00s"), lines[0])
    for (const part of ["waiting", "generating", "tools", "sub-agents"]) assert.ok(all.includes(`■ ${part}`), part)
    assert.equal(lines.filter((l) => /^ {2}\d {2}/.test(l) && l.includes("■")).length, 3, "a timeline row per step")
    assert.ok(/bash\s+3\.00s/.test(all), all)
    assert.ok(/subagent\s+20\.00s/.test(all), all)
    assert.ok(all.includes("— stop"))
    // Tokens lead with what was generated, as the steps count it: 120 + 30 + 60.
    assert.ok(/^generated\s+210 tok/m.test(all), all)
    // The engine's figures, in its grid, and not OpenCode's total.
    assert.ok(/speed\s+30\.0 tok\/s/.test(all) && all.includes("prefill") && all.includes("93/87/82%"), all)
    assert.ok(!/◆ MTPLX[\s\S]*33\.00s/.test(all), "the engine section has no OpenCode total")
  } finally {
    h.restore()
    eng.stop()
  }
})

await test("every tab fits its width: no line wraps onto a blank-looking row", async () => {
  const eng = engineServer()
  const h = await startPlugin({ mtplxMetricsUrl: `${eng.url}/metrics` })
  try {
    const sid = h.session("ses_w")
    await toolTurn(h, eng, sid)
    await toolTurn(h, eng, sid)
    for (const w of WIDTHS) {
      for (const [name, lines] of [
        ["turn", tab.turn(h, sid, w)],
        ["session", tab.session(h, sid, w)],
        ["history", tab.history(h, sid, w)],
        ["history all", tab.history(h, sid, w, "all")],
      ]) {
        for (const l of lines) assert.ok(width(l) <= w, `${name} at ${w}: ${width(l)} > ${w}: ${l.map(([t]) => t).join("")}`)
      }
    }
  } finally {
    h.restore()
    eng.stop()
  }
})

await test("Session tab: tools by time, coverage and tokens over the session's turns", async () => {
  const eng = engineServer()
  const h = await startPlugin({ mtplxMetricsUrl: `${eng.url}/metrics` })
  try {
    const sid = h.session("ses_s")
    await toolTurn(h, eng, sid)
    await toolTurn(h, eng, sid)
    const all = text(tab.session(h, sid, 80)).join("\n")
    assert.ok(/Tools by time[─ ]+2 calls/.test(all), all)
    assert.ok(/ {2}bash\s+■+\s+6\.00s\s+2 calls/.test(all), all)
    assert.ok(!/ {2}subagent /.test(all), "a sub-agent's time is its own part, not a tool's")
    assert.ok(/engine\s+2 of 2 turns/.test(all), all)
    assert.ok(/generated\s+420 tok/.test(all), all)
  } finally {
    h.restore()
    eng.stop()
  }
})

await test("Session tab: a turn with no tool calls says so, rather than hiding the section", async () => {
  const h = await startPlugin({})
  try {
    const sid = h.session("ses_n")
    h.user(sid)
    h.executionStarted(sid)
    await h.step(sid, { provider: "lmstudio", model: "m", ttftMs: 500, streamMs: 1_000, finish: "stop",
      tokens: { input: 10, output: 30, reasoning: 0, cache: { read: 0, write: 0 } } })
    h.executionSucceeded(sid)
    await settle()
    const all = text(tab.session(h, sid, 80)).join("\n")
    assert.ok(all.includes("no tool calls in these turns"), all)
  } finally {
    h.restore()
  }
})

await test("History tab: a row per turn in this session; all sessions adds the model", async () => {
  const eng = engineServer()
  const h = await startPlugin({ mtplxMetricsUrl: `${eng.url}/metrics` })
  try {
    const a = h.session("ses_a")
    await toolTurn(h, eng, a)
    const b = h.session("ses_b")
    await toolTurn(h, eng, b)
    const mine = text(tab.history(h, b, 80))
    assert.ok(/\b1 turn\b/.test(mine[0]) && !mine[0].includes("1 turns"), mine[0])
    assert.equal(mine.filter((l) => /^ {2}\d\d:\d\d/.test(l)).length, 1)
    assert.ok(!mine.join("\n").includes("model"))
    const every = text(tab.history(h, b, 80, "all"))
    assert.equal(every.filter((l) => /^ {2}\d\d:\d\d/.test(l)).length, 2)
    assert.ok(every.some((l) => l.includes("model")) && every.some((l) => l.includes("qwen3.8-27b")), every.join("\n"))
    assert.ok(every.filter((l) => /^ {2}\d\d:\d\d/.test(l)).every((l) => l.trimEnd().endsWith("◆")), "engine figures used on both")
  } finally {
    h.restore()
    eng.stop()
  }
})

await test("spacing: a blank row under each heading, and no blank row doubled", async () => {
  const eng = engineServer()
  const h = await startPlugin({ mtplxMetricsUrl: `${eng.url}/metrics` })
  try {
    const sid = h.session("ses_sp")
    await toolTurn(h, eng, sid)
    for (const lines of [tab.turn(h, sid, 80), tab.session(h, sid, 80)]) {
      const t = text(lines)
      t.forEach((l, i) => {
        if (/ ─{3,}/.test(l) && t[i + 1] !== undefined) assert.equal(t[i + 1].trim(), "", `no blank row under: ${l}`)
        if (l.trim() === "" && i > 0) assert.notEqual(t[i - 1].trim(), "", `two blank rows before: ${t[i + 1]}`)
      })
    }
  } finally {
    h.restore()
    eng.stop()
  }
})

done()
