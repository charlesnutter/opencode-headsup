// Which line the sidebar shows, per session.
//
// Pure functions only, for the same reason as history.ts: the entry file
// cannot be imported by tests.
//
// The panel once held one line for the whole TUI, gated on its session so a
// tab never showed another tab's figures. With several tabs open that gate
// wiped every other tab: a turn completing in tab B replaced the one line,
// and tab A fell back to the placeholder (measured live, 2026-09-22). Each
// session now keeps its own last line.

/** Shown for a session that has no completed turn in this TUI yet. */
export const PLACEHOLDER = "inference · —"

/**
 * Sessions kept. The store is memory-scoped and dies with the TUI, so this
 * only bounds a long-running TUI that opens many sessions; one line each is
 * small, and 32 is more tabs than anyone keeps open.
 */
export const PANEL_CAP = 32

export interface PanelEntry {
  text: string
  /** `provider/model` the line describes, to detect a switch per session. */
  key?: string
  /** Write order, for evicting the least recently written session. */
  w: number
}

export interface Panels {
  bySession: Record<string, PanelEntry>
  /** Monotonic write counter. */
  w: number
}

export function emptyPanels(): Panels {
  return { bySession: {}, w: 0 }
}

export function lineFor(p: Panels, sessionID: string | undefined): string {
  if (sessionID === undefined) return PLACEHOLDER
  return p.bySession[sessionID]?.text ?? PLACEHOLDER
}

export function keyFor(p: Panels, sessionID: string): string | undefined {
  return p.bySession[sessionID]?.key
}

/** Returns a new Panels with `sessionID`'s line set, bounded to PANEL_CAP. */
export function setLine(p: Panels, sessionID: string, text: string, key?: string): Panels {
  const w = p.w + 1
  const bySession: Record<string, PanelEntry> = { ...p.bySession, [sessionID]: { text, key, w } }
  if (Object.keys(bySession).length > PANEL_CAP) {
    let oldest: string | undefined
    let oldestW = Infinity
    for (const [id, e] of Object.entries(bySession)) {
      if (e.w < oldestW) {
        oldest = id
        oldestW = e.w
      }
    }
    if (oldest !== undefined) delete bySession[oldest]
  }
  return { bySession, w }
}

/**
 * Monotonic guard against out-of-order renders, per key. A report awaits an
 * engine fetch, so two turns completing close together race; only the latest
 * turn for a session may claim that session's line. Keyed by session so a
 * turn in one tab never suppresses a turn in another -- one TUI-wide counter
 * did exactly that.
 */
export class LatestPerKey {
  private readonly n = new Map<string, number>()

  begin(key: string): number {
    const seq = (this.n.get(key) ?? 0) + 1
    this.n.set(key, seq)
    return seq
  }

  isLatest(key: string, seq: number): boolean {
    return this.n.get(key) === seq
  }
}
