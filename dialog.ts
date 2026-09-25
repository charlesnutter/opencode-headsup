// The details dialog's content: three tabs laid out as styled lines.
//
// Pure, like the other shared modules: the entry file only draws what this
// returns, one `<text>` per line with a colour per segment. Every line fits
// `width` cells, so nothing wraps and the dialog can be sized to its content.
//
// The layout follows the approved mockup (option A): one column, a rule under
// each section title, bars for shares, bold values beside dim labels, aligned
// tables. A figure whose data is absent is left out, never shown as 0.

import type { TurnDetail } from "./detail"
import { percents, ENGINE_MARK, wrap } from "./detail"
import { quantile, sparkline, SKIP_LABEL, type SessionFigures } from "./session"
import type { TurnRecord } from "./history"

export type Style = "" | "dim" | "bold" | "accent" | "engine" | "gen" | "wait" | "tool" | "sub" | "comp" | "rule" | "tab"
export type Seg = readonly [text: string, style: Style]
export type Line = Seg[]

export type Tab = "turn" | "session" | "history"
export const TABS: readonly Tab[] = ["turn", "session", "history"]
export type Scope = "session" | "all"

/** The content width, in cells. The dialog adds its own padding around it. */
export const CONTENT_WIDTH = 72
const LABEL = 12

export const width = (l: Line): number => l.reduce((n, [t]) => n + t.length, 0)

// ---- figures -------------------------------------------------------------------

