// mlx-serve enrichment — /v1/metrics/requests.
//
// mlx-serve (raspoli/mlx-serve) is an Apple-Silicon manager that hot-swaps MLX
// models, spawning `mlx_lm.server` as a subprocess and wrapping it with the
// observability that server lacks. Not to be confused with `mlx_lm.server`
// itself, which exposes nothing beyond per-response `usage`.
//
// Its shape is unlike any other engine here: instead of cumulative counters to
// difference, or a single last-request slot, it keeps a KEYED HISTORY of
// recent requests, newest first, each with its own `request_id`. That makes
// the freshness check exact — we report a record only once, by id — rather
// than inferred from a counter delta.
//
// Two traps, both found on a live v0.1.0 server and neither documented:
//
//   1. The unprefixed aliases (/health, /status, /metrics, /events,
//      /dashboard) are exact paths only. `/metrics/requests` 404s; the working
//      path is `/v1/metrics/requests`.
//   2. `ttft_ms` and `tokens_per_second` mean different things depending on
//      whether the request streamed. See `streamed` below.
//
// No JSX/solid-js imports, so it stays unit-testable (test/mlxserve.test.mjs).

import { httpJson, type HttpOptions } from "../http"
import { nn, ni } from "../format"
import { rowsOf, timeRows, viewText, nt, phase, type Row, type TurnView } from "../rows"

/** One record from /v1/metrics/requests, as the server names its fields. */
export interface MlxServeRequest {
  requestId: string
  model: string
  totalDurationMs: number
  ttftMs: number | null
  tokensPerSecond: number | null
  promptTokens: number | null
  completionTokens: number | null
  statusCode: number
  error: string | null
  coldStart: boolean
}

export interface MlxServeTurn {
  /** The record this describes; the caller stores it to avoid reporting twice. */
  requestId: string
  completionTokens: number
  /**
   * Absent on a streamed request: mlx_lm.server reports no prompt count when
   * streaming, so the field comes back null and there is nothing to show.
   */
  promptTokens?: number
  /**
   * True decode rate, excluding prefill. Only on a streamed request, where the
   * server computes it as completion / (duration - TTFT) — verified exactly
   * against a live record: 100 tokens, 463.5ms duration, 198.8ms TTFT, 377.8
   * tok/s reported, and 100/(0.4635-0.1988) == 377.8.
   */
  decodeTokS?: number
  /**
   * Whole-request rate including prefill, on a NON-streamed request, where the
   * server's own figure is completion / duration. Kept separate from
   * `decodeTokS` because the two are not comparable and must not be shown
   * under the same label.
   */
  overallTokS?: number
  /** Real TTFT, streamed requests only — see `streamed`. */
  ttft?: number
  totalS: number
  /**
   * Whether the request streamed, which decides what the two figures above
   * mean. A non-streamed request has no first-token event to observe, so the
   * server stamps TTFT at completion and `ttft_ms` comes back equal to
   * `total_duration_ms` (measured: 4778.7 and 4778.7). Its `tokens_per_second`
   * is then a whole-request rate, not a decode rate. OpenCode streams, so the
   * streamed branch is the normal one.
   */
  streamed: boolean
  /**
   * The model was loaded on demand during this request, so the duration
   * includes model load — 4.8s against 0.46s once warm, for the same server.
   * Worth showing, or the turn reads as a collapse in performance.
   */
  coldStart: boolean
  /**
   * Usable records summed into this turn — normally 1. mlx-serve keeps a
   * bounded history (`last_n`, requested as 5) of individual records rather
   * than only the most recent one, so unlike KoboldCpp's `/api/extra/perf`
   * this genuinely CAN recover more than one request's tokens when several
   * land between polls (an agentic turn's tool round trips, the same real
   * case Splash's own `requests` field exists for).
   *
   * Confirmed missing before this field existed: three records B, C landing
   * after the last-seen id, only C's (the newest's) completionTokens ever
   * reported — B's tokens silently gone, no indication. completionTokens and
   * promptTokens below are now the SUM across every usable new record; the
   * rate/ttft/streamed fields still describe only the single newest one when
   * `requests === 1`, and are dropped (not misattributed) when > 1, since
   * mlx-serve hands over a pre-computed per-record rate with no raw
   * token+time counters to aggregate the way Splash's do.
   */
  requests: number
  /**
   * Set when the turn was read step by step (`combineMlxServeSteps`): every
   * request is then accounted for, one per step, and the "requests this
   * turn" note -- which exists to flag a summed window -- does not apply.
   */
  steps?: number
}

/**
 * How close `ttft_ms` must get to `total_duration_ms` before we treat the two
 * as the same instant, i.e. a non-streamed request. A genuinely streamed turn
 * leaves a real decode window between them.
 */
