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
