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
import { universalView, turnRate, turnSteps, turnUserAt, lastModel, aggregateTurn, type Turn, type Display, DEFAULT_DISPLAY } from "./universal"
import { record, historyLines, type History, type TurnRecord } from "./history"
import { emptyPanels, lineFor, keyFor, setLine, LatestPerKey, PLACEHOLDER, type Panels } from "./panels"
import { encodeView, decodeView, LABEL_WIDTH, type TurnView } from "./rows"
import { summariseSession, sessionView, sessionFigures, rollupSubagents, subagentRows } from "./session"
import { shiftBaseline, counterDelta } from "./counters"
import { buildTurnDetail, SUBAGENT_TOOLS, type TurnDetail } from "./detail"
import {
  turnLines,
  sessionLines,
  historyTabLines,
  tabsLine,
  footLine,
  dur,
  TABS,
  CONTENT_WIDTH,
  type Line,
  type Style,
  type Tab,
  type Scope,
} from "./dialog"

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
    // Each session's last turn in full, for the details dialog. Memory, like
    // the panels: the dialog describes this run; history keeps the summary.
    const [turnDetail, setTurnDetail] = ctx.storage.memory<{ bySession: Record<string, TurnDetail> }>("turnDetail", {
      initial: { bySession: {} },
    })
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
    // Measured on OpenCode 2.0.12: text is {base, muted, ...}; `muted` is
    // the grey. `subdued` is what the installed types declare.
    const subduedColor = (): Color | undefined =>
      themeColor("text.muted", "text.subdued", "textMuted") as Color | undefined
    const panelColor = (): Color | undefined =>
      // Measured on OpenCode 2.0.12: background is {base, raised:{base, high,
      // max}}. raised.base is the sidebar's own colour (the boxes rendered
      // unshaded on it), so the box takes the next step up.
      themeColor("background.raised.high", "background.surface.offset", "backgroundElement", "backgroundPanel") as
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
          // 2 columns at the sides against 1 row top and bottom: a terminal
          // cell is about twice as tall as it is wide, so this reads as even
          // padding all round (chosen from the mockup, option A).
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
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

    // ---- the details dialog ---------------------------------------------------
    // A full-detail view opened from the sidebar: the last turn (detail.ts)
    // beside the session (session.ts). Measured on 2.0.12 before it was
    // built: ui.dialog.show draws at xlarge, 116 cells on a 214-column
    // terminal; a scrollbox inside scrolls by wheel and by keys; a keymap
    // layer inside the dialog takes tab without the prompt seeing it.
    const [details, setDetails] = ctx.storage.memory<{ tab: Tab; scope: Scope; cols: number; rows: number }>(
      "details",
      { initial: { tab: "turn", scope: "session", cols: 0, rows: 0 } }
    )
    // The dialog's colours, from the theme's hue scales (measured on 2.0.12:
    // hue.{gray,blue,cyan,purple,orange,red}.{100..900}), each with a fallback.
    const styleColor = (st: Style): Color | undefined => {
      switch (st) {
        case "dim":
        case "wait":
          return subduedColor()
        case "gen":
        case "accent":
          return themeColor("hue.blue.500", "text.action.primary") as Color | undefined
        case "tool":
          return themeColor("hue.cyan.500", "hue.green.500") as Color | undefined
        case "sub":
          return themeColor("hue.purple.500") as Color | undefined
        case "comp":
          return themeColor("hue.red.400", "hue.red.500") as Color | undefined
        case "engine":
          return themeColor("hue.orange.400", "hue.yellow.500") as Color | undefined
        case "rule":
          return themeColor("hue.gray.700", "border.base") as Color | undefined
        default:
          return undefined
      }
    }
    /** One line of the dialog: a `<text>` with a span per segment. */
    const drawLine = (line: Line) => (
      <text selectable={false}>
        {line.length === 0
          ? " "
          : line.map(([t, st]) =>
              st === "bold" ? (
                <b>{t}</b>
              ) : st === "tab" ? (
                <span style={{ fg: themeColor("background.base") as Color | undefined, bg: themeColor("text.base") as Color | undefined }}>
                  {t}
                </span>
              ) : (
                <span style={{ fg: styleColor(st) }}>{t}</span>
              )
            )}
      </text>
    )
    // Whether our dialog is the one showing. The keybind toggles it: pressed
    // again while it was open, it re-opened the dialog over itself (a blink).
    let detailsOpen = false
    /**
     * Opens the dialog on `tab`. Asked again for the tab already showing, it
     * closes; asked for another tab while open, it switches.
     */
    const openDetails = (sessionID: string | undefined, tab: Tab = "turn"): void => {
      if (detailsOpen) {
        if (details.tab === tab) {
          dbg("details: toggle closed")
          ctx.ui.dialog.clear()
        } else {
          setDetails((d) => {
            d.tab = tab
          })
        }
        return
      }
      dbg(`details: open ${tab} for ${sessionID ?? "no session"}; terminal ${ctx.renderer.terminalWidth}x${ctx.renderer.terminalHeight}`)
      setDetails((d) => {
        d.tab = tab
        d.cols = ctx.renderer.terminalWidth
        d.rows = ctx.renderer.terminalHeight
      })
      // A resize re-lays the dialog out: its height follows the terminal's.
      const onResize = (cols: number, rows: number): void => {
        setDetails((d) => {
          d.cols = cols
          d.rows = rows
        })
      }
      ctx.renderer.on("resize", onResize)
      let scroll: { scrollBy?: (d: number) => void; focus?: () => void; width?: number; height?: number } | undefined
      let root: { width?: number; height?: number } | undefined
      detailsOpen = true
      ctx.ui.dialog.show(
        () => {
          // The current tab's lines, reactive on the tab, the scope and the
          // stored turn and history.
          const lines = (): Line[] => {
            if (details.tab === "turn") return turnLines(sessionID ? turnDetail.bySession[sessionID] : undefined)
            if (details.tab === "session") return sessionLines(sessionFigures(history.turns, sessionID))
            return historyTabLines(history.turns, sessionID, details.scope)
          }
          const note = (): string => {
            if (details.tab === "turn") {
              const d = sessionID ? turnDetail.bySession[sessionID] : undefined
              return d ? `${d.engine}${d.totalS !== undefined ? ` · ${dur(d.totalS)}` : ""}` : ""
            }
            if (details.tab === "session") {
              const f = sessionFigures(history.turns, sessionID)
              return f ? `${f.turns} ${f.turns === 1 ? "turn" : "turns"} · ${dur(f.elapsedS)}` : ""
            }
            return details.scope === "all" ? "all sessions" : "this session"
          }
          // Sized to the content, up to 70% of the screen less the tabs and
          // footer; it scrolls only beyond that.
          const bodyRows = (): number => Math.max(4, Math.min(lines().length, Math.floor(details.rows * 0.7) - 4))
          ctx.keymap.layer(() => ({
            mode: "global",
            priority: 100,
            commands: [
              {
                title: "Next view",
                bind: "tab",
                run: () =>
                  setDetails((d) => {
                    d.tab = TABS[(TABS.indexOf(d.tab) + 1) % TABS.length] as Tab
                  }),
              },
              {
                title: "Previous view",
                bind: "shift+tab",
                run: () =>
                  setDetails((d) => {
                    d.tab = TABS[(TABS.indexOf(d.tab) + TABS.length - 1) % TABS.length] as Tab
                  }),
              },
              {
                title: "This session / all sessions",
                bind: "s",
                run: () => {
                  if (details.tab !== "history") return false
                  setDetails((d) => {
                    d.scope = d.scope === "session" ? "all" : "session"
                  })
                },
              },
              { title: "Scroll down", bind: "down", run: () => scroll?.scrollBy?.(1) },
              { title: "Scroll up", bind: "up", run: () => scroll?.scrollBy?.(-1) },
              { title: "Page down", bind: "pagedown", run: () => scroll?.scrollBy?.(bodyRows()) },
              { title: "Page up", bind: "pageup", run: () => scroll?.scrollBy?.(-bodyRows()) },
            ],
          }))
          setTimeout(() => {
            // `large` first; if it is narrower than the content needs, `xlarge`.
            const need = CONTENT_WIDTH + 4
            if (root?.width !== undefined && root.width < need) ctx.ui.dialog.set({ size: "xlarge", centered: true })
            dbg(`details: dialog ${root?.width ?? "?"}x${root?.height ?? "?"}; body ${scroll?.width ?? "?"}x${scroll?.height ?? "?"}; ${lines().length} lines`)
          }, 200)
          return (
            <box
              flexDirection="column"
              paddingLeft={2}
              paddingRight={2}
              ref={(r: unknown) => (root = r as typeof root)}
            >
              {drawLine(tabsLine(details.tab, note()))}
              <text selectable={false}> </text>
              <scrollbox
                ref={(r: unknown) => {
                  scroll = r as typeof scroll
                  scroll?.focus?.()
                }}
                scrollY
                height={bodyRows()}
              >
                <box flexDirection="column">{lines().map((l) => drawLine(l))}</box>
              </scrollbox>
              <text selectable={false}> </text>
              {drawLine(footLine(details.tab))}
            </box>
          )
        },
        () => {
          ctx.renderer.off("resize", onResize)
          detailsOpen = false
          dbg("details: closed")
        }
      )
      ctx.ui.dialog.set({ size: "large", centered: true })
    }
    const currentSession = (): string | undefined => {
      const r = ctx.ui.router.current()
      return r.type === "session" ? r.sessionID : undefined
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
    // When each session's current reply started: the execution starting,
    // then each reply ending, since one execution can hold several replies.
    const replyStart = new Map<string, number>()
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
    // Per session: a model selected in it, for priming a session whose
    // messages don't name one yet.
    const selectedModel = new Map<string, { providerID: string; id: string }>()
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
        /** Each step's own engine reading, where the engine is read per step. */
        stepEngine?: TurnDetail["stepEngine"]
        /** A counter engine's reading at the turn's end. */
        endSample?: unknown
      },
      /** The turn's assistant messages, one per step, oldest first. */
      steps: readonly SessionMessageAssistant[],
      /**
       * Sub-agents that ran on this same engine during the turn. A
       * counter-difference engine's window holds their requests too, so its
       * check expects the turn's tokens and steps plus theirs.
       */
      sameEngine?: TurnRecord["subagents"],
      /** Compactions in the turn, each bracketed by counter readings. */
      bracketed: readonly Compaction[] = [],
      /**
       * This turn's own starting reading of a counter engine, taken when the
       * turn started. Preferred to the engine-wide baseline, which another
       * session's report -- a sub-agent's, on the same engine -- moves.
       */
      startSample?: unknown
    ): Promise<TurnView | null> {
      // Readings around each compaction on this engine, to take its request
      // back out of a counter window.
      const bracketsFor = <T extends object,>(): Array<{ before: T; after: T }> =>
        bracketed
          .filter((c) => c.provider === provider && c.before && c.after)
          .map((c) => ({ before: c.before as T, after: c.after as T }))
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
        tier2.endSample = now
        const base0 = (startSample as PromSample | undefined) ?? base.prom[id]
        const prev = base0 ? shiftBaseline(base0, bracketsFor<PromSample>()) : base0
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
          tier2.stepEngine = receipts.map((r) =>
            r
              ? {
                  decodeTokS: r.decode_tok_s ?? undefined,
                  prefillTokS: r.prefill_tok_s ?? undefined,
                  ttftS: r.ttft_s ?? undefined,
                }
              : undefined
          )
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
          tier2.endSample = now
          const base0 = (startSample as LlamaCppCounters | undefined) ?? base.llamacpp[provider]
          const prev = base0 ? shiftBaseline(base0, bracketsFor<LlamaCppCounters>()) : base0
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
          tier2.endSample = now
          const base0 = (startSample as SplashSample | undefined) ?? base.splash[cfg.splashBase]
          const prev = base0 ? shiftBaseline(base0, bracketsFor<SplashSample>()) : base0
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
            tier2.stepEngine = perfs.map((p) =>
              p ? { decodeTokS: p.last_eval_speed || undefined, prefillTokS: p.last_process_speed || undefined } : undefined
            )
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

        default: {
          const p = promTarget(provider)
          return p ? prom(p.id, p.spec, p.url, p.label) : null // no adapter: Tier 1 handles it
        }
      }
    }

    /** The Prometheus engines: baseline key, metric names, URL and label. */
    function promTarget(provider: string): { id: string; spec: PromSpec; url: string; label: string } | undefined {
      switch (provider) {
        case "vllm":
          return { id: "vllm", spec: VLLM_SPEC, url: cfg.vllmBase, label: "vLLM" }
        case "sglang":
          return { id: "sglang", spec: SGLANG_SPEC, url: cfg.sglangBase, label: "SGLang" }
        case "vllmmlx":
        case "vllm-mlx":
          return { id: "vllmmlx", spec: VLLM_MLX_SPEC, url: cfg.vllmMlxBase, label: "vllm-mlx" }
        case "aphrodite":
          return { id: "aphrodite", spec: APHRODITE_SPEC, url: cfg.aphroditeBase, label: "Aphrodite" }
        case "lmdeploy":
          return { id: "lmdeploy", spec: LMDEPLOY_SPEC, url: cfg.lmdeployBase, label: "LMDeploy" }
        default:
          return undefined
      }
    }

    /**
     * An engine's name as its own view heads it, so a turn that falls back to
     * OpenCode's figures keeps the same heading (`vllm-mlx`, not `vllmmlx`).
     * Providers with no adapter keep their id.
     */
    function engineLabel(provider: string): string {
      const known: Record<string, string> = {
        mtplx: "MTPLX",
        omlx: "oMLX",
        llamacpp: "llama.cpp",
        llamafile: "llamafile",
        splash: "Splash",
        koboldcpp: "KoboldCpp",
        kobold: "KoboldCpp",
        mlxserve: "mlx-serve",
        "mlx-serve": "mlx-serve",
      }
      return promTarget(provider)?.label ?? known[provider] ?? provider
    }

    /** Whether any adapter reads this provider's engine. */
    function hasAdapter(provider: string): boolean {
      return engineLabel(provider) !== provider || promTarget(provider) !== undefined || provider === "llamafile"
    }

    /** A turn's tool time and calls per tool name, sub-agents excluded. */
    function toolsByName(d: TurnDetail): Record<string, { s: number; n: number }> | undefined {
      const out: Record<string, { s: number; n: number }> = {}
      for (const st of d.steps) {
        for (const t of st.tools) {
          if (SUBAGENT_TOOLS.has(t.name)) continue
          const cur = out[t.name] ?? { s: 0, n: 0 }
          cur.s += t.seconds ?? 0
          cur.n += 1
          out[t.name] = cur
        }
      }
      return Object.keys(out).length > 0 ? out : undefined
    }

    // ---- baseline priming ---------------------------------------------------
    // A counter-difference engine is read at each turn's end, and that reading
    // is the next turn's baseline -- so the first turn after launch had none
    // and showed "engine telemetry from the next turn". Priming reads the one
    // engine a turn is about to use, when the turn starts, only if it has no
    // baseline yet: one localhost request per engine per run, never a sweep
    // of every configured engine. The engine counts nothing until prefill is
    // done, so the read should land first; if it lands late, the turn's token
    // check declines the window, which is no worse than having no baseline.
    const priming = new Set<string>()
    async function prime(provider: string): Promise<void> {
      if (priming.has(provider)) return
      const http: HttpOptions = { signal: life.signal }
      const t0 = Date.now()
      const done = (what: string): void => dbg(`prime ${provider}: ${what} after ${Date.now() - t0}ms`)
      priming.add(provider)
      try {
        const p = promTarget(provider)
        if (p) {
          if (base.prom[p.id]) return
          const now = await fetchPromSample(p.url, p.spec, http)
          if (!now) return done("no reading")
          // A turn's end may have set one meanwhile; that one is newer.
          setBase((d) => {
            if (!d.prom[p.id]) d.prom[p.id] = now
          })
          return done("baseline set")
        }
        switch (provider) {
          case "llamacpp":
          case "llamafile": {
            if (base.llamacpp[provider]) return
            const now = await fetchLlamaCppCounters(provider === "llamacpp" ? cfg.llamacppBase : cfg.llamafileBase, http)
            if (!now) return done("no reading")
            setBase((d) => {
              if (!d.llamacpp[provider]) d.llamacpp[provider] = now
            })
            return done("baseline set")
          }
          case "splash": {
            if (base.splash[cfg.splashBase]) return
            const now = await fetchSplashSample(cfg.splashBase, http)
            if (!now) return done("no reading")
            setBase((d) => {
              if (!d.splash[cfg.splashBase]) d.splash[cfg.splashBase] = now
            })
            return done("baseline set")
          }
          case "omlx": {
            if (base.omlx) return
            const now = await fetchOmlxSample(cfg.omlxBase, cfg.omlxKey, http)
            if (!now) return done("no reading")
            setBase((d) => {
              if (!d.omlx) d.omlx = now
            })
            return done("baseline set")
          }
        }
      } catch (e: unknown) {
        dbg(`prime ${provider} threw: ${String(e)}`)
      } finally {
        priming.delete(provider)
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

    // Compactions per session, epoch ms: OpenCode summarising the conversation
    // to fit the context, as a request of its own to the same engine. Kept to
    // name them in a turn's time and as the reason a counter window held more
    // than the turn (measured: a Splash turn with a sub-agent declined as
    // "overlapping requests"; the transcript showed a compaction in it).
    //
    // For an engine that publishes cumulative counters, each compaction is
    // also bracketed by a reading of its own at start and end, so its request
    // can be taken back out of the turn's window (see counters.ts) instead of
    // the whole turn being declined.
    interface Compaction {
      start: number
      end?: number
      provider?: string
      before?: unknown
      after?: unknown
    }
    const compactions = new Map<string, Compaction[]>()
    // Each session's reading of its counter engine when its current turn
    // started. The engine-wide baseline alone can't bracket a turn: a
    // sub-agent on the same engine reports first, moving it to after the
    // sub-agent, and the parent's window then held only its last step
    // (found by the end-to-end suite; live, it read as "overlapping requests").
    const turnStart = new Map<string, { provider: string; sample: unknown }>()
    const compactionsOverlapping = (sessionID: string, from: number, to: number): Compaction[] =>
      (compactions.get(sessionID) ?? []).filter((c) => (c.end ?? to) > from && c.start < to)
    const compactionsIn = (sessionID: string, from: number, to: number): Array<readonly [number, number]> =>
      compactionsOverlapping(sessionID, from, to).map((c) => [Math.max(c.start, from), Math.min(c.end ?? to, to)] as const)
    /** A cumulative-counter engine's reading, for bracketing a compaction. */
    const readCounters = (provider: string): Promise<unknown> | undefined => {
      const http: HttpOptions = { signal: life.signal }
      const p = promTarget(provider)
      if (p) return fetchPromSample(p.url, p.spec, http)
      if (provider === "llamacpp") return fetchLlamaCppCounters(cfg.llamacppBase, http)
      if (provider === "llamafile") return fetchLlamaCppCounters(cfg.llamafileBase, http)
      if (provider === "splash") return fetchSplashSample(cfg.splashBase, http)
      // oMLX publishes running averages, which can't be subtracted.
      return undefined
    }

    // Replies already reported, by their last step's id. A reply is reported
    // when its last step ends, and again asked for when the execution ends;
    // it must render once.
    const reported = new Set<string>()
    /**
     * One reply: the user message's steps, ending at `endID` (the step that
     * ended the reply) or at the latest step. `outcome` is set when the
     * execution was interrupted or failed before the reply finished.
     */
    async function report(
      sessionID: string,
      opts: { endID?: string; outcome?: "interrupted" | "failed" } = {}
    ): Promise<void> {
      // `message.list()` is a union of message kinds and its tail after a turn
      // is an "idle" marker, not the reply — measured, see audit P1. Scan
      // backwards for the assistant message.
      const msgs = ctx.data.session.message.list(sessionID)
      if (!msgs) return
      // The turn is every assistant message since the last user message: one
      // per step when it calls tools. Reading only the last one showed
      // `140 tok  10.20s` for a 316-token, 37s turn (measured, vllm-mlx).
      const steps = turnSteps(msgs, opts.endID)
      const lastID = steps[steps.length - 1]?.id
      if (!lastID || reported.has(lastID)) return
      reported.add(lastID)
      if (reported.size > 64) {
        const oldest = reported.values().next().value
        if (oldest !== undefined) reported.delete(oldest)
      }
      const seq = latest.begin(sessionID)
      // The reply started when the execution did -- or, for a message queued
      // behind an earlier reply in the same execution, when that reply ended,
      // or when the message was sent if that is later.
      const userAt = turnUserAt(msgs, opts.endID)
      const since = replyStart.get(sessionID)
      const start = since !== undefined && userAt !== undefined ? Math.max(since, userAt) : (since ?? userAt)
      const agg = aggregateTurn(steps, turns, {
        execStart: start,
        endAt: opts.outcome ? Date.now() : undefined,
      })
      replyStart.set(sessionID, Date.now())
      const info = agg.info
      const turn = agg.turn
      if (!info) return
      dbg(`report: ${sessionID} ending ${lastID}${opts.outcome ? ` (${opts.outcome})` : ""}; ${steps.length} step(s)`)
      const turnCompactions = compactionsIn(sessionID, info.time.created, Date.now())
      if (turnCompactions.length > 0) {
        dbg(`  compaction during turn: ${turnCompactions.map(([a, b]) => `${((b - a) / 1000).toFixed(2)}s`).join(", ")}`)
      }
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
        show(encodeView({ engine: engineLabel(provider), rows: [], notes: ["…"] }), sessionID, key)
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

      const tier2: {
        pendingBaseline: boolean
        sharedWindow: boolean
        engine?: TurnRecord["engine"]
        stepEngine?: TurnDetail["stepEngine"]
        endSample?: unknown
      } = {
        pendingBaseline: false,
        sharedWindow: false,
      }
      let line: TurnView | null = null
      try {
        // An unfinished reply's last step never completed, so the engine has
        // no reading of it to check against: OpenCode's figures only.
        const bracketed = compactionsOverlapping(sessionID, info.time.created, Date.now())
        if (bracketed.some((c) => c.before && c.after)) dbg(`  taking ${bracketed.length} compaction(s) out of the window`)
        const start = turnStart.get(sessionID)
        const startSample = start?.provider === provider ? start.sample : undefined
        if (!opts.outcome) {
          line = await enrich(provider, model, info, turn, http, tier2, steps, sameEngine, bracketed, startSample)
        }
        // The end of this reply starts the next one in the same execution.
        if (tier2.endSample) turnStart.set(sessionID, { provider, sample: tier2.endSample })
        else turnStart.delete(sessionID)
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
          engineLabel(provider),
          info,
          turn,
          cfg.display,
          cfg.display.context ? contextLimitFor(provider, model) : undefined
        )
        // Say why this turn looks different from the next one. The figures
        // above are measured and complete; only their SOURCE changes once a
        // baseline exists, and the rate in particular can move an order of
        // magnitude when it does. Split to fit the box's 32 cells.
        if (!opts.outcome && tier2.sharedWindow && turnCompactions.length > 0) {
          line.notes.push("engine data skipped:", "compaction ran this turn")
        } else if (opts.outcome) {
          // OpenCode records no tokens for a step it stopped mid-stream
          // (measured: an interrupted reply's step came back 0/error after 7s
          // of thinking), so a 0 here is unknown, not none.
          const out0 = (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
          if (out0 === 0) line.rows = line.rows.filter(([label]) => label !== "tokens" && label !== "speed")
          line.notes.push(opts.outcome)
        } else if (tier2.pendingBaseline) line.notes.push("engine telemetry", "from the next turn")
        else if (tier2.sharedWindow) line.notes.push("engine data skipped:", "overlapping requests")
      }

      // The turn in full, for the dialog. Built before the stream marks are
      // released below, and from the rows before sub-agent rows join them:
      // those are OpenCode's, kept in the detail's own sub-agent section.
      let detail: TurnDetail | undefined
      try {
        detail = buildTurnDetail(steps, turns, {
          sessionID,
          provider,
          model,
          engine: engineLabel(provider),
          at: Date.now(),
          totalS: turnRate(0, info, turn).total,
          outcome: opts.outcome,
          contextLimit: contextLimitFor(provider, model),
          engineRows: enriched ? [...(line.detail ?? line.rows)] : [],
          engineNote: enriched ? undefined : [...line.notes],
          stepEngine: enriched ? tier2.stepEngine : undefined,
          compactions: turnCompactions,
          compactionEngine: compactionsOverlapping(sessionID, info.time.created, Date.now()).flatMap((c) => {
            if (!c.before || !c.after || c.provider !== provider) return []
            const d = counterDelta(c.before as object, c.after as object) as Record<string, number | undefined>
            const read = d["prefillTokens"] ?? d["promptTokens"] ?? d["prompt"]
            const wrote = d["decodeTokens"] ?? d["predictedTokens"] ?? d["generation"]
            return read !== undefined || wrote !== undefined
              ? [`${read !== undefined ? `${Math.round(read).toLocaleString("en-US")} tok read` : ""}${read !== undefined && wrote !== undefined ? " · " : ""}${wrote !== undefined ? `${Math.round(wrote).toLocaleString("en-US")} written` : ""}`]
              : []
          }),
          subagents,
        })
        const dd = detail
        dbg(
          `detail: ${dd.steps.length} step(s); tools [${dd.steps.flatMap((st) => st.tools.map((t) => `${t.name}:${t.seconds?.toFixed(2) ?? t.status}`)).join(", ")}]` +
            (dd.time ? `; split ${Object.entries(dd.time).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")} of ${dd.totalS?.toFixed(2)}` : "")
        )
        setTurnDetail((d) => {
          d.bySession[sessionID] = dd
          const keys = Object.keys(d.bySession)
          if (keys.length > 32) {
            const oldest = keys.sort((a, b) => (d.bySession[a]?.at ?? 0) - (d.bySession[b]?.at ?? 0))[0]
            if (oldest) delete d.bySession[oldest]
          }
        })
      } catch (e: unknown) {
        dbg(`detail threw: ${String(e)}`)
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
        outcome: opts.outcome,
        // For the dialog's session column.
        cacheWrite: detail?.tokens.cacheWrite || undefined,
        toolsS: detail?.time?.tools,
        compactionS: detail?.time?.compaction || undefined,
        tools: detail ? toolsByName(detail) : undefined,
        retryReasons: detail?.steps.flatMap((st) => (st.retryReason ? [st.retryReason] : [])),
        skip: enriched
          ? undefined
          : opts.outcome
            ? "unfinished"
            : tier2.pendingBaseline
              ? "baseline"
              : tier2.sharedWindow
                ? turnCompactions.length > 0
                  ? "compaction"
                  : "overlap"
                : hasAdapter(provider)
                  ? "unavailable"
                  : "no-adapter",
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
          if (typeof sid !== "string") return
          replyStart.set(sid, Date.now())
          // The engine this turn will use: the session's last model, or one
          // just selected. A new session on the default model has neither,
          // and its first turn goes unprimed, as before.
          const m = selectedModel.get(sid) ?? lastModel(ctx.data.session.message.list(sid) ?? [])
          dbg(`prime lookup ${sid}: ${m ? `${m.providerID}/${m.id}` : "no model known"}`)
          if (m) void prime(m.providerID)
          const read = m ? readCounters(m.providerID) : undefined
          turnStart.delete(sid)
          if (m && read) {
            read
              .then((sample) => {
                if (sample) turnStart.set(sid, { provider: m.providerID, sample })
                if (turnStart.size > 64) {
                  const oldest = turnStart.keys().next().value
                  if (oldest !== undefined && oldest !== sid) turnStart.delete(oldest)
                }
              })
              .catch(() => {})
          }
        })
      )
      off.push(
        ctx.data.on("session.model.selected", (evt) => {
          const d = (evt as { data?: { sessionID?: string; model?: { providerID?: string; id?: string } } }).data
          if (typeof d?.sessionID === "string" && d.model?.providerID && d.model.id) {
            selectedModel.set(d.sessionID, { providerID: d.model.providerID, id: d.model.id })
            bound(selectedModel)
          }
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
          if (!id) return
          if (HUD_DEBUG) {
            const t = turns.get(id)
            const now = Date.now()
            dbg(
              `  stream window ${id}: ${t?.firstAt !== undefined && t.lastAt !== undefined ? ((t.lastAt - t.firstAt) / 1000).toFixed(2) : "?"}s; ` +
                `last mark ${t?.lastAt !== undefined ? now - t.lastAt : "?"}ms before step.streamed; tool deltas ${toolDeltas.get(id) ?? 0}`
            )
            toolDeltas.delete(id)
          }
          readStep(id, "step.streamed")
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
      // A tool call's arguments are generated tokens too, counted in the
      // step's output. Unwatched, a step that wrote a file had its tokens
      // divided by only its text's streaming time (measured: 3,672 tokens "at
      // 162.9 tok/s" on a `write` step, against the engine's 36.4 for the
      // turn), inflating the session's speed. The argument deltas never
      // reach a plugin (measured: 0 on every step of an 8-step turn that
      // wrote a file); the start and end of the arguments do, and with them
      // the window's last mark lands 0-1ms before the stream ends. Session
      // 36.4 tok/s against the engine's 36.1, from 55.1 against 36.4. The
      // delta subscription is kept in case a later OpenCode forwards them.
      const toolDeltas = new Map<string, number>()
      off.push(
        ctx.data.on("session.tool.input.delta", (evt) => {
          mark(evt)
          const id = stepID(evt)
          if (id) toolDeltas.set(id, (toolDeltas.get(id) ?? 0) + 1)
        })
      )
      off.push(ctx.data.on("session.tool.input.started", mark))
      off.push(ctx.data.on("session.tool.input.ended", mark))

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
      // A reply ends when a step ends with a final answer. That is
      // its own turn even if the execution goes on: a message sent while it
      // ran is queued into the same execution, which then only ends -- or is
      // interrupted -- after the next reply (measured: a 19m 53s reply never
      // reported, because its execution ended interrupted 20m in).
      off.push(
        ctx.data.on("session.step.ended", (evt) => {
          const d = (evt as { data?: { sessionID?: string; assistantMessageID?: string; finish?: string } }).data
          if (typeof d?.sessionID !== "string" || typeof d.assistantMessageID !== "string") return
          // Not "error" or "unknown": OpenCode retries a step under the same
          // message id, and a failed attempt must not end the reply before
          // the retry does. The execution's own end catches those.
          if (d.finish !== "stop" && d.finish !== "length" && d.finish !== "content-filter") return
          const sid = d.sessionID
          const id = d.assistantMessageID
          // After the host has applied the step to the message it ends.
          setTimeout(() => {
            const m = ctx.data.session.message.get(sid, id) as SessionMessageAssistant | undefined
            dbg(`reply ended ${id} (${d.finish}); completed ${m?.time?.completed !== undefined}, tokens ${m?.tokens?.output ?? "?"}`)
            report(sid, { endID: id }).catch((e: unknown) => dbg(`report threw: ${String(e)}`))
          }, 50)
        })
      )
      // Compactions: when each started and ended, per session.
      const compactionEvent =
        (end: boolean) =>
        (evt: unknown): void => {
          const sid = (evt as { data?: { sessionID?: string } }).data?.sessionID
          if (typeof sid !== "string") return
          const list = compactions.get(sid) ?? []
          let c: Compaction | undefined
          if (end) {
            c = list.find((x) => x.end === undefined)
            if (c) c.end = Date.now()
          } else {
            const provider = lastModel(ctx.data.session.message.list(sid) ?? [])?.providerID
            c = { start: Date.now(), provider }
            list.push(c)
            // A session compacts rarely; the last few are all a turn can need.
            while (list.length > 8) list.shift()
          }
          const target = c
          const read = target?.provider ? readCounters(target.provider) : undefined
          if (target && read) {
            read
              .then((sample) => {
                if (end) target.after = sample ?? undefined
                else target.before = sample ?? undefined
                dbg(`  compaction ${end ? "after" : "before"} reading (${target.provider}): ${sample ? "ok" : "none"}`)
              })
              .catch(() => {})
          }
          compactions.set(sid, list)
          if (compactions.size > 64) {
            const oldest = compactions.keys().next().value
            if (oldest !== undefined && oldest !== sid) compactions.delete(oldest)
          }
          dbg(`event compaction.${end ? "ended" : "started"} ${sid}`)
        }
      off.push(ctx.data.on("session.compaction.started", compactionEvent(false)))
      off.push(ctx.data.on("session.compaction.ended", compactionEvent(true)))
      off.push(ctx.data.on("session.compaction.failed", compactionEvent(true)))
      // An execution stopped before its reply finished still used the engine;
      // the reply is shown, marked, rather than leaving the previous turn up.
      off.push(
        ctx.data.on("session.execution.interrupted", (evt) => {
          const sid = (evt as { data?: { sessionID?: string } }).data?.sessionID
          if (typeof sid === "string") {
            dbg(`event execution.interrupted ${sid}`)
            report(sid, { outcome: "interrupted" }).catch((e: unknown) => dbg(`report threw: ${String(e)}`))
          }
        })
      )
      off.push(
        ctx.data.on("session.execution.failed", (evt) => {
          const sid = (evt as { data?: { sessionID?: string } }).data?.sessionID
          if (typeof sid === "string") {
            dbg(`event execution.failed ${sid}`)
            report(sid, { outcome: "failed" }).catch((e: unknown) => dbg(`report threw: ${String(e)}`))
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
          id: "headsup.details",
          title: "Show Inference Details",
          description: "Open the full per-turn and session telemetry",
          group: "opencode-headsup",
          bind: "ctrl+shift+d",
          palette: true,
          // `/headsup`, `/headsup session`, `/headsup history`: the rest of the
          // line picks the tab (arguments: true passes it through).
          slash: { name: "headsup", arguments: true },
          run: (input) => {
            const arg = (input ?? "").trim().toLowerCase()
            const tab: Tab = arg.startsWith("s") ? "session" : arg.startsWith("h") ? "history" : "turn"
            if (arg) dbg(`details: /headsup ${arg} -> ${tab}`)
            openDetails(currentSession(), tab)
          },
        },
        {
          id: "headsup.panel",
          title: "Show Inference History",
          description: "Open or close the per-turn telemetry drill-down",
          group: "opencode-headsup",
          bind: "ctrl+shift+h",
          palette: true,
          // The history panel is retired in favour of the dialog's History
          // tab, which knows its width and never wraps a row. The panel's
          // code stays (see the session.panel slot) for one release, in case
          // the tab is missing something; this key now opens the tab.
          run: () => {
            openDetails(currentSession(), "history")
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
                {/* On release, not press: opened on press, the dialog's backdrop
                    took the release as a click outside and closed it at once
                    (measured: open and close 1ms apart). */}
                <text selectable={false} marginTop={1} marginLeft={3} onMouseUp={() => openDetails(input.sessionID)}>
                  <span style={{ fg: themeColor("text.action.primary", "hue.blue.500") as Color | undefined }}>details ›</span>
                </text>
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
            // One text, wrapped by the host. A line per row with
            // wrapMode="none" and truncate was tried (OpenCode 2.0.12): it
            // cut rows in the middle with "..." and left stale cells from
            // earlier frames on resize, so rows read as garbage.
            input.name === PANEL_NAME ? <text>{historyLines(history.turns).join("\n")}</text> : null,
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
