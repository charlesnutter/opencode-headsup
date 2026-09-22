// KoboldCpp enrichment — /api/extra/perf.
//
// A different shape from every other engine here. Prometheus engines publish
// cumulative counters that have to be differenced across a turn boundary;
// KoboldCpp instead reports the LAST request outright, already reduced, and
// times prefill and decode as separate phases. That makes it the richest
// surface of any engine in this plugin after LMDeploy — and the only one where
// the rates need no arithmetic from us at all.
//
// It also matters more here than elsewhere: KoboldCpp's OpenAI-compatible
// streaming emits no usage chunk, so the universal layer never sees token
// counts for a streamed turn. Without this endpoint there are no token numbers
// to show.
//
// No JSX/solid-js imports, so it stays unit-testable (test/koboldcpp.test.mjs)
// without the TUI runtime.

import { httpJson, type HttpOptions } from "../http"
import { nn, ni, short } from "../format"
/**
 * The fields of /api/extra/perf this plugin reads. The endpoint returns more
 * (image/TTS/transcription counters, horde bookkeeping, seeds) that describe
 * subsystems this plugin does not surface.
 *
 * Field semantics, established against a live v1.121 server rather than docs:
 *   last_process / last_eval        milliseconds PER TOKEN
 *   last_process_time / _eval_time  total seconds for that phase
 *   last_process_speed / _eval_speed  tokens per second
 * The three are redundant: speed == 1000 / ms_per_token == count / time. A
 * capture showed last_eval 4.6111 ms/tok, last_eval_time 0.083s over 18
 * tokens, last_eval_speed 216.867 — all three agree exactly.
 */
export interface KoboldPerf {
  last_input_count: number
  last_token_count: number
  last_process_time: number
  last_eval_time: number
  last_process_speed: number
  last_eval_speed: number
  last_draft_success: number
  last_draft_failed: number
  total_gens: number
}

/**
 * Shortest phase duration whose reported rate is trustworthy.
 *
 * The server's phase timers quantise to about 1ms: a 15-token prompt prefilled
 * in a reported 0.001s, yielding "15000 tok/s". The same server on a
 * 1216-token prompt reported 0.111s and 10955 tok/s — plausible, and the
 * difference is resolution, not speed. At 10ms the quantum is under a tenth of
 * the measurement, so the rate is worth showing; below that it is mostly an
 * artefact of the clock.
 */
const MIN_TIMED_SECONDS = 0.01

export interface KoboldTurn {
  promptTokens: number
  completionTokens: number
  /** Engine-timed decode phase, excluding prefill. */
  decodeTokS?: number
  /**
   * Engine-timed prefill phase. Dropped when the timer resolution dominates.
   *
   * Overstated on a PARTIAL prefix-cache hit, and undetectably so:
   * last_input_count counts the whole prompt while last_process_time covers
   * only the part actually recomputed. A measured example — a 1216-token
   * prompt prefilled in 0.111s, then a 2016-token superset of it in 0.112s,
   * reported as 18000 tok/s. A FULL cache hit is safe by accident: the server
   * reports process_time 0.0 and speed 0, which the floor below rejects.
   */
  prefillTokS?: number
  prefillS: number
  decodeS: number
  /** Fraction of speculative draft tokens accepted, when a draft model is in use. */
  draftAcceptRate?: number
  /**
   * How many generations landed between the previous sample and this one,
   * when known (undefined on the first turn after launch, where there is no
   * baseline to diff against).
   *
   * /api/extra/perf structurally cannot do better than this: it stores only
   * the MOST RECENT request, with no per-request history at all. If more than
   * one generation completes in a window — an agentic turn firing several
   * tool round trips is the real, reachable case, same as every other
   * multi-request adapter here — every field above describes ONLY the last
   * of them. Confirmed live: firing two generations (9 and 3 completion
   * tokens) with one poll after both reported completionTokens: 3, silently
   * dropping the first request's 9 tokens with no indication anything was
   * missed. Unlike llama.cpp's identical-in-spirit freshness gap, this one
   * IS detectable — total_gens still counts every generation even though
   * only the latest's stats survive — so the caller can and must say so.
   */
  generationsInWindow?: number
}

