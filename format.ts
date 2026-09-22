// Panel formatting — how a figure is rendered, not what it means.
//
// Shared by every adapter and by Tier 1, and knows nothing about either. It
// sat inside universal.ts, which made that file both "the tier built from
// OpenCode's events" and "the formatters everyone borrows"; the three adapters
// that import from it only ever wanted this half.
//
// The rule these encode: a figure that cannot be defended is not rendered.
// `nn`/`ni` return "?" for anything non-finite, and callers are expected to
// omit the line rather than print that — MTPLX shipped "ttft ?s" to the
// sidebar for exactly this reason.

export const nn = (v: unknown, d = 1) =>
  typeof v === "number" && isFinite(v) ? v.toFixed(d) : "?"
export const ni = (v: unknown) =>
  typeof v === "number" && isFinite(v) ? String(Math.round(v)) : "?"

export function short(model: string, width = 24): string {
  const tail = model.split("/").pop() ?? model
  // `width` exists for the drill-down panel, which knows its own column
  // width; the sidebar keeps the historical 24 by default so nothing that
  // already renders changes.
  return tail.length > width ? tail.slice(0, width - 1) + "…" : tail
}


/**
 * The one place token counts are rendered, so every tier reads the same:
 * `1247 tok (889 think)` — topline is everything the model decoded, with the
 * thinking portion named as a SUBSET of it. Deliberately not `(+889 think)`,
 * which reads as an addition and invites summing 1247 + 889.
 *
 * `total` must already include `reasoning`. Sources differ on this and the
 * difference is invisible in the numbers, so each caller has to know which it
 * holds:
 *   - OpenCode's `tokens.output` EXCLUDES reasoning. Measured on a Splash
 *     Qwen3.8-27B turn: output 358 + reasoning 889 == the engine's own
 *     `output 1,247`. Callers must pass `output + reasoning`.
 *   - MTPLX's `usage.completion_tokens` INCLUDES it, per the OpenAI
 *     convention where `completion_tokens_details.reasoning_tokens` is a
 *     subset. Confirmed against four captured receipts: treating it as
 *     exclusive implies 0.54 visible chars/token, which is impossible.
 *   - Engine counters (llama.cpp `tokens_predicted_total`, Prometheus
 *     `generation_tokens_total`, KoboldCpp `last_token_count`, oMLX
 *     `total_completion_tokens`) count every decoded token and expose no
 *     reasoning split, so they pass 0 and no think figure is shown.
 */
export function tokensLabel(total: number, reasoning: number): string {
  return `${ni(total)} tok${reasoning > 0 ? ` (${ni(reasoning)} think)` : ""}`
}

/**
 * A cost in USD, at a precision that suits the magnitude.
 *
 * Turn costs here span four orders of magnitude — 0.0006 on a cheap model
 * against 0.065 on a reasoning one, both measured. A fixed 2 decimals would
 * render the first as "$0.00", which is the absent-vs-zero mistake in
 * currency form: it reads as free when it was not.
 *
 * Returns "" for a cost that is absent or genuinely zero, so the caller drops
 * the figure rather than printing "$0.00" for a free model.
 */
export function money(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return ""
  if (v >= 1) return `$${v.toFixed(2)}`
  if (v >= 0.01) return `$${v.toFixed(3)}`
  return `$${v.toFixed(4)}`
}
