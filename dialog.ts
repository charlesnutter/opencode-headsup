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

// The mockup's glyphs: parts of a bar differ by shade as well as colour, so
// they still read apart where colour does not.
// Squares (chosen 2026-09-25): centred, about half a row tall, with a gap
// between cells, so a bar clears the lines above and below it. Parts are
// told apart by colour.
const SQ = "■"
const GLYPH = { waiting: SQ, generating: SQ, tools: SQ, subagents: SQ, compaction: SQ, other: SQ } as const
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

// ---- scale ----------------------------------------------------------------------

/** The mockup was drawn 72 cells wide; its fixed sizes scale with the width. */
const MOCK = 72
const sc = (cells: number, w: number): number => Math.max(1, Math.round((cells * w) / MOCK))

type Split = { waiting: number; generating: number; tools: number; subagents: number; compaction: number; other: number }
const KEYS = ["waiting", "generating", "tools", "subagents", "compaction", "other"] as const

/** The time bar: indented 2, 60 of the mockup's 72 cells. */
function timeBar(t: Split, w: number): Line {
  const keys = KEYS.filter((k) => t[k] > 0)
  return [["  ", ""], ...bar(keys.map((k) => [t[k], STYLE[k], GLYPH[k]] as const), w - 12)]
}

/** The Turn tab's legend: two columns, name, seconds and share (mockup). */
function legendColumns(t: Split): Line[] {
  const keys = KEYS.filter((k) => t[k] > 0 || k === "waiting" || k === "generating")
  const pct = percents(keys.map((k) => t[k]))
  const half = Math.ceil(keys.length / 2)
  const left = keys.slice(0, half)
  const right = keys.slice(half)
  const rw = Math.max(7, ...right.map((k) => NAME[k].length))
  const cell = (k: (typeof KEYS)[number], i: number, nameW: number, valW: number): Line => [
    [GLYPH[k], STYLE[k]],
    [` ${NAME[k].padEnd(nameW)} `, "dim"],
    [`${dur(t[k]).padStart(valW)}`, "bold"],
    [(pct[i] === 0 && t[k] > 0 ? "<1%" : `${pct[i]}%`).padStart(4), "dim"],
  ]
  const out: Line[] = []
  for (let r = 0; r < half; r++) {
    const line: Line = [["  ", ""], ...cell(left[r] as (typeof KEYS)[number], r, 11, 8)]
    const k = right[r]
    if (k) line.push(["      ", ""], ...cell(k, half + r, rw, 7))
    out.push(line)
  }
  return out
}

/** The Session tab's legend: name and time, flowing across lines (mockup). */
function legendFlow(t: Split, w: number): Line[] {
  const keys = KEYS.filter((k) => t[k] > 0 || k === "waiting" || k === "generating")
  const out: Line[] = []
  let cur: Line = [["  ", ""]]
  for (const k of keys) {
    const item: Line = [[GLYPH[k], STYLE[k]], [` ${NAME[k]} `, "dim"], [dur(t[k]), "bold"]]
    const sep: Line = width(cur) > 2 ? [["  ", ""]] : []
    if (width(cur) + width(sep) + width(item) > w && width(cur) > 2) {
      out.push(cur)
      cur = [["  ", ""], ...item]
    } else cur = [...cur, ...sep, ...item]
  }
  if (width(cur) > 2) out.push(cur)
  return out
}

// ---- aligned rows and columns -------------------------------------------------------

/**
 * Rows of one section laid out on shared columns: label, value (right-aligned
 * to the widest), qualifier (to the widest), then a bar that starts and ends
 * at the same place on every row, then a note. A row without a bar puts its
 * note where the bars start.
 */
export type AlignedRow = { label: string; value: string; qual?: string; bar?: Array<readonly [number, Style, string]>; note?: string }

export function alignedRows(rows: readonly AlignedRow[], barCells: number, w: number): Line[] {
  const vw = Math.max(0, ...rows.map((r) => r.value.length))
  const qw = Math.max(0, ...rows.map((r) => (r.qual ? r.qual.length + 1 : 0)))
  // The bar gives way to the widest note on a barred row, so nothing overflows.
  const lead = LABEL + vw + qw + 3
  const note = Math.max(0, ...rows.filter((r) => r.bar).map((r) => (r.note ? r.note.length + 3 : 0)))
  barCells = Math.max(6, Math.min(barCells, w - lead - note))
  return rows.map((r): Line => {
    const line: Line = [
      [r.label.padEnd(LABEL), "dim"],
      [r.value.padStart(vw), "bold"],
      [(r.qual ? ` ${r.qual}` : "").padEnd(qw), "dim"],
      ["   ", ""],
    ]
    if (r.bar) line.push(...bar(r.bar, barCells), ["   ", ""])
    if (r.note) line.push([r.note, "dim"])
    return line
  })
}