const n0 = (v: number): string => Math.round(v).toLocaleString("en-US")
const n1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1)
/** Seconds as `42.75s`, or `7m 57s` from a minute up. */
export const dur = (s: number): string =>
  s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(2)}s`
const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** A share as a percent that never rounds a real part to 0 or the rest to 100. */
export const share = (part: number, whole: number): string => {
  if (whole <= 0) return "0%"
  const p = (part / whole) * 100
  if (p > 0 && p < 1) return "<1%"
  if (p < 100 && p > 99) return `${p.toFixed(1)}%`
  return `${Math.round(p)}%`
}

// ---- building blocks ----------------------------------------------------------

/** A section title, a rule to the width, and an optional note at the right. */
export function heading(title: string, w: number, right = ""): Line {
  const fill = w - title.length - 1 - (right ? right.length + 1 : 0)
  const line: Line = [[title, "bold"], [" ", ""], ["─".repeat(Math.max(0, fill)), "rule"]]
  if (right) line.push([` ${right}`, "dim"])
  return line
}

/** Width of the value column, right-aligned, where a row's value lines up with others. */
const VALUE = 9
/** Where a row's bar (or its note) starts: after the label and value columns, and a gap. */
const BAR_AT = LABEL + VALUE + 3

/** `label` dim, then `value` bold and right-aligned in the value column. */
export function valueRow(label: string, value: string): Line {
  return [[label.padEnd(LABEL), "dim"], [value.padStart(VALUE), "bold"]]
}

/**
 * The grid every figure row uses: label, value right-aligned in the value
 * column, and what follows (a unit, a note, a bar) from a fixed column.
 */
export function gridRow(label: string, value: string, tail: Line | string = []): Line {
  const head = valueRow(label, value)
  const rest: Line = typeof tail === "string" ? (tail ? [[tail, "dim"]] : []) : tail
  return rest.length > 0 ? [...head, [" ".repeat(BAR_AT - width(head)), ""], ...rest] : head
}

/** A heading and the blank row under it: every section opens this way. */
export const titled = (title: string, w: number, right = ""): Line[] => [heading(title, w, right), []]

/** `label` dim in its column, `value` bold, `tail` dim. */
export function row(label: string, value: string, tail = ""): Line {
  const line: Line = [[label.padEnd(LABEL), "dim"], [value, "bold"]]
  if (tail) line.push([tail, "dim"])
  return line
}

/**
 * A stacked bar of `cells` cells: each part's share of the whole, rounded so
 * the parts fill the bar exactly. A part with any time gets at least a cell,
 * so a small but real share does not vanish.
 */
export function bar(parts: ReadonlyArray<readonly [value: number, style: Style, glyph: string]>, cells: number): Line {
  const total = parts.reduce((a, [v]) => a + Math.max(0, v), 0)
  if (total <= 0 || cells <= 0) return [[" ".repeat(Math.max(0, cells)), ""]]
  const raw = parts.map(([v]) => (Math.max(0, v) / total) * cells)
  const n = raw.map((r) => (r > 0 && r < 1 ? 1 : Math.floor(r)))
  let left = cells - n.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    if (raw[i] as number >= 1) {
      n[i] = (n[i] as number) + 1
      left--
    }
  }
  // Rounding a part up can overshoot; take it back from the largest.
  while (left < 0) {
    const i = n.indexOf(Math.max(...n))
    n[i] = (n[i] as number) - 1
    left++
  }
  return parts.flatMap(([, style, glyph], i) => ((n[i] as number) > 0 ? [[glyph.repeat(n[i] as number), style] as const] : []))
}

// Bars are drawn with a line glyph, not full blocks: a full block fills its
// whole row and touched the text above and below (measured: the dialog read
// as cramped). Parts are told apart by colour; the legend marks each with ■.
const BAR = "━"
const GLYPH = { waiting: BAR, generating: BAR, tools: BAR, subagents: BAR, compaction: BAR, other: BAR } as const
const STYLE: Record<keyof typeof GLYPH, Style> = {
  waiting: "wait",
  generating: "gen",
  tools: "tool",
  subagents: "sub",
  compaction: "comp",
  other: "dim",
}
const NAME: Record<keyof typeof GLYPH, string> = {
  waiting: "waiting",
  generating: "generating",
  tools: "tools",
  subagents: "sub-agents",
  compaction: "compaction",
  other: "other",
}

/** Where the time went: a bar, then a legend in two columns with seconds and shares. */
function timeSplit(
  t: { waiting: number; generating: number; tools: number; subagents: number; compaction: number; other: number },
  total: number,
  w: number
): Line[] {
  const keys = (Object.keys(GLYPH) as Array<keyof typeof GLYPH>).filter(
    (k) => t[k] > 0 || k === "waiting" || k === "generating"
  )
  const pct = percents(keys.map((k) => t[k]))
  const out: Line[] = [...titled("Where the time went", w, dur(total))]
  // The bar and legend start at the label column, and each legend value ends
  // where every other row's value does.
  out.push(bar(keys.map((k) => [t[k], STYLE[k], GLYPH[k]] as const), w))
  const cell = (k: keyof typeof GLYPH, i: number): Line => [
    ["■", STYLE[k]],
    [` ${NAME[k].padEnd(LABEL - 2)}`, "dim"],
    [dur(t[k]).padStart(VALUE), "bold"],
    [(pct[i] === 0 && t[k] > 0 ? "<1%" : `${pct[i]}%`).padStart(5), "dim"],
  ]
  const half = Math.ceil(keys.length / 2)
  for (let r = 0; r < half; r++) {
    const left = keys[r] as keyof typeof GLYPH
    const right = keys[r + half]
    const line: Line = [...cell(left, r)]
    if (right) line.push([" ".repeat(Math.max(2, Math.floor(w / 2) - width(line))), ""], ...cell(right, r + half))
    out.push(line)
  }
  return out
}

// ---- the tabs line and the footer -------------------------------------------------

const TAB_NAME: Record<Tab, string> = { turn: "Turn", session: "Session", history: "History" }

export function tabsLine(sel: Tab, right: string, w = CONTENT_WIDTH): Line {
  const line: Line = [["Heads Up", "bold"], ["   ", ""]]
  for (const t of TABS) line.push([` ${TAB_NAME[t]} `, t === sel ? "tab" : "dim"], [" ", ""])
  const used = width(line)
  if (right && used + right.length + 1 <= w) line.push([" ".repeat(w - used - right.length), ""], [right, "dim"])
  return line
}

export function footLine(tab: Tab, w = CONTENT_WIDTH): Line {
  const keys: Line = [
    ["tab", "bold"],
    [" switch view  ", "dim"],
    ["↑↓", "bold"],
    [" scroll  ", "dim"],
  ]
  if (tab === "history") keys.push(["s", "bold"], [" this session / all  ", "dim"])
  keys.push(["esc", "bold"], [" close", "dim"])
  const used = width(keys)
  const mark = `${ENGINE_MARK} engine`
  if (used + mark.length + 1 <= w) keys.push([" ".repeat(w - used - mark.length), ""], [mark, "engine"])
  return keys
}

// ---- Turn ------------------------------------------------------------------------

/** The Turn tab. */
export function turnLines(d: TurnDetail | undefined, w = CONTENT_WIDTH): Line[] {
  if (!d) return [[["No turn yet in this run. Details start with the next turn.", "dim"]]]
  const out: Line[] = []
  if (d.outcome) out.push([[`This reply ${d.outcome === "interrupted" ? "was interrupted" : "failed"}; figures run to where it stopped.`, "dim"]], [])

  if (d.time && d.totalS !== undefined) out.push(...timeSplit(d.time, d.totalS, w), [])

  // Timeline: each step's wait, generation and tools on one time scale.
  const start = d.steps[0]?.createdAt
  const end = start !== undefined && d.totalS !== undefined ? start + d.totalS * 1000 : undefined
  if (start !== undefined && end !== undefined && end > start && d.steps.length > 0) {
    const cells = w - 8
    const at = (ms: number): number => Math.max(0, Math.min(cells, Math.round(((ms - start) / (end - start)) * cells)))
    out.push(...titled("Timeline", w, "per step"))
    d.steps.forEach((s, i) => {
      const spans: Array<[number, number, Style, string]> = []
      if (s.firstAt !== undefined) spans.push([s.createdAt, s.firstAt, "wait", GLYPH.waiting])
      if (s.firstAt !== undefined && s.lastAt !== undefined) spans.push([s.firstAt, s.lastAt, "gen", GLYPH.generating])
      for (const t of s.tools) {
        if (t.start !== undefined && t.end !== undefined) {
          const sub = t.name === "subagent" || t.name === "task" || t.name === "agent"
          spans.push([t.start, t.end, sub ? "sub" : "tool", sub ? GLYPH.subagents : GLYPH.tools])
        }
      }
      const cellsOf: Array<[Style, string]> = Array.from({ length: cells }, () => ["", " "])
      for (const [a, b, style, glyph] of spans) {
        const from = at(a)
        const to = Math.max(from + 1, at(b))
        for (let c = from; c < Math.min(cells, to); c++) cellsOf[c] = [style, glyph]
      }
      const line: Line = [[`  ${String(i + 1).padStart(2)}  `, "dim"]]
      for (const [style, glyph] of cellsOf) {
        const last = line[line.length - 1] as Seg
        if (last[1] === style && line.length > 1) line[line.length - 1] = [last[0] + glyph, style]
        else line.push([glyph, style])
      }
      out.push(line)
    })
    out.push([["      0s", "dim"], [" ".repeat(Math.max(1, cells - dur(d.totalS as number).length - 2)), ""], [dur(d.totalS as number), "dim"]])
    out.push([])
  }

  // Steps: OpenCode's rate, and the engine's own where it read each step.
  if (d.steps.length > 0) {
    const eng = d.stepEngine?.some((e) => e?.decodeTokS !== undefined) === true
    out.push(...titled("Steps", w, String(d.steps.length)))
    out.push([
      ["   #  tokens  ", "dim"],
      ...(eng ? ([[ENGINE_MARK, "engine"], ["tok/s ", "dim"]] as Line) : []),
      [" tok/s     ttft   tool", "dim"],
    ])
    d.steps.forEach((s, i) => {
      const tok = s.output + s.reasoning
      const rate = s.streamS && s.streamS > 0 ? n1(tok / s.streamS) : "—"
      const e = d.stepEngine?.[i]?.decodeTokS
      const head: Line = [
        [`  ${String(i + 1).padStart(2)}  ${n0(tok).padStart(6)}  `, ""],
        ...(eng ? ([[(e !== undefined ? n1(e) : "—").padStart(6), "engine"], [" ", ""]] as Line) : []),
        [`${rate.padStart(6)}  ${(s.ttftS !== undefined ? `${s.ttftS.toFixed(2)}s` : "—").padStart(7)}   `, ""],
      ]
      const pad = " ".repeat(width(head))
      const tools = s.tools.length > 0 ? s.tools : [undefined]
      tools.forEach((t, j) => {
        const tail: Line = t
          ? [[t.name.slice(0, 10).padEnd(11), ""], [t.seconds !== undefined ? dur(t.seconds) : t.status, "bold"]]
          : s.finish && s.finish !== "tool-calls"
            ? [[`— ${s.finish}`, "dim"]]
            : []
        out.push(j === 0 ? [...head, ...tail] : [[pad, ""], ...tail])
      })
      const notes = [
        s.retries > 0 ? `${s.retries} ${s.retries === 1 ? "retry" : "retries"}` : "",
        s.compactionS ? `waited on compaction ${dur(s.compactionS)}` : "",
      ].filter(Boolean)
      if (notes.length > 0) out.push([[`        ${notes.join(" · ")}`, "dim"]])
    })
    const reasons = d.steps.flatMap((s, i) =>
      [s.retryReason ? `step ${i + 1}: ${s.retryReason}` : "", s.error ? `step ${i + 1} failed: ${s.error}` : ""].filter(Boolean)
    )
    for (const r of reasons) for (const l of wrap(r, w - 4)) out.push([[`  ${l}`, "dim"]])
    out.push([])
  }

  // Tokens: the five kinds, with the cache's share and the context used as bars.
  const t = d.tokens
  out.push(...titled("Tokens", w))
  // Generated first, as the steps and the engine count it; then its split.
  const produced = t.output + t.reasoning
  out.push(
    gridRow("generated", n0(produced), t.reasoning > 0 ? `${n0(t.output)} answer · ${n0(t.reasoning)} reasoning (${share(t.reasoning, produced)})` : "")
  )
  const prompt = t.input + t.cacheRead
  if (prompt > 0) {
    const head = valueRow("prompt", n0(prompt))
    out.push([
      ...head,
      [" ".repeat(Math.max(1, BAR_AT - width(head))), ""],
      ...bar([[t.input, "gen", BAR], [t.cacheRead, "wait", BAR]], 20),
      [`  ${n0(t.input)} fresh · ${n0(t.cacheRead)} cached (${share(t.cacheRead, prompt)})`, "dim"],
    ])
  }
  if (t.cacheWrite > 0) out.push(gridRow("", n0(t.cacheWrite), "written to cache"))
  if (d.context) {
    const head = valueRow("context", n0(d.context.used))
    const tail: Line = d.context.limit
      ? [
          [" ".repeat(Math.max(1, BAR_AT - width(head))), ""],
          ...bar([[d.context.used, "gen", BAR], [Math.max(0, d.context.limit - d.context.used), "wait", BAR]], 20),
          [`  ${share(d.context.used, d.context.limit)} of ${n0(d.context.limit)}`, "dim"],
        ]
      : []
    out.push([...head, ...tail])
  }
  if (d.cost !== undefined) out.push(gridRow("cost", `$${d.cost.toFixed(4)}`))
  out.push([])

  // Engine: its own figures only, packed a few to a line, or which were
  // left out and why.
  if (d.engineRows.length > 0) {
    const title = `${ENGINE_MARK} ${d.engine}`
    const note = " measured by the engine"
    out.push([[title, "engine"], [" ", ""], ["─".repeat(Math.max(0, w - title.length - 1 - note.length)), "rule"], [note, "dim"]], [])
    out.push(...gridRows(d.engineRows, w))
    if (d.compactionEngine) for (const c of d.compactionEngine) out.push(gridRow("compaction", "", `${c}, taken out of the above`))
  } else {
    out.push(...titled(d.engine, w))
    const note = d.engineNote && d.engineNote.length > 0 ? `${d.engine}'s figures were left out: ${d.engineNote.join(" ")}` : "no engine telemetry for this provider"
    for (const l of wrap(note, w)) out.push([[l, "dim"]])
  }

  if (d.subagents) {
    out.push([], ...titled("Sub-agents", w))
    out.push(gridRow("count", n0(d.subagents.count), `${n0(d.subagents.tokens)} tok · ${dur(d.subagents.spanS)}`))
    if (d.subagents.cost !== undefined) out.push(gridRow("cost", `$${d.subagents.cost.toFixed(4)}`))
  }
  return out
}

