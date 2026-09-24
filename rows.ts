// The sidebar's layout unit: labelled rows, one figure per line.
//
// Pure, like history.ts and panels.ts. Adapters and the universal layer build
// a TurnView; the entry file draws it into a box. A value with parts
// continues on the next row under an empty label, so every row fits the
// sidebar's 38 columns: a 12-cell label column inside a box with a 1-cell
// margin and 2-cell side padding leaves 20 cells for the value.

/** A label and its value. An empty label continues the row above. */
export type Row = readonly [label: string, value: string]

export interface TurnView {
  /** The heading: the engine (or provider id), never the model. */
  engine: string
  rows: Row[]
  /** Full-width notes below the rows, e.g. why engine figures are missing. */
  notes: string[]
  /** The one figure a collapsed heading keeps, e.g. `34.4 tok/s`. */
  key?: string
}

/** Width of the label column, in cells. */
export const LABEL_WIDTH = 12

/** Numbers with thousands separators, as the mockup shows them. */
export const nt = (v: unknown): string =>
  typeof v === "number" && isFinite(v) ? Math.round(v).toLocaleString("en-US") : "?"

/** A row per part: the first carries the label, the rest continue it. */
export function rowsOf(label: string, parts: readonly string[]): Row[] {
  return parts.filter(Boolean).map((p, i) => [i === 0 ? label : "", p] as const)
}

/** One line per row, label padded to its column. */
export function rowLines(rows: readonly Row[]): string[] {
  return rows.map(([label, value]) => `${label.padEnd(LABEL_WIDTH)}${value}`)
}

/**
 * A view as plain text: the engine, then `label value` per row, then notes.
 * Used to store a view per session and by tests that look for a figure.
 */
export function viewText(v: TurnView): string {
  return [v.engine, ...v.rows.map(([l, val]) => (l ? `${l} ${val}` : val)), ...v.notes].join("\n")
}

/** Serialised for the per-session store, which holds strings. */
export function encodeView(v: TurnView): string {
  return JSON.stringify(v)
}

/** The stored string back to a view; a legacy plain-text line becomes a note. */
export function decodeView(s: string): TurnView {
  try {
    const v = JSON.parse(s) as TurnView
    if (v && typeof v.engine === "string" && Array.isArray(v.rows)) return { ...v, notes: v.notes ?? [] }
  } catch {
    // not JSON: a placeholder or a line stored by an earlier version
  }
  const [engine = "", ...rest] = s.split("\n")
  return { engine, rows: [], notes: rest }
}

/**
 * The turn's total -- what the user waited, from OpenCode -- and any
 * retries on the row below it.
 */
export function timeRows(total: number | undefined, retries = 0): Row[] {
  return rowsOf("time", [
    total !== undefined && isFinite(total) ? `${total.toFixed(2)}s` : "",
    retries > 0 ? `${retries} ${retries === 1 ? "retry" : "retries"}` : "",
  ])
}
