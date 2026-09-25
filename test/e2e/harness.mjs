// End-to-end harness: runs the real entry file against a fake OpenCode.
//
// `tui.tsx` is imported as OpenCode loads it, and its `setup` is called with a
// fake Context: storage that behaves like the host's, an event bus for
// `ctx.data.on`, and a session message store the test fills as a turn goes.
// Engines are served over real HTTP from whatever the test sets, so the
// adapters' fetch, parse and check paths all run. Time is a fake clock the
// test advances, so rates and durations are exact.
//
// Nothing is rendered: slot claims are recorded, not drawn. Assertions read
// what the plugin stored for the UI -- the sidebar view per session, the
// history rows, the dialog's turn detail -- which is what the user sees.

import { lineFor } from "../../panels.ts"
import { decodeView } from "../../rows.ts"

// ---- the clock ----------------------------------------------------------------

let now = Date.UTC(2026, 8, 25, 12, 0, 0)
Date.now = () => now
export const clock = {
  get: () => now,
  /** Advances the fake clock by `ms`. */
  advance(ms) {
    now += ms
  },
}

/** Lets pending promises, HTTP round trips and short timers run. */
export const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

// ---- the fake engine ------------------------------------------------------------

/**
 * A local HTTP server answering from `routes`: path -> string (served as
 * text) or object (served as JSON) or undefined (404). Tests change routes
 * between events, as a real engine's counters change.
 */
