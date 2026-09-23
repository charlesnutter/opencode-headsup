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