/**
 * Label/value rows in a two-column grid: each pair's label in a fixed column,
 * its value beside it, the second column starting at half the width. A row
 * with an empty label continues the one above; acceptance by depth folds
 * into `93/87/82% by depth`.
 */
export function gridRows(rows: ReadonlyArray<readonly [string, string]>, w: number): Line[] {
  const groups: Array<{ label: string; value: string; rest: string }> = []
  let cur: { label: string; values: string[] } | undefined
  const flush = (): void => {
    if (!cur) return
    const depths = cur.values.map((v) => /^(\d+)% at depth \d+$/.exec(v)?.[1])
    if (depths.length > 1 && depths.every((x) => x !== undefined)) groups.push({ label: cur.label, value: `${depths.join("/")}%`, rest: "by depth" })
    else groups.push({ label: cur.label, value: cur.values[0] ?? "", rest: cur.values.slice(1).join(" ") })
  }
  for (const [label, value] of rows) {
    if (label || !cur) {
      flush()
      cur = { label, values: [value] }
    } else cur.values.push(value)
  }
  flush()
  const half = Math.floor(w / 2)
  const cell = (g: { label: string; value: string; rest: string }, cw: number): Line => {
    const line: Line = [[g.label.padEnd(LABEL), "dim"], [g.value, "bold"]]
    if (g.rest) line.push([` ${g.rest}`, "dim"])
    const used = width(line)
    return used < cw ? [...line, [" ".repeat(cw - used), ""]] : line
  }
  const out: Line[] = []
  for (let i = 0; i < groups.length; i += 2) {
    const a = groups[i] as { label: string; value: string; rest: string }
    const b = groups[i + 1]
    out.push(b ? [...cell(a, half), ...cell(b, 0)] : cell(a, 0))
  }
  return out
}

