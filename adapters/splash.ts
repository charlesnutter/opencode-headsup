// Splash enrichment — /metrics, Prometheus text.
//
// Splash (incoai/splash) is an Apple-Silicon server built around one packaged
// model. Its /metrics is always on (no flag) and is the richest surface of any
// engine here: it publishes cumulative TOKEN and WALL-TIME counters for BOTH
// phases, so differencing a turn gives prefill and decode rates that are the
// engine's own measurements rather than anything derived from the caller's
// clock. It also counts speculative drafting and prefix-cache reuse.
//
// Its counters are plain `splash_*` names with no labels and no histograms,
// so PromSpec (prometheus.ts) does not fit: that shape expects `_sum`/`_count`
// histogram pairs, and Splash exposes percentile GAUGES plus millisecond
// totals instead. Hence a small module of its own, reusing only the line
// parser.
//
// No JSX/solid-js imports, so it stays unit-testable (test/splash.test.mjs).

import { sumLabeledMetric } from "../prometheus-text"
import { httpText, type HttpOptions } from "../http"
import { nn, ni, short } from "../format"

/**
 * Names verified against the server's own metrics.py (Splash 1.0), which maps
 * each to a path in the native status object.
 *
 * Wall times are MILLISECOND totals, not seconds and not histogram sums — the
 * one thing most likely to be misread here.
 */
const M = {
  requestsCompleted: "splash_requests_completed_total",
  decodeTokens: "splash_decode_output_tokens_total",
  decodeWallMs: "splash_decode_wall_milliseconds_total",
  prefillTokens: "splash_prefill_input_tokens_total",
  prefillWallMs: "splash_prefill_wall_milliseconds_total",
  cacheReusedTokens: "splash_cache_reused_tokens_total",
  draftedTokens: "splash_drafted_tokens_total",
  acceptedDraftTokens: "splash_accepted_draft_tokens_total",
} as const

export interface SplashSample {
  requestsCompleted: number
  decodeTokens: number
  decodeWallMs: number
  prefillTokens: number
  prefillWallMs: number
  cacheReusedTokens: number
  draftedTokens: number
  acceptedDraftTokens: number
}

export interface SplashTurn {
  /**
   * Tokens Splash counted as decoded in this window.
   *
   * Measured equal to the response's `completion_tokens` in every live turn
   * captured here (166, then 200 twice), reasoning tokens included. Splash's
   * per-request metrics_dict does subtract `first_token_batch_tokens` — a
   * leading speculative block generated before TTFT — but this cumulative
   * counter does not, so it tracks usage directly.
   */
  completionTokens: number
  /**
   * Prompt tokens actually PREFILLED, i.e. recomputed — not the whole prompt.
   * Tokens served from the prefix cache are counted separately in
   * `cachedTokens`, and the two sum to the response's `usage.prompt_tokens`
   * (measured: 31 prefilled + 32 cached == 63 reported; and 63 + 0 == 63 on a
   * cold prompt). This is what makes `prefillTokS` honest here — it divides
   * recomputed tokens by the time spent recomputing them, where an engine
   * that divided the FULL prompt by that same time would overstate the rate
   * on every cache hit.
   */
  promptTokens: number
  /** Engine-timed decode phase, excluding prefill. */
  decodeTokS?: number
  /** Engine-timed prefill phase — few engines here can produce this at all. */
  prefillTokS?: number
  decodeS: number
  prefillS: number
  /** Prompt tokens served from the prefix cache rather than recomputed. */
  cachedTokens: number
  /** Share of speculative draft tokens the target model accepted. */
  draftAcceptRate?: number
  /**
   * Requests Splash completed in this window — normally 1, so every figure
   * here describes that one request.
   *
   * It is not always 1: an OpenCode turn that calls tools issues a request per
   * round trip, and all of them land between two samples. The figures are then
   * sums over the turn (and the rates are its aggregate rates), which is still
   * this turn and never the session, but is worth showing so a large token
   * count is not misread as one enormous reply.
   */
  requests: number
}

export function parseSplashSample(text: string): SplashSample | null {
  // Every Splash metric carries this prefix; its absence means some other
  // server is answering on this port.
  if (!text.includes("splash_")) return null
  const g = (name: string) => sumLabeledMetric(text, name)
  return {
    requestsCompleted: g(M.requestsCompleted),
    decodeTokens: g(M.decodeTokens),
    decodeWallMs: g(M.decodeWallMs),
    prefillTokens: g(M.prefillTokens),
    prefillWallMs: g(M.prefillWallMs),
    cacheReusedTokens: g(M.cacheReusedTokens),
    draftedTokens: g(M.draftedTokens),
    acceptedDraftTokens: g(M.acceptedDraftTokens),
  }
}

/**
 * Smallest phase duration whose rate is worth reporting. Guards against a
 * near-zero denominator producing an absurd rate — the same failure the
 * KoboldCpp and SGLang adapters each hit for their own reasons.
 */
const MIN_PHASE_SECONDS = 0.005

