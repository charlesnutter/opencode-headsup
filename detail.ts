// A turn's full detail, for the details dialog.
//
// Pure, like history.ts and session.ts. The sidebar shows a handful of rows;
// the adapters and the universal layer reduce each turn to those and the rest
// was discarded. This keeps what the dialog needs, built from the turn's
// assistant messages (one per step) and the plugin's own stream marks:
//
// - every step: tokens, streaming time, time to first token, finish reason,
//   its tool calls and how long each ran, its last retry's reason;
// - the turn's time split into waiting, generating, tools, sub-agents and
//   other, which adds up to the turn's total;
// - tokens in all five buckets.
//
// Everything here is OpenCode's own data. Engine figures travel separately,
// as rows the adapter produced, so each can be marked with its source.

import type { SessionMessageAssistant } from "@opencode-ai/client"
import type { Turn } from "./universal"
import type { Row } from "./rows"

export interface ToolDetail {
  name: string
  status: string
  /** Running time: from the tool starting to run to it completing. */
  seconds?: number
  /** Epoch ms, for merging overlapping calls. */
  start?: number
  end?: number
  error?: string
}

export interface StepDetail {
  id: string
  output: number
  reasoning: number
  /** Prompt tokens not served from cache. */
  input: number
  cacheRead: number
  cacheWrite: number
  finish?: string
  /** Seconds from the step's request to its first token, retries included. */
  ttftS?: number
  /** Seconds from its first token to its last. */
  streamS?: number
  tools: ToolDetail[]
  /** Attempts beyond the first. */
  retries: number
  /** The last retry's reason, as OpenCode recorded it. */
  retryReason?: string
  error?: string
}

export interface TimeSplit {
  waiting: number
  generating: number
  tools: number
  subagents: number
  other: number
}

export interface TurnDetail {
  sessionID: string
  provider: string
  model: string
  /** The engine's display name, as the sidebar box heads it. */
  engine: string
  /** Epoch ms when the turn was recorded. */
  at: number
  outcome?: "interrupted" | "failed"
  totalS?: number
  /** Seconds, adding up to `totalS`; absent when the total is unknown. */
  time?: TimeSplit
  steps: StepDetail[]
  tokens: { output: number; reasoning: number; input: number; cacheRead: number; cacheWrite: number }
  /** Context in use after the turn: the last step's prompt plus its output. */
  context?: { used: number; limit?: number }
  cost?: number
  /** Figures measured by the engine, as the adapter rendered them. */
  engineRows: Row[]
  /** Why engine figures are missing, when they are. */
  engineNote?: string[]
  subagents?: { count: number; tokens: number; spanS: number; cost?: number; steps?: number }
}

/**
 * Tools that run a sub-agent. Their time is the sub-agent's, counted under
 * sub-agents rather than tools. OpenCode's name for it is `task`.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["task", "agent", "subagent"])

type ToolPart = {
  type?: string
  name?: string
  state?: { status?: string; error?: { message?: string } }
  time?: { created?: number; ran?: number; completed?: number }
}

function toolsOf(m: SessionMessageAssistant): ToolDetail[] {
  const out: ToolDetail[] = []
  for (const part of (m.content ?? []) as ToolPart[]) {
    if (part?.type !== "tool") continue
    const start = part.time?.ran ?? part.time?.created
    const end = part.time?.completed
    out.push({
      name: part.name ?? "?",
      status: part.state?.status ?? "?",
      start,
      end,
      seconds: start !== undefined && end !== undefined && end >= start ? (end - start) / 1000 : undefined,
      error: part.state?.status === "error" ? part.state.error?.message : undefined,
    })
  }
  return out
}

/** Total length of a set of intervals, overlaps counted once. */
export function unionSeconds(spans: ReadonlyArray<readonly [number, number]>): number {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  let total = 0
  let curStart = -Infinity
  let curEnd = -Infinity
  for (const [a, b] of sorted) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart
      curStart = a
      curEnd = b
    } else if (b > curEnd) {
      curEnd = b
    }
  }
  if (curEnd > curStart) total += curEnd - curStart
  return total / 1000
}

/**
 * The detail of one turn from its steps (oldest first) and the plugin's
 * stream marks. `totalS` is the turn's real elapsed time, as the sidebar
 * shows it; the split's `other` is what the named parts leave of it.
 */