/**
 * Label/value rows packed several to a line: `speed 41.2 tok/s   prefill 475
 * tok/s   ttft 17.37s`. A row with an empty label continues the one above;
 * acceptance by depth (`93% at depth 1`, ...) folds into `93/87/82% by depth`.
 */
export function packRows(rows: ReadonlyArray<readonly [string, string]>, w: number): Line[] {
  const groups: Array<{ label: string; values: string[] }> = []
  for (const [label, value] of rows) {
    if (label || groups.length === 0) groups.push({ label, values: [value] })
    else (groups[groups.length - 1] as { values: string[] }).values.push(value)
  }
  const segs = groups.map(({ label, values }): Line => {
    const depths = values.map((v) => /^(\d+)% at depth \d+$/.exec(v)?.[1])
    if (depths.length > 1 && depths.every((x) => x !== undefined)) {
      return [[label, "dim"], [" ", ""], [`${depths.join("/")}%`, "bold"], [" by depth", "dim"]]
    }
    const [first, ...rest] = values
    return [[label, "dim"], [" ", ""], [first ?? "", "bold"], ...(rest.length > 0 ? ([[` ${rest.join(" ")}`, "dim"]] as Line) : [])]
  })
  const out: Line[] = []
  let cur: Line = []
  for (const g of segs) {
    const [labelSeg, , ...value] = g
    const lead: Line = cur.length === 0 ? [[(labelSeg as Seg)[0].padEnd(LABEL), "dim"], ...value] : [["   ", ""], ...g]
    if (cur.length > 0 && width(cur) + width(lead) > w) {
      out.push(cur)
      cur = [[(labelSeg as Seg)[0].padEnd(LABEL), "dim"], ...value]
    } else {
      cur = [...cur, ...lead]
    }
  }
  if (cur.length > 0) out.push(cur)
  return out
}

