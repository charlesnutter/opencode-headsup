// Per-turn history for the drill-down panel.
//
// Pure functions only — no OpenCode types, no fetching, no rendering
// primitives. The entry file cannot be imported by tests, so anything with
// logic in it lives here instead. That rule exists because both bugs that
// reached the v1 panel hid in exactly that blind spot.
//
// The competing plugins that keep history do it by appending JSONL to a file.
// This is held in `ctx.storage.store()` instead: durable across restarts and
// live-synced across TUI instances, which a file is not.

import { nn, ni, money, short } from "./format"

/**
 * Which tier drew the sidebar line for this turn. NOT the provenance of the
 * row's own figures: every row is built from OpenCode's figures (`info.tokens`
 * and `turnRate`) whatever tier rendered the line, and no engine figure is
 * ever recorded. The marker says where the panel's live line came from, which
 * explains why a row can differ from what the sidebar showed.
 */
export type Source = "engine" | "host"

export interface TurnRecord {
  /** Wall clock at completion, for ordering and display. */
  at: number
  provider: string
  model: string
  /** Decoded tokens: visible output plus reasoning, which are also decoded. */
  tokens: number
  /** Subset of `tokens` that was reasoning, when the provider reports it. */
  reasoning?: number
  /** Tokens/sec, over whichever window `rateWindow` names. */
  rate?: number
  /** Which window `rate` measured. A whole-turn rate is not a decode rate. */
  rateWindow?: "decode" | "whole"
  /**
   * The OpenCode session this turn belongs to. A glance figure must describe
   * the session being looked at: `history` is durable and survives a TUI
   * restart, so without this the collapsed line reported the last turn of a
   * PREVIOUS session -- a real figure, but not one describing anything on
   * screen, and possibly a different model entirely.
   */
  sessionID?: string
  ttft?: number
  /**
   * Which tier `ttft` came from. Always "host" today, like every figure in
   * the row; kept so a future row that records an engine figure can say so
   * per figure rather than per row.
   */
  ttftSource?: Source
  /** Whole-turn duration in seconds. */
  totalS?: number
  /** This turn's cost in USD. Never a running session total. */
  cost?: number
  /** Prompt tokens served from cache rather than recomputed. */
  cached?: number
  source: Source
  /** Prompt tokens NOT served from cache, summed over the turn's steps. */
  promptTokens?: number
  /** Time spent streaming after each step's first token, summed (seconds). */
  streamS?: number
  /** Time spent waiting for each step's first token, summed (seconds). */
  waitS?: number
  /** Retries OpenCode made across the turn. */
  retries?: number
  /** Model requests in the turn: one per step. */
  steps?: number
  /**
   * Engine-only figures, recorded only when the engine's reading for this
   * turn was accepted -- so a session average of them covers only such
   * turns. Every other figure in the row is OpenCode's own.
   */
  /**
   * Sub-agents that ran during this turn, each in its own child session:
   * their summed tokens and cost, and the span they ran (they can run in
   * parallel, so not a sum). Rates are never combined across them.
   */
  subagents?: { count: number; tokens: number; spanS: number; cost?: number; steps?: number }
  /** Set when the reply did not finish: stopped by the user, or failed. */
  outcome?: "interrupted" | "failed"
  engine?: {
    prefillTokS?: number
    /** Tokens committed per verify pass (MTPLX's multi-token prediction). */
    mtpX?: number
    /** Share of speculative draft tokens accepted (KoboldCpp, Splash). */
    draftAccept?: number
  }
}

export interface History {
  turns: TurnRecord[]
}

/**
 * Newest first, bounded.
 *
 * Bounded because this store is durable: it survives TUI restarts, so an
 * unbounded append grows forever across weeks. 200 turns is far more than a
 * panel can show and still small enough to keep in a JSON document.
 */
export const HISTORY_CAP = 200

export function record(h: History, t: TurnRecord, cap: number = HISTORY_CAP): History {
  return { turns: [t, ...h.turns].slice(0, cap) }
}

/** What a session adds up to. Only sums figures that are actually present. */
export interface Summary {
  turns: number
  tokens: number
  /** Total cost, or undefined when no turn in the window had one at all. */
  cost?: number
  /**
   * Generation tok/s on the newest turn's model: its turns' tokens over
   * their streaming time, the Session box's rule. Never a mean of per-turn
   * rates, never a whole-turn rate, and never across two models.
   */
  genTokS?: number
  /** The model `genTokS` is for. */
  genModel?: string
  /** How many rows came from an engine rather than from the host. */
  engineRows: number
}

/** A turn's streaming time: recorded, or derived from an older row's rate. */
export function streamOf(t: TurnRecord): number | undefined {
  // A reply that did not finish has no tokens recorded for its last step, so
  // its tokens over its streaming time would understate the speed (measured:
  // an interrupted turn, 0 tokens over 6s of streaming, halved a session's
  // average). It counts toward nothing that divides by streaming time.
  if (t.outcome) return undefined
  if (t.streamS !== undefined && t.streamS > 0) return t.streamS
  // Rows recorded before streamS existed carry a generation rate whose
  // window is tokens / rate. A whole-turn rate is not generation, so no.
  if (t.rate !== undefined && t.rate > 0 && t.rateWindow !== "whole") return t.tokens / t.rate
  return undefined
}

