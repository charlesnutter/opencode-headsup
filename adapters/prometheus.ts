// Labelled-counter engines — vLLM, SGLang, vllm-mlx, Aphrodite, LMDeploy.
//
// What each engine calls its counters, and what a turn means once they are
// differenced. Reading the text itself is prometheus-text.ts.
// No JSX, no OpenCode/solid-js imports — kept separate so it can be unit
// tested (test/prometheus.test.mjs) without pulling in the TUI runtime, which
// isn't installed locally (OpenCode provides it at load time).

import { httpText, type HttpOptions } from "../http"
import { sumLabeledMetric } from "../prometheus-text"
export interface PromSpec {
  prefix: string
  promptTokens: string
  generationTokens: string
  /** Absent on engines with no prefix/prompt-cache counter (vllm-mlx). */
  cachedTokens?: string
  ttftSum: string
  ttftCount: string
  /**
   * End-to-end request-duration histogram, where the engine publishes one.
   * With it (and a TTFT histogram) a single request's decode window can be
   * derived exactly — duration minus TTFT — instead of leaning on the
   * caller's own wall clock.
   */
  durationSum?: string
  durationCount?: string
  /**
   * Separate prefill and decode time histograms, where an engine publishes
   * them (LMDeploy). Better than duration-minus-TTFT: each phase is timed by
   * the engine directly, so both rates are its own measurement.
   */
  prefillTimeSum?: string
  prefillTimeCount?: string
  decodeTimeSum?: string
  decodeTimeCount?: string
}

export const VLLM_SPEC: PromSpec = {
  prefix: "vllm:",
  promptTokens: "vllm:prompt_tokens_total",
  generationTokens: "vllm:generation_tokens_total",
  cachedTokens: "vllm:prompt_tokens_cached_total",
  ttftSum: "vllm:time_to_first_token_seconds_sum",
  ttftCount: "vllm:time_to_first_token_seconds_count",
}

/**
 * Names verified against sglang/srt/observability/metrics_collector.py. It
 * publishes an end-to-end latency histogram alongside TTFT, so a single turn's
 * decode window is recoverable exactly (duration minus TTFT) rather than from
 * the caller's wall clock. Counters carry an `is_streaming` label, so every
 * series for a name has to be summed.
 */
export const SGLANG_SPEC: PromSpec = {
  prefix: "sglang:",
  promptTokens: "sglang:prompt_tokens_total",
  generationTokens: "sglang:generation_tokens_total",
  cachedTokens: "sglang:cached_tokens_total",
  ttftSum: "sglang:time_to_first_token_seconds_sum",
  ttftCount: "sglang:time_to_first_token_seconds_count",
  durationSum: "sglang:e2e_request_latency_seconds_sum",
  durationCount: "sglang:e2e_request_latency_seconds_count",
}

/**
 * Aphrodite is a vLLM fork and inherits its metric shape verbatim, under its
 * own prefix — so it is the same spec with `vllm:` swapped for `aphrodite:`.
 */
export const APHRODITE_SPEC: PromSpec = {
  prefix: "aphrodite:",
  promptTokens: "aphrodite:prompt_tokens_total",
  generationTokens: "aphrodite:generation_tokens_total",
  cachedTokens: "aphrodite:prompt_tokens_cached_total",
  ttftSum: "aphrodite:time_to_first_token_seconds_sum",
  ttftCount: "aphrodite:time_to_first_token_seconds_count",
}

/**
 * vllm-mlx (the MLX-native Apple Silicon server, not vllm-metal, which runs
 * upstream vLLM itself and so uses VLLM_SPEC). Underscore-prefixed
 * prometheus_client names, labelled by endpoint/stream, and — unusually — it
 * publishes BOTH a TTFT and an end-to-end duration histogram, so a single
 * turn's decode window is recoverable exactly. No prompt-cache counter.
 */