/**
 * Label/value items in a grid of `n` columns, row by row. Within a column the
 * labels are padded to the widest and the values line up; the first column's
 * labels sit in the section's label column.
 */
export function columns(items: ReadonlyArray<{ label: string; value: Line }>, w: number, n = 3): Line[] {
  for (let cols = Math.min(n, items.length); cols >= 1; cols--) {
    const lw = Array.from({ length: cols }, (_, c) => {
      const labels = items.filter((_, i) => i % cols === c).map((it) => it.label.length)
      return c === 0 ? Math.max(LABEL - 1, ...labels) : Math.max(0, ...labels)
    })
    const vw = Array.from({ length: cols }, (_, c) => Math.max(0, ...items.filter((_, i) => i % cols === c).map((it) => width(it.value))))
    const gap = 4
    const total = lw.reduce((a, b) => a + b + 1, 0) + vw.reduce((a, b) => a + b, 0) + gap * (cols - 1)
    if (total > w && cols > 1) continue
    const out: Line[] = []
    for (let i = 0; i < items.length; i += cols) {
      const line: Line = []
      for (let c = 0; c < cols && i + c < items.length; c++) {
        const it = items[i + c] as { label: string; value: Line }
        if (c > 0) line.push([" ".repeat(gap), ""])
        line.push([`${it.label.padEnd(lw[c] as number)} `, "dim"], ...it.value)
        const pad = (vw[c] as number) - width(it.value)
        if (c < cols - 1 && pad > 0) line.push([" ".repeat(pad), ""])
      }
      out.push(line)
    }
    return out
  }
  return []
}

// ---- Turn ------------------------------------------------------------------------