const NON_STREAM_RATIO = 0.99

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export function parseMlxServeRequests(raw: unknown): MlxServeRequest[] | null {
  const list = (raw as { requests?: unknown } | null | undefined)?.requests
  if (!Array.isArray(list)) return null // not this endpoint
  const out: MlxServeRequest[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const r = entry as Record<string, unknown>
    if (typeof r.request_id !== "string") continue
    out.push({
      requestId: r.request_id,
      model: typeof r.model === "string" ? r.model : "",
      totalDurationMs: num(r.total_duration_ms) ?? 0,
      ttftMs: num(r.ttft_ms),
      tokensPerSecond: num(r.tokens_per_second),
      promptTokens: num(r.prompt_tokens),
      completionTokens: num(r.completion_tokens),
      statusCode: num(r.status_code) ?? 200,
      error: typeof r.error === "string" ? r.error : null,
      coldStart: r.cold_start === true,
    })
  }
  return out
}

/**
 * Picks the newest usable record and turns it into this turn's figures.
 *
 * `lastSeenId` is the record already reported for a previous turn. The history
 * is newest-first, so if the head still carries that id nothing new has
 * completed and this returns null — the universal line stands instead. Records
 * that failed, or produced no tokens, are skipped rather than reported.
 */
export function mlxServeTurn(
  records: MlxServeRequest[],
  lastSeenId: string | undefined
): MlxServeTurn | null {
  // Two different situations, and conflating them was a real bug caught by
  // the existing tests: with NO baseline yet (first turn after launch),
  // there is nothing to diff against, so this must behave like every other
  // adapter's first-turn case -- scan for the single newest USABLE record
  // (skipping past any failed/empty ones at the head, as `.find()` always
  // did), never summing the whole `last_n` history the server happened to
  // be holding before this plugin ever started watching. Only once a
  // baseline EXISTS -- whether still visible or aged out of the bounded
  // history because more requests landed than the server retains -- does
  // summing every record ahead of it become correct, since all of it is
  // then provably new.
  const sumAcrossWindow = lastSeenId !== undefined
  const newRecords = !sumAcrossWindow
    ? records
    : (() => {
        const idx = records.findIndex((x) => x.requestId === lastSeenId)
        return idx === -1 ? records : records.slice(0, idx)
      })()

  const usable = newRecords.filter(
    (x) => x.statusCode < 400 && x.error === null && (x.completionTokens ?? 0) > 0
  )
  if (usable.length === 0) return null
  // No baseline: only the single newest usable record, matching every other
  // adapter's first-turn behaviour and the original .find()-based logic.
  const relevant = sumAcrossWindow ? usable : usable.slice(0, 1)

  const head = relevant[0] // newest usable record: source for rate/ttft/streamed
  // Unreachable: `usable.length === 0` returned above and both branches of
  // `relevant` keep at least one element. Stated as a guard rather than a
  // cast so the invariant is checked instead of asserted -- this repo's
  // tsconfig adds noUncheckedIndexedAccess, which v1's did not.
  if (!head) return null
  const totalS = head.totalDurationMs / 1000
  // TTFT at or above the whole duration means it was stamped at completion.
  const streamed =
    head.ttftMs !== null && head.totalDurationMs > 0 && head.ttftMs < head.totalDurationMs * NON_STREAM_RATIO
  const rate = head.tokensPerSecond !== null && head.tokensPerSecond > 0 ? head.tokensPerSecond : undefined

  // Sum tokens across every usable new record -- this IS recoverable, unlike
  // KoboldCpp's endpoint, because individual records survive rather than
  // only the latest.
  const completionTokens = relevant.reduce((sum, x) => sum + (x.completionTokens ?? 0), 0)
  const promptTokens = relevant.every((x) => x.promptTokens !== null)
    ? relevant.reduce((sum, x) => sum + (x.promptTokens ?? 0), 0)
    : undefined // a streamed record reports no prompt count; can't sum a mix

  return {
    requestId: head.requestId,
    completionTokens,
    promptTokens,
    // Only attributable to a single request: with more than one summed in,
    // there is no raw token+time counter to aggregate a rate from (mlx-serve
    // hands over a pre-computed per-record tokens_per_second, not the
    // components), so showing the newest one's rate next to a summed token
    // count would misattribute it. Dropped, matching how this codebase
    // treats every other "cannot defend this denominator" case.
    decodeTokS: relevant.length === 1 && streamed ? rate : undefined,
    overallTokS: relevant.length === 1 && !streamed ? rate : undefined,
    ttft: relevant.length === 1 && streamed ? (head.ttftMs as number) / 1000 : undefined,
    totalS,
    streamed,
    coldStart: relevant.some((x) => x.coldStart),
    requests: relevant.length,
  }
}

/**
 * Renders the panel block. When more than one request was summed into this
 * turn, the rate/ttft fields are already absent (see mlxServeTurn), and a
 * trailing note says how many were combined -- matching Splash's own
 * "N requests this turn" convention, since both exist for the identical real
 * scenario (an agentic turn's tool round trips landing between two polls).
 */
