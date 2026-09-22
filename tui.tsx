/** @jsxImportSource @opentui/solid */
// opencode-headsup — per-turn inference telemetry in the OpenCode 2 sidebar.
//
// Two tiers, never collapsed:
//   Tier 1 (universal.ts) — from OpenCode's own per-turn data. Every provider.
//   Tier 2 (adapters/)    — the serving engine's own metrics, where there is
//                           an adapter for its telemetry shape.
//
// Everything here that looks like paranoia is a Phase 0 measurement. Four
// figures in this API are CUMULATIVE where a per-turn one is expected, and
// reading any of them naively reports a session total while appearing to
// report the turn (.agents/audit.md, P2/P4):
//
//   session.usage.updated  running session totals, and it fires mid-turn
//   session.cost()         running session cost — use message.cost instead
//   engine counters        what adapters/ already differences
//   time.streamed          stamped at stream END, 1ms before completed.
//                          NOT ttft. Our own delta marks are the only
//                          per-turn ttft available.
//
// `output` and `reasoning` are separate counters and reasoning can exceed
// output (measured: 4096 vs 2211). Total decoded is the sum; universal.ts
// does that. Dividing only visible output by a window that also covered
// thinking is the v1 bug this comment exists to stop recurring.

import { Plugin } from "@opencode-ai/plugin/tui"
import type { SessionMessageAssistant } from "@opencode-ai/client"
import { appendFileSync } from "node:fs"

import { short } from "./format"
import type { HttpOptions } from "./http"
import { universalLine, turnRate, type Turn } from "./universal"

import { fetchMtplxLatest, formatMtplxLine } from "./adapters/mtplx"
import { fetchOmlxSample, formatOmlxLine, type OmlxSample } from "./adapters/omlx"
import {
  fetchLlamaCppCounters,
  diffLlamaCppCounters,
  formatLlamaCppLine,
  type LlamaCppCounters,
} from "./adapters/llamacpp"
import { fetchMlxServeRequests, mlxServeTurn, formatMlxServeLine } from "./adapters/mlxserve"
import {
  fetchSplashSample,
  diffSplashSamples,
  formatSplashLine,
  type SplashSample,
} from "./adapters/splash"
import { fetchKoboldPerf, koboldTurn, formatKoboldLine } from "./adapters/koboldcpp"
import {
  fetchPromSample,
  diffPromSamples,
  formatPromLine,
  VLLM_SPEC,
  SGLANG_SPEC,
  VLLM_MLX_SPEC,
  APHRODITE_SPEC,
  LMDEPLOY_SPEC,
  type PromSample,
  type PromSpec,
} from "./adapters/prometheus"

// ---- config -----------------------------------------------------------------

interface Config {
  mtplxUrl: string
  omlxBase: string
  omlxKey: string
  llamacppBase: string
  llamafileBase: string
  vllmBase: string
  sglangBase: string
  vllmMlxBase: string
  aphroditeBase: string
  lmdeployBase: string
  splashBase: string
  koboldBase: string
  mlxServeBase: string
  mlxServeKey: string
}

const HUD_DEBUG = !!process.env.OPENCODE_HUD_DEBUG