/** The Turn tab, laid out as the mockup. */
export function turnLines(d: TurnDetail | undefined, w = CONTENT_WIDTH): Line[] {
  if (!d) return [[["No turn yet in this run. Details start with the next turn.", "dim"]]]
  const out: Line[] = []
  if (d.outcome) out.push([[`This reply ${d.outcome === "interrupted" ? "was interrupted" : "failed"}; figures run to where it stopped.`, "dim"]], [])

  if (d.time && d.totalS !== undefined) {
    out.push(heading("Where the time went", w, dur(d.totalS)), timeBar(d.time, w), ...legendColumns(d.time), [])
  }

  // Timeline: each step's wait, generation and tools on one time scale.
  const start = d.steps[0]?.createdAt
  const end = start !== undefined && d.totalS !== undefined ? start + d.totalS * 1000 : undefined
  if (start !== undefined && end !== undefined && end > start && d.steps.length > 0) {
    const cells = w - 12
    const at = (ms: number): number => Math.max(0, Math.min(cells, Math.round(((ms - start) / (end - start)) * cells)))
    out.push(heading("Timeline", w, "per step"))
    d.steps.forEach((s, i) => {
      const spans: Array<[number, number, Style, string]> = []
      if (s.firstAt !== undefined) spans.push([s.createdAt, s.firstAt, "wait", GLYPH.waiting])
      if (s.firstAt !== undefined && s.lastAt !== undefined) spans.push([s.firstAt, s.lastAt, "gen", GLYPH.generating])
      for (const t of s.tools) {
        if (t.start === undefined || t.end === undefined) continue
        const sub = t.name === "subagent" || t.name === "task" || t.name === "agent"
        spans.push([t.start, t.end, sub ? "sub" : "tool", sub ? GLYPH.subagents : GLYPH.tools])
      }
      const cellsOf: Array<[Style, string]> = Array.from({ length: cells }, () => ["", " "])
      for (const [a, b, style, glyph] of spans) {
        const from = at(a)
        const to = Math.max(from + 1, at(b))
        for (let c = from; c < Math.min(cells, to); c++) cellsOf[c] = [style, glyph]
      }
      // Trailing blanks trimmed, so the line ends where the step does.
      while (cellsOf.length > 0 && (cellsOf[cellsOf.length - 1] as [Style, string])[1] === " ") cellsOf.pop()
      const line: Line = [[`  ${String(i + 1)}  `.padEnd(5), "dim"]]
      for (const [style, glyph] of cellsOf) {
        const last = line[line.length - 1] as Seg
        if (last[1] === style && line.length > 1) line[line.length - 1] = [last[0] + glyph, style]
        else line.push([glyph, style])
      }
      out.push(line)
    })
    const total = dur(d.totalS as number)
    out.push([["     0s", "dim"], [" ".repeat(Math.max(1, cells - 2 - total.length + 5 - 5)), ""], [total, "dim"]])
    out.push([])
  }

  // Steps: the mockup's columns. The engine's own per-step rate appears
  // where the engine was read per step.
  if (d.steps.length > 0) {
    const eng = d.stepEngine?.some((e) => e?.decodeTokS !== undefined) === true
    out.push(heading("Steps", w, String(d.steps.length)))
    out.push([
      ["  #   tokens  ", "dim"],
      ...(eng ? ([[ENGINE_MARK, "engine"], ["tok/s", "dim"]] as Line) : []),
      [`${eng ? "   " : ""}tok/s     ttft   tool`, "dim"],
    ])
    d.steps.forEach((s, i) => {
      const tok = s.output + s.reasoning
      const rate = s.streamS && s.streamS > 0 ? n1(tok / s.streamS) : "—"
      const e = d.stepEngine?.[i]?.decodeTokS
      const head: Line = [
        [`  ${String(i + 1)}${n0(tok).padStart(12 - 2 - String(i + 1).length)}`, ""],
        ...(eng ? ([["    ", ""], [(e !== undefined ? n1(e) : "—").padStart(4), "engine"]] as Line) : []),
        [`${rate.padStart(eng ? 8 : 10)}${(s.ttftS !== undefined ? `${s.ttftS.toFixed(2)}s` : "—").padStart(9)}   `, ""],
      ]
      const pad = " ".repeat(width(head))
      const tools = s.tools.length > 0 ? s.tools : [undefined]
      tools.forEach((t, j) => {
        const tail: Line = t
          ? [[`${t.name.slice(0, 10).padEnd(10)} ${t.seconds !== undefined ? dur(t.seconds) : t.status}`, ""]]
          : s.finish && s.finish !== "tool-calls"
            ? [[`— ${s.finish}`, "dim"]]
            : []
        out.push(j === 0 ? [...head, ...tail] : [[pad, ""], ...tail])
      })
      const notes = [
        s.retries > 0 ? `${s.retries} ${s.retries === 1 ? "retry" : "retries"}` : "",
        s.compactionS ? `waited on compaction ${dur(s.compactionS)}` : "",
      ].filter(Boolean)
      if (notes.length > 0) out.push([[`      ${notes.join(" · ")}`, "dim"]])
    })
    const reasons = d.steps.flatMap((s, i) =>
      [s.retryReason ? `step ${i + 1}: ${s.retryReason}` : "", s.error ? `step ${i + 1} failed: ${s.error}` : ""].filter(Boolean)
    )
    for (const r of reasons) for (const l of wrap(r, w - 2)) out.push([[`  ${l}`, "dim"]])
    out.push([])
  }

  // Tokens: generated with its split; prompt and context with a bar each.
  const t = d.tokens
  const produced = t.output + t.reasoning
  const prompt = t.input + t.cacheRead
  const tokenRows: AlignedRow[] = [
    {
      label: "generated",
      value: n0(produced),
      qual: "tok",
      note: t.reasoning > 0 ? `${n0(t.output)} answer · ${n0(t.reasoning)} reasoning (${share(t.reasoning, produced)})` : undefined,
    },
  ]
  if (prompt > 0) {
    tokenRows.push({
      label: "input",
      value: n0(t.input),
      qual: "fresh",
      bar: [[t.input, "gen", SQ], [t.cacheRead, "wait", SQ]],
      note: `${n0(t.cacheRead)} cached (${share(t.cacheRead, prompt)})`,
    })
  }
  if (t.cacheWrite > 0) tokenRows.push({ label: "", value: n0(t.cacheWrite), qual: "written to cache" })
  if (d.context) {
    tokenRows.push({
      label: "context",
      value: n0(d.context.used),
      qual: d.context.limit ? `of ${n0(d.context.limit)}` : undefined,
      bar: d.context.limit ? [[d.context.used, "gen", SQ], [Math.max(0, d.context.limit - d.context.used), "wait", SQ]] : undefined,
      note: d.context.limit ? share(d.context.used, d.context.limit) : undefined,
    })
  }
  if (d.cost !== undefined) tokenRows.push({ label: "cost", value: `$${d.cost.toFixed(4)}` })
  out.push(heading("Tokens", w), ...alignedRows(tokenRows, sc(24, w), w), [])

  // Engine: its own figures, a few to a line; or which were left out and why.
  if (d.engineRows.length > 0) {
    out.push(heading(`${ENGINE_MARK} ${d.engine}`, w, "measured by the engine"))
    out.push(...columns(engineItems(d.engineRows), w, 3))
    if (d.compactionEngine) for (const c of d.compactionEngine) out.push(row("compaction", c, "  taken out of the above"))
  } else {
    out.push(heading(d.engine, w))
    const note = d.engineNote && d.engineNote.length > 0 ? `${d.engine}'s figures were left out: ${d.engineNote.join(" ")}` : "no engine telemetry for this provider"
    for (const l of wrap(note, w)) out.push([[l, "dim"]])
  }

  if (d.subagents) {
    out.push([], heading("Sub-agents", w))
    out.push(row("count", n0(d.subagents.count), `  ${n0(d.subagents.tokens)} tok · ${dur(d.subagents.spanS)}`))
    if (d.subagents.cost !== undefined) out.push(row("cost", `$${d.subagents.cost.toFixed(4)}`))
  }
  return out
}