export function parseKoboldPerf(raw: unknown): KoboldPerf | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  // total_gens is the one field that must be present and numeric: it is how a
  // stale sample is detected, and its absence means this is not /api/extra/perf.
  if (typeof r.total_gens !== "number") return null
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    last_input_count: n(r.last_input_count),
    last_token_count: n(r.last_token_count),
    last_process_time: n(r.last_process_time),
    last_eval_time: n(r.last_eval_time),
    last_process_speed: n(r.last_process_speed),
    last_eval_speed: n(r.last_eval_speed),
    last_draft_success: n(r.last_draft_success),
    last_draft_failed: n(r.last_draft_failed),
    total_gens: n(r.total_gens),
  }
}

/**
 * Turns one perf sample into this turn's figures.
 *
 * `prevTotalGens` is the generation count seen at the end of the previous
 * turn. Because the endpoint reports only the most recent request, a sample
 * whose count has not advanced describes some earlier generation — the turn
 * was served from cache, or another client's request is what these numbers
 * belong to. Reporting it would attribute someone else's timings to this turn,
 * so it returns null and the universal line stands instead.
 */
export function koboldTurn(now: KoboldPerf, prevTotalGens: number | undefined): KoboldTurn | null {
  if (prevTotalGens !== undefined && now.total_gens <= prevTotalGens) return null
  if (now.last_token_count <= 0) return null

  const decodeTokS =
    now.last_eval_time >= MIN_TIMED_SECONDS
      ? now.last_eval_speed > 0
        ? now.last_eval_speed
        : now.last_token_count / now.last_eval_time
      : undefined

  const prefillTokS =
    now.last_process_time >= MIN_TIMED_SECONDS && now.last_input_count > 0
      ? now.last_process_speed > 0
        ? now.last_process_speed
        : now.last_input_count / now.last_process_time
      : undefined

  // Speculative decoding, when a draft model is loaded. Both counters stay 0
  // otherwise, which must not read as "0% accepted".
  const drafted = now.last_draft_success + now.last_draft_failed
  const draftAcceptRate = drafted > 0 ? now.last_draft_success / drafted : undefined

  return {
    promptTokens: now.last_input_count,
    completionTokens: now.last_token_count,
    decodeTokS,
    prefillTokS,
    prefillS: now.last_process_time,
    decodeS: now.last_eval_time,
    draftAcceptRate,
    generationsInWindow: prevTotalGens !== undefined ? now.total_gens - prevTotalGens : undefined,
  }
}

/**
 * Renders the panel block. When more than one generation landed in the
 * window, appends a note that the figures above are the LAST generation
 * only, not a sum across the window — there is nothing here to sum them
 * with, since the endpoint keeps no history beyond the most recent request.
 */
export function formatKoboldLine(t: KoboldTurn, model: string): string {
  return [
    `KoboldCpp  ${short(model)}`,
    t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s` : "",
    t.prefillTokS !== undefined ? `prefill ${ni(t.prefillTokS)} tok/s` : "",
    `${ni(t.completionTokens)} tok  ${nn(t.prefillS + t.decodeS, 2)}s`,
    t.draftAcceptRate !== undefined ? `draft ${ni(t.draftAcceptRate * 100)}% accepted` : "",
    t.generationsInWindow !== undefined && t.generationsInWindow > 1
      ? `${ni(t.generationsInWindow)} generations this turn (last shown only)`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export async function fetchKoboldPerf(
  base: string,
  opts?: HttpOptions
): Promise<KoboldPerf | null> {
  return parseKoboldPerf(await httpJson(`${base}/api/extra/perf`, opts))
}
