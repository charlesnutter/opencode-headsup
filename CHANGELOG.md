## [Unreleased]
### Added
- A **Session** section below the per-turn figures, collapsed by default:
  click its heading to open it. Collapsed, it still shows the session's
  generation speed (`▸ Session · 14 turns · 48.2 tok/s avg`). Open, it
  shows generation tok/s with a trend of recent turns, TTFT median and
  worst, cache hit rate, how the time split between generating, waiting
  for the first token and everything else, the engine's own averages
  (MTP or draft acceptance, prefill rate) where the engine provides them,
  and retries. Only the current model's turns count; the heading says so
  when the model changed partway through. The session's tokens, context
  and cost are left to OpenCode's own sidebar.
- `sessionBackground` option: the theme's offset shade behind the Session
  section.

### Changed
- The per-turn block's first line (engine and model) is bold, matching
  OpenCode's own sidebar sections.

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
