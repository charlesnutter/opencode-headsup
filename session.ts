// The collapsible Session section: aggregates over one session's turns.
//
// Pure functions only, for the same reason as history.ts and panels.ts: the
// entry file cannot be imported by tests. Built from the history rows the
// plugin already records per turn, so it needs no data of its own.
//
// The per-turn rules carry over to the aggregate:
// - tok/s is generation only: total tokens over total streaming time, never a
//   mean of per-turn rates and never a whole-turn figure;
// - averages never mix models -- only the current model's turns count, and
//   the heading says so when some were left out;
// - an engine-only figure is averaged over the turns that have it, which are
//   the turns whose engine reading was accepted.
// OpenCode's own sidebar already shows the session's tokens, % context used
// and $ spent, so those are deliberately not repeated here.

import { nn, ni, short, money } from "./format"
import { streamOf, type TurnRecord } from "./history"
import { rowsOf, nt, type Row, type TurnView } from "./rows"

/** Recent turns shown in the generation trend. */
export const TREND_TURNS = 8

export interface SessionSummary {
  /** Turns counted: this session's, on its current model. */
  turns: number
  /** All of this session's turns, whatever the model. */
  totalTurns: number
  provider: string
  model: string
  /** Generation tok/s: total tokens over total streaming time. */
  genTokS?: number
  /** Recent turns' generation rates, oldest first. */
  trend: number[]
  ttftMedian?: number
  ttftMax?: number
  /** Cached prompt tokens over all prompt tokens. */
  cacheHit?: number
  /**
   * Shares of the counted turns' real total time; they sum to 1. `subagents`
   * is time a sub-agent was running inside the turn (its span, real time),
   * taken out of what would otherwise be `other` -- never added on top.
   */
  time?: { generating: number; waiting: number; subagents: number; other: number }
  retries: number
  engine?: { prefillTokS?: number; mtpX?: number; draftAccept?: number }
  /** Sub-agents across the counted turns: how many, their tokens and cost. */
  subagents?: { count: number; tokens: number; cost?: number }
}

export type SubagentRollup = NonNullable<TurnRecord["subagents"]>

/**
 * The sub-agents of one turn: history rows of this session's sub-agent
 * sessions (`childIDs`) that finished inside the turn (`since`..`until`,
 * epoch ms). Tokens and cost are summed; the time is the span from the
 * first one starting to the last one finishing, since sub-agents can run in
 * parallel. Undefined when none ran.
 */
export function rollupSubagents(
  history: readonly TurnRecord[],
  childIDs: readonly string[],
  since: number,
  until: number
): SubagentRollup | undefined {
  const ids = new Set(childIDs)
  const rows = history.filter(
    (t) => t.sessionID !== undefined && ids.has(t.sessionID) && t.at >= since && t.at <= until
  )
  if (rows.length === 0) return undefined
  let start = Infinity
  let end = -Infinity
  let cost = 0
  let sawCost = false
  for (const t of rows) {
    end = Math.max(end, t.at)
    start = Math.min(start, t.at - (t.totalS ?? 0) * 1000)
    if (typeof t.cost === "number" && t.cost > 0) {
      cost += t.cost
      sawCost = true
    }
  }
  return {
    count: new Set(rows.map((t) => t.sessionID)).size,
    tokens: rows.reduce((n, t) => n + t.tokens, 0),
    // Engine requests: one per step. A row from before steps existed is one.
    steps: rows.reduce((n, t) => n + (t.steps ?? 1), 0),
    spanS: (end - start) / 1000,
    cost: sawCost ? cost : undefined,
  }
}

/** The per-turn box's sub-agent rows: sums only, never a rate. */
export function subagentRows(r: SubagentRollup): Row[] {
  return rowsOf(r.count === 1 ? "sub-agent" : "sub-agents", [
    r.count === 1 ? `${nt(r.tokens)} tok` : `${ni(r.count)} · ${nt(r.tokens)} tok`,
    `${nn(r.spanS, 2)}s`,
    money(r.cost),
  ])
}

