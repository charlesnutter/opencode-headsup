# Fixture provenance

Not all fixtures are equal evidence. Each file below is labelled with where it
came from, because "the test passes" means something different depending on it.

| File | Provenance |
|---|---|
| `mtplx-completed.json` | **Live capture.** MTPLX (Qwen3.8-27B), one completed turn (`usage: {prompt_tokens: 59, completion_tokens: 64, reasoning_tokens: 23}`). Capturing it found a real gap: `/metrics` `latest` has no reasoning/answer token field anywhere in its 342 keys — checked exhaustively, nested objects included — so the adapter cannot show a think/answer split for MTPLX, unlike engines whose panel gets that from the same endpoint it already polls. |
| `mtplx-interrupted.json` | **Live capture.** The client aborted an MTPLX stream mid-generation (`AbortController.abort()`). `ttft_s` and `prefill_tok_s` come back genuinely absent (no key, not `null`) while `decode_tok_s`, `completion_tokens` and `request_elapsed_s` survive — the regression case for the `?`-placeholder bug this adapter exists to prevent. |
| `omlx-before.json` | **Live capture.** oMLX 0.7.0.dev4, server freshly loaded, zero requests this session — the no-baseline / server-average fallback case. |
| `omlx-after-one.json` | **Live capture**, same server, immediately after exactly one real generation (`usage: {prompt_tokens: 17, completion_tokens: 100}`). The single-observation arithmetic-mean recovery — `recoverLatest` returns the server's own `avg_generation_tps` exactly, since one request against a zero baseline recovers itself. |
| `omlx-after-two.json` | **Live capture**, two more generations fired concurrently (not individually sampled) so both land in one window before the next poll. Real regression case: the multi-request fallback previously showed the raw `avg_generation_tps` with no label — which is the server's full *lifetime* average, not even a windowed one — right beside an exact per-window token count. Now carries `(avg)`, matching the vocabulary `(server avg)`/`ttftExact` already use elsewhere in this codebase for the same situation. |
| `vllm-mlx-idle.prom`, `vllm-mlx-after.prom` | **Live capture.** Taken from a local vllm-mlx server on Apple Silicon, bracketing one real generation whose response reported `usage: {prompt_tokens: 33, completion_tokens: 50}`. The test asserts against those numbers. |
| `vllm-metal-before.prom`, `vllm-metal-after.prom` | **Live capture.** Taken from upstream vLLM running under vllm-metal on Apple Silicon, bracketing one real generation (`usage: {prompt_tokens: 35, completion_tokens: 35}`). |
| `vllm-idle.prom`, `vllm-busy.prom` | **Real capture**, inherited from the inference-hud VS Code extension. Real bytes a real vLLM emitted, but not captured here and not cross-checked against a response body. |
| `sglang-stream-before.prom`, `sglang-stream-after.prom` | **Live capture.** SGLang on its MLX/Apple-Silicon backend (`SGLANG_USE_MLX=1 --enable-metrics`), bracketing one real **streaming** generation (`usage: {prompt_tokens: 35, completion_tokens: 25}`). This is the path OpenCode uses. |
| `sglang-before.prom`, `sglang-after.prom` | **Live capture**, same server, one **non-streaming** generation. Kept deliberately: SGLang stamps TTFT at completion when not streaming, so these are the regression case for the degenerate decode-window guard. |
| `mlxserve-streamed.json` | **Live capture.** mlx-serve 0.1.0 wrapping `mlx_lm.server`. History head is a streamed request: real `ttft_ms` (96.2ms of 356.2ms) and a decode-only `tokens_per_second`. Holds 3 real records (94, 100, 60 completion tokens), which also makes it the regression fixture for a multi-request window: with an older id as the baseline, the newer records must be SUMMED (194, or 254 for all three), not just the single newest reported. |
| `mlxserve-nonstreamed.json` | **Live capture**, same server, non-streamed. `ttft_ms` equals `total_duration_ms` (403 and 403) and the rate covers the whole request — the regression case for the stream detection. Holds 4 real records mixing streamed (`prompt_tokens: null`) and non-streamed ones, which is the regression fixture for the mixed-null-prompt-tokens case: summing across a mix must drop `promptTokens` entirely rather than silently undercounting it from only the defined ones. |
| `splash-before.prom`, `splash-after.prom` | **Live capture.** Splash 1.0 on Apple Silicon, bracketing one generation (`usage: {prompt_tokens: 63, completion_tokens: 200, cached_tokens: 32}`). `/metrics` needs no flag. |
| `splash-cached-before.prom`, `splash-cached-after.prom` | **Live capture.** The identical prompt re-sent. Splash counts only recomputed tokens as prefill, so prefilled + cached reconstructs the reported prompt in both pairs. |
| `llamacpp-before.prom`, `llamacpp-after.prom` | **Live capture.** `llama-server --metrics` on Apple Silicon, bracketing one generation (`usage: {prompt_tokens: 35, completion_tokens: 32}`). Bare unlabelled `llamacpp:` names — the only engine here that omits labels. llamafile publishes the identical names and shares this adapter. |
| `llamacpp-minimal-before.prom`, `llamacpp-minimal-after.prom` | **Live capture.** A `max_tokens: 1` generation. The server itself reports `tokens_predicted_seconds_total` as exactly `0.0` for this one token — not a tiny nonzero value — so this pins that the existing `decodeS > 0` guard converts that correctly to no rate, not Infinity or an inflated one. Checked directly for the KoboldCpp-style timer-floor bug; it does not reproduce here. |
| `llamacpp-cachehit-before.prom`, `llamacpp-cachehit-after.prom` | **Live capture.** An identical prompt re-sent after priming the cache once; `usage.prompt_tokens_details.cached_tokens` reports 40 of 41 prompt tokens cached, so only 1 token was actually recomputed. The resulting prefill rate is real and plausible (tens to low-hundreds tok/s across repeated runs), not absurd — this pair exists to show a near-total cache hit does not misbehave the way a full cache hit or a KoboldCpp-style floor artifact would. |
| `koboldcpp-before.json`, `koboldcpp-after.json` | **Live capture.** KoboldCpp v1.121, macOS arm64, bracketing one generation (`usage: {prompt_tokens: 16, completion_tokens: 83}`). Short prompt, so `last_process_time` sits on the ~1ms timer floor and the server reports 16000 tok/s prefill — the regression case for the floor guard. |
| `koboldcpp-novel-*.json` | **Live capture.** A long prompt with no prefix-cache overlap, so the prefill timer measures real work (0.197s over 2818 tokens). The positive case: prefill survives the floor. |
| `koboldcpp-cachehit-*.json` | **Live capture.** The identical prompt re-sent, a full prefix-cache hit. The server reports `process_time: 0.0` and `speed: 0` — not a huge rate. |
| `koboldcpp-longprompt-*.json` | **Live capture.** A *partial* cache hit: 2016 prompt tokens but only the uncached suffix timed, reported as 18000 tok/s. Pins the known, undetectable overstatement. |
| `koboldcpp-multigen-before.json`, `koboldcpp-multigen-after.json` | **Live capture.** Two generations fired back-to-back with only one poll after both (`total_gens` +2). `last_token_count` matched only the second request's own completion count — the first request's tokens are gone from the endpoint entirely, since `/api/extra/perf` keeps no history beyond the single most recent request. Real regression case for a silent under-count this adapter previously had; now detected via `generationsInWindow` and labelled in the panel. |
| `lmdeploy-before.prom`, `lmdeploy-after.prom` | **Synthesized.** LMDeploy is CUDA-only. Names and the `{model_name,engine}` label shape are verified against `lmdeploy/metrics/loggers.py`; values chosen to make the diff arithmetic checkable. |
| *(Aphrodite has no fixture)* | Its test **derives** input by swapping `vllm:` → `aphrodite:` in the real vLLM capture, which is precisely the documented difference between them. No real Aphrodite bytes exist here. |

