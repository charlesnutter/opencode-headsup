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
import { universalView, turnRate, turnSteps, aggregateTurn, type Turn, type Display, DEFAULT_DISPLAY } from "./universal"
import { record, formatHistory, type History, type TurnRecord } from "./history"
import { emptyPanels, lineFor, keyFor, setLine, LatestPerKey, PLACEHOLDER, type Panels } from "./panels"
import { encodeView, decodeView, LABEL_WIDTH, type TurnView } from "./rows"
import { summariseSession, sessionView, rollupSubagents, subagentRows } from "./session"

import { fetchMtplxLatest, mtplxView, combineMtplxSteps, type MtplxLatest } from "./adapters/mtplx"
import { fetchOmlxSample, omlxView, omlxIsThisTurn, type OmlxSample } from "./adapters/omlx"
import {
  fetchLlamaCppCounters,
  diffLlamaCppCounters,
  llamaCppView,
  llamaCppIsThisTurn,
  type LlamaCppCounters,
} from "./adapters/llamacpp"
import { fetchMlxServeRequests, mlxServeTurn, mlxServeView, combineMlxServeSteps, type MlxServeRequest } from "./adapters/mlxserve"
import {
  fetchSplashSample,
  diffSplashSamples,
  splashView,
  splashIsThisTurn,
  type SplashSample,
} from "./adapters/splash"
import { fetchKoboldPerf, koboldTurn, koboldView, combineKoboldSteps, type KoboldPerf } from "./adapters/koboldcpp"
import {
  fetchPromSample,
  diffPromSamples,
  promView,
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
      background: bool(options["background"], DEFAULT_DISPLAY.background),
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
  /** The Session section is expanded. Collapsed by default. */
  sessionOpen?: boolean
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
    const toggleSession = (): void => {
      setUi((d) => {
        d.sessionOpen = !d.sessionOpen
      }).catch((e: unknown) => dbg(`ui write failed: ${String(e)}`))
    }

    // Theme colours, looked up defensively. The runtime theme's shape does
    // not match the installed types: on OpenCode 2.0.12 `ctx.theme.background`
    // was undefined and reading `.surface.offset` crashed the slot. Other
    // plugins use at least three shapes (text.subdued; text.muted/text.base;
    // textMuted; background.raised.base), so each known path is tried and a
    // missing colour means "no colour", never a throw.
    const themeColor = (...paths: string[]): unknown => {
      for (const path of paths) {
        let v: unknown = ctx.theme
        for (const k of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined
        if (v !== undefined && v !== null && typeof v !== "function") return v
      }
      return undefined
    }
    type Color = Parameters<typeof ctx.theme.increase>[0]
    const subduedColor = (): Color | undefined =>
      themeColor("text.subdued", "text.muted", "textMuted", "text.subtle") as Color | undefined
    const panelColor = (): Color | undefined =>
      themeColor("background.surface.offset", "background.raised.base", "backgroundPanel", "backgroundElement") as
        | Color
        | undefined
    if (HUD_DEBUG) {
      try {
        const shape = (o: unknown, depth: number): string =>
          o && typeof o === "object" && depth > 0
            ? `{${Object.keys(o as object)
                .slice(0, 24)
                .map((k) => `${k}:${shape((o as Record<string, unknown>)[k], depth - 1)}`)
                .join(",")}}`
            : typeof o
        dbg(`theme shape: ${shape(ctx.theme, 3)}`)
        dbg(`theme picks: subdued ${subduedColor() !== undefined}, panel ${panelColor() !== undefined}`)
      } catch (e: unknown) {
        dbg(`theme inspection threw: ${String(e)}`)
      }
    }

    // One box. Theme colours throughout, so it follows the user's theme:
    // bold heading, subdued labels and notes, default-coloured values.
    const drawBox = (view: TurnView, suffix: string, open: boolean, toggle: () => void, first: boolean) => {
      const subdued = subduedColor()
      return (
        <box
          flexDirection="column"
          marginLeft={1}
          marginRight={1}
          marginTop={first ? 0 : 1}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={open ? 1 : 0}
          paddingBottom={open ? 1 : 0}
          backgroundColor={cfg.display.background ? panelColor() : undefined}
        >
          <text selectable={false} onMouseDown={toggle}>
            <b>{`${open ? "▾" : "▸"} ${view.engine}${suffix}`}</b>
            {!open && view.key ? <span style={{ fg: subdued }}>{`  ${view.key}`}</span> : null}
          </text>
          {open && (view.rows.length > 0 || view.notes.length > 0) ? (
            <box flexDirection="column" marginTop={1}>
              {view.rows.map(([label, value]) => (
                <text selectable={false}>
                  <span style={{ fg: subdued }}>{label.padEnd(LABEL_WIDTH)}</span>
                  {value}
                </text>
              ))}
              {view.notes.map((note) => (
                <text selectable={false} fg={subdued}>
                  {note}
                </text>
              ))}
            </box>
          ) : null}
        </box>
      )
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
    // When each session's current execution started: the start of what the
    // user waits for, which the turn's total runs from (retries included).
    const execStart = new Map<string, number>()
    // Per step: its provider and model (from session.step.started), and for
    // engines that report their latest request -- MTPLX, KoboldCpp, mlx-serve
    // -- a read taken at that step's end. A tool-using turn is one request
    // per step, and those engines only hold the latest, so each has to be
    // read before the next step replaces it (measured on MTPLX: at step.ended
    // `latest` held that step, 62 then 138). Bounded like `turns`: an
    // interrupted turn never reports.
    const stepProvider = new Map<string, string>()
    const stepModel = new Map<string, string>()
    const stepReads = new Map<string, Promise<unknown>>()
    const bound = <V,>(m: Map<string, V>): void => {
      if (m.size > 64) {
        const oldest = m.keys().next().value
        if (oldest !== undefined) m.delete(oldest)
      }
    }
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
      tier2: {
        pendingBaseline: boolean
        sharedWindow: boolean
        /** Engine-only figures of an accepted reading, for the history row. */
        engine?: TurnRecord["engine"]
      },
      /** The turn's assistant messages, one per step, oldest first. */
      steps: readonly SessionMessageAssistant[],
      /**
       * Sub-agents that ran on this same engine during the turn. A
       * counter-difference engine's window holds their requests too, so its
       * check expects the turn's tokens and steps plus theirs.
       */
      sameEngine?: TurnRecord["subagents"]
    ): Promise<TurnView | null> {
      // OpenCode's own ttft for this turn. Five provider ids report none of
      // their own (omlx, llamacpp, llamafile, splash, koboldcpp), and the
      // host has the marks regardless of which tier renders the line. Passed
      // in rather than imported by the adapter, same as the Prometheus
      // fallback below, so adapters stay leaves.
      const hostTtft = turnRate(0, info, turn).ttft

      // Diagnostics for the non-Prometheus adapters: does the figure an
      // adapter is about to render describe this turn? Their engines count
      // tokens for whatever they report (the latest request, or a window), so
      // a count that differs from OpenCode's own for the turn means it is
      // another request's, or several. Logged only; nothing acts on it yet
      // (v2 audit, "Open — non-Prometheus adapters").
      const hostTokens = (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
      const match = (engineTok: number | null | undefined, extra = ""): void => {
        dbg(`${provider} match: engine ${engineTok ?? "?"} tok vs host ${hostTokens} tok${extra}`)
      }

      /** Shared by every Prometheus engine; they differ only by spec and URL. */
      const prom = async (
        id: string,
        spec: PromSpec,
        url: string,
        label: string
      ): Promise<TurnView | null> => {
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
        // The fallback rate is this turn's own generation: OpenCode's count
        // over its streaming, never the window's, which can include sub-agents.
        const line = promView(diff, label, model, {
          ...turnRate(hostTok, info, turn),
          tokens: windowTokens,
          steps: windowSteps,
          retries: turn?.retries,
          includesSubagents,
        })
        if (line === null) tier2.sharedWindow = true
        else if ((turn?.steps ?? 1) === 1 && diff.prefillTokS !== undefined) tier2.engine = { prefillTokS: diff.prefillTokS }
        return line
      }

      // Every step's read from its end, or undefined when any step has none
      // (the plugin loaded mid-turn, or the event was missed).
      const stepTokens = (m: SessionMessageAssistant): number =>
        (m.tokens?.output ?? 0) + (m.tokens?.reasoning ?? 0)
      const perStep = async <T,>(): Promise<(T | null)[] | undefined> => {
        const reads = steps.map((m) => stepReads.get(m.id))
        if (steps.length === 0 || reads.some((r) => r === undefined)) return undefined
        return (await Promise.all(reads)) as Array<T | null>
      }
      const hostFigures = { total: turnRate(0, info, turn).total, retries: turn?.retries }
      // What a counter-difference window should hold: this turn's tokens and
      // steps, plus any sub-agents' on this same engine.
      const windowTokens = hostTokens + (sameEngine?.tokens ?? 0)
      const windowSteps = steps.length + (sameEngine?.steps ?? 0)
      const includesSubagents = sameEngine !== undefined

      switch (provider) {
        case "mtplx": {
          // Each step's receipt, read at its end, checked against OpenCode's
          // own count for that step, and combined (see combineMtplxSteps).
          let receipts = await perStep<MtplxLatest>()
          if (receipts) {
            // read at every step's end
          } else if (steps.length === 1) {
            // No read at the step's end (the plugin loaded mid-turn): a
            // single-step turn can still be read now; a multi-step one can't.
            receipts = [await fetchMtplxLatest(cfg.mtplxUrl, http)]
          } else {
            return null
          }
          const combined = combineMtplxSteps(
            steps.map((m, i) => ({ receipt: receipts[i] ?? null, hostTokens: stepTokens(m) }))
          )
          match(combined?.completion_tokens, `; steps ${steps.length}`)
          if (!combined) {
            // Receipts that exist but are not the steps' own: say why.
            if (receipts.every((r) => r !== null)) tier2.sharedWindow = true
            return null
          }
          const verifies = combined.verify_calls ?? 0
          tier2.engine = {
            prefillTokS: combined.prefill_tok_s ?? undefined,
            mtpX: verifies > 0 && combined.completion_tokens ? combined.completion_tokens / verifies : undefined,
          }
          return mtplxView(combined, hostFigures)
        }

        case "omlx": {
          const now = await fetchOmlxSample(cfg.omlxBase, cfg.omlxKey, http)
          if (!now) return null
          const prev = base.omlx
          setBase((d) => {
            d.omlx = now
          })
          if (prev) {
            match(now.completion - prev.completion, `; requests ${now.requests - prev.requests}, steps ${steps.length}`)
            // A window that isn't this turn's -- a spare request, or tokens
            // that don't match -- is declined. The no-baseline render below
            // is labelled as the server's averages and needs no check.
            if (now.requests > prev.requests && !omlxIsThisTurn(prev, now, { tokens: windowTokens, steps: windowSteps })) {
              tier2.sharedWindow = true
              return null
            }
          }
          return omlxView(now, prev, hostTtft, {
            ...hostFigures,
            decodeTokS: turnRate(hostTokens, info, turn).decodeTokS,
            includesSubagents,
          })
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
          if (!t) return null
          match(t.completionTokens, `; steps ${steps.length}`)
          if (!llamaCppIsThisTurn(t, windowTokens)) {
            tier2.sharedWindow = true
            return null
          }
          tier2.engine = { prefillTokS: t.prefillTokS }
          return llamaCppView(t, label, hostTtft, { ...hostFigures, includesSubagents })
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
          if (!t) return null
          match(t.completionTokens, `; requests ${t.requests}, steps ${steps.length}`)
          if (!splashIsThisTurn(t, { tokens: windowTokens, steps: windowSteps })) {
            tier2.sharedWindow = true
            return null
          }
          tier2.engine = { prefillTokS: t.prefillTokS, draftAccept: t.draftAcceptRate }
          return splashView(t, hostTtft, { ...hostFigures, steps: windowSteps, includesSubagents })
        }

        case "koboldcpp":
        case "kobold": {
          // Read at every step's end: each step's receipt, combined.
          const perfs = await perStep<KoboldPerf>()
          if (perfs) {
            const combined = combineKoboldSteps(
              steps.map((m, i) => ({ perf: perfs[i] ?? null, hostTokens: stepTokens(m) }))
            )
            match(combined?.completionTokens, `; steps ${steps.length}`)
            const last = perfs[perfs.length - 1]
            if (last) {
              setBase((d) => {
                d.koboldGens[cfg.koboldBase] = last.total_gens
              })
            }
            if (!combined) {
              if (perfs.every((p) => p !== null)) tier2.sharedWindow = true
              return null
            }
            tier2.engine = { prefillTokS: combined.prefillTokS, draftAccept: combined.draftAcceptRate }
            return koboldView(combined, hostTtft, hostFigures)
          }
          // No per-step reads: one read now, which can only describe the
          // last request -- labelled as such when several landed.
          const perf = await fetchKoboldPerf(cfg.koboldBase, http)
          if (!perf) return null
          const prev = base.koboldGens[cfg.koboldBase]
          setBase((d) => {
            d.koboldGens[cfg.koboldBase] = perf.total_gens
          })
          const t = koboldTurn(perf, prev)
          if (t) match(t.completionTokens, `; generations ${t.generationsInWindow ?? "?"}`)
          return t ? koboldView(t, hostTtft, hostFigures) : null
        }

        case "mlxserve":
        case "mlx-serve": {
          // Read at every step's end: each step's newest record, combined.
          const reads = await perStep<MlxServeRequest[]>()
          if (reads) {
            const combined = combineMlxServeSteps(
              steps.map((m, i) => ({ records: reads[i] ?? null, hostTokens: stepTokens(m) })),
              base.mlxServeId[cfg.mlxServeBase]
            )
            match(combined?.completionTokens, `; steps ${steps.length}`)
            if (!combined) {
              if (reads.every((r) => r !== null)) tier2.sharedWindow = true
              return null
            }
            setBase((d) => {
              d.mlxServeId[cfg.mlxServeBase] = combined.requestId
            })
            return mlxServeView(combined, hostFigures)
          }
          const recs = await fetchMlxServeRequests(
            cfg.mlxServeBase,
            model,
            cfg.mlxServeKey || undefined,
            http
          )
          if (!recs) return null
          const t = mlxServeTurn(recs, base.mlxServeId[cfg.mlxServeBase])
          if (!t) return null // nothing newer than what was already reported
          match(t.completionTokens, `; request ${t.requestId}`)
          setBase((d) => {
            d.mlxServeId[cfg.mlxServeBase] = t.requestId
          })
          return mlxServeView(t, hostFigures)
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
      // The turn is every assistant message since the last user message: one
      // per step when it calls tools. Reading only the last one showed
      // `140 tok  10.20s` for a 316-token, 37s turn (measured, vllm-mlx).
      const steps = turnSteps(msgs)
      const agg = aggregateTurn(steps, turns, { execStart: execStart.get(sessionID) })
      execStart.delete(sessionID)
      const info = agg.info
      const turn = agg.turn
      if (!info) return
      dbg(
        `turn: ${steps.length} assistant message(s) [${steps
          .map((m) => `${(m.tokens?.output ?? 0) + (m.tokens?.reasoning ?? 0)}${m.finish ? `/${m.finish}` : ""}`)
          .join(", ")}]; retries ${turn?.retries ?? 0}`
      )
      // Diagnostics for sub-agent roll-ups: which session this turn is, its
      // parent if it is a sub-agent, and the session tree OpenCode reports.
      if (HUD_DEBUG) {
        try {
          const parent = ctx.data.session.get(sessionID)?.parentID
          const family = ctx.data.session.family(sessionID)
          const recorded = family.map((id) => `${id}:${history.turns.filter((t) => t.sessionID === id).length}`)
          dbg(
            `  session ${sessionID}${parent ? ` (sub-agent of ${parent})` : ""}; family [${recorded.join(", ")}]; ` +
              `status ${family.map((id) => ctx.data.session.status(id)).join("/")}`
          )
        } catch (e: unknown) {
          dbg(`  session lookup threw: ${String(e)}`)
        }
      }

      const provider = info.model?.providerID ?? ""
      const model = info.model?.id ?? ""
      const key = `${provider}/${model}`
      if (key !== keyFor(panel, sessionID)) {
        // A model or provider switch replaces this session's line rather than
        // blending two engines' figures into one reading. Per session, so a
        // different model in another tab is not a switch here.
        show(encodeView({ engine: provider, rows: [], notes: ["…"] }), sessionID, key)
      }

      // One signal for every fetch this turn. Each request still gets its own
      // timeout inside `http.ts`; this composes on top so teardown cancels
      // them all at once rather than leaving them to run the clock out.
      const http: HttpOptions = { signal: life.signal }

      // Sub-agents that ran during this turn, each in its own child session
      // whose turns are recorded under that session (measured: the child's
      // row existed, and the child had finished, 11s before the parent's turn
      // ended). Their tokens, time and cost are summed onto one line; rates
      // are never combined, since a sub-agent can run on another model.
      let subagents: TurnRecord["subagents"]
      let sameEngine: TurnRecord["subagents"]
      try {
        const descendants = ctx.data.session.family(sessionID).filter((id) => {
          let p = ctx.data.session.get(id)?.parentID
          for (let hops = 0; p && hops < 16; hops++) {
            if (p === sessionID) return true
            p = ctx.data.session.get(p)?.parentID
          }
          return false
        })
        const until = Date.now()
        subagents = rollupSubagents(history.turns, descendants, info.time.created, until)
        // The ones on this same engine: counter-difference engines see their
        // requests in this turn's window, so the check expects them too.
        sameEngine = rollupSubagents(
          history.turns.filter((t) => t.provider === provider),
          descendants,
          info.time.created,
          until
        )
      } catch (e: unknown) {
        dbg(`sub-agent lookup threw: ${String(e)}`)
      }

      const tier2: { pendingBaseline: boolean; sharedWindow: boolean; engine?: TurnRecord["engine"] } = {
        pendingBaseline: false,
        sharedWindow: false,
      }
      let line: TurnView | null = null
      try {
        line = await enrich(provider, model, info, turn, http, tier2, steps, sameEngine)
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
        line = universalView(
          provider,
          info,
          turn,
          cfg.display,
          cfg.display.context ? contextLimitFor(provider, model) : undefined
        )
        // Say why this turn looks different from the next one. The figures
        // above are measured and complete; only their SOURCE changes once a
        // baseline exists, and the rate in particular can move an order of
        // magnitude when it does. Split to fit the box's 34 cells.
        if (tier2.pendingBaseline) line.notes.push("engine telemetry", "from the next turn")
        else if (tier2.sharedWindow) line.notes.push("engine data skipped:", "overlapping requests")
      }

      if (subagents) line.rows.push(...subagentRows(subagents))

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
        promptTokens: turn?.promptTokens,
        streamS: turn?.streamMs ? turn.streamMs / 1000 : undefined,
        waitS: turn?.waitMs !== undefined ? turn.waitMs / 1000 : undefined,
        retries: turn?.retries,
        steps: turn?.steps,
        engine: enriched ? tier2.engine : undefined,
        subagents,
      }
      setHistory((d) => {
        d.turns = record({ turns: d.turns }, rec).turns
      }).catch((e: unknown) => dbg(`history write failed: ${String(e)}`))

      // Every step's marks, not just the last: deleting only the last left one
      // entry per earlier step behind (measured: `turns: size 1` after a
      // two-step turn), to be swept only by the 64-entry bound.
      for (const m of steps) {
        turns.delete(m.id)
        stepProvider.delete(m.id)
        stepModel.delete(m.id)
        stepReads.delete(m.id)
      }
      dbg(`turns: size ${turns.size} after completing ${info.id}`)
      // History is written unconditionally above -- every completed turn is a
      // real record. Only the panel is last-writer-wins, and only the latest
      // turn may claim it.
      if (!latest.isLatest(sessionID, seq)) {
        dbg(`report ${seq} for ${sessionID} superseded, not rendering`)
        return
      }
      show(encodeView(line), sessionID, key)
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
      // Each attempt at a step. OpenCode retries a step under the same message
      // id (measured: seven starts for one message on a busy vllm-mlx), and
      // only the final attempt's stream is the step's, so the marks restart.
      // Not a request start: this fires when the engine begins responding,
      // after prefill on MTPLX, so ttft is measured from the message instead.
      off.push(
        ctx.data.on("session.step.started", (evt) => {
          const d = (evt as { data?: { assistantMessageID?: string; model?: { providerID?: string; id?: string } } }).data
          const id = d?.assistantMessageID
          if (typeof id !== "string") return
          if (d?.model?.providerID) {
            stepProvider.set(id, d.model.providerID)
            bound(stepProvider)
          }
          if (d?.model?.id) {
            stepModel.set(id, d.model.id)
            bound(stepModel)
          }
          // A new attempt at the step: any read from an earlier attempt is not
          // this attempt's, and would block the new read (readStep keeps the
          // first read per step).
          stepReads.delete(id)
          const t = turnFor(id)
          t.firstAt = undefined
          t.lastAt = undefined
          t.attempts = (t.attempts ?? 0) + 1
        })
      )
      off.push(
        ctx.data.on("session.execution.started", (evt) => {
          const sid = (evt as { data?: { sessionID?: string } }).data?.sessionID
          if (typeof sid === "string") execStart.set(sid, Date.now())
        })
      )
      // Read engines that keep only their latest request when a step's
      // streaming ends. Not at step.ended: for a step that calls tools, that
      // fires only after the tools have run, so a tool using the same engine
      // -- a sub-agent, measured -- has replaced `latest` by then (step.ended
      // read 163 tok, the sub-agent's; step.streamed read 194, the step's
      // own). At step.streamed the engine already held the step on all five
      // steps measured. step.ended stays as a fallback for a step whose
      // stream event never arrived.
      const readStep = (id: string, moment: string): void => {
        if (stepReads.has(id)) return
        const provider = stepProvider.get(id)
        const http: HttpOptions = { signal: life.signal }
        let read: Promise<unknown> | undefined
        if (provider === "mtplx") {
          const r = fetchMtplxLatest(cfg.mtplxUrl, http).catch(() => null)
          r.then((l) => dbg(`  mtplx receipt at ${moment}: ${l?.completion_tokens ?? "none"} tok`)).catch(() => {})
          read = r
        } else if (provider === "koboldcpp" || provider === "kobold") {
          const r = fetchKoboldPerf(cfg.koboldBase, http).catch(() => null)
          r.then((p) => dbg(`  koboldcpp receipt at ${moment}: ${p?.last_token_count ?? "none"} tok`)).catch(() => {})
          read = r
        } else if (provider === "mlxserve" || provider === "mlx-serve") {
          const r = fetchMlxServeRequests(cfg.mlxServeBase, stepModel.get(id), cfg.mlxServeKey || undefined, http).catch(
            () => null
          )
          r.then((recs) => dbg(`  mlxserve receipt at ${moment}: ${recs?.[0]?.completionTokens ?? "none"} tok`)).catch(
            () => {}
          )
          read = r
        }
        if (read) {
          stepReads.set(id, read)
          bound(stepReads)
        }
      }
      const stepID = (evt: unknown): string | undefined => {
        const id = (evt as { data?: { assistantMessageID?: string } }).data?.assistantMessageID
        return typeof id === "string" ? id : undefined
      }
      off.push(
        ctx.data.on("session.step.streamed", (evt) => {
          const id = stepID(evt)
          if (id) readStep(id, "step.streamed")
        })
      )
      off.push(
        ctx.data.on("session.step.ended", (evt) => {
          const id = stepID(evt)
          if (id) readStep(id, "step.ended (fallback)")
        })
      )
      off.push(ctx.data.on("session.text.delta", mark))
      off.push(ctx.data.on("session.reasoning.delta", mark))

      // Diagnostics only (OPENCODE_HUD_DEBUG): the per-step events, to design
      // reading the engine once per step instead of once per turn. On
      // step.ended it also reads MTPLX's `latest` or vllm-mlx's counters, to
      // see whether the engine has already recorded the step by then.
      if (HUD_DEBUG) {
        type Tok = { input?: number; output?: number; reasoning?: number }
        const tk = (t: Tok | undefined): string =>
          t ? `out ${t.output ?? 0} + think ${t.reasoning ?? 0}, in ${t.input ?? 0}` : "no tokens"
        off.push(
          ctx.data.on("session.execution.started", (evt) => {
            dbg(`event execution.started ${(evt as { data?: { sessionID?: string } }).data?.sessionID ?? "?"}`)
          })
        )
        off.push(
          ctx.data.on("session.step.streamed", (evt) => {
            dbg(`event step.streamed ${(evt as { data?: { assistantMessageID?: string } }).data?.assistantMessageID ?? "?"}`)
          })
        )
        off.push(
          ctx.data.on("session.created", (evt) => {
            const d = (evt as { data?: { sessionID?: string; parentID?: string } }).data
            dbg(`event session.created ${d?.sessionID ?? "?"}${d?.parentID ? ` parent ${d.parentID}` : ""}`)
          })
        )
        off.push(
          ctx.data.on("session.execution.succeeded", (evt) => {
            dbg(`event execution.succeeded ${(evt as { data?: { sessionID?: string } }).data?.sessionID ?? "?"}`)
          })
        )
        off.push(
          ctx.data.on("session.step.started", (evt) => {
            const d = (evt as { data?: { assistantMessageID?: string; model?: { providerID?: string; id?: string } } }).data
            dbg(`event step.started ${d?.assistantMessageID ?? "?"} ${d?.model?.providerID ?? "?"}/${d?.model?.id ?? "?"}`)
          })
        )
        off.push(
          ctx.data.on("session.step.ended", (evt) => {
            const d = (evt as { data?: { assistantMessageID?: string; finish?: string; tokens?: Tok } }).data
            const id = d?.assistantMessageID ?? "?"
            const provider = stepProvider.get(id) ?? "?"
            dbg(`event step.ended ${id} ${d?.finish ?? "?"}; ${tk(d?.tokens)}`)
            const http: HttpOptions = { signal: life.signal }
            if (provider === "vllmmlx" || provider === "vllm-mlx") {
              fetchPromSample(cfg.vllmMlxBase, VLLM_MLX_SPEC, http)
                .then((p) =>
                  dbg(
                    `  probe vllmmlx at step.ended: generation ${p?.generation ?? "?"}, ttft count ${p?.ttftCount ?? "?"}, duration count ${p?.durationCount ?? "?"}`
                  )
                )
                .catch(() => {})
            }
          })
        )
        // `session.usage.recorded` (title/compaction usage) exists in the SDK
        // types but is not in the TUI plugin's subscribable event union.
      }

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
            // Two independent boxes, each opened and closed by its heading:
            // the last turn, and the session. Laid out as labelled rows, one
            // figure per line, inside a 1-cell margin and 1-cell / 1-row
            // padding on the theme's offset shade -- so they read as this
            // plugin's own blocks, not as more lines of OpenCode's sidebar.
            // The heading names the engine only: the model is already shown
            // under the prompt box.
            const stored = lineFor(panel, input.sessionID)
            const turnView: TurnView =
              stored === PLACEHOLDER ? { engine: "last turn", rows: [], notes: ["no turn yet"] } : decodeView(stored)
            const suffix = stored === PLACEHOLDER ? "" : " · last turn"
            const summary = summariseSession(history.turns, input.sessionID)
            return (
              <box flexDirection="column">
                {drawBox(turnView, suffix, !ui.collapsed, toggleCollapsed, true)}
                {summary ? drawBox(sessionView(summary), "", ui.sessionOpen === true, toggleSession, false) : null}
              </box>
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