const mean = (xs: number[]): number | undefined =>
  xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/**
 * The summary for one session, from history rows (newest first, as
 * `record` keeps them). Undefined when the session has no turns yet.
 */
export function summariseSession(
  history: readonly TurnRecord[],
  sessionID: string | undefined
): SessionSummary | undefined {
  if (sessionID === undefined) return undefined
  const all = history.filter((t) => t.sessionID === sessionID)
  const latest = all[0]
  if (!latest) return undefined
  const turns = all.filter((t) => t.provider === latest.provider && t.model === latest.model)

  let tokens = 0
  let streamS = 0
  for (const t of turns) {
    const s = streamOf(t)
    if (s !== undefined) {
      tokens += t.tokens
      streamS += s
    }
  }

  const trend = turns
    .filter((t) => streamOf(t) !== undefined)
    .slice(0, TREND_TURNS)
    .map((t) => t.tokens / (streamOf(t) as number))
    .reverse()

  const ttfts = turns.map((t) => t.ttft).filter((v): v is number => v !== undefined)

  let cached = 0
  let prompt = 0
  let cacheTurns = 0
  for (const t of turns) {
    if (t.promptTokens === undefined || t.cached === undefined) continue
    cached += t.cached
    prompt += t.promptTokens + t.cached
    cacheTurns++
  }

  let gen = 0
  let wait = 0
  let sub = 0
  let total = 0
  for (const t of turns) {
    const s = streamOf(t)
    if (s === undefined || t.waitS === undefined || t.totalS === undefined || t.totalS <= 0) continue
    gen += s
    wait += t.waitS
    // The parent is waiting on a tool while a sub-agent runs, so the span
    // falls inside the turn's other time; capped so it can never exceed it.
    sub += Math.min(t.subagents?.spanS ?? 0, Math.max(0, t.totalS - s - t.waitS))
    total += t.totalS
  }
  const other = Math.max(0, total - gen - wait - sub)

  const eng = (pick: (e: NonNullable<TurnRecord["engine"]>) => number | undefined): number | undefined =>
    mean(turns.map((t) => (t.engine ? pick(t.engine) : undefined)).filter((v): v is number => v !== undefined))
  const engine = {
    prefillTokS: eng((e) => e.prefillTokS),
    mtpX: eng((e) => e.mtpX),
    draftAccept: eng((e) => e.draftAccept),
  }

  let subCount = 0
  let subTokens = 0
  let subCost = 0
  let subSawCost = false
  for (const t of turns) {
    if (!t.subagents) continue
    subCount += t.subagents.count
    subTokens += t.subagents.tokens
    if (t.subagents.cost !== undefined) {
      subCost += t.subagents.cost
      subSawCost = true
    }
  }

  return {
    turns: turns.length,
    totalTurns: all.length,
    provider: latest.provider,
    model: latest.model,
    genTokS: streamS > 0 ? tokens / streamS : undefined,
    trend,
    ttftMedian: median(ttfts),
    ttftMax: ttfts.length > 0 ? Math.max(...ttfts) : undefined,
    cacheHit: cacheTurns > 0 && prompt > 0 ? cached / prompt : undefined,
    time:
      total > 0
        ? { generating: gen / total, waiting: wait / total, subagents: sub / total, other: other / total }
        : undefined,
    retries: turns.reduce((n, t) => n + (t.retries ?? 0), 0),
    engine:
      engine.prefillTokS !== undefined || engine.mtpX !== undefined || engine.draftAccept !== undefined
        ? engine
        : undefined,
    subagents: subCount > 0 ? { count: subCount, tokens: subTokens, cost: subSawCost ? subCost : undefined } : undefined,
  }
}

const BARS = "▁▂▃▄▅▆▇█"

