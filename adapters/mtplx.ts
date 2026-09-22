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
export function formatMtplxLine(l: MtplxLatest, model: string): string {
  const decode = num(l.decode_tok_s)
  const ttft = num(l.ttft_s)
  const prefill = num(l.prefill_tok_s)
  const completion = num(l.completion_tokens)
  const elapsed = num(l.request_elapsed_s)
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
      ? `${ni(completion)} tok${elapsed !== undefined ? `  ${nn(elapsed, 2)}s` : ""}`
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
