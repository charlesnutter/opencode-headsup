# Measurement notes

The README's "Important Notes" section in full, as it stood before it was
shortened (2026-09-25). Kept here as source material for fuller docs later.

Two things have changed since it was written and should be updated before
this is published anywhere:

- **Compaction.** A compaction inside a turn on a counter engine is now read
  before and after and taken out of the turn's window, so the turn keeps its
  engine figures; `compaction ran this turn` is shown only when that fails.
- **Same-engine sub-agents.** A sub-agent on the same counter engine as its
  parent is expected in the parent's window (its tokens and steps are added
  to the check) and labelled `incl. sub-agents`, and each turn now takes its
  own starting reading, so the sub-agent's report no longer moves it.

---

## Important Notes (as of 0.4.0)

### tok/s is generation speed; the total is what you waited

`tok/s` is tokens over the time spent streaming after the first token —
raw generation speed. OpenCode's own tok/s, in the footer under each turn,
divides by each step's time from the request to the end of streaming: it
leaves out time spent running tools, but includes prefill and the wait for
the first token. On a turn with a long wait before the first token the two
differ widely (measured: 38.1 tok/s over a 0.97s decode window against 3.7
over the same turn's 10.03s; on MTPLX with a 17.6s prefill, 35.2 against
OpenCode's 13.1). Both are correct; the TTFT
beside the rate is what reconciles them. A turn that cannot be timed
from its stream shows no rate rather than a whole-turn figure.

A large prefill shows in TTFT, in the prefill rate where the engine
reports one, and in the total — never in `tok/s`. The total runs from
the request to the end of the turn, and names any retries OpenCode made:
`60.00s (6 retries)`.

A turn that calls tools is several requests, one per step. Its tokens,
cost and cache reuse are summed over every step; its `tok/s` covers only
the steps' own streaming, never the time spent running tools.

### Every figure is one turn, never a running total

Four things in this API are cumulative where a per-turn figure is
expected — `session.usage.updated`, `session.cost()`, raw engine
counters, and `time.streamed` (which is stamped at the *end* of the
stream, not the start, and is therefore not a TTFT). The per-turn
figures here are differenced or measured accordingly.

A counter difference is only one turn's when the requests that reached the
engine between the two readings are this turn's own — one per step — and
its token count equals OpenCode's for the turn. OpenCode's own background
work (a new session's title, compaction), a turn you interrupted that kept
generating, or another tab or client sharing the server all break that, and
no engine here labels its counters by request or session to separate them
again. So a turn that shared its window shows the universal line with
`engine data skipped: overlapping requests` rather than figures that
describe several requests at once. This applies to every engine that
differences counters: the Prometheus engines, `llamacpp`, `llamafile`,
`splash` and `omlx`, checked against the turn's tokens and, where the
engine counts requests, against its steps. Verified live on vllm-mlx; the
others are built from their live captures.

`mtplx`, `koboldcpp` and `mlxserve` report only the engine's latest
request, so they are read at the end of every step and the steps' receipts
combined: tokens summed, the rate over every step's decode time, TTFT and
prefill from the first step, the step that read the context. Each receipt
must match OpenCode's count for its step, or the turn shows the universal
line with the notice. Verified live on MTPLX; KoboldCpp and mlx-serve are
built from their live captures but not yet run step by step against a live
server.

### Absent is not zero

A free model shows no cost rather than `$0.00`, a cold prompt shows no
cache line rather than `0 cached`, and a missing speculative-draft
counter shows nothing rather than `0% accepted`.
