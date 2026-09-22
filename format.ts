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

export function short(model: string): string {
  const tail = model.split("/").pop() ?? model
  return tail.length > 24 ? tail.slice(0, 23) + "…" : tail
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