// ---- Session ------------------------------------------------------------------------

/** The Session tab. */
export function sessionLines(f: SessionFigures | undefined, w = CONTENT_WIDTH): Line[] {
  if (!f) return [[["No turns yet in this session.", "dim"]]]
  const out: Line[] = []
  const s = f.summary

  out.push(...titled("Speed", w, "generation only"))
  if (s.genTokS !== undefined) {
    const spread =
      f.rates.length > 1
        ? `  ·  min ${n1(quantile(f.rates, 0) as number)} · median ${n1(quantile(f.rates, 0.5) as number)} · p90 ${n1(quantile(f.rates, 0.9) as number)} · max ${n1(quantile(f.rates, 1) as number)}`
        : ""
    out.push(gridRow("average", n1(s.genTokS), `tok/s${spread}`))
  }
  const spark = sparkline(f.rates.slice(0, 24).reverse())
  if (spark) out.push(gridRow("trend", "", [[spark, "accent"], [`   last ${Math.min(24, f.rates.length)} turns`, "dim"]]))
  if (f.ttfts.length > 0) {
    const more = f.ttfts.length > 1 ? `median · p90 ${(quantile(f.ttfts, 0.9) as number).toFixed(2)}s · max ${(quantile(f.ttfts, 1) as number).toFixed(2)}s` : ""
    out.push(gridRow("ttft", `${(quantile(f.ttfts, 0.5) as number).toFixed(2)}s`, more.trim()))
  }
  out.push([])

  if (f.time) out.push(...timeSplit(f.time, f.time.total, w), [])

  if (f.tools.length > 0) {
    const shown = f.tools.slice(0, 8)
    const most = (shown[0] as { s: number }).s
    out.push(...titled("Tools by time", w, `${n0(f.toolCalls)} calls`))
    for (const t of shown) {
      out.push([
        [`  ${t.name.slice(0, 10).padEnd(11)}`, "dim"],
        ...bar([[t.s, "tool", BAR], [Math.max(0, most - t.s), "", " "]], 28),
        [`  ${dur(t.s).padStart(7)}`, "bold"],
        [`  ${n0(t.n)} ${t.n === 1 ? "call" : "calls"}`, "dim"],
      ])
    }
    if (f.tools.length > shown.length) out.push([[`  and ${f.tools.length - shown.length} more`, "dim"]])
    out.push([])
  }

  out.push(...titled("Coverage", w, "turns with the engine's own figures"))
  out.push(
    gridRow("engine", `${n0(f.coverage.engine)}/${n0(f.coverage.total)}`, [
      ...bar([[f.coverage.engine, "gen", BAR], [f.coverage.total - f.coverage.engine, "wait", BAR]], 20),
      [`  ${share(f.coverage.engine, f.coverage.total)} of turns`, "dim"],
    ])
  )
  f.coverage.without.forEach(({ label, n }, i) => out.push(gridRow(i === 0 ? "without" : "", n0(n), label)))
  out.push([])

  out.push(...titled("Tokens", w))
  const gen = f.tokens.output + f.tokens.reasoning
  out.push(
    gridRow("generated", n0(gen), f.tokens.reasoning > 0 ? `${n0(f.tokens.output)} answer · ${n0(f.tokens.reasoning)} reasoning (${share(f.tokens.reasoning, gen)})` : "")
  )
  if (f.tokens.input !== undefined || f.tokens.cacheRead !== undefined) {
    const fresh = f.tokens.input ?? 0
    const cached = f.tokens.cacheRead ?? 0
    out.push(
      gridRow("prompt", n0(fresh + cached), [
        ...bar([[fresh, "gen", BAR], [cached, "wait", BAR]], 20),
        [`  ${n0(fresh)} fresh · ${n0(cached)} cached (${share(cached, fresh + cached)})`, "dim"],
      ])
    )
  }
  if (f.tokens.cacheWrite > 0) out.push(gridRow("", n0(f.tokens.cacheWrite), "written to cache"))
  out.push(gridRow("turns", n0(f.turns), `${n0(f.steps)} steps · ${dur(f.elapsedS)}${f.cost !== undefined ? ` · $${f.cost.toFixed(4)}` : ""}`))

  if (f.retryReasons.length > 0) {
    out.push([], ...titled("Retries", w, String(s.retries)))
    for (const { reason, n } of f.retryReasons) for (const l of wrap(`${n}× ${reason}`, w - 2)) out.push([[`  ${l}`, "dim"]])
  }

  if (s.engine && (s.engine.mtpX !== undefined || s.engine.draftAccept !== undefined || s.engine.prefillTokS !== undefined)) {
    out.push([], [[`${ENGINE_MARK} Engine averages`, "engine"], [" ", ""], ["─".repeat(Math.max(0, w - 18)), "rule"]], [])
    if (s.engine.mtpX !== undefined) out.push(gridRow("MTP", `${s.engine.mtpX.toFixed(2)}x`, "average"))
    if (s.engine.draftAccept !== undefined) out.push(gridRow("draft", `${Math.round(s.engine.draftAccept * 100)}%`, "accepted, average"))
    if (s.engine.prefillTokS !== undefined) out.push(gridRow("prefill", n0(s.engine.prefillTokS), "tok/s average"))
  }
  if (s.subagents) {
    out.push([], ...titled("Sub-agents", w))
    out.push(gridRow("count", n0(s.subagents.count), `${n0(s.subagents.tokens)} tok${s.subagents.cost !== undefined ? ` · $${s.subagents.cost.toFixed(4)}` : ""}`))
  }
  return out
}