KoboldCpp fixtures are JSON, not Prometheus text, and each carries a
`_provenance` object recording the host, server version, scenario and the
response body's own `usage` for the generation it brackets — the tests assert
against that block rather than against numbers typed into the test file.

## What a passing test does and doesn't tell you

Fixtures verify the parser and the diff arithmetic: label summing, the
`_created`-line trap, prefix boundaries, counter resets, blended windows.

They cannot verify that a current build of the engine actually emits those
names, that the endpoint exists, or that the flag to enable it is what the docs
say. Every one of those has been wrong at least once here — a flag documented
as `--metrics` was really `--enable-metrics`; an engine widely described as
having a Prometheus endpoint had none at all. Only running the thing catches
that.

Replace any synthesized pair with a real capture if a suitable machine becomes
available.

## Replacing a synthesized fixture with a real one

`scripts/capture-fixture.sh` captures a real before/after pair around exactly
one generation, and writes a provenance header recording the host, endpoint,
model and the response's own `usage` block:

```bash
./scripts/capture-fixture.sh http://127.0.0.1:30000 sglang: sglang
```

It refuses to write anything if `/metrics` is missing, carries no lines with
the expected prefix, or is byte-identical before and after a generation — the
three ways a capture would be worthless. Afterwards, assert the printed deltas
against the printed `usage` block in `test/prometheus.test.mjs` and update the
table above.