/**
 * One turn from its steps, each read at that step's end: the newest usable
 * record in that read is the step. Returns null unless every step's record
 * is new -- not the previous step's, not the last one reported (`lastSeenId`)
 * -- and its tokens equal OpenCode's own count for the step.
 *
 * Tokens are summed (prompt tokens only if every record has them); the rate
 * is total tokens over total decode time, only when every step streamed;
 * ttft is the first step's; a cold start in any step is flagged.
 */
export function combineMlxServeSteps(
  steps: ReadonlyArray<{ records: MlxServeRequest[] | null; hostTokens: number }>,
  lastSeenId?: string
): MlxServeTurn | null {
  const turns: MlxServeTurn[] = []
  let prevId = lastSeenId
  for (const { records, hostTokens } of steps) {
    if (!records) return null
    const t = mlxServeTurn(records, undefined) // newest usable record only
    if (!t || t.requestId === prevId || t.completionTokens !== hostTokens) return null
    prevId = t.requestId
    turns.push(t)
  }
  const first = turns[0]
  const last = turns[turns.length - 1]
  if (!first || !last) return null
  const completion = turns.reduce((n, t) => n + t.completionTokens, 0)
  const decodeS = turns.every((t) => t.decodeTokS !== undefined && t.decodeTokS > 0)
    ? turns.reduce((n, t) => n + t.completionTokens / (t.decodeTokS as number), 0)
    : undefined
  return {
    requestId: last.requestId,
    completionTokens: completion,
    promptTokens: turns.every((t) => t.promptTokens !== undefined)
      ? turns.reduce((n, t) => n + (t.promptTokens as number), 0)
      : undefined,
    decodeTokS: decodeS !== undefined && decodeS > 0 ? completion / decodeS : undefined,
    overallTokS: undefined,
    ttft: first.ttft,
    totalS: turns.reduce((n, t) => n + t.totalS, 0),
    streamed: turns.every((t) => t.streamed),
    coldStart: turns.some((t) => t.coldStart),
    requests: turns.length,
    steps: turns.length,
  }
}

/**
 * The turn as labelled rows. `host.total` is the turn's total from OpenCode
 * -- what the user waited, retries included -- and wins over the record's
 * request duration. Only a streamed record's rate is shown: a non-streamed
 * record's `tokens_per_second` is completion / whole duration, prefill
 * included, which is not generation speed (OpenCode always streams).
 */
export function mlxServeView(
  t: MlxServeTurn,
  host: { total?: number; retries?: number } = {}
): TurnView {
  const rows: Row[] = [
    ...rowsOf("speed", [t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s` : ""]),
    ...rowsOf("ttft", [t.decodeTokS !== undefined && t.ttft !== undefined ? `${nn(t.ttft, 2)}s` : ""]),
    ["tokens", nt(t.completionTokens)],
    ...rowsOf("prompt", [t.promptTokens !== undefined ? nt(t.promptTokens) : ""]),
    ...timeRows(host.total ?? t.totalS, host.retries),
  ]
  const notes: string[] = []
  // A cold start loaded the model mid-request; without this the turn reads
  // as a tenfold slowdown rather than a one-off load.
  if (t.coldStart) notes.push("cold start (model loaded)")
  if (t.requests > 1 && t.steps === undefined) notes.push(`${ni(t.requests)} requests this turn`)
  const detail: Row[] = [
    ...rowsOf("speed", [t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s` : ""]),
    ...rowsOf("ttft", [t.decodeTokS !== undefined && t.ttft !== undefined ? `${nn(t.ttft, 2)}s` : ""]),
    ["tokens", nt(t.completionTokens)],
    ...rowsOf("prompt", [t.promptTokens !== undefined ? `${nt(t.promptTokens)} tok` : ""]),
    ["request", `${nn(t.totalS, 2)}s`],
    ...rowsOf("requests", [t.requests > 1 ? nt(t.requests) : ""]),
  ]
  return {
    engine: "mlx-serve",
    rows,
    notes,
    key: t.decodeTokS !== undefined ? `${nn(t.decodeTokS)} tok/s` : undefined,
    detail,
  }
}

/** The view as text; kept for tests that look for a figure. */
export function formatMlxServeLine(
  t: MlxServeTurn,
  _model: string,
  host: { total?: number; retries?: number } = {}
): string {
  return viewText(mlxServeView(t, host))
}

export async function fetchMlxServeRequests(
  base: string,
  model?: string,
  apiKey?: string,
  opts?: HttpOptions
): Promise<MlxServeRequest[] | null> {
  // Note the /v1 prefix: /metrics/requests without it is a 404.
  const q = new URLSearchParams({ last_n: "5" })
  if (model) q.set("model", model)
  // MLX_API_KEY, when set on the server, guards every route on this router.
  const headers = apiKey ? { ...opts?.headers, authorization: `Bearer ${apiKey}` } : opts?.headers
  return parseMlxServeRequests(
    await httpJson(`${base}/v1/metrics/requests?${q}`, { ...opts, headers })
  )
}