function dbg(msg: string): void {
  if (!HUD_DEBUG) return
  try {
    appendFileSync("/tmp/opencode-headsup-debug.log", `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // diagnostics must never take the panel down
  }
}

function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const str = (v: unknown, envKey: string, fallback: string): string =>
    typeof v === "string" && v ? v : process.env[envKey] || fallback
  const trim = (s: string): string => s.replace(/\/+$/, "")
  return {
    mtplxUrl: str(options["mtplxMetricsUrl"], "MTPLX_METRICS_URL", "http://127.0.0.1:8000/metrics"),
    omlxBase: trim(str(options["omlxBaseUrl"], "OMLX_BASE_URL", "http://127.0.0.1:8099")),
    omlxKey: str(options["omlxApiKey"], "OMLX_API_KEY", ""),
    llamacppBase: trim(str(options["llamacppBaseUrl"], "LLAMACPP_BASE_URL", "http://127.0.0.1:8080")),
    llamafileBase: trim(str(options["llamafileBaseUrl"], "LLAMAFILE_BASE_URL", "http://127.0.0.1:8003")),
    vllmBase: trim(str(options["vllmBaseUrl"], "VLLM_BASE_URL", "http://127.0.0.1:8000")),
    sglangBase: trim(str(options["sglangBaseUrl"], "SGLANG_BASE_URL", "http://127.0.0.1:30000")),
    vllmMlxBase: trim(str(options["vllmMlxBaseUrl"], "VLLM_MLX_BASE_URL", "http://127.0.0.1:8000")),
    aphroditeBase: trim(str(options["aphroditeBaseUrl"], "APHRODITE_BASE_URL", "http://127.0.0.1:2242")),
    lmdeployBase: trim(str(options["lmdeployBaseUrl"], "LMDEPLOY_BASE_URL", "http://127.0.0.1:23333")),
    splashBase: trim(str(options["splashBaseUrl"], "SPLASH_BASE_URL", "http://127.0.0.1:8000")),
    koboldBase: trim(str(options["koboldcppBaseUrl"], "KOBOLDCPP_BASE_URL", "http://127.0.0.1:5001")),
    mlxServeBase: trim(str(options["mlxServeBaseUrl"], "MLXSERVE_BASE_URL", "http://127.0.0.1:8095")),
    mlxServeKey: str(options["mlxServeApiKey"], "MLX_API_KEY", ""),
  }
}

// ---- stored state -----------------------------------------------------------

/**
 * Engine counter baselines.
 *
 * These live in `ctx.storage.memory()` rather than module scope. It is
 * documented to survive hot reloads with old and new generations sharing one
 * store, and to be discarded when the TUI exits — which is exactly the right
 * lifetime for a baseline the engine is still counting up from. v1 used
 * module-scope Maps and had to reason about whether a stale baseline could
 * cross a reload (v1 audit C8); here the host settles it.
 *
 * Plain records rather than Maps, so the Solid store can track writes.
 */
interface Baselines {
  omlx?: OmlxSample
  llamacpp: Record<string, LlamaCppCounters>
  splash: Record<string, SplashSample>
  koboldGens: Record<string, number>
  mlxServeId: Record<string, string>
  prom: Record<string, PromSample>
}

/** What the sidebar shows. Reactive — writing it re-renders the slot. */
interface Panel {
  text: string
}

// ---- entry ------------------------------------------------------------------

export default Plugin.define({
  id: "opencode-headsup",

  setup(ctx: Plugin.Context) {
    const off: Array<() => void> = []
    const cfg = readConfig(ctx.options)

    const [panel, setPanel] = ctx.storage.memory<Panel>("panel", {
      initial: { text: "inference · —" },
    })
    const [base, setBase] = ctx.storage.memory<Baselines>("baselines", {
      initial: { llamacpp: {}, splash: {}, koboldGens: {}, mlxServeId: {}, prom: {} },
    })

    const show = (text: string): void => {
      setPanel((d) => {
        d.text = text
      })
    }

    // ---- per-turn stream marks ---------------------------------------------
    // P1: `time.streamed` is stamped at completion, so the host cannot supply
    // a ttft. These marks are the only source. Keyed by assistant message id.
    const turns = new Map<string, Turn>()
    const turnFor = (id: string): Turn => {
      let t = turns.get(id)
      if (!t) {
        t = {}
        turns.set(id, t)
        if (turns.size > 64) {
          // Bound the map. Normally each entry is deleted when its turn
          // completes, so eviction firing at all means turns are being
          // abandoned — which is the case v1 audit C3 exists to catch.
          const oldest = turns.keys().next().value
          if (oldest !== undefined && oldest !== id) {
            turns.delete(oldest)
            dbg(`turns: evicted ${oldest}, size now ${turns.size}`)
          }
        }
      }
      return t
    }

    // ---- Tier 2 dispatch ----------------------------------------------------

    async function enrich(
      provider: string,
      model: string,
      info: SessionMessageAssistant,
      turn: Turn | undefined,
      http: HttpOptions
    ): Promise<string | null> {
      /** Shared by every Prometheus engine; they differ only by spec and URL. */
      const prom = async (
        id: string,
        spec: PromSpec,
        url: string,
        label: string
      ): Promise<string | null> => {
        const now = await fetchPromSample(url, spec, http)
        if (!now) return null
        const prev = base.prom[id]
        setBase((d) => {
          d.prom[id] = now
        })
        if (!prev) return null // no baseline yet: first turn since launch
        const diff = diffPromSamples(prev, now)
        if (!diff) return null
        // Tier 1 supplies the fallback rate for engines with no duration
        // histogram. Passed in rather than imported by the adapter, so
        // adapters stay leaves.
        return formatPromLine(diff, label, model, turnRate(diff.completionTokens, info, turn))
      }

      switch (provider) {
        case "mtplx": {
          const latest = await fetchMtplxLatest(cfg.mtplxUrl, http)
          return latest ? formatMtplxLine(latest, model) : null
        }

        case "omlx": {
          const now = await fetchOmlxSample(cfg.omlxBase, cfg.omlxKey, http)
          if (!now) return null
          const prev = base.omlx
          setBase((d) => {
            d.omlx = now
          })
          return formatOmlxLine(now, prev)
        }

        // llamafile is llama.cpp-derived and publishes identical metric names,
        // so it reuses that adapter verbatim; only URL, label and baseline key
        // differ, which lets both run side by side.
        case "llamacpp":
        case "llamafile": {
          const url = provider === "llamacpp" ? cfg.llamacppBase : cfg.llamafileBase
          const label = provider === "llamacpp" ? "llama.cpp" : "llamafile"
          const now = await fetchLlamaCppCounters(url, http)
          if (!now) return null // unreachable, or started without --metrics
          const prev = base.llamacpp[provider]
          setBase((d) => {
            d.llamacpp[provider] = now
          })
          if (!prev) return null
          const t = diffLlamaCppCounters(prev, now)
          return t ? formatLlamaCppLine(t, label, model) : null
        }

        case "splash": {
          const now = await fetchSplashSample(cfg.splashBase, http)
          if (!now) return null
          const prev = base.splash[cfg.splashBase]
          setBase((d) => {
            d.splash[cfg.splashBase] = now
          })
          if (!prev) return null
          const t = diffSplashSamples(prev, now)
          return t ? formatSplashLine(t, model) : null
        }

        case "koboldcpp":
        case "kobold": {
          const perf = await fetchKoboldPerf(cfg.koboldBase, http)
          if (!perf) return null
          const prev = base.koboldGens[cfg.koboldBase]
          setBase((d) => {
            d.koboldGens[cfg.koboldBase] = perf.total_gens
          })
          const t = koboldTurn(perf, prev)
          return t ? formatKoboldLine(t, model) : null
        }

        case "mlxserve":
        case "mlx-serve": {
          const recs = await fetchMlxServeRequests(
            cfg.mlxServeBase,
            model,
            cfg.mlxServeKey || undefined,
            http
          )
          if (!recs) return null
          const t = mlxServeTurn(recs, base.mlxServeId[cfg.mlxServeBase])
          if (!t) return null // nothing newer than what was already reported
          setBase((d) => {
            d.mlxServeId[cfg.mlxServeBase] = t.requestId
          })
          return formatMlxServeLine(t, model)
        }

        case "vllm":
          return prom("vllm", VLLM_SPEC, cfg.vllmBase, "vLLM")
        case "sglang":
          return prom("sglang", SGLANG_SPEC, cfg.sglangBase, "SGLang")
        case "vllmmlx":
        case "vllm-mlx":
          return prom("vllmmlx", VLLM_MLX_SPEC, cfg.vllmMlxBase, "vllm-mlx")
        case "aphrodite":
          return prom("aphrodite", APHRODITE_SPEC, cfg.aphroditeBase, "Aphrodite")
        case "lmdeploy":
          return prom("lmdeploy", LMDEPLOY_SPEC, cfg.lmdeployBase, "LMDeploy")

        default:
          return null // no adapter: Tier 1 handles it
      }
    }

    // ---- turn completion ----------------------------------------------------

    let lastKey = ""

    async function report(sessionID: string): Promise<void> {
      // `message.list()` is a union of message kinds and its tail after a turn
      // is an "idle" marker, not the reply — measured, see audit P1. Scan
      // backwards for the assistant message.
      const msgs = ctx.data.session.message.list(sessionID)
      if (!msgs) return
      let info: SessionMessageAssistant | undefined
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m && m.type === "assistant") {
          info = m
          break
        }
      }
      if (!info) return

      const provider = info.model?.providerID ?? ""
      const model = info.model?.id ?? ""
      const key = `${provider}/${model}`
      if (key !== lastKey) {
        // A model or provider switch replaces the panel rather than blending
        // two engines' figures into one reading.
        show(`${provider}  ${short(model)}\n…`)
        lastKey = key
      }

      const turn = turns.get(info.id)
      const http: HttpOptions = {}

      let line: string | null = null
      try {
        line = await enrich(provider, model, info, turn, http)
      } catch (e: unknown) {
        // Non-negotiable 4: an adapter failure must never blank the panel, so
        // this falls through to Tier 1. That silence hid a ReferenceError for
        // several commits in v1 — OPENCODE_HUD_DEBUG is how it surfaces.
        // `unknown` because a throw is not guaranteed to be an Error.
        const err = e instanceof Error ? e : new Error(String(e))
        dbg(`${provider} adapter threw: ${err.name}: ${err.message}\n${err.stack ?? ""}`)
      }
      if (!line) line = universalLine(provider, model, info, turn)

      turns.delete(info.id)
      dbg(`turns: size ${turns.size} after completing ${info.id}`)
      show(line)
    }

    // ---- subscriptions ------------------------------------------------------

    try {
      // Our own ttft marks, since time.streamed cannot supply one. Both delta
      // streams are watched because v2 splits them and reasoning arrives
      // first — 842ms before any text on one measured turn. Reasoning tokens
      // are decoded output, so the first of either is the first token.
      const mark = (evt: unknown): void => {
        const d = (evt as { data?: Record<string, unknown> } | undefined)?.data
        const id = d?.["assistantMessageID"]
        if (typeof id !== "string") return
        const t = turnFor(id)
        const now = Date.now()
        if (t.firstAt === undefined) t.firstAt = now
        t.lastAt = now
      }
      off.push(ctx.data.on("session.text.delta", mark))
      off.push(ctx.data.on("session.reasoning.delta", mark))

      // `session.idle` never fires — subscribed across four turns in Phase 0
      // with zero firings. This is the real turn-completion event.
      off.push(
        ctx.data.on("session.execution.succeeded", (evt) => {
          const sid = (evt as { data?: { sessionID?: string } } | undefined)?.data?.sessionID
          if (typeof sid === "string") {
            report(sid).catch((e: unknown) => dbg(`report threw: ${String(e)}`))
          }
        })
      )
    } catch (e: unknown) {
      dbg(`subscribe failed: ${String(e)}`)
    }

    // ---- the panel ----------------------------------------------------------

    try {
      off.push(
        ctx.ui.slot({
          append: "sidebar.footer",
          // Reading `panel.text` inside render makes this reactive: a write
          // re-renders the slot. v1 needed a hand-rolled listener set and an
          // explicit requestRender, plus an onCleanup to avoid accumulating a
          // dead listener per mount (v1 audit C2). The host owns all of that
          // here, so that whole class of bug is gone rather than handled.
          render: () => <text>{panel.text}</text>,
        })
      )
    } catch (e: unknown) {
      dbg(`slot claim failed: ${String(e)}`)
    }

    dbg(`setup complete: ${off.length} subscriptions`)

    // The only teardown hook in v2 — it cannot be forgotten the way an
    // onDispose registration could. Confirmed to run, releasing everything,
    // across hot reloads (audit B5).
    return () => {
      dbg(`cleanup: releasing ${off.length}`)
      let released = 0
      for (const f of off) {
        try {
          f()
          released++
        } catch (e: unknown) {
          dbg(`cleanup threw: ${String(e)}`)
        }
      }
      dbg(`cleanup complete: ${released}/${off.length}`)
    }
  },
})