export const VLLM_MLX_SPEC: PromSpec = {
  prefix: "vllm_mlx_",
  promptTokens: "vllm_mlx_prompt_tokens_total",
  generationTokens: "vllm_mlx_completion_tokens_total",
  ttftSum: "vllm_mlx_inference_ttft_seconds_sum",
  ttftCount: "vllm_mlx_inference_ttft_seconds_count",
  durationSum: "vllm_mlx_inference_request_duration_seconds_sum",
  durationCount: "vllm_mlx_inference_request_duration_seconds_count",
}

/**
 * LMDeploy publishes the richest surface of these engines: alongside the usual
 * counters it times prefill and decode as separate histograms, so both rates
 * are engine-measured rather than derived. Needs `--enable-metrics` (off by
 * default); default port 23333. Names verified against
 * lmdeploy/metrics/loggers.py.
 */
export const LMDEPLOY_SPEC: PromSpec = {
  prefix: "lmdeploy:",
  promptTokens: "lmdeploy:prompt_tokens_total",
  generationTokens: "lmdeploy:generation_tokens_total",
  ttftSum: "lmdeploy:time_to_first_token_seconds_sum",
  ttftCount: "lmdeploy:time_to_first_token_seconds_count",
  durationSum: "lmdeploy:e2e_request_latency_seconds_sum",
  durationCount: "lmdeploy:e2e_request_latency_seconds_count",
  prefillTimeSum: "lmdeploy:request_prefill_time_seconds_sum",
  prefillTimeCount: "lmdeploy:request_prefill_time_seconds_count",
  decodeTimeSum: "lmdeploy:request_decode_time_seconds_sum",
  decodeTimeCount: "lmdeploy:request_decode_time_seconds_count",
}

export interface PromSample {
  prompt: number
  generation: number
  cached: number
  ttftSum: number
  ttftCount: number
  durationSum: number
  durationCount: number
  prefillTimeSum: number
  prefillTimeCount: number
  decodeTimeSum: number
  decodeTimeCount: number
}

export function parsePromSample(text: string, spec: PromSpec): PromSample | null {
  if (!text.includes(spec.prefix)) return null
  return {
    prompt: sumLabeledMetric(text, spec.promptTokens),
    generation: sumLabeledMetric(text, spec.generationTokens),
    cached: spec.cachedTokens ? sumLabeledMetric(text, spec.cachedTokens) : 0,
    ttftSum: sumLabeledMetric(text, spec.ttftSum),
    ttftCount: sumLabeledMetric(text, spec.ttftCount),
    durationSum: spec.durationSum ? sumLabeledMetric(text, spec.durationSum) : 0,
    durationCount: spec.durationCount ? sumLabeledMetric(text, spec.durationCount) : 0,
    prefillTimeSum: spec.prefillTimeSum ? sumLabeledMetric(text, spec.prefillTimeSum) : 0,
    prefillTimeCount: spec.prefillTimeCount ? sumLabeledMetric(text, spec.prefillTimeCount) : 0,
    decodeTimeSum: spec.decodeTimeSum ? sumLabeledMetric(text, spec.decodeTimeSum) : 0,
    decodeTimeCount: spec.decodeTimeCount ? sumLabeledMetric(text, spec.decodeTimeCount) : 0,
  }
}

export async function fetchPromSample(
  base: string,
  spec: PromSpec,
  opts?: HttpOptions
): Promise<PromSample | null> {
  const text = await httpText(`${base}/metrics`, opts)
  return text === null ? null : parsePromSample(text, spec)
}

/**
 * Smallest share of a request's total duration that a derived decode window
 * has to occupy to be believable. Below this, TTFT and end-to-end latency were
 * effectively recorded at the same instant (see diffPromSamples) and the
 * subtraction is measuring clock noise, not decoding.
 */
const MIN_DECODE_SHARE = 0.01

