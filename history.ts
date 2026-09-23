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
  /** Mean of the per-turn decode rates — whole-turn rates are excluded,
   *  because averaging the two together would compare different windows. */
  meanDecodeTokS?: number
  /** How many rows came from an engine rather than from the host. */
  engineRows: number
}

export function summarise(turns: readonly TurnRecord[]): Summary {
  let tokens = 0
  let cost = 0
  let sawCost = false
  let rateSum = 0
  let rateCount = 0
  let engineRows = 0

  for (const t of turns) {
    tokens += t.tokens
    if (typeof t.cost === "number" && t.cost > 0) {
      cost += t.cost
      sawCost = true
    }
    // Only decode rates. Mixing in a whole-turn rate would average two
    // different measurements into one meaningless number.
    if (t.rate !== undefined && t.rateWindow !== "whole") {
      rateSum += t.rate
      rateCount++
    }
    if (t.source === "engine") engineRows++
  }

  return {
    turns: turns.length,
    tokens,
    cost: sawCost ? cost : undefined,
    meanDecodeTokS: rateCount > 0 ? rateSum / rateCount : undefined,
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
  ].filter(Boolean)
  // A leading marker rather than a column, so a row is readable at any width.
  const mark = t.source === "engine" ? "*" : " "
  return `${mark}${clock(t.at)}  ${short(t.model, modelWidth).padEnd(modelWidth)}  ${[rate, ...parts]
    .filter(Boolean)
    .join("  ")}`.trimEnd()
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
 * The whole panel body: a summary, then the rows.
 *
 * `*` marks a row whose sidebar line came from the serving engine's own
 * metrics. The row itself is OpenCode's figures either way, which the legend
 * says, because an earlier wording claimed the row was engine-measured.
 * The legend is only printed when the distinction actually appears in the
 * window, because a legend for something absent is noise.
 */
export function formatHistory(turns: readonly TurnRecord[], modelWidth = 18): string {
  if (turns.length === 0) {
    return "No turns recorded yet."
  }
  const s = summarise(turns)
  const head = [
    `${ni(s.turns)} turns`,
    `${ni(s.tokens)} tok`,
    s.meanDecodeTokS !== undefined ? `${nn(s.meanDecodeTokS)} tok/s mean` : "",
    money(s.cost),
  ]
    .filter(Boolean)
    .join("  ·  ")

  const rows = turns.map((t) => formatRow(t, modelWidth))
  const mixed = s.engineRows > 0 && s.engineRows < turns.length
  const legend = mixed ? ["", "* sidebar used engine telemetry; rows are OpenCode's figures"] : []
  return [head, "", ...rows, ...legend].join("\n")
}