// ---- History ------------------------------------------------------------------------

/**
 * The History tab: one row per turn in fixed columns, never wrapped. Scope is
 * this session or every session; with every session, a model column appears,
 * since that is when the model varies. Cost and cache columns appear only
 * when some turn in view has them.
 */
export function historyTabLines(
  turns: readonly TurnRecord[],
  sessionID: string | undefined,
  scope: Scope,
  w = CONTENT_WIDTH
): Line[] {
  const rows = scope === "all" ? turns : turns.filter((t) => t.sessionID === sessionID)
  if (rows.length === 0) return [[[scope === "all" ? "No turns recorded yet." : "No turns in this session yet.", "dim"]]]
  const showModel = scope === "all"
  const showCost = rows.some((t) => typeof t.cost === "number" && t.cost > 0)
  // Across every session the model column needs the room; cache and tool
  // counts stay in the session view, where the model is one.
  const showCache = !showModel && rows.some((t) => (t.cached ?? 0) > 0)
  const showTools = !showModel && rows.some((t) => Object.values(t.tools ?? {}).some((x) => x.n > 0))

  // Headline: the scope's totals, and its generation speed on the newest model.
  const tokens = rows.reduce((a, t) => a + t.tokens, 0)
  const newest = rows[0] as TurnRecord
  let genTok = 0
  let genS = 0
  for (const t of rows) {
    if (t.model !== newest.model || t.outcome) continue
    const s = t.streamS ?? (t.rate && t.rate > 0 && t.rateWindow !== "whole" ? t.tokens / t.rate : undefined)
    if (s === undefined || s <= 0) continue
    genTok += t.tokens
    genS += s
  }
  const cost = rows.reduce((a, t) => a + (t.cost ?? 0), 0)
  const out: Line[] = [
    [
      ["  ", ""],
      [`${n0(rows.length)} turns`, "bold"],
      [" · ", "dim"],
      [`${n0(tokens)} tok`, "bold"],
      ...(genS > 0 ? ([[" · ", "dim"], [`${n1(genTok / genS)} tok/s`, "bold"], [" avg", "dim"]] as Line) : []),
      ...(cost > 0 ? ([[" · ", "dim"], [`$${cost.toFixed(4)}`, "bold"]] as Line) : []),
    ],
    [],
  ]

  // Columns, fitted to the width: the model column takes what is left.
  const fixed = 2 + 6 + 8 + 8 + 9 + 9 + (showTools ? 6 : 0) + 3 + (showCost ? 9 : 0) + (showCache ? 9 : 0)
  const modelW = showModel ? Math.max(8, Math.min(22, w - fixed)) : 0
  const header: Line = [
    [
      `  ${"time".padEnd(6)}${showModel ? "model".padEnd(modelW) : ""}${"tok/s".padStart(8)}${"tokens".padStart(8)}${"ttft".padStart(9)}${"total".padStart(9)}${showTools ? "tools".padStart(6) : ""}${showCost ? "cost".padStart(9) : ""}${showCache ? "cached".padStart(9) : ""}  `,
      "dim",
    ],
    [ENGINE_MARK, "engine"],
  ]
  out.push(header, [["─".repeat(w), "rule"]])
  const notes: string[] = []
  for (const t of rows.slice(0, 200)) {
    const calls = Object.values(t.tools ?? {}).reduce((a, x) => a + x.n, 0)
    // Cut from the middle: a model's distinguishing part is often its end.
    const keep = modelW - 2
    const model =
      t.model.length > modelW - 1 ? `${t.model.slice(0, Math.ceil(keep / 3))}…${t.model.slice(t.model.length - Math.floor((keep * 2) / 3))}` : t.model
    out.push([
      [`  ${clock(t.at).padEnd(6)}`, ""],
      ...(showModel ? ([[model.padEnd(modelW), "dim"]] as Line) : []),
      [(t.rate !== undefined && t.rateWindow !== "whole" && !t.outcome ? n1(t.rate) : "—").padStart(8), "bold"],
      [`${(t.tokens > 0 ? n0(t.tokens) : "—").padStart(8)}${(t.ttft !== undefined ? `${t.ttft.toFixed(2)}s` : "—").padStart(9)}${(t.totalS !== undefined ? dur(t.totalS) : "—").padStart(9)}${showTools ? (calls > 0 ? String(calls) : "").padStart(6) : ""}`, ""],
      ...(showCost ? ([[(t.cost ? `$${t.cost.toFixed(4)}` : "").padStart(9), ""]] as Line) : []),
      ...(showCache ? ([[(t.cached ? n0(t.cached) : "").padStart(9), ""]] as Line) : []),
      ["  ", ""],
      t.source === "engine" ? [ENGINE_MARK, "engine"] : ["·", "dim"],
    ])
    if (t.outcome) notes.push(`${clock(t.at)} ${t.outcome}`)
    else if (t.source !== "engine" && t.skip && t.skip !== "no-adapter") notes.push(`${clock(t.at)} ${SKIP_LABEL[t.skip]}`)
  }
  if (notes.length > 0) {
    out.push([])
    for (const l of wrap(notes.slice(0, 6).join(" · "), w - 2)) out.push([[`  ${l}`, "dim"]])
  }
  return out
}