/** A small trend chart, scaled between the lowest and highest value. */
export function sparkline(values: readonly number[]): string {
  if (values.length < 2) return ""
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return values
    .map((v) => {
      const i = hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * (BARS.length - 1))
      return BARS[i]
    })
    .join("")
}

const pct = (v: number): string => `${ni(v * 100)}%`

/**
 * The section as a view, laid out like the per-turn box: a heading, then
 * labelled rows, one figure per line. The heading names the model and turn
 * range when the session changed model partway through; collapsed, it keeps
 * the average generation speed as its one figure.
 */
export function sessionView(s: SessionSummary): TurnView {
  const engine =
    s.turns === s.totalTurns
      ? `Session · ${ni(s.turns)} ${s.turns === 1 ? "turn" : "turns"}`
      : `Session · ${short(s.model, 14)} · ${ni(s.turns)}/${ni(s.totalTurns)}`
  const rows: Row[] = []
  if (s.genTokS !== undefined) {
    rows.push(["speed", `${nn(s.genTokS)} tok/s avg`])
    const spark = sparkline(s.trend)
    if (spark) rows.push(["trend", spark])
  }
  if (s.ttftMedian !== undefined && s.ttftMax !== undefined) {
    rows.push(
      ...(s.turns > 1
        ? rowsOf("ttft", [`${nn(s.ttftMedian, 2)}s median`, `${nn(s.ttftMax, 2)}s max`])
        : rowsOf("ttft", [`${nn(s.ttftMedian, 2)}s`]))
    )
  }
  if (s.cacheHit !== undefined) rows.push(["cache", `${pct(s.cacheHit)} hit`])
  if (s.time) {
    rows.push(
      ...rowsOf("time", [
        `${pct(s.time.generating)} generating`,
        `${pct(s.time.waiting)} waiting`,
        s.time.subagents > 0 ? `${pct(s.time.subagents)} sub-agents` : "",
        `${pct(s.time.other)} other`,
      ])
    )
  }
  if (s.engine) {
    if (s.engine.mtpX !== undefined) rows.push(["MTP", `${nn(s.engine.mtpX, 2)}x avg`])
    if (s.engine.draftAccept !== undefined) rows.push(["draft", `${pct(s.engine.draftAccept)} avg`])
    if (s.engine.prefillTokS !== undefined) rows.push(["prefill", `${ni(s.engine.prefillTokS)} tok/s avg`])
  }
  if (s.subagents) {
    rows.push(
      ...rowsOf("sub-agents", [`${ni(s.subagents.count)} · ${nt(s.subagents.tokens)} tok`, money(s.subagents.cost)])
    )
  }
  if (s.retries > 0) rows.push(["retries", ni(s.retries)])
  return { engine, rows, notes: [], key: s.genTokS !== undefined ? `${nn(s.genTokS)} tok/s` : undefined }
}

// ---- the details dialog's session tab -------------------------------------------

/** The session's figures for the details dialog, as data; dialog.ts lays them out. */
export interface SessionFigures {
  summary: SessionSummary
  turns: number
  steps: number
  toolCalls: number
  elapsedS: number
  cost?: number
  /** Per-turn generation rates, newest first. */
  rates: number[]
  ttfts: number[]
  /** Seconds, over the turns that recorded every part. */
  time?: { waiting: number; generating: number; tools: number; subagents: number; compaction: number; other: number; total: number }
  /** Per tool name, most time first. */
  tools: Array<{ name: string; s: number; n: number }>
  tokens: { output: number; reasoning: number; input?: number; cacheRead?: number; cacheWrite: number }
  retryReasons: Array<{ reason: string; n: number }>
  coverage: { engine: number; total: number; without: Array<{ label: string; n: number }> }
}

/** The value at fraction `q` of the values (nearest rank). */
export function quantile(xs: readonly number[], q: number): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