/**
 * The engine's rows as grid items, in the mockup's order: rates first, then
 * speculative decoding. A continuation row becomes its own item where it is a
 * figure of its own (`95 verify passes` -> `verify 95 passes`); acceptance by
 * depth folds into `93/87/82%`. The token count is left out: the Tokens
 * section has it.
 */
export function engineItems(rows: ReadonlyArray<readonly [string, string]>): Array<{ label: string; value: Line }> {
  const all: Array<{ label: string; values: string[] }> = []
  for (const [label, value] of rows) {
    if (label || all.length === 0) all.push({ label, values: [value] })
    else (all[all.length - 1] as { values: string[] }).values.push(value)
  }
  const items: Array<{ label: string; value: Line }> = []
  for (const { label, values } of all) {
    if (label === "tokens") continue
    const depths = values.map((v) => /^(\d+)% at depth \d+$/.exec(v)?.[1])
    if (depths.length > 1 && depths.every((x) => x !== undefined)) {
      items.push({ label, value: [[`${depths.join("/")}%`, "bold"], [" by depth", "dim"]] })
      continue
    }
    const [first, ...rest] = values
    items.push({ label, value: [[first ?? "", "bold"]] })
    for (const r of rest) {
      const m = /^([\d,.]+) (.+)$/.exec(r)
      if (m) {
        const words = (m[2] as string).split(" ")
        items.push({ label: words[0] as string, value: [[m[1] as string, "bold"], [` ${words.slice(1).join(" ")}`, "dim"]] })
      } else items.push({ label: "", value: [[r, "dim"]] })
    }
  }
  const ORDER = ["speed", "prefill", "ttft", "MTP", "verify", "accepted", "draft"]
  const rank = (l: string): number => (ORDER.includes(l) ? ORDER.indexOf(l) : ORDER.length)
  return items.sort((a, b) => rank(a.label) - rank(b.label))
}

/**
 * Label/value rows packed several to a line, as the mockup's engine section:
 * `speed 41.2 tok/s     prefill 475 tok/s     ttft 17.37s`. A row with an
 * empty label continues the one above; acceptance by depth folds into
 * `93/87/82% by depth`.
 */
