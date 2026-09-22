// Phase 0 probe. Not the plugin — a disposable instrument that answers P1-P3
// (and the live half of P4/P5) by logging what the v2 runtime actually does,
// rather than what its type definitions imply.
//
// Everything here is wrapped: a probe that crashes the TUI teaches nothing
// and costs a restart. Non-negotiable 4 applies to instruments too.
//
// Wire it up in ~/.config/opencode/cli.json:
//   { "plugins": [{ "package": "/Users/you/dev/opencode-headsup" }] }
// Then read /tmp/headsup-probe.log

import { Plugin } from "@opencode-ai/plugin/tui"
import { appendFileSync } from "node:fs"

const LOG = "/tmp/headsup-probe.log"

function log(tag: string, payload?: unknown): void {
  try {
    const at = new Date().toISOString()
    const body = payload === undefined ? "" : ` ${safe(payload)}`
    appendFileSync(LOG, `${at} [${tag}]${body}\n`)
  } catch {
    // a probe that throws while logging is worse than a silent probe
  }
}

/**
 * Field names whose values must never reach the log. The probe writes to a
 * temp file that gets shared around; a config-supplied API key landing in it
 * is a real leak, not a hypothetical one.
 */
function secret(key: string): boolean {
  const k = key.toLowerCase()
  // `tokens` is usage data and must NOT be redacted — an earlier version of
  // this matched it on "token" and hid the exact figures P2 exists to read.
  if (k === "tokens") return false
  return (
    k.includes("apikey") ||
    k.includes("api_key") ||
    k.includes("secret") ||
    k.includes("password") ||
    k.includes("authorization") ||
    k.endsWith("token") ||
    k === "key"
  )
}

/** Shallow, bounded description — never dump a whole message tree. */
function safe(v: unknown, depth = 0): string {
  if (v === null) return "null"
  if (v === undefined) return "undefined"
  if (typeof v === "string") return v.length > 120 ? `"${v.slice(0, 120)}…"` : `"${v}"`
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (typeof v === "function") return "fn"
  if (Array.isArray(v)) {
    if (depth >= 3) return `[${v.length} items]`
    return `[${v.slice(0, 4).map((x) => safe(x, depth + 1)).join(", ")}${v.length > 4 ? ", …" : ""}]`
  }
  if (typeof v === "object") {
    if (depth >= 4) return `{${Object.keys(v as object).join(",")}}`
    const e = Object.entries(v as Record<string, unknown>).slice(0, 12)
    return `{${e
      .map(([k, val]) => `${k}: ${secret(k) ? "<redacted>" : safe(val, depth + 1)}`)
      .join(", ")}}`
  }
  return String(v)
}