export function diffSplashSamples(prev: SplashSample, now: SplashSample): SplashTurn | null {
  // A restart zeroes the counters; anything running backwards is not a turn.
  if (now.requestsCompleted < prev.requestsCompleted || now.decodeTokens < prev.decodeTokens) return null
  // No completed request in this window: the turn was served entirely from
  // cache, or another client's request is what moved the counters.
  if (now.requestsCompleted - prev.requestsCompleted <= 0) return null

  const completionTokens = now.decodeTokens - prev.decodeTokens
  if (completionTokens <= 0) return null
  const promptTokens = now.prefillTokens - prev.prefillTokens

  const decodeS = (now.decodeWallMs - prev.decodeWallMs) / 1000
  const prefillS = (now.prefillWallMs - prev.prefillWallMs) / 1000

  const decodeTokS = decodeS >= MIN_PHASE_SECONDS ? completionTokens / decodeS : undefined
  const prefillTokS =
    prefillS >= MIN_PHASE_SECONDS && promptTokens > 0 ? promptTokens / prefillS : undefined

  const drafted = now.draftedTokens - prev.draftedTokens
  const accepted = now.acceptedDraftTokens - prev.acceptedDraftTokens
  // Both stay flat when speculation is off, which must not read as "0%".
  const draftAcceptRate = drafted > 0 ? accepted / drafted : undefined

  return {
    requests: now.requestsCompleted - prev.requestsCompleted,
    completionTokens,
    promptTokens,
    decodeTokS,
    prefillTokS,
    decodeS,
    prefillS,
    cachedTokens: Math.max(0, now.cacheReusedTokens - prev.cacheReusedTokens),
    draftAcceptRate,
  }
}

export async function fetchSplashSample(
  base: string,
  opts?: HttpOptions
): Promise<SplashSample | null> {
  const text = await httpText(`${base}/metrics`, opts)
  return text === null ? null : parseSplashSample(text)
}

/**
 * Splash draws the fullest line of any engine here: both phases are
 * engine-timed, and prefix-cache reuse and speculative drafting are counted
 * separately.
 *
 * Extracted from the v1 entry file, where it lived inline and was therefore
 * untested — the same blind spot that hid two shipped bugs. `promptTokens` is
 * what was recomputed and `cachedTokens` what the cache served; showing both
 * is the honest reading, because Splash's prefill counter deliberately
 * excludes cache hits.
 */
/**
 * `hostTtft` is OpenCode's own time-to-first-token, in seconds, passed in by
 * the caller -- this engine reports none. It is rendered `(host)` rather than
 * as a bare `ttft` because it is NOT the same measurement an engine-reported
 * one would be: it spans queue, network and TUI event delivery as well as
 * prefill, where an engine stamps from the request reaching it. Same word,
 * different span, so it says which.
 */
/**
 * Whether a window is this turn's: as many requests as the turn had steps
 * (one request per step), and the window's tokens equal to OpenCode's own
 * count for the turn. `splash opencode` routes OpenCode's title and
 * compaction requests to Splash, so a spare request is the expected way
 * this fails. A host token count of 0 or absent skips the token check.
 */
export function splashIsThisTurn(t: SplashTurn, host: { tokens?: number; steps?: number }): boolean {
  if (t.requests !== (host.steps ?? 1)) return false
  return host.tokens === undefined || host.tokens <= 0 || t.completionTokens === host.tokens
}

/**
 * `host.total` is the turn's total from OpenCode -- what the user waited,
 * retries included -- and wins over the engine's phase times. `host.steps`
 * set means the window was checked against the turn's steps, so its
 * requests are all accounted for and need no "requests this turn" note.
 */
export function formatSplashLine(
  t: SplashTurn,
  model: string,
  hostTtft?: number,
  host: { total?: number; retries?: number; steps?: number } = {}
): string {
  // Host-derived, and labelled as such. No derived figure on this line takes
  // its numerator from one source and its denominator from the other -- ttft
  // is measured directly, so nothing crosses the seam.
  const ttftLabel = hostTtft !== undefined ? `  ttft ${nn(hostTtft, 2)}s (host)` : ""
  const prompt = t.promptTokens + t.cachedTokens
  return [
    `Splash  ${short(model)}`,
    t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s${ttftLabel}` : ttftLabel.trim(),
    t.prefillTokS !== undefined ? `prefill ${ni(t.prefillTokS)} tok/s` : "",
    `${ni(t.completionTokens)} tok  ${nn(host.total ?? t.prefillS + t.decodeS, 2)}s${
      (host.retries ?? 0) > 0 ? ` (${host.retries} ${host.retries === 1 ? "retry" : "retries"})` : ""
    }`,
    `${ni(prompt)} prompt${t.cachedTokens > 0 ? `, ${ni(t.cachedTokens)} cached` : ""}`,
    t.draftAcceptRate !== undefined ? `draft ${ni(t.draftAcceptRate * 100)}% accepted` : "",
    // Only when a turn spanned several requests (tool round trips), so the
    // figures above read as sums rather than as one reply.
    t.requests > 1 && host.steps === undefined ? `${ni(t.requests)} requests this turn` : "",
  ]
    .filter(Boolean)
    .join("\n")
}