export function packRows(rows: ReadonlyArray<readonly [string, string]>, w: number): Line[] {
  const all: Array<{ label: string; values: string[] }> = []
  for (const [label, value] of rows) {
    if (label || all.length === 0) all.push({ label, values: [value] })
    else (all[all.length - 1] as { values: string[] }).values.push(value)
  }
  // The mockup's order: rates first, then speculative decoding. The token
  // count is left out: the Tokens section already has it.
  const ORDER = ["speed", "prefill", "ttft", "MTP", "accepted", "draft"]
  const rank = (l: string): number => (ORDER.includes(l) ? ORDER.indexOf(l) : ORDER.length)
  const groups = all.filter((g) => g.label !== "tokens").sort((a, b) => rank(a.label) - rank(b.label))
  const segs = groups.map(({ label, values }): { label: string; value: Line } => {
    const depths = values.map((v) => /^(\d+)% at depth \d+$/.exec(v)?.[1])
    if (depths.length > 1 && depths.every((x) => x !== undefined)) {
      return { label, value: [[`${depths.join("/")}%`, "bold"], [" by depth", "dim"]] }
    }
    const [first, ...rest] = values
    return { label, value: [[first ?? "", "bold"], ...(rest.length > 0 ? ([[`  ${rest.join(" ")}`, "dim"]] as Line) : [])] }
  })
  const out: Line[] = []
  let cur: Line = []
  let prev = ""
  for (const g of segs) {
    const first: Line = [[g.label.padEnd(LABEL), "dim"], ...g.value]
    const next: Line = [["     ", ""], [`${g.label} `, "dim"], ...g.value]
    const newGroup = prev !== "" && rank(prev) <= 2 && rank(g.label) > 2
    prev = g.label
    if (cur.length === 0) cur = first
    else if (newGroup || width(cur) + width(next) > w) {
      out.push(cur)
      cur = first
    } else cur = [...cur, ...next]
  }
  if (cur.length > 0) out.push(cur)
  return out
}

// ---- Session ------------------------------------------------------------------------

