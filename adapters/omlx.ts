// oMLX enrichment — /api/status, differenced across the turn.
//
// oMLX publishes only RUNNING AVERAGES, not per-request figures: total
// requests, total tokens, and `avg_generation_tps` / `avg_prefill_tps` over
// every request since launch. A naive reading shows the server's lifetime
// average and never this turn.
//
// One request's rate is recoverable from an arithmetic mean, because the mean
// carries its own count:
//
//     avg_new * n_new  -  avg_prev * n_prev  =  the single new value
//
// which holds exactly when n_new - n_prev == 1. With more than one request in
// the window there is no way to separate them, so the panel falls back to the
// server average and says so rather than implying a per-turn number.
//
// Requires an API key: /api/status is authenticated, and without one this
// adapter cannot report at all.
//
// Split out of tui.tsx so the recovery arithmetic and the fallback are
// testable — it was the last adapter whose formatting nothing could assert
// against, which is the gap that hid two earlier bugs.

import { httpJson, type HttpOptions } from "../http"
import { nn, ni, short } from "../format"

/** Cumulative counters as this plugin reads them. */
export interface OmlxSample {
  requests: number
  prompt: number
  completion: number
  cached: number
  avgGen: number
  avgPrefill: number
  model?: string
}

/** The fields this plugin reads from oMLX's `/api/status`. */
export interface OmlxStatus {
  total_requests?: number
  total_prompt_tokens?: number
  total_completion_tokens?: number
  total_cached_tokens?: number
  avg_generation_tps?: number
  avg_prefill_tps?: number
  loaded_models?: string[]
  default_model?: string
}

export function toOmlxSample(j: OmlxStatus): OmlxSample {
  return {
    requests: j.total_requests ?? 0,
    prompt: j.total_prompt_tokens ?? 0,
    completion: j.total_completion_tokens ?? 0,
    cached: j.total_cached_tokens ?? 0,
    avgGen: j.avg_generation_tps ?? 0,
    avgPrefill: j.avg_prefill_tps ?? 0,
    model: j.loaded_models?.[0] ?? j.default_model,
  }
}

/**
 * Recovers the value contributed by a single new observation to a running
 * mean. Returns undefined unless exactly one request landed, or if the result
 * is not a positive number — a mean that moved backwards, or counters that
 * were reset, cannot be attributed to this turn.
 */
export function recoverLatest(
  prevAvg: number,
  prevCount: number,
  nowAvg: number,
  nowCount: number
): number | undefined {
  if (nowCount - prevCount !== 1) return undefined
  const value = nowAvg * nowCount - prevAvg * prevCount
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Renders the panel block. With no baseline, a model switch, or no new
 * request, it shows the server's lifetime averages LABELLED as such; there is
 * no honest per-turn figure to give in those cases.
 */
export function formatOmlxLine(now: OmlxSample, prev: OmlxSample | undefined): string {
  const header = `oMLX  ${short(now.model ?? "")}`

  if (!prev || prev.model !== now.model || now.requests <= prev.requests) {
    return [
      header,
      `${nn(now.avgGen)} tok/s (server avg)`,
      `prefill ${ni(now.avgPrefill)} tok/s (avg)`,
    ].join("\n")
  }

  // More than one request landed in the window (an agentic turn issuing
  // several tool round trips, same as Splash's `requests > 1` case): recovery
  // needs exactly one, so it falls back to the raw current field. Unlike the
  // no-baseline branch, that field is not merely unattributed — it is the
  // server's FULL LIFETIME average, unwindowed, across every request since
  // launch, not just the ones in this turn. Reusing the "(avg)" suffix the
  // no-baseline branch already uses says so, matching the same vocabulary
  // `diffPromSamples`'s ttftExact uses elsewhere in this codebase for the
  // identical situation. The token counts stay unlabelled deliberately: those
  // ARE exact deltas for this window, verified against real captures
  // (fixtures/omlx-after-two.json: 220-100=120 completion, 45-17=28 prompt,
  // matching the two requests' own usage exactly) — only the rate is unmoored
  // from the window.
  const recoveredDecode = recoverLatest(prev.avgGen, prev.requests, now.avgGen, now.requests)
  const recoveredPrefill = recoverLatest(prev.avgPrefill, prev.requests, now.avgPrefill, now.requests)
  const decodeLabel = recoveredDecode === undefined ? " (avg)" : ""
  const prefillLabel = recoveredPrefill === undefined ? " (avg)" : ""
  const decode = recoveredDecode ?? now.avgGen
  const prefill = recoveredPrefill ?? now.avgPrefill

  const completion = now.completion - prev.completion
  const promptTokens = now.prompt - prev.prompt
  const cached = now.cached - prev.cached

  return [
    header,
    `${nn(decode)} tok/s${decodeLabel}`,
    `prefill ${ni(prefill)} tok/s${prefillLabel}`,
    `${ni(completion)} tok  (${ni(promptTokens)} prompt${cached > 0 ? `, ${ni(cached)} cached` : ""})`,
  ].join("\n")
}

export async function fetchOmlxSample(
  base: string,
  apiKey: string,
  http: HttpOptions
): Promise<OmlxSample | null> {
  if (!apiKey) return null // /api/status is authenticated; nothing to read without it
  const j = (await httpJson(`${base}/api/status`, {
    ...http,
    headers: { ...http.headers, authorization: `Bearer ${apiKey}` },
  })) as OmlxStatus | null
  return j ? toOmlxSample(j) : null
}
