// The universal telemetry layer — everything derived from OpenCode's own
// per-turn events, with no engine endpoint involved. Every provider gets this,
// including ones with no adapter here at all.
//
// Kept out of tui.tsx (which imports the TUI runtime) so it can be unit
// tested. It was the one tier without tests, and that is exactly where a real
// bug hid: the decode rate divided only the VISIBLE output tokens by a window
// that also covered the model's thinking, understating reasoning-model rates
// several-fold. See test/universal.test.mjs.

import { nn, short, tokensLabel } from "./format"

// ---- Tier 1: universal, from OpenCode's own per-turn events -----------------
import type { SessionMessageAssistant } from "@opencode-ai/client"

export interface Turn {
  startAt?: number // request start (message.time.created), for TTFT
  firstAt?: number // first streamed delta
  lastAt?: number // last streamed delta
}

/**
 * Decode rate, TTFT and total time from OpenCode's own per-turn timing —
 * `time.created`/`time.completed` on the message, and the streaming-delta
 * marks in `turn`. Shared by the universal line and by enrichment tiers that
 * have exact token counts but no per-request timing of their own (vLLM,
 * SGLang): their Prometheus counters need continuous polling to split decode
 * from prefill, which nothing here does, but OpenCode's own event stream
 * already has it for free.
 */
export function turnRate(
  tokens: number,
  info: SessionMessageAssistant | undefined,
  turn?: Turn
): { decodeTokS?: number; ttft?: number; total?: number; rateWindow?: "decode" | "whole" } {
  const created = info?.time?.created
  const completed = info?.time?.completed
  const total = typeof created === "number" && typeof completed === "number" ? (completed - created) / 1000 : undefined

  let ttft: number | undefined
  let decodeTokS: number | undefined
  let rateWindow: "decode" | "whole" | undefined

  // The request start. `turn.startAt` if a caller recorded one, otherwise the
  // message's own `created` — which is what it means anyway. Falling back here
  // rather than requiring startAt is deliberate: the v2 entry had no event
  // carrying the request start, so requiring it silently produced no ttft at
  // all for every provider without an adapter.
  const start = turn?.startAt ?? created

  if (turn) {
    if (turn.firstAt !== undefined && typeof start === "number") {
      ttft = (turn.firstAt - start) / 1000
    }
    if (turn.firstAt !== undefined && turn.lastAt !== undefined && turn.lastAt > turn.firstAt && tokens > 0) {
      decodeTokS = tokens / ((turn.lastAt - turn.firstAt) / 1000)
      rateWindow = "decode"
    }
  }
  // Fall back to a whole-request rate when the stream window was too short to
  // time. `rateWindow` says which one this is, because the two differ by an
  // order of magnitude on a turn with a long wait before the first token
  // (measured: 38.1 tok/s over a 0.97s decode window vs 3.7 over 10.03s
  // total) and presenting either as the other is indefensible.
  if (decodeTokS === undefined && tokens > 0 && total !== undefined && total > 0) {
    decodeTokS = tokens / total
    rateWindow = "whole"
  }
  return { decodeTokS, ttft, total, rateWindow }
}

export function universalLine(
  provider: string,
  model: string,
  info: SessionMessageAssistant | undefined,
  turn?: Turn
): string {
  const out: number = info?.tokens?.output ?? 0
  const reason: number = info?.tokens?.reasoning ?? 0
  // Reasoning tokens are decoded tokens: they are produced one at a time
  // inside the very window this rate is measured over. Dividing only the
  // VISIBLE output by that window understates the rate by however much of the
  // turn was spent thinking. Measured against Splash (Qwen3.8-27B): 889 of
  // 1247 generated tokens were reasoning, and this line reported 11.4 tok/s
  // where the engine's own log said 39.7 over the same 31.4s window.
  const generated = out + reason
  const { decodeTokS, ttft, total, rateWindow } = turnRate(generated, info, turn)

  // Named for the window it actually measured. OpenCode's own status line
  // shows a whole-turn rate, so an unlabelled figure here reads as
  // contradicting it when it is in fact a decode rate over a shorter window.
  const rateName = rateWindow === "whole" ? "overall" : "decode"
  const rate =
    decodeTokS !== undefined
      ? `${rateName} ${nn(decodeTokS)} tok/s${ttft !== undefined ? `  ttft ${nn(ttft, 2)}s` : ""}`
      : ttft !== undefined
        ? `ttft ${nn(ttft, 2)}s`
        : ""
  // OpenCode's output count excludes reasoning, so the topline adds them back.
  const totals = `${tokensLabel(generated, reason)}${total !== undefined ? `  ${nn(total, 2)}s` : ""}`
  return [`${provider}  ${short(model)}`, rate, totals].filter(Boolean).join("\n")
}