/** The Session tab, laid out as the mockup. */
export function sessionLines(f: SessionFigures | undefined, w = CONTENT_WIDTH): Line[] {
  if (!f) return [[["No turns yet in this session.", "dim"]]]
  const out: Line[] = []
  const s = f.summary

  out.push(heading("Speed", w, "tok/s"))
  if (s.genTokS !== undefined) {
    const spread =
      f.rates.length > 1
        ? `   min ${n1(quantile(f.rates, 0) as number)} · median ${n1(quantile(f.rates, 0.5) as number)} · p90 ${n1(quantile(f.rates, 0.9) as number)} · max ${n1(quantile(f.rates, 1) as number)}`
        : ""
    out.push(row("average", n1(s.genTokS), spread))
  }
  const spark = sparkline(f.rates.slice(0, 24).reverse())
  if (spark) out.push([["trend".padEnd(LABEL), "dim"], [spark, "accent"], [`   last ${Math.min(24, f.rates.length)} turns`, "dim"]])
  if (f.ttfts.length > 0) {
    const more = f.ttfts.length > 1 ? `  median · p90 ${(quantile(f.ttfts, 0.9) as number).toFixed(2)}s · max ${(quantile(f.ttfts, 1) as number).toFixed(2)}s` : ""
    out.push(row("ttft", `${(quantile(f.ttfts, 0.5) as number).toFixed(2)}s`, more))
  }
  out.push([])

  if (f.time) out.push(heading("Where the time went", w, dur(f.time.total)), timeBar(f.time, w), ...legendFlow(f.time, w), [])

  if (f.tools.length === 0) {
    out.push(heading("Tools by time", w))
    out.push([[f.toolsRecorded > 0 ? "  no tool calls in these turns" : "  not recorded for these turns (recorded from this version on)", "dim"]], [])
  } else {
    const shown = f.tools.slice(0, 8)
    const most = (shown[0] as { s: number }).s
    out.push(heading("Tools by time", w, `${n0(f.toolCalls)} calls`))
    for (const t of shown) {
      out.push([
        [`  ${t.name.slice(0, 10).padEnd(10)}`, "dim"],
        ...bar([[t.s, "tool", GLYPH.tools], [Math.max(0, most - t.s), "", " "]], sc(30, w)),
        [`  ${dur(t.s).padStart(7)}`, "bold"],
        [`  ${n0(t.n)} ${t.n === 1 ? "call" : "calls"}`, "dim"],
      ])
    }
    if (f.tools.length > shown.length) out.push([[`  and ${f.tools.length - shown.length} more`, "dim"]])
    out.push([])
  }

  out.push(heading("Coverage", w))
  out.push([
    ...row("engine", `${n0(f.coverage.engine)} of ${n0(f.coverage.total)} turns`, "   "),
    ...bar([[f.coverage.engine, "gen", GLYPH.generating], [f.coverage.total - f.coverage.engine, "wait", GLYPH.waiting]], sc(20, w)),
  ])
  f.coverage.without.forEach(({ label, n }, i) => out.push([[(i === 0 ? "without" : "").padEnd(LABEL), "dim"], [`${n0(n)} ${label}`, "dim"]]))
  out.push([])

  const gen = f.tokens.output + f.tokens.reasoning
  const sessRows: AlignedRow[] = [
    { label: "generated", value: n0(gen), qual: "tok", note: f.tokens.reasoning > 0 ? `${n0(f.tokens.output)} answer · ${n0(f.tokens.reasoning)} reasoning (${share(f.tokens.reasoning, gen)})` : undefined },
  ]
  if (f.tokens.input !== undefined || f.tokens.cacheRead !== undefined) {
    const fresh = f.tokens.input ?? 0
    const cached = f.tokens.cacheRead ?? 0
    sessRows.push({ label: "input", value: n0(fresh), qual: "fresh", bar: [[fresh, "gen", SQ], [cached, "wait", SQ]], note: `${n0(cached)} cached (${share(cached, fresh + cached)} hit)` })
  }
  if (f.tokens.cacheWrite > 0) sessRows.push({ label: "", value: n0(f.tokens.cacheWrite), qual: "written to cache" })
  out.push(heading("Tokens", w), ...alignedRows(sessRows, sc(24, w), w))

  if (f.retryReasons.length > 0) {
    out.push([], heading("Retries", w, String(s.retries)))
    for (const { reason, n } of f.retryReasons) for (const l of wrap(`${n}× ${reason}`, w - 2)) out.push([[`  ${l}`, "dim"]])
  }
  if (s.engine && (s.engine.mtpX !== undefined || s.engine.draftAccept !== undefined || s.engine.prefillTokS !== undefined)) {
    out.push([], heading(`${ENGINE_MARK} Engine averages`, w))
    const items: Array<{ label: string; value: Line }> = []
    if (s.engine.prefillTokS !== undefined) items.push({ label: "prefill", value: [[`${n0(s.engine.prefillTokS)} tok/s`, "bold"]] })
    if (s.engine.mtpX !== undefined) items.push({ label: "MTP", value: [[`${s.engine.mtpX.toFixed(2)}x`, "bold"]] })
    if (s.engine.draftAccept !== undefined) items.push({ label: "draft", value: [[`${Math.round(s.engine.draftAccept * 100)}%`, "bold"], [" accepted", "dim"]] })
    out.push(...columns(items, w, 3))
  }
  if (s.subagents) {
    out.push([], heading("Sub-agents", w))
    out.push(row("count", n0(s.subagents.count), `  ${n0(s.subagents.tokens)} tok${s.subagents.cost !== undefined ? ` · $${s.subagents.cost.toFixed(4)}` : ""}`))
  }
  return out
}

// ---- History ------------------------------------------------------------------------