export default Plugin.define({
  id: "headsup-probe",
  setup(ctx: Plugin.Context) {
    const off: Array<() => void> = []
    log("boot", { pid: process.pid })

    // ---- what the runtime actually handed us -----------------------------
    // The type definitions say Context has these keys. Confirm the runtime
    // agrees before trusting any of them.
    try {
      log("ctx.keys", Object.keys(ctx as object))
      log("ctx.options", ctx.options)
      log("ctx.themeMode", ctx.themeMode)
    } catch (e) {
      log("ctx.inspect.threw", String(e))
    }

    // ---- P5 (live half): is limit.context populated? ----------------------
    // The field exists in ModelInfo. The open question is whether OpenCode
    // fills it for a hand-written OpenAI-compatible provider block, which is
    // exactly the local-inference case this plugin serves.
    try {
      const models = ctx.data.location.model.list()
      if (!models) {
        log("P5.models", "list() returned undefined — not synced yet")
      } else {
        log("P5.models.count", models.length)
        for (const m of models) {
          log("P5.model", {
            id: m.id,
            providerID: m.providerID,
            limit: m.limit,
          })
        }
      }
    } catch (e) {
      log("P5.threw", String(e))
    }

    // ---- P1: what does time.streamed mark? -------------------------------
    // Stamp our own wall clock on the first text delta of each message, then
    // compare against the host's time.{created,streamed,completed} when the
    // turn lands. If streamed ≈ our first-delta mark, it is TTFT and Tier 1's
    // delta tracking is unnecessary. If it is closer to created, it marks the
    // stream opening, which is not the same thing.
    const firstDelta = new Map<string, number>()
    const firstReasoning = new Map<string, number>()

    try {
      off.push(
        ctx.data.on("session.text.delta", (evt) => {
          try {
            const id = pickMessageID(evt)
            if (id && !firstDelta.has(id)) {
              firstDelta.set(id, Date.now())
              log("P1.first-text-delta", { messageID: id, at: Date.now() })
            }
          } catch (e) {
            log("P1.text.threw", String(e))
          }
        })
      )
      off.push(
        ctx.data.on("session.reasoning.delta", (evt) => {
          try {
            const id = pickMessageID(evt)
            if (id && !firstReasoning.has(id)) {
              firstReasoning.set(id, Date.now())
              log("P1.first-reasoning-delta", { messageID: id, at: Date.now() })
            }
          } catch (e) {
            log("P1.reasoning.threw", String(e))
          }
        })
      )
    } catch (e) {
      log("P1.subscribe.threw", String(e))
    }

    // ---- P2: when does session.usage.updated fire, with what? -------------
    try {
      off.push(
        ctx.data.on("session.usage.updated", (evt) => {
          log("P2.usage.updated", evt)
        })
      )
      off.push(
        ctx.data.on("session.message.content.updated", (evt) => {
          // Log only the shape, not the content — this fires constantly.
          log("P2.content.updated.keys", Object.keys((evt ?? {}) as object))
        })
      )
      // `session.idle` was subscribed first and never fired once across four
      // turns. `session.execution.succeeded` is the event that actually marks
      // a completed turn; both are kept so the log shows which fires.
      off.push(
        ctx.data.on("session.execution.succeeded", (evt) => {
          log("P1.execution.succeeded", evt)
          reportTurn(evt)
        })
      )
      off.push(
        ctx.data.on("session.idle", (evt) => {
          log("P1.idle.fired", evt)
          reportTurn(evt)
        })
      )
    } catch (e) {
      log("P2.subscribe.threw", String(e))
    }

    function reportTurn(evt: unknown): void {
      {
        try {
            const sid = pickSessionID(evt)
            if (!sid) return log("P2.idle.no-session", evt)
            // message.list() is a union of message kinds (user, system,
            // skill, shell, compaction, "idle", assistant...). The last
            // entry after a turn is an "idle" marker, not the reply — scan
            // backwards for the assistant message instead of taking the tail.
            const msgs = ctx.data.session.message.list(sid)
            let last: unknown = undefined
            if (msgs) {
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i] as { type?: string } | undefined
                if (m?.type === "assistant") {
                  last = m
                  break
                }
              }
            }
            log("P1.message-kinds", (msgs ?? []).map((m) => (m as { type?: string }).type))
            log("P1.turn-landed", {
              sessionID: sid,
              type: (last as { type?: string } | undefined)?.type,
              time: (last as { time?: unknown } | undefined)?.time,
              tokens: (last as { tokens?: unknown } | undefined)?.tokens,
              cost: (last as { cost?: unknown } | undefined)?.cost,
              model: (last as { model?: unknown } | undefined)?.model,
            })
            const id = (last as { id?: string } | undefined)?.id
            if (id) {
              log("P1.compare", {
                messageID: id,
                ourFirstTextDelta: firstDelta.get(id) ?? null,
                ourFirstReasoningDelta: firstReasoning.get(id) ?? null,
              })
            }
            // P4: three independent cost readings plus the token counts they
            // should be derivable from, on one line so they can be checked
            // against the provider's published rates without cross-referencing.
            const a = last as {
              cost?: number
              tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
              model?: { id?: string; providerID?: string; variant?: string }
              time?: { created?: number; completed?: number }
            } | undefined
            const t = a?.tokens
            log("P4.cost-summary", {
              model: a?.model?.id,
              provider: a?.model?.providerID,
              variant: a?.model?.variant,
              input: t?.input,
              output: t?.output,
              reasoning: t?.reasoning,
              cacheRead: t?.cache?.read,
              cacheWrite: t?.cache?.write,
              costOnMessage: a?.cost,
              costFromSession: ctx.data.session.cost(sid),
              durationMs:
                a?.time?.completed !== undefined && a?.time?.created !== undefined
                  ? a.time.completed - a.time.created
                  : undefined,
            })
        } catch (e) {
          log("P2.turn.threw", String(e))
        }
      }
    }

    // ---- P3: answered, claims removed -----------------------------------
    // Three slots were claimed here rendering numbered 8-line blocks, to
    // find each one's clip point. All three rendered all eight lines, so
    // there is no clipping to measure and the blocks were only clutter in
    // a live UI. Result is recorded in .agents/audit.md; the probe now
    // renders nothing and only listens.

    log("boot.complete", { subscriptions: off.length })

    // ---- B5: does the returned cleanup actually run? ----------------------
    return () => {
      log("cleanup.called", { releasing: off.length })
      let released = 0
      for (const f of off) {
        try {
          f()
          released++
        } catch (e) {
          log("cleanup.threw", String(e))
        }
      }
      log("cleanup.complete", { released, of: off.length })
    }
  },
})

/**
 * v2 events are `{ id, created, type, data: {...} }`. The first version of
 * this looked in `properties` (v1's shape) for `messageID`, and the real
 * field is `data.assistantMessageID` — so every delta handler silently
 * matched nothing. Confirmed against SessionTextDelta in the generated types.
 */
function pickMessageID(evt: unknown): string | undefined {
  const d = (evt as { data?: Record<string, unknown> } | undefined)?.data
  const id = d?.["assistantMessageID"] ?? d?.["messageID"]
  return typeof id === "string" ? id : undefined
}

function pickSessionID(evt: unknown): string | undefined {
  const d = (evt as { data?: Record<string, unknown> } | undefined)?.data
  const id = d?.["sessionID"]
  return typeof id === "string" ? id : undefined
}
