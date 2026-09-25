## [Unreleased]
### Fixed
- A reply is recorded when it ends, not when OpenCode's execution does. A
  message sent while a reply is running is queued into the same execution,
  so the first reply was never shown: a 19m 53s reply left the previous
  turn in the sidebar.
- A reply that was interrupted or failed is shown, marked `interrupted` or
  `failed`, with OpenCode's figures up to that point, instead of leaving the
  previous turn in place. The history panel marks it too.

## [0.3.1] – 2026-09-24
### Changed
- The first turn after OpenCode starts can show engine figures on
  `vllm`, `sglang`, `vllmmlx`, `aphrodite`, `lmdeploy`, `llamacpp`,
  `llamafile`, `splash` and `omlx`, instead of `engine telemetry from the
  next turn`. When a turn starts on one of these engines with no reading
  yet, that one engine is read once. Nothing is read at startup, and no
  other engine is read. A new session that has not used or selected a
  model yet is not primed, as before.
- A turn shown with OpenCode's own figures is headed by the engine's name,
  as its engine figures are (`vllm-mlx`, not `vllmmlx`).

## [0.3.0] – 2026-09-23
### Added
- A **Session** section below the per-turn figures, collapsed by default:
  click its heading to open it. Collapsed, it still shows the session's
  generation speed (`▸ Session · 14 turns  48.2 tok/s`). Open, it
  shows generation tok/s with a trend of recent turns, TTFT median and
  worst, cache hit rate, how the time split between generating, waiting
  for the first token and everything else, the engine's own averages
  (MTP or draft acceptance, prefill rate) where the engine provides them,
  and retries. Only the current model's turns count; the heading says so
  when the model changed partway through. The session's tokens, context
  and cost are left to OpenCode's own sidebar.
- Sub-agent roll-ups. A turn that started sub-agents adds a line to the
  per-turn figures (`sub-agents  2 · 4,210 tok`, then `38.10s` and
  `$0.012` on the rows below): their tokens and cost summed, and the time from the first starting to the last
  finishing. Rates are never combined across them. The Session section
  totals them in a `sub-agents` row, and its time split gives the real time
  sub-agents were running its own share instead of folding it into `other`.
- On `vllm`, `sglang`, `vllmmlx`, `aphrodite`, `lmdeploy`, `llamacpp`,
  `llamafile`, `splash` and `omlx`, a turn whose sub-agent used the same
  engine is no longer declined: the engine's window is expected to hold the
  turn's requests and tokens plus the sub-agents'. Those figures then cover
  both, and the line says `incl. sub-agents`. Rate and TTFT stay the turn's
  own. Built and tested against captures; not yet run live.
- `background` option (default on): shades each box one step above the
  sidebar's own background.

### Changed
- The sidebar is two boxes, the last turn and the session, each opened and
  closed independently by clicking its heading. Figures are laid out one
  per line as label and value; a figure with parts continues on the next
  line. Collapsed, a heading keeps one figure. The heading names the
  engine, not the model, which OpenCode already shows under the prompt.
- mlx-serve no longer shows a non-streamed request's whole-request rate:
  it includes prefill, so it is not generation speed.
