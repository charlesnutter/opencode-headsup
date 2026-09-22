// Shared fetch plumbing for every engine adapter.
//
// This existed six times over — one copy per adapter, each pairing an
// AbortController with a setTimeout and a clearTimeout in a finally block.
// Beyond the duplication, that shape has two defects:
//
//   1. The timeout is the ONLY thing that can cancel a request. When the
//      plugin is disposed mid-turn, in-flight fetches keep running for up to
//      their full timeout, holding their closures alive past teardown.
//   2. Every copy has to remember to clear its timer on all three paths
//      (success, HTTP error, throw). One missed `clearTimeout` leaks a timer
//      per request.
//
// Both go away by composing signals instead of managing a timer:
// `AbortSignal.timeout` is runtime-managed with nothing to clear, and
// `AbortSignal.any` lets the caller's lifetime cancel the request too. The
// TUI api exposes `lifecycle.signal` for exactly this.

/** Default per-request budget. Telemetry is never worth stalling a turn for. */
const DEFAULT_TIMEOUT_MS = 2500

export interface HttpOptions {
  headers?: Record<string, string>
  /**
   * Cancels the request when it fires — pass `api.lifecycle.signal` so a
   * disposed plugin does not leave requests running.
   */
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * A signal that aborts on whichever comes first: the timeout, or the caller's
 * own signal. Exported for adapters that need the signal without the fetch.
 */
export function requestSignal(timeoutMs = DEFAULT_TIMEOUT_MS, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return external ? AbortSignal.any([timeout, external]) : timeout
}

/**
 * Every failure is a null: unreachable host, non-2xx, abort, malformed body.
 * Callers treat null as "no enrichment this turn" and fall back to the
 * universal line, so distinguishing the causes would change nothing.
 */
export async function httpText(url: string, opts: HttpOptions = {}): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: requestSignal(opts.timeoutMs, opts.signal),
      headers: { connection: "close", ...opts.headers },
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** As `httpText`, parsed. Returns `unknown`: callers narrow at their boundary. */
export async function httpJson(url: string, opts: HttpOptions = {}): Promise<unknown> {
  try {
    const res = await fetch(url, {
      signal: requestSignal(opts.timeoutMs, opts.signal),
      headers: { connection: "close", ...opts.headers },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