export function summarise(turns: readonly TurnRecord[]): Summary {
  let tokens = 0
  let cost = 0
  let sawCost = false
  let genTokens = 0
  let streamS = 0
  let engineRows = 0
  const model = turns[0]?.model

  for (const t of turns) {
    tokens += t.tokens
    if (typeof t.cost === "number" && t.cost > 0) {
      cost += t.cost
      sawCost = true
    }
    const s = streamOf(t)
    if (t.model === model && s !== undefined) {
      genTokens += t.tokens
      streamS += s
    }
    if (t.source === "engine") engineRows++
  }

  return {
    turns: turns.length,
    tokens,
    cost: sawCost ? cost : undefined,
    genTokS: streamS > 0 ? genTokens / streamS : undefined,
    genModel: streamS > 0 ? model : undefined,
    engineRows,
  }
}

function clock(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** One row. `·` separates figures so an absent one leaves no empty column. */
export function formatRow(t: TurnRecord, modelWidth = 18): string {
  const rate =
    t.rate !== undefined
      ? `${nn(t.rate)} tok/s${t.rateWindow === "whole" ? " overall" : ""}`
      : ""
  const parts = [
    `${ni(t.tokens)} tok`,
    t.totalS !== undefined ? `${nn(t.totalS, 1)}s` : "",
    t.ttft !== undefined ? `ttft ${nn(t.ttft, 2)}s` : "",
    money(t.cost),
    t.cached !== undefined && t.cached > 0 ? `${ni(t.cached)} cached` : "",
    t.outcome ?? "",
  ].filter(Boolean)
  // A leading marker rather than a column, so a row is readable at any width.
  const mark = t.source === "engine" ? "*" : " "
  return `${mark}${clock(t.at)}  ${short(t.model, modelWidth).padEnd(modelWidth)}  ${[rate, ...parts]
    .filter(Boolean)
    .join("  ")}`.trimEnd()
}

/**
 * The newest recorded turn for one session. `turns` is newest first. With
 * several tabs open, the newest turn overall is often another tab's, so the
 * collapsed line must look up its own session's rather than take `turns[0]`.
 */
export function latestFor(
  turns: readonly TurnRecord[],
  sessionID: string | undefined
): TurnRecord | undefined {
  if (sessionID === undefined) return undefined
  return turns.find((t) => t.sessionID === sessionID)
}

/**
 * The collapsed sidebar line. One glance figure plus an affordance, not
 * nothing — collapsing to bare "view metrics" with no number defeats the
 * point of a glanceable panel. Derived from the most recent recorded turn
 * rather than from whatever string the caller last rendered, so this stays
 * correct even if the panel's own format changes.
 */
export function formatCollapsedLine(
  latest: TurnRecord | undefined,
  sessionID?: string
): string {
  // No figure unless the newest turn is one from THIS session. Showing a
  // stale rate beside "view metrics" reads as current, and a durable store
  // means the newest record can be hours and several models old.
  if (!latest || latest.sessionID !== sessionID) return "▸ view metrics"
  const rate =
    latest.rate !== undefined
      ? `${nn(latest.rate)} tok/s${latest.rateWindow === "whole" ? " overall" : ""}`
      : ""
  return ["▸ view metrics", rate].filter(Boolean).join("  ·  ")
}

/**
 * The whole panel body, one entry per line: a summary, then the rows. Each
 * line is drawn unwrapped and cut at the panel's edge, so a row's figures run
 * most important first -- what a narrow panel loses is the tail.
 *
 * `*` marks a row whose sidebar line came from the serving engine's own
 * metrics. The row itself is OpenCode's figures either way, which the legend
 * says, because an earlier wording claimed the row was engine-measured.
 * The legend is only printed when the distinction actually appears in the
 * window, because a legend for something absent is noise.
 */
export function historyLines(turns: readonly TurnRecord[], modelWidth = 18): string[] {
  if (turns.length === 0) {
    return ["No turns recorded yet."]
  }
  const s = summarise(turns)
  const head = [
    `${ni(s.turns)} turns`,
    `${ni(s.tokens)} tok`,
    s.genTokS !== undefined ? `${nn(s.genTokS)} tok/s avg ${short(s.genModel ?? "", modelWidth)}` : "",
    money(s.cost),
  ]
    .filter(Boolean)
    .join("  ·  ")

  const rows = turns.map((t) => formatRow(t, modelWidth))
  const mixed = s.engineRows > 0 && s.engineRows < turns.length
  const legend = mixed ? ["", "* sidebar used engine telemetry; rows are OpenCode's figures"] : []
  return [head, "", ...rows, ...legend]
}

export function formatHistory(turns: readonly TurnRecord[], modelWidth = 18): string {
  return historyLines(turns, modelWidth).join("\n")
}
