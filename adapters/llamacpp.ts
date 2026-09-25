// llama.cpp / llamafile enrichment — /metrics, differenced across the turn.
//
// llamafile is llama.cpp-derived and publishes the identical metric names, so
// one adapter serves both; only the base URL and the stored baseline differ.
//
// These counters are ATOMIC AT COMPLETION, like oMLX's and unlike vLLM's: they
// sit still while a request runs and jump once it lands (confirmed against a
// live server). So a snapshot diff across the turn boundary is exact, and the
// continuous /slots poll a live ticker would need is unnecessary — the
// universal layer already covers TTFT and a live estimate from OpenCode's own
// streaming events.
//
// Needs the server started with `--metrics`; it is off by default, and an
// unmetriced or unreachable server simply fails the fetch and falls back.
//
// On the parser: llama.cpp emits BARE `name value` lines with no labels, where
// every other engine here labels its series. That looked like it needed its
// own parser, and carried one for a while. It does not — the shared reader in
// prometheus-text.ts accepts a bare name, verified against this adapter's live
// fixtures.

import { sumLabeledMetric } from "../prometheus-text"
import { httpText, type HttpOptions } from "../http"
import { nn, ni } from "../format"
import { rowsOf, timeRows, viewText, nt, phase, type Row, type TurnView } from "../rows"

export interface LlamaCppCounters {
  promptTokens: number
  promptSeconds: number
  predictedTokens: number
  predictedSeconds: number
}

export interface LlamaCppTurn {
  completionTokens: number
  /**
   * Tokens the server actually PREFILLED. Under-reports the prompt on a cache
   * hit, because the counter advances only for what was recomputed, and
   * nothing here can correct it: llama.cpp exposes no cached-token counter,
   * and the live /slots sample that would show it needs mid-request polling.
   * The rate below is therefore honest about the work done, while the count is
   * lower than the prompt the caller sent.
   */
  promptTokens: number
  decodeTokS?: number
  prefillTokS?: number
  decodeS: number
  prefillS: number
}

export function parseLlamaCppCounters(text: string): LlamaCppCounters | null {
  // Every metric carries this prefix; without it some other server answered.
  if (!text.includes("llamacpp:")) return null
  return {
    promptTokens: sumLabeledMetric(text, "llamacpp:prompt_tokens_total"),
    promptSeconds: sumLabeledMetric(text, "llamacpp:prompt_seconds_total"),
    predictedTokens: sumLabeledMetric(text, "llamacpp:tokens_predicted_total"),
    predictedSeconds: sumLabeledMetric(text, "llamacpp:tokens_predicted_seconds_total"),
  }
}

/**
 * Returns null when there is nothing to attribute to this turn: no generated
 * token advanced the counter (answered from cache faster than we sampled, or a
 * concurrent caller's turn beat us to it) or the counters ran backwards
 * because the server restarted.
 *
 * Freshness gap, structural and undocumented until now: llama.cpp's /metrics
 * exposes no cumulative request-count field of any kind, checked directly
 * against a live server's full metric list (`n_decode_total` is a decode-STEP
 * counter close to but not equal to `predictedTokens`; `requests_processing`
 * and `requests_deferred` are point-in-time gauges of in-flight state,
 * confirmed both at 0 immediately after a completed request). Every other
 * adapter in this codebase that can land more than one request in a
 * sampling window has a total-requests-style counter to detect and label
 * that (Splash's `requests`, oMLX's `total_requests`, the Prometheus
 * engines' histogram counts via `ttftExact`). llama.cpp has nothing to key
 * such a label off — if more than one generation completes between two
 * samples, this silently sums them with no way to say so. Unlike the oMLX
 * fallback this codebase fixed, there is no server-side data to fix it with;
 * this is a known, permanent limitation of the endpoint, not an oversight.
 */