export function buildTurnDetail(
  steps: readonly SessionMessageAssistant[],
  marks: ReadonlyMap<string, Turn>,
  base: {
    sessionID: string
    provider: string
    model: string
    engine: string
    at: number
    totalS?: number
    outcome?: "interrupted" | "failed"
    contextLimit?: number
    engineRows?: Row[]
    engineNote?: string[]
    subagents?: TurnDetail["subagents"]
  }
): TurnDetail {
  const tokens = { output: 0, reasoning: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0
  let sawCost = false
  let waitMs = 0
  let streamMs = 0
  const toolSpans: Array<[number, number]> = []
  const subSpans: Array<[number, number]> = []
  const out: StepDetail[] = []

  for (const m of steps) {
    const t = marks.get(m.id)
    const s: StepDetail = {
      id: m.id,
      output: m.tokens?.output ?? 0,
      reasoning: m.tokens?.reasoning ?? 0,
      input: m.tokens?.input ?? 0,
      cacheRead: m.tokens?.cache?.read ?? 0,
      cacheWrite: m.tokens?.cache?.write ?? 0,
      finish: m.finish,
      tools: toolsOf(m),
      retries: Math.max(0, (t?.attempts ?? 1) - 1),
      retryReason: m.retry?.error?.message,
      error: m.error?.message,
    }
    if (t?.firstAt !== undefined && t.firstAt > m.time.created) {
      s.ttftS = (t.firstAt - m.time.created) / 1000
      waitMs += t.firstAt - m.time.created
    }
    if (t?.firstAt !== undefined && t.lastAt !== undefined && t.lastAt > t.firstAt) {
      s.streamS = (t.lastAt - t.firstAt) / 1000
      streamMs += t.lastAt - t.firstAt
    }
    for (const tool of s.tools) {
      if (tool.start === undefined || tool.end === undefined) continue
      ;(SUBAGENT_TOOLS.has(tool.name) ? subSpans : toolSpans).push([tool.start, tool.end])
    }
    tokens.output += s.output
    tokens.reasoning += s.reasoning
    tokens.input += s.input
    tokens.cacheRead += s.cacheRead
    tokens.cacheWrite += s.cacheWrite
    if (typeof m.cost === "number") {
      cost += m.cost
      sawCost = true
    }
    out.push(s)
  }

  let time: TimeSplit | undefined
  if (base.totalS !== undefined && base.totalS > 0) {
    const waiting = waitMs / 1000
    const generating = streamMs / 1000
    // A sub-agent's time is its tool call's; without one (a sub-agent the
    // steps don't show), the roll-up's span stands in.
    const subagents = subSpans.length > 0 ? unionSeconds(subSpans) : (base.subagents?.spanS ?? 0)
    // Tool time while a sub-agent was also running is already in the
    // sub-agent's time; counted in both, the parts would exceed the total.
    const tools = unionSeconds([...toolSpans, ...subSpans]) - unionSeconds(subSpans)
    time = {
      waiting,
      generating,
      tools,
      subagents,
      other: Math.max(0, base.totalS - waiting - generating - tools - subagents),
    }
  }

  const last = steps[steps.length - 1]
  const used =
    last !== undefined
      ? (last.tokens?.input ?? 0) +
        (last.tokens?.cache?.read ?? 0) +
        (last.tokens?.cache?.write ?? 0) +
        (last.tokens?.output ?? 0) +
        (last.tokens?.reasoning ?? 0)
      : 0

  return {
    sessionID: base.sessionID,
    provider: base.provider,
    model: base.model,
    engine: base.engine,
    at: base.at,
    outcome: base.outcome,
    totalS: base.totalS,
    time,
    steps: out,
    tokens,
    context: used > 0 ? { used, limit: base.contextLimit } : undefined,
    cost: sawCost && cost > 0 ? cost : undefined,
    engineRows: base.engineRows ?? [],
    engineNote: base.engineNote,
    subagents: base.subagents,
  }
}

// ---- as text, for the dialog -------------------------------------------------

/** A titled block of the dialog: labelled rows, or preformatted lines. */
export interface Section {
  title: string
  rows?: Row[]
  lines?: string[]
}

const secs = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(2)}s`)
const n0 = (v: number): string => Math.round(v).toLocaleString("en-US")

/**
 * Largest-remainder rounding, so shares of a whole add up to exactly 100.
 * Plain rounding of 22/10/47/7/3/12-ish shares gives 101.
 */
export function percents(parts: readonly number[]): number[] {
  const total = parts.reduce((a, b) => a + b, 0)
  if (total <= 0) return parts.map(() => 0)
  const raw = parts.map((p) => (p / total) * 100)
  const floor = raw.map(Math.floor)
  let left = 100 - floor.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    floor[i] = (floor[i] as number) + 1
    left--
  }
  return floor
}

/** The turn column's sections. Widths fit a 46-cell column. */
export function turnSections(d: TurnDetail): Section[] {
  const out: Section[] = []
  if (d.time && d.totalS !== undefined) {
    const parts: Array<[string, number]> = [
      ["waiting", d.time.waiting],
      ["generating", d.time.generating],
      ["tools", d.time.tools],
      ["sub-agents", d.time.subagents],
      ["other", d.time.other],
    ]
    const shown = parts.filter(([label, v]) => v > 0 || label === "waiting" || label === "generating")
    const pct = percents(shown.map(([, v]) => v))
    out.push({
      title: `Where the time went · ${secs(d.totalS)}`,
      rows: shown.map(([label, v], i) => [label, `${secs(v).padStart(8)}  ${String(pct[i]).padStart(3)}%`] as const),
    })
  }
  if (d.steps.length > 0) {
    const lines = ["#  tokens  tok/s    ttft  tool"]
    d.steps.forEach((s, i) => {
      const tok = s.output + s.reasoning
      const rate = s.streamS && s.streamS > 0 ? (tok / s.streamS).toFixed(1) : "—"
      const ttft = s.ttftS !== undefined ? `${s.ttftS.toFixed(2)}s` : "—"
      const head = `${String(i + 1).padEnd(2)} ${n0(tok).padStart(6)}  ${rate.padStart(5)}  ${ttft.padStart(6)}  `
      const tools = s.tools.length > 0 ? s.tools : [undefined]
      tools.forEach((t, j) => {
        const tail = t
          ? `${t.name.slice(0, 9).padEnd(9)} ${t.seconds !== undefined ? secs(t.seconds) : t.status}`
          : s.finish && s.finish !== "tool-calls"
            ? `— ${s.finish}`
            : ""
        lines.push((j === 0 ? head : " ".repeat(head.length)) + tail)
      })
      if (s.retries > 0) lines.push(`${" ".repeat(3)}${s.retries} ${s.retries === 1 ? "retry" : "retries"}${s.retryReason ? `: ${s.retryReason}` : ""}`.slice(0, 46))
    })
    out.push({ title: `Steps · ${d.steps.length}`, lines })
  }
  const t = d.tokens
  const rows: Row[] = [
    ["output", n0(t.output)],
    ...(t.reasoning > 0
      ? ([["reasoning", `${n0(t.reasoning)}  (${Math.round((t.reasoning / Math.max(1, t.output + t.reasoning)) * 100)}% of output)`]] as Row[])
      : []),
    ["input", `${n0(t.input)} fresh`],
    ["", `${n0(t.cacheRead)} cache read`],
    ...(t.cacheWrite > 0 ? ([["", `${n0(t.cacheWrite)} cache write`]] as Row[]) : []),
  ]
  if (d.context) {
    rows.push([
      "context",
      d.context.limit ? `${n0(d.context.used)} / ${n0(d.context.limit)}  ${Math.round((d.context.used / d.context.limit) * 100)}%` : n0(d.context.used),
    ])
  }
  if (d.cost !== undefined) rows.push(["cost", `$${d.cost.toFixed(4)}`])
  out.push({ title: "Tokens", rows })
  if (d.engineRows.length > 0 || d.engineNote) {
    out.push({ title: `Engine · ${d.engine}`, rows: d.engineRows, lines: d.engineNote })
  }
  if (d.subagents) {
    out.push({
      title: "Sub-agents",
      rows: [
        ["count", String(d.subagents.count)],
        ["tokens", n0(d.subagents.tokens)],
        ["time", secs(d.subagents.spanS)],
        ...(d.subagents.cost !== undefined ? ([["cost", `$${d.subagents.cost.toFixed(4)}`]] as Row[]) : []),
      ],
    })
  }
  return out
}