/** Why a turn has no engine figures, in words. */
export const SKIP_LABEL: Record<NonNullable<TurnRecord["skip"]>, string> = {
  baseline: "first turn, no baseline",
  overlap: "overlapping requests",
  compaction: "compaction",
  unfinished: "interrupted or failed",
  "no-adapter": "no engine telemetry",
  unavailable: "engine unreachable",
}

/**
 * The session's figures: the Session box's spread out, the time in seconds,
 * tools by time, retries by reason, and how many turns had the engine's own
 * figures. Only the current model's turns, like the box. A figure from a
 * field older history rows lack is left out, not guessed.
 */
export function sessionFigures(history: readonly TurnRecord[], sessionID: string | undefined): SessionFigures | undefined {
  const summary = summariseSession(history, sessionID)
  if (!summary) return undefined
  const turns = history.filter((t) => t.sessionID === sessionID && t.provider === summary.provider && t.model === summary.model)
  const sum = (f: (t: TurnRecord) => number | undefined): number => turns.reduce((a, t) => a + (f(t) ?? 0), 0)

  let gen = 0
  let wait = 0
  let tools = 0
  let sub = 0
  let comp = 0
  let total = 0
  for (const t of turns) {
    const w = streamOf(t)
    if (w === undefined || t.waitS === undefined || t.totalS === undefined || t.totalS <= 0) continue
    gen += w
    wait += t.waitS
    tools += t.toolsS ?? 0
    sub += Math.min(t.subagents?.spanS ?? 0, Math.max(0, t.totalS - w - t.waitS - (t.toolsS ?? 0)))
    comp += t.compactionS ?? 0
    total += t.totalS
  }

  const byTool = new Map<string, { s: number; n: number }>()
  for (const t of turns) {
    for (const [name, x] of Object.entries(t.tools ?? {})) {
      const cur = byTool.get(name) ?? { s: 0, n: 0 }
      cur.s += x.s
      cur.n += x.n
      byTool.set(name, cur)
    }
  }
  const reasons = new Map<string, number>()
  for (const t of turns) for (const r of t.retryReasons ?? []) reasons.set(r, (reasons.get(r) ?? 0) + 1)
  const why = new Map<string, number>()
  for (const t of turns) {
    if (t.source === "engine") continue
    const label = t.skip ? SKIP_LABEL[t.skip] : "reason not recorded"
    why.set(label, (why.get(label) ?? 0) + 1)
  }
  const reasoning = sum((t) => t.reasoning)
  const cost = sum((t) => t.cost)

  return {
    summary,
    turns: turns.length,
    steps: sum((t) => t.steps ?? 1),
    toolCalls: [...byTool.values()].reduce((a, x) => a + x.n, 0),
    elapsedS: sum((t) => t.totalS),
    cost: cost > 0 ? cost : undefined,
    rates: turns.flatMap((t) => {
      const w = streamOf(t)
      return w !== undefined ? [t.tokens / w] : []
    }),
    ttfts: turns.flatMap((t) => (t.ttft !== undefined ? [t.ttft] : [])),
    time:
      total > 0
        ? { waiting: wait, generating: gen, tools, subagents: sub, compaction: comp, other: Math.max(0, total - wait - gen - tools - sub - comp), total }
        : undefined,
    tools: [...byTool.entries()].map(([name, x]) => ({ name, ...x })).sort((a, b) => b.s - a.s),
    tokens: {
      output: sum((t) => t.tokens) - reasoning,
      reasoning,
      input: turns.some((t) => t.promptTokens !== undefined) ? sum((t) => t.promptTokens) : undefined,
      cacheRead: turns.some((t) => t.cached !== undefined) ? sum((t) => t.cached) : undefined,
      cacheWrite: sum((t) => t.cacheWrite),
    },
    retryReasons: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    coverage: {
      engine: turns.filter((t) => t.source === "engine").length,
      total: turns.length,
      without: [...why.entries()].map(([label, n]) => ({ label, n })),
    },
  }
}
