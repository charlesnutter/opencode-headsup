// The universal telemetry layer — everything derived from OpenCode's own
// per-turn events, with no engine endpoint involved. Every provider gets this,
// including ones with no adapter here at all.
//
// Kept out of tui.tsx (which imports the TUI runtime) so it can be unit
// tested. It was the one tier without tests, and that is exactly where a real
// bug hid: the decode rate divided only the VISIBLE output tokens by a window
// that also covered the model's thinking, understating reasoning-model rates
// several-fold. See test/universal.test.mjs.

import { nn, ni, short, tokensLabel, money } from "./format"

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
      // Suppress a physically impossible reading rather than print it. Our
      // marks are TUI-side event arrivals, so delivery latency is part of
      // the measurement: on a 903ms cloud turn (P1) the first delta landed
      // 13ms AFTER the message was marked complete, which would have
      // rendered `ttft 0.92s` on a 0.90s turn. A first token cannot arrive
      // at or after the response finished, so when it appears to, the
      // measurement failed and there is no figure -- not a small one.
      //
      // This is deliberately the impossible-value guard only. An absolute
      // floor ("suppress under 200ms") would need a distribution of the
      // delivery-latency error to place honestly, and one measured turn is
      // not that.
      if (ttft <= 0 || (total !== undefined && ttft >= total)) ttft = undefined
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

/**
 * What the panel shows and hides. Every field defaults to matching current
 * behaviour except `context`, which defaults off — see its own doc comment
 * for why.
 */
/**
 * The one thing about this panel that is genuinely a preference rather than
 * a fact about the data. TTFT, cost and cache are already shown exactly
 * when the underlying figure exists and hidden exactly when it does not —
 * that is not a setting to expose, there is nothing to prefer, only data
 * that is there or is not.
 *
 * Context is different in kind, which is why it is the only toggle. It is
 * an opt-in, our-own-arithmetic figure: `tokens.input / limit.context` from
 * the model's own declared limit (verified to exist — Phase 0, P5). Off by
 * default for a reason distinct from a normal preference: OpenCode's own
 * sidebar already shows a context percentage, computed from data and a
 * formula this plugin cannot see. For a built-in provider that is
 * presumably measured; for a custom OpenAI-compatible one (llama.cpp,
 * vLLM, ...) the limit is whatever the user wrote in their own
 * `opencode.json`, so it is config, not a measurement, and this figure is
 * only ever as trustworthy as that file.
 *
 * This is therefore explicitly NOT a claim of agreement with the host's
 * own percentage, and is labelled `prompt/limit` rather than `context used`
 * so it is not mistaken for one. Whether the two actually agree has not
 * been checked against a live host figure; that is the reason this defaults
 * off, and it stays off until someone wants to revisit it.
 */
export interface Display {
  context: boolean
}

export const DEFAULT_DISPLAY: Display = { context: false }

export function universalLine(
  provider: string,
  model: string,
  info: SessionMessageAssistant | undefined,
  turn?: Turn,
  display: Display = DEFAULT_DISPLAY,
  contextLimit?: number
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

  // A decode rate is left unqualified: the ttft beside it is what explains
  // why the whole turn was slower, without asserting where that time went
  // (ttft is queue + network + prefill + first-token compute, and only some
  // engines can tell those apart).
  //
  // The FALLBACK rate is qualified, because it is a different measurement —
  // tokens over the whole turn, not over the stream window. On a turn with a
  // long wait those differ ~10x, so letting it pass as a decode rate would be
  // wrong rather than merely terse.
  const overall = rateWindow === "whole" ? " overall" : ""
  const ttftLabel = ttft !== undefined ? `  ttft ${nn(ttft, 2)}s` : ""
  const rate =
    decodeTokS !== undefined
      ? `${nn(decodeTokS)} tok/s${overall}${ttftLabel}`
      : ttftLabel.trim()
  // OpenCode's output count excludes reasoning, so the topline adds them back.
  const totals = `${tokensLabel(generated, reason)}${total !== undefined ? `  ${nn(total, 2)}s` : ""}`

  // Cost and cache reuse, both from the host rather than any engine — so
  // every provider gets them, including cloud models where Tier 2 never
  // fires. This is the one place a cloud user sees a cache signal at all.
  //
  // `info.cost` is THIS turn's cost. `ctx.data.session.cost()` is a running
  // session total and would grow every turn while appearing to describe one
  // (measured: they differ by exactly the previous turn's cost). Per-turn is
  // what every other figure on this panel means, so per-turn is what is used.
  //
  // Both are omitted entirely when absent or zero: a free model showing
  // "$0.00" and a cold prompt showing "0 cached" are the same absent-is-not-
  // zero mistake the counters already avoid.
  const cost = money(info?.cost)
  const cacheRead = info?.tokens?.cache?.read ?? 0
  const cacheLabel = cacheRead > 0 ? `${ni(cacheRead)} cached` : ""
  const extras = [cost, cacheLabel].filter(Boolean).join("  ")

  // Opt-in only (see Display.context). `prompt/limit`, never `context used`
  // or a bare percentage — the wording itself is the caveat that this may
  // not agree with the host's own figure, which uses data and a formula
  // this plugin cannot see.
  const context =
    display.context && contextLimit !== undefined && contextLimit > 0
      ? `${ni((info?.tokens?.input ?? 0) / contextLimit * 100)}% prompt/limit`
      : ""

  return [`${provider}  ${short(model)}`, rate, totals, extras, context].filter(Boolean).join("\n")
}

