/** @jsxImportSource @opentui/solid */
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
  return k.includes("key") || k.includes("token") || k.includes("secret") || k.includes("password")
}

/** Shallow, bounded description — never dump a whole message tree. */
function safe(v: unknown, depth = 0): string {
  if (v === null) return "null"
  if (v === undefined) return "undefined"
  if (typeof v === "string") return v.length > 120 ? `"${v.slice(0, 120)}…"` : `"${v}"`
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (typeof v === "function") return "fn"
  if (Array.isArray(v)) {
    if (depth >= 2) return `[${v.length} items]`
    return `[${v.slice(0, 4).map((x) => safe(x, depth + 1)).join(", ")}${v.length > 4 ? ", …" : ""}]`
  }
  if (typeof v === "object") {
    if (depth >= 2) return `{${Object.keys(v as object).join(",")}}`
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
      off.push(
        ctx.data.on("session.idle", (evt) => {
          // A turn finished. Dump the assistant message's own timing so P1
          // can be answered by comparison, and start P4 by reading cost.
          try {
            const sid = pickSessionID(evt)
            if (!sid) return log("P2.idle.no-session", evt)
            const msgs = ctx.data.session.message.list(sid)
            const last = msgs?.[msgs.length - 1]
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
            log("P4.session.cost", ctx.data.session.cost(sid))
          } catch (e) {
            log("P2.idle.threw", String(e))
          }
        })
      )
    } catch (e) {
      log("P2.subscribe.threw", String(e))
    }

    // ---- P3: which slots render, what do they receive, where do they clip?
    // Eight numbered lines: whichever number is last visible is the clip
    // point. v1's footer clipped past roughly five.
    const probeLines = (where: string, input: unknown) => {
      log(`P3.${where}.render`, input)
      return (
        <text>
          {`${where} 1/8\n${where} 2/8\n${where} 3/8\n${where} 4/8\n` +
            `${where} 5/8\n${where} 6/8\n${where} 7/8\n${where} 8/8`}
        </text>
      )
    }

    for (const path of ["sidebar.footer", "sidebar.content", "prompt.footer.status"] as const) {
      try {
        off.push(
          ctx.ui.slot({
            append: path,
            render: (input: unknown) => probeLines(path, input),
          } as Parameters<typeof ctx.ui.slot>[0])
        )
        log("P3.claimed", path)
      } catch (e) {
        log("P3.claim.threw", { path, error: String(e) })
      }
    }

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

/** Event payload shapes are unverified; probe defensively. */
function pickMessageID(evt: unknown): string | undefined {
  const p = (evt ?? {}) as Record<string, unknown>
  const direct = p["messageID"] ?? p["messageId"]
  if (typeof direct === "string") return direct
  const props = p["properties"] as Record<string, unknown> | undefined
  const nested = props?.["messageID"] ?? props?.["messageId"]
  return typeof nested === "string" ? nested : undefined
}

function pickSessionID(evt: unknown): string | undefined {
  const p = (evt ?? {}) as Record<string, unknown>
  const direct = p["sessionID"] ?? p["sessionId"]
  if (typeof direct === "string") return direct
  const props = p["properties"] as Record<string, unknown> | undefined
  const nested = props?.["sessionID"] ?? props?.["sessionId"]
  return typeof nested === "string" ? nested : undefined
}
