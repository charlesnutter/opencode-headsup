// MTPLX enrichment — /metrics, the `latest` request receipt.
//
// MTPLX answers /metrics with JSON, not Prometheus text, and its `latest` key
// is the previous request already reduced — several hundred fields covering
// scheduler internals, of which a handful reach the panel.
//
// Unlike every other adapter, each of those fields is OPTIONAL, and they go
// missing in a way that matters: on an INTERRUPTED turn the receipt still
// carries decode rate and token count, but `ttft_s` and `prefill_tok_s` are
// absent. Rendering those unguarded produced "ttft ?s" and "prefill ? tok/s"
// in the sidebar — a placeholder where a measurement should be, which is the
// opposite of the rule that a figure we cannot defend is not shown at all.
//
// Split out of tui.tsx so the formatting is testable; it was the last adapter
// whose output nothing could assert against.

import { httpJson, type HttpOptions } from "../http"
import { nn, ni, short } from "../format"

/**
 * The fields this plugin reads. All optional — see the note above about
 * interrupted turns, which is why every one is guarded before rendering.
 */
export interface MtplxLatest {
  decode_tok_s?: number | null
  prefill_tok_s?: number | null
  ttft_s?: number | null
  completion_tokens?: number | null
  request_elapsed_s?: number | null
  verify_calls?: number | null
  mean_accept_probability_by_depth?: number[] | null
}

/** Narrows to a finite number, so absent/null/NaN all collapse to undefined. */
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

/**
 * Renders the panel block, omitting any line — or any fragment of a line —
 * whose figure is missing. A shorter block is correct; a block padded with
 * "?" is not.
 */
/**
 * One turn's receipt from its steps' receipts, read one per step at each
 * `session.step.ended` (measured: `latest` equalled the step's own count at
 * that moment, 62 then 138, on a live two-step turn).
 *
 * Returns null unless every step has a receipt whose `completion_tokens`
 * equals OpenCode's own count for that step: a receipt that isn't the step's
 * -- OpenCode's title request finishing after it, another client -- declines
 * the whole turn rather than contributing to it.
 *
 * - tokens and verify passes are summed;
 * - the rate is total tokens over total decode time, so generation only;
 *   a step without a rate leaves the turn without one;
 * - ttft and prefill are the FIRST step's: the step that read the context.
 *   Later steps mostly hit the prompt cache, and a blend would be pulled
 *   around by their tiny prefills (decided 2026-09-23);
 * - per-depth acceptance is weighted by each step's verify passes;
 * - `request_elapsed_s` is dropped: a turn's total is the host's.
 */
export function combineMtplxSteps(
  steps: ReadonlyArray<{ receipt: MtplxLatest | null; hostTokens: number }>
): MtplxLatest | null {
  const first = steps[0]
  if (!first?.receipt) return null
  let tokens = 0
  let decodeS = 0
  let rated = true
  let verify = 0
  let verified = true
  const depthSum: number[] = []
  let depthWeight = 0
  for (const { receipt, hostTokens } of steps) {
    const t = num(receipt?.completion_tokens)
    if (!receipt || t === undefined || t !== hostTokens) return null
    tokens += t
    const rate = num(receipt.decode_tok_s)
    if (rate !== undefined && rate > 0) decodeS += t / rate
    else rated = false
    const v = num(receipt.verify_calls)
    if (v !== undefined) verify += v
    else verified = false
    const depths = receipt.mean_accept_probability_by_depth
    if (Array.isArray(depths) && v !== undefined && v > 0) {
      depths.forEach((d, i) => (depthSum[i] = (depthSum[i] ?? 0) + d * v))
      depthWeight += v
    }
  }
  return {
    completion_tokens: tokens,
    decode_tok_s: rated && decodeS > 0 ? tokens / decodeS : undefined,
    ttft_s: first.receipt.ttft_s,
    prefill_tok_s: first.receipt.prefill_tok_s,
    request_elapsed_s: undefined,
    verify_calls: verified ? verify : undefined,
    mean_accept_probability_by_depth: depthWeight > 0 ? depthSum.map((d) => d / depthWeight) : undefined,
  }
}

/**
 * `host.total` is the turn's total from OpenCode -- what the user waited,
 * retries included -- and wins over the receipt's `request_elapsed_s`,
 * which is one request's duration.
 */
export function formatMtplxLine(
  l: MtplxLatest,
  model: string,
  host: { total?: number; retries?: number } = {}
): string {
  const decode = num(l.decode_tok_s)
  const ttft = num(l.ttft_s)
  const prefill = num(l.prefill_tok_s)
  const completion = num(l.completion_tokens)
  const elapsed = host.total ?? num(l.request_elapsed_s)
  const r = host.retries ?? 0
  const retries = r > 0 ? ` (${r} ${r === 1 ? "retry" : "retries"})` : ""
  const verify = num(l.verify_calls)

  // Rate and TTFT share a line but are independently available: an
  // interrupted turn has the rate and not the TTFT.
  const rate = [
    decode !== undefined ? `${nn(decode)} tok/s` : "",
    ttft !== undefined ? `ttft ${nn(ttft, 2)}s` : "",
  ]
    .filter(Boolean)
    .join("  ")

  // Speculative decoding: tokens committed per verify pass, with the
  // per-depth acceptance probabilities MTPLX reports alongside.
  let mtp = ""
  if (verify !== undefined && verify > 0 && completion !== undefined) {
    const acc = Array.isArray(l.mean_accept_probability_by_depth)
      ? l.mean_accept_probability_by_depth.map((p) => Math.round(p * 100)).join("/")
      : null
    mtp = `MTP ${nn(completion / verify, 2)}x${acc ? ` ${acc}%` : ""}`
  }

  // No think/answer split: a live capture's `latest` was searched key by
  // key, nested objects included, against a turn whose own response `usage`
  // reported 23 of 64 completion tokens as reasoning, and no field anywhere
  // in the 342-key receipt held that number. /metrics does not carry it,
  // unlike the per-response `usage` block MTPLX returns from
  // /v1/chat/completions — this adapter only ever sees the former.
  // completion_tokens does follow the OpenAI convention (it already includes
  // reasoning), so the total itself is correct; only the "(N think)" subset
  // tokensLabel can render elsewhere is unavailable here.
  const totals =
    completion !== undefined
      ? `${ni(completion)} tok${elapsed !== undefined ? `  ${nn(elapsed, 2)}s${retries}` : ""}`
      : ""

  return [
    `MTPLX  ${short(model)}`,
    rate,
    prefill !== undefined ? `prefill ${ni(prefill)} tok/s` : "",
    totals,
    mtp,
  ]
    .filter(Boolean)
    .join("\n")
}

export async function fetchMtplxLatest(
  metricsUrl: string,
  opts?: HttpOptions
): Promise<MtplxLatest | null> {
  const body = (await httpJson(metricsUrl, opts)) as { latest?: MtplxLatest } | null
  return body?.latest ?? null
}
