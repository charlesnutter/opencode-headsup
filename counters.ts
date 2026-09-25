// Taking a known request out of a counter window.
//
// Pure, like the other shared modules. Engines that publish cumulative
// counters -- Splash, llama.cpp, llamafile, the Prometheus engines -- give a
// turn's figures as the difference between a reading before it and one after.
// A request of OpenCode's own inside that window (a compaction, measured on
// Splash) lands in the difference too, and the turn is declined because its
// tokens no longer match. When that request was bracketed by readings of its
// own, its difference can be taken back out.

/** Field-wise `after - before`, for every numeric field. */
export function counterDelta<T extends object>(before: T, after: T): Partial<Record<keyof T, number>> {
  const out: Partial<Record<keyof T, number>> = {}
  for (const k of Object.keys(after) as Array<keyof T>) {
    const a = after[k]
    const b = before[k]
    if (typeof a === "number" && typeof b === "number") out[k] = a - b
  }
  return out
}

/**
 * The baseline moved forward by each bracketed request's own difference, so
 * that `now - shifted` holds everything in the window except those requests.
 * Non-numeric fields keep the baseline's. A bracket that went backwards (a
 * restarted engine) can't be trusted, and leaves the baseline as it was.
 */
export function shiftBaseline<T extends object>(prev: T, brackets: ReadonlyArray<{ before: T; after: T }>): T {
  const shifted = { ...prev } as Record<string, unknown>
  for (const { before, after } of brackets) {
    const d = counterDelta(before, after) as Record<string, number | undefined>
    if (Object.values(d).some((v) => v !== undefined && v < 0)) continue
    for (const [k, v] of Object.entries(d)) {
      const cur = shifted[k]
      if (typeof cur === "number" && v !== undefined) shifted[k] = cur + v
    }
  }
  return shifted as T
}