export function diffLlamaCppCounters(
  prev: LlamaCppCounters,
  now: LlamaCppCounters
): LlamaCppTurn | null {
  if (now.predictedTokens <= prev.predictedTokens) return null

  const completionTokens = now.predictedTokens - prev.predictedTokens
  const decodeS = now.predictedSeconds - prev.predictedSeconds
  const promptTokens = now.promptTokens - prev.promptTokens
  const prefillS = now.promptSeconds - prev.promptSeconds

  return {
    completionTokens,
    promptTokens,
    decodeS,
    prefillS,
    decodeTokS: decodeS > 0 ? completionTokens / decodeS : undefined,
    prefillTokS: prefillS > 0 && promptTokens > 0 ? promptTokens / prefillS : undefined,
  }
}

/** `label` distinguishes llama.cpp from llamafile, which share this adapter. */
/**
 * `hostTtft` is OpenCode's own time-to-first-token, in seconds, passed in by
 * the caller -- this engine reports none. It is rendered `(host)` rather than
 * as a bare `ttft` because it is NOT the same measurement an engine-reported
 * one would be: it spans queue, network and TUI event delivery as well as
 * prefill, where an engine stamps from the request reaching it. Same word,
 * different span, so it says which.
 */
/**
 * Whether a window is this turn's. llama.cpp has no request counter, so the
 * token count is the whole check: the window's generated tokens must equal
 * OpenCode's own count for the turn, summed over its steps. A title request,
 * another client, or an interrupted turn still generating all add tokens.
 * 0 or absent means OpenCode has no count, and the check is skipped.
 */
export function llamaCppIsThisTurn(t: LlamaCppTurn, hostTokens: number | undefined): boolean {
  return hostTokens === undefined || hostTokens <= 0 || t.completionTokens === hostTokens
}

/**
 * The turn as labelled rows under `label` (llama.cpp or llamafile).
 * `host.total` is the turn's total from OpenCode -- what the user waited,
 * retries included -- and wins over the engine's own timings. TTFT is the
 * host's, labelled: llama.cpp reports none of its own.
 * `host.includesSubagents`: the window also held same-engine sub-agents'
 * requests, so the token count covers theirs too, and says so.
 */
export function llamaCppView(
  t: LlamaCppTurn,
  label: string,
  hostTtft?: number,
  host: { total?: number; retries?: number; includesSubagents?: boolean } = {}
): TurnView {
  const rows: Row[] = [
    ...rowsOf("speed", [t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s` : ""]),
    ...rowsOf("ttft", [hostTtft !== undefined ? `${nn(hostTtft, 2)}s (host)` : ""]),
    ...rowsOf("prefill", [t.prefillTokS !== undefined ? `${ni(t.prefillTokS)} tok/s` : ""]),
    ...rowsOf("tokens", [nt(t.completionTokens), host.includesSubagents ? "incl. sub-agents" : ""]),
    ...timeRows(host.total ?? t.decodeS + t.prefillS, host.retries),
  ]
  const detail: Row[] = [
    ...rowsOf("speed", [t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s` : ""]),
    ...rowsOf("prefill", [t.prefillTokS !== undefined ? `${ni(t.prefillTokS)} tok/s` : "", phase(t.promptTokens, t.prefillS)]),
    ["decode", phase(t.completionTokens, t.decodeS)],
  ]
  return { engine: label, rows, notes: [], key: t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s` : undefined, detail }
}

/** The view as text; kept for tests that look for a figure. */
export function formatLlamaCppLine(
  t: LlamaCppTurn,
  label: string,
  _model: string,
  hostTtft?: number,
  host: { total?: number; retries?: number; includesSubagents?: boolean } = {}
): string {
  return viewText(llamaCppView(t, label, hostTtft, host))
}

export async function fetchLlamaCppCounters(
  base: string,
  opts?: HttpOptions
): Promise<LlamaCppCounters | null> {
  const text = await httpText(`${base}/metrics`, opts)
  return text === null ? null : parseLlamaCppCounters(text)
}