- `mtplx`, `koboldcpp` and `mlxserve` are read when each step finishes
  streaming, not when OpenCode marks the step ended. For a step that calls
  tools, "ended" comes only after the tools have run, and a sub-agent on the
  same engine had replaced the step's figures by then, so the turn was
  declined with `engine data skipped: overlapping requests`. Measured on
  MTPLX: 194 tokens (the step's own) at the end of streaming, 163 (the
  sub-agent's) at "ended".
- The history panel's headline rate is generation tok/s on the newest
  turn's model (tokens over streaming time, as in the Session box), instead
  of a mean of per-turn rates across every model.

## [0.2.4] – 2026-09-23
### Changed
- `mtplx` is read at the end of every step, not once per turn, so a turn
  that calls tools shows engine figures for the whole turn: tokens summed,
  the rate over every step's decode time, TTFT and prefill from the first
  step, MTP acceptance weighted across steps. Each step's receipt must match
  OpenCode's count for that step; if one doesn't, the turn shows the
  universal line with the overlapping-requests notice.
- `koboldcpp` and `mlxserve` are read the same way: at the end of every
  step, combined across the turn, each step checked against OpenCode's
  count. KoboldCpp's `N generations this turn (last shown only)` no longer
  appears on turns read step by step, since nothing is dropped. Built from
  live captures; not yet run step by step against a live server.
- `llamacpp`, `llamafile`, `splash` and `omlx` check that a window is this
  turn's before showing it: its tokens must equal OpenCode's count for the
  turn and, for Splash and oMLX, its requests must equal the turn's steps.
  A window that fails shows the universal line with the overlapping-requests
  notice. Splash's `N requests this turn` no longer appears once the
  requests are accounted for. On a multi-step turn oMLX shows OpenCode's
  generation rate instead of the server's all-time average. Built from live
  captures; not yet run against a live server.
- Every engine line's total is OpenCode's -- what you waited, retries named
  -- rather than an engine's own request or phase timings.

## [0.2.3] – 2026-09-23
### Changed
- A turn that calls tools is now measured as the whole turn, not its last
  step. Tokens, cost and cache reuse are summed over every step; measured, a
  316-token, 37s turn had shown `140 tok  10.20s`. Applies to the sidebar,
  the collapsed line and history. The engine line from `mtplx`, `koboldcpp`
  and `mlxserve`, which report the latest request, still describes a tool
  turn's last step; reading them per step follows in a later release.
- Turn time is what you waited, from the request to the last step's end,
  and names any retries OpenCode made: `60.00s (6 retries)`.
- `tok/s` is generation speed only: tokens over the time spent streaming
  after each step's first token, so tool execution and prefill never count.
  A turn that cannot be timed from its stream shows no rate, where it used to
  show a whole-turn figure labelled `overall`.

### Fixed
- Prometheus engines declined every tool-using turn: its window holds one
  request per step. One per step is now expected, with the engine's tokens
  checked against the turn's total.
- On a single-step Prometheus turn the total was the engine's request
  duration, which excludes retries; it is now the total you waited.

## [0.2.2] – 2026-09-22
### Fixed
- `vllm`, `sglang`, `vllmmlx`, `aphrodite` and `lmdeploy` rendered figures
  for several requests as one turn's whenever other requests reached the
  engine in the same window — a new session's title, an interrupted turn, a
  second tab. Measured: a 46-token answer showed `116135.1 tok/s` over
  `8594 tok`. Such a turn now shows the universal line with
  `engine data skipped: overlapping requests`.
- On engines that publish a request-duration histogram (`sglang`,
  `vllmmlx`, `lmdeploy`), the turn's total and engine-derived decode rate
  were averaged with any other request in the window. On vllm-mlx every
  OpenCode turn is joined by a rejected ~0s title request, which halved the
  total (`0.32s` against OpenCode's own `649ms`). The engine's duration is
  now used only when exactly one was recorded; otherwise OpenCode's timing.
- With several tabs open, a turn completing in one tab replaced every other
  tab's sidebar line with `inference · —`. The sidebar kept one line for the
  whole TUI; it now keeps one per session. The collapsed line had the same
  fault and now uses its own session's latest turn. A turn in one tab can no
  longer suppress another tab's line as out of order.
- The history panel's legend said `*` rows were "engine-measured". Every row
  holds OpenCode's own figures; `*` only means the sidebar line for that turn
  came from the engine. The legend now says so.

## [0.2.1] – 2026-09-22
### Fixed
- The plugin crashed on load with `ctx.storage.memory is not a function` when
  installed from npm. `package.json` carried a `main` field, which OpenCode's
  loader falls back to for the **server** process, so a TUI-only plugin was
  being started there. It now exposes `./tui` and nothing else, and the server
  skips it.

## [0.2.0] – 2026-09-22
### Added
- TTFT for `omlx`, `llamacpp`, `llamafile`, `splash` and `koboldcpp`, which
  report none of their own. Taken from OpenCode's stream marks and labelled
  `(host)`, because it spans queue, network and event delivery as well as
  prefill — not the same measurement an engine reports.

### Fixed
- A time-to-first-token at or past the end of its own turn is now suppressed
  rather than shown. These marks are TUI-side event arrivals, so on a short
  turn the first delta can land after the response is already complete.

## [0.1.1] – 2026-09-22
### Fixed
- `ctrl+shift+h` opened the history panel but never closed it. The keymap
  layer was owned by the `sidebar.footer` slot, which unmounts when the
  panel takes over; it is now owned by the `app` slot and survives.

## [0.1.0] – 2026-09-21
### Added
- Universal per-turn telemetry for every provider — rate, TTFT, exact
  token counts, cost and cache reuse, from OpenCode's own events
- Engine telemetry for 12 provider ids across 7 adapters: mtplx, omlx,
  llamacpp/llamafile, mlx-serve, splash, koboldcpp, vllm, sglang, vllm-mlx,
  and fixture-verified aphrodite and lmdeploy (CUDA-only, not independently
  live-tested — see README)
- Collapsible sidebar line (`ctrl+shift+m`, or click) and a per-turn history
  panel (`ctrl+shift+h`)
- `showContext` option, off by default