/**
 * The History tab: one row per turn in fixed columns, spread across the
 * width, never wrapped. Scope is this session or every session; with every
 * session, a model column appears. Cost and cache columns appear only when
 * some turn in view has them, tools only when some turn used one.
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
  const showCache = !showModel && rows.some((t) => (t.cached ?? 0) > 0)
  // Across every session the model column needs the room; tool counts stay
  // in the session view.
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

  // Columns: name, width, right-aligned, style. The spare width is shared
  // out between them, so the table spans the dialog.
  type Col = { name: string; w: number; right: boolean; cell: (t: TurnRecord) => Seg }
  // The model column takes what the others leave, at two cells between each.
  const others = 2 + 5 + 6 + 7 + 7 + 8 + 1 + (showTools ? 5 : 0) + (showCost ? 8 : 0) + (showCache ? 7 : 0)
  const nCols = 6 + (showModel ? 1 : 0) + (showTools ? 1 : 0) + (showCost ? 1 : 0) + (showCache ? 1 : 0)
  const modelW = Math.max(8, Math.min(24, w - others - 2 * (nCols - 1)))
  const cols: Col[] = [
    { name: "time", w: 5, right: false, cell: (t) => [clock(t.at), ""] },
    ...(showModel
      ? ([{ name: "model", w: modelW, right: false, cell: (t: TurnRecord) => [midCut(t.model, modelW), "dim"] as Seg }] as Col[])
      : []),
    { name: "tok/s", w: 6, right: true, cell: (t) => [t.rate !== undefined && t.rateWindow !== "whole" && !t.outcome ? n1(t.rate) : "—", "bold"] },
    { name: "tokens", w: 7, right: true, cell: (t) => [t.tokens > 0 ? n0(t.tokens) : "—", ""] },
    { name: "ttft", w: 7, right: true, cell: (t) => [t.ttft !== undefined ? `${t.ttft.toFixed(2)}s` : "—", ""] },
    { name: "total", w: 8, right: true, cell: (t) => [t.totalS !== undefined ? dur(t.totalS) : "—", ""] },
    ...(showTools
      ? ([{ name: "tools", w: 5, right: true, cell: (t: TurnRecord) => [String(Object.values(t.tools ?? {}).reduce((a, x) => a + x.n, 0) || ""), ""] as Seg }] as Col[])
      : []),
    ...(showCost ? ([{ name: "cost", w: 8, right: true, cell: (t: TurnRecord) => [t.cost ? `$${t.cost.toFixed(4)}` : "", ""] as Seg }] as Col[]) : []),
    ...(showCache ? ([{ name: "cached", w: 7, right: true, cell: (t: TurnRecord) => [t.cached ? n0(t.cached) : "", ""] as Seg }] as Col[]) : []),
    { name: ENGINE_MARK, w: 1, right: true, cell: (t) => (t.source === "engine" ? [ENGINE_MARK, "engine"] : ["·", "dim"]) },
  ]
  const base = 2 + cols.reduce((a, c) => a + c.w, 0)
  const gap = Math.max(2, Math.floor((w - base) / (cols.length - 1)))
  const cell = (c: Col, text: string, i: number): string => {
    const t = c.right ? text.padStart(c.w) : text.padEnd(c.w)
    return i === 0 ? t : " ".repeat(gap) + t
  }
  out.push([
    ["  ", ""],
    ...cols.map((c, i): Seg => [cell(c, c.name, i), c.name === ENGINE_MARK ? "engine" : "dim"]),
  ])
  out.push([["─".repeat(w), "rule"]])
  const notes: string[] = []
  for (const t of rows.slice(0, 200)) {
    out.push([["  ", ""], ...cols.map((c, i): Seg => {
      const [text, style] = c.cell(t)
      return [cell(c, text, i), style]
    })])
    if (t.outcome) notes.push(`${clock(t.at)} ${t.outcome}`)
    else if (t.source !== "engine" && t.skip && t.skip !== "no-adapter") notes.push(`${clock(t.at)} ${SKIP_LABEL[t.skip]}`)
  }
  if (notes.length > 0) {
    out.push([])
    for (const l of wrap(notes.slice(0, 6).join(" · "), w - 2)) out.push([[`  ${l}`, "dim"]])
  }
  return out
}

/** A long name cut in the middle: a model's distinguishing part is often its end. */
function midCut(s: string, n: number): string {
  if (s.length <= n) return s
  const keep = n - 1
  return `${s.slice(0, Math.ceil(keep / 3))}…${s.slice(s.length - Math.floor((keep * 2) / 3))}`
}

// ---- vertical spacing ------------------------------------------------------------------

/**
 * A terminal row has one height and a plugin cannot change it, so space
 * between lines comes only in whole blank rows. "roomy" is the layout the
 * user settled on (2026-09-25, by editing the mockup): a blank row under every
 * section heading, and the blank row between sections. Nothing else: rows
 * around the bars made the Tokens section and the time bar look gapped.
 */
export type Spacing = "tight" | "roomy"

const isHeading = (l: Line): boolean =>
  l.some(([t, st]) => st === "rule" && t.startsWith("─")) && (l[0]?.[1] === "bold" || l[0]?.[1] === "engine")

export function spaced(lines: readonly Line[], spacing: Spacing): Line[] {
  if (spacing === "tight") return [...lines]
  const out: Line[] = []
  lines.forEach((l, i) => {
    out.push(l)
    const next = lines[i + 1]
    if (isHeading(l) && next !== undefined && next.length > 0) out.push([])
  })
  return out
}
