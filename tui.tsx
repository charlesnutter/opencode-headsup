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
import { universalLine, turnRate, type Turn, type Display, DEFAULT_DISPLAY } from "./universal"
import { record, formatHistory, formatCollapsedLine, latestFor, type History, type TurnRecord } from "./history"
import { emptyPanels, lineFor, keyFor, setLine, LatestPerKey, type Panels } from "./panels"

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
  display: Display
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
  // Only one figure is configurable. Everything else already shows exactly
  // when its data exists and hides exactly when it does not, which is not a
  // preference — there is nothing to choose between. `showContext` is real
  // config, not a display preference, and defaults off; see Display's own
  // doc comment in universal.ts.
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback)
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
    display: {
      context: bool(options["showContext"], DEFAULT_DISPLAY.context),
    },
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

/** Durable UI preference, independent of any one turn. */
interface UiState {
  collapsed: boolean
}

// ---- entry ------------------------------------------------------------------

/** Identifies this plugin's panel among any others contributed to the slot. */
const PANEL_NAME = "headsup.history"

export default Plugin.define({
  id: "opencode-headsup",

  setup(ctx: Plugin.Context) {
    const off: Array<() => void> = []
    const cfg = readConfig(ctx.options)

    // Cancels every in-flight engine fetch when this plugin goes away.
    //
    // v1 passed `api.lifecycle.signal` for this; v2's Context has no
    // equivalent — no `signal`, no `lifecycle`, nothing (checked against the
    // shipped types and the Phase 0 probe's dump of the real Context keys).
    // So the plugin owns the controller instead. Without it, a hot reload
    // mid-turn leaves fetches running against a torn-down generation until
    // their own timeouts expire, which is the cancel-on-dispose case v1's
    // audit already covered once.
    const life = new AbortController()
    off.push(() => life.abort())

    // What the sidebar shows, one line per session (see panels.ts). Reactive:
    // writing it re-renders the slot. Memory-scoped, so it dies with the TUI.
    const [panel, setPanel] = ctx.storage.memory<Panels>("panels", {
      initial: emptyPanels(),
    })
    const [base, setBase] = ctx.storage.memory<Baselines>("baselines", {
      initial: { llamacpp: {}, splash: {}, koboldGens: {}, mlxServeId: {}, prom: {} },
    })
    // Durable, unlike the baselines: this one is meant to outlive the TUI, so
    // the drill-down still has a session's worth of turns after a restart.
    // `record` bounds it, because a durable append with no cap grows forever.
    const [history, setHistory] = ctx.storage.store<History>("history", {
      initial: { turns: [] },
    })
    // The collapse preference. Durable like history, not ephemeral like the
    // baselines: a user who collapses the footer almost certainly wants that
    // to stick across restarts, the same way they would expect a sidebar
    // section's collapsed state to persist in any other tool.
    const [ui, setUi] = ctx.storage.store<UiState>("ui", { initial: { collapsed: false } })
    const toggleCollapsed = (): void => {
      setUi((d) => {
        d.collapsed = !d.collapsed
      }).catch((e: unknown) => dbg(`ui write failed: ${String(e)}`))
    }

    const show = (text: string, sessionID: string, key: string): void => {
      setPanel((d) => {
        const next = setLine(d, sessionID, text, key)
        d.bySession = next.bySession
        d.w = next.w
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
      http: HttpOptions,
      /**
       * Set when Tier 2 declined only because it has no baseline yet. That is
       * the first turn against a counter-diff engine, and it is a different
       * thing from the adapter failing: the universal line that follows is
       * complete and correct, it simply is not the engine's own. Without
       * saying so, the figures change shape on turn two and the rate can move
       * by an order of magnitude, which reads as a bug.
       *
       * `sharedWindow` is the same idea for a Prometheus window that held
       * other requests besides this turn: the engine figures were declined
       * as unattributable, and the line should say why they are missing.
       */
      tier2: { pendingBaseline: boolean; sharedWindow: boolean }
    ): Promise<string | null> {
      // OpenCode's own ttft for this turn. Five provider ids report none of
      // their own (omlx, llamacpp, llamafile, splash, koboldcpp), and the
      // host has the marks regardless of which tier renders the line. Passed
      // in rather than imported by the adapter, same as the Prometheus
      // fallback below, so adapters stay leaves.
      const hostTtft = turnRate(0, info, turn).ttft

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
        if (!prev) {
          tier2.pendingBaseline = true
          return null // no baseline yet: first turn since launch
        }
        const diff = diffPromSamples(prev, now)
        if (!diff) return null
        // OpenCode's own count for this turn; the adapter declines the engine
        // line when the window's count differs (another request's tokens).
        const hostTok = (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
        dbg(
          `${id} window: ttft ${diff.requests.ttft}, duration ${diff.requests.duration}; ` +
            `engine ${diff.completionTokens} tok vs host ${hostTok} tok`
        )
        // Tier 1 supplies the fallback rate and total wherever the engine has
        // no single-request figure of its own. Passed in rather than imported
        // by the adapter, so adapters stay leaves.
        const line = formatPromLine(diff, label, model, {
          ...turnRate(diff.completionTokens, info, turn),
          tokens: hostTok,
        })
        if (line === null) tier2.sharedWindow = true
        return line
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
          return formatOmlxLine(now, prev, hostTtft)
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
          if (!prev) {
            tier2.pendingBaseline = true
            return null
          }
          const t = diffLlamaCppCounters(prev, now)
          return t ? formatLlamaCppLine(t, label, model, hostTtft) : null
        }

        case "splash": {
          const now = await fetchSplashSample(cfg.splashBase, http)
          if (!now) return null
          const prev = base.splash[cfg.splashBase]
          setBase((d) => {
            d.splash[cfg.splashBase] = now
          })
          if (!prev) {
            tier2.pendingBaseline = true
            return null
          }
          const t = diffSplashSamples(prev, now)
          return t ? formatSplashLine(t, model, hostTtft) : null
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
          return t ? formatKoboldLine(t, model, hostTtft) : null
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

    // ---- context limit (opt-in Display.context only) ------------------------
    // ModelInfo.limit.context exists (Phase 0, P5) but is not indexed by the
    // host for us, so this is a linear scan over whatever models are synced.
    // Absent entirely until the first sync, and absent per-model for a
    // provider block that declares no limit -- both real, both mean "no
    // figure" rather than a guessed one.
    function contextLimitFor(providerID: string, modelID: string): number | undefined {
      const models = ctx.data.location.model.list()
      if (!models) return undefined
      for (const m of models) {
        if (m.providerID === providerID && m.id === modelID) return m.limit?.context
      }
      return undefined
    }

    // ---- turn completion ----------------------------------------------------

    // Monotonic guard against out-of-order renders, per session. `report`
    // awaits an engine fetch, so two turns completing close together race:
    // whichever adapter answers last calls `show` last, which is not
    // necessarily the later turn. Per session, because a TUI-wide counter let
    // a turn in one tab suppress another tab's line (see panels.ts).
    const latest = new LatestPerKey()

    async function report(sessionID: string): Promise<void> {
      const seq = latest.begin(sessionID)
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
      if (key !== keyFor(panel, sessionID)) {
        // A model or provider switch replaces this session's line rather than
        // blending two engines' figures into one reading. Per session, so a
        // different model in another tab is not a switch here.
        show(`${provider}  ${short(model)}\n…`, sessionID, key)
      }

      const turn = turns.get(info.id)
      // One signal for every fetch this turn. Each request still gets its own
      // timeout inside `http.ts`; this composes on top so teardown cancels
      // them all at once rather than leaving them to run the clock out.
      const http: HttpOptions = { signal: life.signal }

      const tier2 = { pendingBaseline: false, sharedWindow: false }
      let line: string | null = null
      try {
        line = await enrich(provider, model, info, turn, http, tier2)
        // Recorded before the fallback overwrites it, so history knows which
        // tier the figures actually came from.
      } catch (e: unknown) {
        // Non-negotiable 4: an adapter failure must never blank the panel, so
        // this falls through to Tier 1. That silence hid a ReferenceError for
        // several commits in v1 — OPENCODE_HUD_DEBUG is how it surfaces.
        // `unknown` because a throw is not guaranteed to be an Error.
        const err = e instanceof Error ? e : new Error(String(e))
        dbg(`${provider} adapter threw: ${err.name}: ${err.message}\n${err.stack ?? ""}`)
      }
      const enriched = line !== null
      if (!line) {
        line = universalLine(
          provider,
          model,
          info,
          turn,
          cfg.display,
          cfg.display.context ? contextLimitFor(provider, model) : undefined
        )
        // Say why this turn looks different from the next one. The figures
        // above are measured and complete; only their SOURCE changes once a
        // baseline exists, and the rate in particular can move an order of
        // magnitude when it does.
        if (tier2.pendingBaseline) line += "\nengine telemetry from the next turn"
        else if (tier2.sharedWindow) line += "\nengine data skipped: overlapping requests"
      }

      // Keep the turn for the drill-down. Every figure below is OpenCode's own,
      // whatever tier drew the sidebar line; `source` records only which tier
      // that was, so a row that differs from the live line can be explained.
      const out = info.tokens?.output ?? 0
      const reasoning = info.tokens?.reasoning ?? 0
      const r = turnRate(out + reasoning, info, turn)
      const rec: TurnRecord = {
        at: Date.now(),
        provider,
        model,
        sessionID,
        tokens: out + reasoning,
        reasoning: reasoning > 0 ? reasoning : undefined,
        rate: r.decodeTokS,
        rateWindow: r.rateWindow,
        ttft: r.ttft,
        totalS: r.total,
        cost: typeof info.cost === "number" && info.cost > 0 ? info.cost : undefined,
        cached: info.tokens?.cache?.read,
        source: enriched ? "engine" : "host",
        // Host-derived like every figure in this row; see TurnRecord.ttftSource.
        ttftSource: "host",
      }
      setHistory((d) => {
        d.turns = record({ turns: d.turns }, rec).turns
      }).catch((e: unknown) => dbg(`history write failed: ${String(e)}`))

      turns.delete(info.id)
      dbg(`turns: size ${turns.size} after completing ${info.id}`)
      // History is written unconditionally above -- every completed turn is a
      // real record. Only the panel is last-writer-wins, and only the latest
      // turn may claim it.
      if (!latest.isLatest(sessionID, seq)) {
        dbg(`report ${seq} for ${sessionID} superseded, not rendering`)
        return
      }
      show(line, sessionID, key)
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

    // ---- keybinds ------------------------------------------------------------
    // MEASURED twice over, and neither answer was the obvious one.
    //
    // 1. Registered inside the `sidebar.footer` render, the layer's lifetime
    //    was that component's. With `sidebar: "auto"` the sidebar unmounts
    //    when the panel takes over, so the layer died with it: the log showed
    //    `headsup.panel fired` on the open and NOTHING on the press meant to
    //    close, because the command no longer existed. `mode: "global"` could
    //    not have helped -- the layer was gone, not filtered.
    // 2. A bare `createRoot` owner fixed the lifetime but broke the plugin
    //    outright: `Keymap.Provider is missing`. `ctx.keymap.layer` resolves a
    //    Solid context, so it must be called inside the HOST's component tree,
    //    not merely inside some owner of ours.
    //
    // `app` is the one slot that satisfies both: a real host component, and
    // the root, so it outlives every sidebar and panel mount. It renders
    // nothing -- it exists purely to own the keymap layer.
    try {
      off.push(
        ctx.ui.slot({
          append: "app",
          render: () => {
            ctx.keymap.layer(() => ({
      // `mode` defaults to "base"; "global" is the documented opt-out.
      // Kept because a HUD toggle should reach the user in whatever mode
      // they are in -- NOT because it fixed anything. It was added for the
      // close bug on a diagnosis the log then disproved.
      mode: "global",
      commands: [
        {
          id: "headsup.toggle",
          title: "Toggle Engine Telemetry",
          description: "Collapse or expand the inference telemetry line in the sidebar",
          group: "opencode-headsup",
          bind: "ctrl+shift+m",
          palette: true,
          run: () => {
            toggleCollapsed()
          },
        },
        {
          id: "headsup.panel",
          title: "Show Inference History",
          description: "Open or close the per-turn telemetry drill-down",
          group: "opencode-headsup",
          bind: "ctrl+shift+h",
          palette: true,
          run: () => {
            // A snapshot read, not a reactive one: this decides once.
            // `current()` is per-plugin ("This plugin's active panel"), so
            // it never sees another plugin's panel.
            const open = ctx.ui.panel.current()?.name === PANEL_NAME
            dbg(`panel toggle -> ${open ? "close" : "open"}`)
            if (open) ctx.ui.panel.close()
            else ctx.ui.panel.open(PANEL_NAME)
          },
        },
      ],
            }))
            return null
          },
        })
      )
    } catch (e: unknown) {
      dbg(`keymap claim failed: ${String(e)}`)
    }


    // ---- the panel ----------------------------------------------------------

    try {
      off.push(
        ctx.ui.slot({
          append: "sidebar.footer",
          // Renders the line only. The keybinds deliberately do NOT live
          // here: this slot unmounts when the panel takes over the sidebar,
          // and a layer registered here died with it.
          render: (input) => {
            // Reading `panel`/`ui.collapsed`/`history.turns` here, not
            // captured outside, is what makes this reactive: a write to any
            // of them re-renders the slot. v1 needed a hand-rolled listener
            // set, an explicit requestRender, and an onCleanup to avoid
            // accumulating a dead listener per mount (v1 audit C2) -- the
            // host owns all of that here.
            // selectable defaults to true on every Renderable, so a plain
            // click was starting a text selection (visible as the inverted
            // highlight) instead of just toggling. This is a footer we
            // render, not a passage a user would want to copy, so turning
            // selection off is the right default rather than a workaround.
            return (
              <text selectable={false} onMouseDown={() => toggleCollapsed()}>
                {ui.collapsed
                  ? formatCollapsedLine(latestFor(history.turns, input.sessionID), input.sessionID)
                  : lineFor(panel, input.sessionID)}
              </text>
            )
          },
        })
      )
    } catch (e: unknown) {
      dbg(`slot claim failed: ${String(e)}`)
    }

    // The drill-down. `name` lets several plugins contribute panels and each
    // decide whether this one is theirs; rendering unconditionally would
    // hijack every other plugin's panel.
    try {
      off.push(
        ctx.ui.slot({
          append: "session.panel",
          render: (input) =>
            input.name === PANEL_NAME ? <text>{formatHistory(history.turns)}</text> : null,
        })
      )
    } catch (e: unknown) {
      dbg(`panel claim failed: ${String(e)}`)
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