export function engineServer() {
  const routes = {}
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      const body = routes[path]
      if (body === undefined) return new Response("not found", { status: 404 })
      return typeof body === "string"
        ? new Response(body, { headers: { "content-type": "text/plain" } })
        : Response.json(body)
    },
  })
  return { routes, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

// ---- the fake host ----------------------------------------------------------------

/**
 * Starts the plugin. Returns helpers to drive sessions and turns, and to read
 * what the plugin stored for the UI.
 */
export async function startPlugin(options = {}) {
  delete process.env.OPENCODE_HUD_DEBUG
  const plugin = (await import("../../tui.tsx")).default

  const handlers = new Map()
  const emit = (type, data) => {
    for (const h of handlers.get(type) ?? []) h({ type, data })
  }
  const memory = new Map()
  const makeStore = (durable) => (key, { initial }) => {
    if (!memory.has(key)) memory.set(key, structuredClone(initial))
    const value = memory.get(key)
    const set = (mutate) => {
      mutate(value)
      return durable ? Promise.resolve() : undefined
    }
    return [value, set]
  }

  const messages = new Map() // sessionID -> message[]
  const sessions = new Map() // sessionID -> { id, parentID }
  const claims = []
  let route = { type: "home" }

  const ctx = {
    options,
    location: undefined,
    storage: { memory: makeStore(false), store: makeStore(true) },
    theme: {},
    themeMode: "dark",
    renderer: { terminalWidth: 200, terminalHeight: 50, on() {}, off() {} },
    data: {
      on(type, handler) {
        if (!handlers.has(type)) handlers.set(type, [])
        handlers.get(type).push(handler)
        return () => handlers.set(type, handlers.get(type).filter((h) => h !== handler))
      },
      listen: () => () => {},
      session: {
        list: () => [...sessions.values()],
        get: (id) => sessions.get(id),
        root: (id) => {
          let s = sessions.get(id)
          while (s?.parentID) s = sessions.get(s.parentID)
          return s?.id ?? id
        },
        family(id) {
          const root = ctx.data.session.root(id)
          return [...sessions.keys()].filter((s) => ctx.data.session.root(s) === root)
        },
        cost: () => 0,
        status: () => "idle",
        message: {
          list: (sid) => messages.get(sid) ?? [],
          get: (sid, mid) => (messages.get(sid) ?? []).find((m) => m.id === mid),
        },
      },
      location: {
        model: { list: () => options.__models ?? [] },
      },
    },
    ui: {
      slot(claim) {
        claims.push(claim)
        return () => {}
      },
      dialog: { show() {}, set() {}, clear() {} },
      toast: {},
      router: { current: () => route },
      panel: { open: () => true, close() {}, current: () => undefined },
    },
    keymap: { layer() {} },
  }

  const dispose = plugin.setup(ctx)

  let seq = 0
  const id = (p) => `${p}_${String(++seq).padStart(4, "0")}`

  const h = {
    ctx,
    claims,
    emit,
    dispose,
    /** Opens a session (optionally a sub-agent of `parentID`). */
    session(sid, parentID) {
      sessions.set(sid, { id: sid, parentID })
      messages.set(sid, messages.get(sid) ?? [])
      if (parentID) emit("session.created", { sessionID: sid, parentID })
      route = { type: "session", sessionID: sid }
      return sid
    },
    /** The user sends a message. */
    user(sid, text = "…") {
      messages.get(sid).push({ type: "user", id: id("usr"), text, time: { created: now } })
    },
    /** An earlier reply in the session, so it names its model (for priming). */
    earlier(sid, providerID, modelID) {
      messages.get(sid).push({ type: "user", id: id("usr"), text: "earlier", time: { created: now - 60_000 } })
      messages.get(sid).push({
        type: "assistant", id: id("msg"), agent: "build", model: { providerID, id: modelID },
        time: { created: now - 59_000, completed: now - 50_000 }, finish: "stop", content: [],
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    },
    /** A model switch recorded in the session, as OpenCode shows it. */
    switchModel(sid, providerID, modelID) {
      messages.get(sid).push({ type: "model-switched", id: id("sw"), time: { created: now }, model: { providerID, id: modelID } })
    },
    executionStarted(sid) {
      emit("session.execution.started", { sessionID: sid })
    },
    executionSucceeded(sid) {
      emit("session.execution.succeeded", { sessionID: sid })
    },
    executionInterrupted(sid) {
      emit("session.execution.interrupted", { sessionID: sid, reason: "user" })
    },
    compaction(sid, which) {
      emit(`session.compaction.${which}`, { sessionID: sid, reason: "auto" })
    },
    /**
     * One step, as OpenCode runs it: the request, a wait for the first token,
     * streaming, then the step ending -- and after it, each tool running.
     *
     * - `provider`, `model`: the engine
     * - `ttftMs`, `streamMs`: wait for the first token, then streaming
     * - `argsMs`: of the streaming, time spent writing tool arguments at the
     *   end (arrives as tool.input.started/ended, never as deltas)
     * - `tokens`: { output, reasoning, input, cache: { read, write } }
     * - `finish`: "stop" | "tool-calls" | ...
     * - `tools`: [{ name, ms }] run after the step ends
     * - `beforeStreamed`: a hook run just before step.streamed, where a test
     *   sets what a per-step engine will answer with
     * - `interruptAfterMs`: stop streaming after this long, without ending
     */
    async step(sid, s) {
      const mid = id("msg")
      const msg = {
        type: "assistant",
        id: mid,
        agent: "build",
        model: { providerID: s.provider, id: s.model },
        time: { created: now },
        content: [],
      }
      messages.get(sid).push(msg)
      clock.advance(s.ttftMs ?? 0)
      emit("session.step.started", { sessionID: sid, assistantMessageID: mid, model: msg.model })
      emit(s.reasoningFirst ? "session.reasoning.delta" : "session.text.delta", { sessionID: sid, assistantMessageID: mid, delta: "x" })
      if (s.interruptAfterMs !== undefined) {
        clock.advance(s.interruptAfterMs)
        emit("session.text.delta", { sessionID: sid, assistantMessageID: mid, delta: "x" })
        msg.finish = "error"
        msg.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        return mid
      }
      const argsMs = s.argsMs ?? 0
      clock.advance((s.streamMs ?? 0) - argsMs)
      emit("session.text.delta", { sessionID: sid, assistantMessageID: mid, delta: "x" })
      if (argsMs > 0) {
        emit("session.tool.input.started", { sessionID: sid, assistantMessageID: mid, id: "call", name: s.tools?.[0]?.name ?? "write" })
        clock.advance(argsMs)
        emit("session.tool.input.ended", { sessionID: sid, assistantMessageID: mid, id: "call", text: "{}" })
      }
      if (s.beforeStreamed) await s.beforeStreamed()
      msg.tokens = s.tokens
      msg.finish = s.finish ?? "stop"
      msg.time.completed = now
      emit("session.step.streamed", { sessionID: sid, assistantMessageID: mid })
      await settle(40)
      emit("session.step.ended", {
        sessionID: sid,
        assistantMessageID: mid,
        finish: msg.finish,
        tokens: s.tokens,
        cost: 0,
      })
      for (const t of s.tools ?? []) {
        const start = now
        // A tool that does its own work meanwhile -- a sub-agent's turn.
        if (t.run) await t.run()
        clock.advance(t.ms ?? 0)
        msg.content.push({ type: "tool", id: id("tool"), name: t.name, state: { status: "completed" }, time: { created: start, ran: start, completed: now } })
      }
      return mid
    },
    // ---- what the user sees ----
    /** The sidebar's last-turn box for a session, as the plugin stored it. */
    sidebar(sid) {
      return decodeView(lineFor(memory.get("panels"), sid))
    },
    history() {
      return memory.get("history").turns
    },
    detail(sid) {
      return memory.get("turnDetail").bySession[sid]
    },
    /** Releases the plugin. The fake clock stays: every test runs on it. */
    restore() {
      dispose?.()
    },
  }
  return h
}

/** Rows of a view as a label -> value map (first row per label). */
export const rowsOf = (view) => Object.fromEntries(view.rows.filter(([l]) => l).map(([l, v]) => [l, v]).reverse())

// ---- a tiny runner, like the other suites ----------------------------------------

let passed = 0
let failed = 0
export async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log("  ok ", name)
  } catch (e) {
    failed++
    console.log("  FAIL", name, "\n      ", e.message)
    process.exitCode = 1
  }
}
export const done = () => console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`)

// ---- a Splash engine's counters ------------------------------------------------------

/**
 * Splash's cumulative counters, as its /metrics text. `add` moves them the
 * way one completed request does.
 */
export function splashCounters() {
  const c = { requests: 0, decode: 0, decodeMs: 0, prefill: 0, prefillMs: 0, reused: 0 }
  return {
    c,
    add({ output, input = 100, decodeMs = 1_000, prefillMs = 200 }) {
      c.requests += 1
      c.decode += output
      c.decodeMs += decodeMs
      c.prefill += input
      c.prefillMs += prefillMs
    },
    text: () =>
      [
        "splash_info 1",
        `splash_requests_completed_total ${c.requests}`,
        `splash_decode_output_tokens_total ${c.decode}`,
        `splash_decode_wall_milliseconds_total ${c.decodeMs}`,
        `splash_prefill_input_tokens_total ${c.prefill}`,
        `splash_prefill_wall_milliseconds_total ${c.prefillMs}`,
        `splash_cache_reused_tokens_total ${c.reused}`,
        "splash_drafted_tokens_total 0",
        "splash_accepted_draft_tokens_total 0",
      ].join("\n"),
  }
}