export interface PromDiff {
  completionTokens: number
  promptTokens: number
  cachedTokens: number
  /** Mean TTFT over the requests in this window; exact when `ttftExact`. */
  ttft?: number
  /**
   * True when exactly one request landed in the window, which makes `ttft`
   * and `durationS` that request's own values rather than an average over
   * several. OpenCode issues one request per turn, so this is the norm.
   */
  ttftExact: boolean
  durationS?: number
  /**
   * Decode rate measured by the engine itself: tokens over (duration - TTFT),
   * i.e. excluding prefill. Only when the engine publishes both histograms
   * and exactly one request landed, so it describes this turn alone.
   */
  decodeTokS?: number
  /**
   * Prefill rate, when the engine times prefill as its own phase (LMDeploy).
   * Nothing else here can produce this from Prometheus alone.
   */
  prefillTokS?: number
}

/**
 * Diffs two samples taken across a turn boundary. Returns null when there is
 * nothing to attribute to this turn: no generation advanced (a cache hit
 * answered from a still-open connection, or a concurrent caller's turn beat
 * this one to the scrape) or the counters ran backwards (the server restarted).
 */
export function diffPromSamples(prev: PromSample, now: PromSample): PromDiff | null {
  if (now.generation < prev.generation) return null // counters reset
  const completionTokens = now.generation - prev.generation
  if (completionTokens <= 0) return null
  const dTtftCount = now.ttftCount - prev.ttftCount
  const ttft = dTtftCount > 0 ? (now.ttftSum - prev.ttftSum) / dTtftCount : undefined
  const dDurCount = now.durationCount - prev.durationCount
  const durationS = dDurCount > 0 ? (now.durationSum - prev.durationSum) / dDurCount : undefined

  // Exactly one request in the window makes these figures this turn's own.
  const exact = dTtftCount === 1
  const promptTokens = now.prompt - prev.prompt

  let decodeTokS: number | undefined
  let prefillTokS: number | undefined

  // Best case: the engine timed decode as its own phase (LMDeploy). Requires
  // `exact` too, not just its own histogram count: `completionTokens` is the
  // WHOLE WINDOW's generation delta, not scoped to whichever single request
  // advanced decodeTimeCount. If two requests land in a window and only one
  // of them records a decode-time observation — plausible on an errored or
  // partial completion — dDecCount===1 alone would divide both requests'
  // tokens by one request's decode time. Confirmed reproducible: a window
  // with 400 generation tokens (2 requests) and one 2.0s decode-time sample
  // reported 200 tok/s instead of the true 100, silently 2x inflated,
  // because `exact` (already computed from the TTFT count every engine here
  // publishes) was never consulted for this branch.
  const dDecCount = now.decodeTimeCount - prev.decodeTimeCount
  if (exact && dDecCount === 1) {
    const decodeS = now.decodeTimeSum - prev.decodeTimeSum
    if (decodeS > 0) decodeTokS = completionTokens / decodeS
  }
  // Otherwise derive the decode window as duration minus TTFT (vllm-mlx).
  //
  // Only sound when the request actually streamed. A non-streaming request has
  // no first-token event to observe, so some engines stamp TTFT at completion
  // and the two histograms collapse onto each other: SGLang on a non-streaming
  // turn reports TTFT 2.989060s against an e2e of 2.989067s — a 6.6us "decode
  // window" that yields 15.7M tok/s. Requiring decode to be a real share of
  // the request rejects that without needing to know which engine did it.
  if (decodeTokS === undefined && exact && dDurCount === 1 && ttft !== undefined && durationS !== undefined) {
    const decodeWindow = durationS - ttft
    if (decodeWindow > 0 && decodeWindow >= durationS * MIN_DECODE_SHARE) {
      decodeTokS = completionTokens / decodeWindow
    }
  }
  // Same reasoning as decode above: exact is required, not just this
  // histogram's own count, or promptTokens (the whole window's prefill
  // delta) can get divided by a single request's prefill time.
  const dPreCount = now.prefillTimeCount - prev.prefillTimeCount
  if (exact && dPreCount === 1 && promptTokens > 0) {
    const prefillS = now.prefillTimeSum - prev.prefillTimeSum
    if (prefillS > 0) prefillTokS = promptTokens / prefillS
  }

  return {
    completionTokens,
    promptTokens,
    cachedTokens: now.cached - prev.cached,
    ttft,
    ttftExact: exact,
    durationS,
    decodeTokS,
    prefillTokS,
  }
}
