# OpenCode Heads Up

Per-turn inference telemetry in the OpenCode 2 sidebar — the serving
engine's own metrics where an adapter exists, OpenCode's own turn data
everywhere else.

```
MTPLX  arsis-dev-ukisai-swift-…
38.1 tok/s  ttft 9.06s
prefill 452 tok/s
37 tok  10.03s
MTP 3.70x 99/96/80%
```

Requires **OpenCode 2**. For the v1 line (OpenCode 1.18.x), see
[opencode-engine-hud](https://github.com/charlesnutter/opencode-engine-hud),
which stays published and in maintenance.

## Contents

- [Install](#install)
- [Keys](#keys)
- [Configuration](#configuration)
- [Supported Engines](#supported-engines)
- [Engine Details](#engine-details)
- [Adding an Engine](#adding-an-engine)
- [What the numbers mean](#what-the-numbers-mean)
- [Roadmap](#roadmap)

## Install

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": ["@banburist/opencode-headsup"]
}
```

Restart OpenCode. The panel appears in the sidebar footer after the first
turn.

## Keys

| Key | Does |
| --- | --- |
| `ctrl+shift+m` | Collapse/expand the sidebar line. Clicking the line does the same. |
| `ctrl+shift+h` | Open/close the per-turn history panel. |

Both are registered with stable command ids (`headsup.toggle`,
`headsup.panel`), so they can be remapped from your own OpenCode keybind
config and are reachable from the command palette.

Collapsed, the line keeps one figure rather than becoming a bare label:

```
▸ view metrics  ·  38.1 tok/s
```

## Configuration

One key, because one figure is genuinely a preference. Everything else
appears exactly when its underlying data exists and stays silent when it
does not — there is nothing to choose.

```jsonc
{
  "plugins": [
    {
      "package": "@banburist/opencode-headsup",
      "options": { "showContext": false }
    }
  ]
}
```

`showContext` (default `false`) adds a `13% prompt/limit` line, computed as
`tokens.input / ModelInfo.limit.context`. It is off by default and labelled
`prompt/limit` rather than `context used` for a reason: OpenCode's sidebar
already shows its own context percentage from a formula this plugin cannot
see, and for custom providers `limit.context` is whatever you wrote in your
own `opencode.json` — config, not a measurement. Opting in gets a number
computed the same defensible way as everything else here; it does not get a
promise it matches the one above it.

Engine endpoints use the defaults below, overridable per key or by env var.
An engine that is not running just falls back to the universal layer.

| Option | Env | Default |
|---|---|---|
| `mtplxMetricsUrl` | `MTPLX_METRICS_URL` | `http://127.0.0.1:8000/metrics` |
| `omlxBaseUrl` | `OMLX_BASE_URL` | `http://127.0.0.1:8099` |
| `omlxApiKey` | `OMLX_API_KEY` | *(none — required to read oMLX)* |
| `llamacppBaseUrl` | `LLAMACPP_BASE_URL` | `http://127.0.0.1:8080` |
| `llamafileBaseUrl` | `LLAMAFILE_BASE_URL` | `http://127.0.0.1:8003` |
| `vllmBaseUrl` | `VLLM_BASE_URL` | `http://127.0.0.1:8000` |
| `sglangBaseUrl` | `SGLANG_BASE_URL` | `http://127.0.0.1:30000` |
| `vllmMlxBaseUrl` | `VLLM_MLX_BASE_URL` | `http://127.0.0.1:8000` |
| `aphroditeBaseUrl` | `APHRODITE_BASE_URL` | `http://127.0.0.1:2242` |
| `lmdeployBaseUrl` | `LMDEPLOY_BASE_URL` | `http://127.0.0.1:23333` |
| `splashBaseUrl` | `SPLASH_BASE_URL` | `http://127.0.0.1:8000` |
| `koboldcppBaseUrl` | `KOBOLDCPP_BASE_URL` | `http://127.0.0.1:5001` |
| `mlxServeBaseUrl` | `MLXSERVE_BASE_URL` | `http://127.0.0.1:8095` |
| `mlxServeApiKey` | `MLX_API_KEY` | *(unset)* |

`OPENCODE_HUD_DEBUG=1` logs adapter failures to
`/tmp/opencode-headsup-debug.log`. Adapter throws are swallowed by design so
a broken engine never blanks the panel; this is how you see them.

## Supported Engines

Every provider gets the **universal** line from OpenCode's own per-turn data
— rate, TTFT, exact token counts, cost and cache reuse. The provider ids
below additionally get their engine's own telemetry merged in. Get the id
exactly right (see [Adding an Engine](#adding-an-engine)) or you get the
universal line only.

| Provider | tok/s | TTFT | Prefill tok/s | Exact tokens | Cache info | Extras | Validated |
|---|---|---|---|---|---|---|---|
| [`mtplx`](#mtplx) | ✅ | ✅ | ✅ | ✅ | ❌ | MTP accept % | live |
| [`omlx`](#omlx) | ✅ | ❌ | ✅ | ✅ | ✅ | — | live |
| [`llamacpp`](#llamacpp) | ✅ | ❌ | ✅ | ✅ | ❌ | — | live |
| [`llamafile`](#llamafile) | ✅ | ❌ | ✅ | ✅ | ❌ | — | live |
| [`mlxserve`](#mlxserve) | ✅ | ✅ | ❌ | ✅ | ❌ | cold-start flag | live |
| [`splash`](#splash) | ✅ | ❌ | ✅ | ✅ | ✅ | draft accept % | live |
| [`koboldcpp`](#koboldcpp) | ✅ | ❌ | ✅ | ✅ | ❌ | draft accept % | live |
| [`vllm`](#vllm) | ✅ | ✅ | ❌ | ✅ | ✅ | — | live |
| [`sglang`](#sglang) | ✅ | ✅ | ❌ | ✅ | ✅ | — | live |
| [`vllmmlx`](#vllmmlx) | ✅ | ✅ | ❌ | ✅ | ❌ | — | live |
| [`aphrodite`](#aphrodite) | ✅ | ✅ | ❌ | ✅ | ✅ | — | derived |
| [`lmdeploy`](#lmdeploy) | ✅ | ✅ | ✅ | ✅ | ❌ | — | synthetic |
| anything else | ✅ | ✅ | ❌ | ✅ | ✅ | — | live |

`Validated` — **live**: run against a real server, deltas checked against
its own response. **derived**: a real vLLM capture with the metric prefix
swapped (Aphrodite is a vLLM fork, identical shape). **synthetic**: values
fixed by hand from the engine's source to make the arithmetic checkable, not
measured — `aphrodite` and `lmdeploy` are both CUDA-only and unavailable
here. Per-file provenance in [`fixtures/README.md`](fixtures/README.md).

## Engine Details

<a id="mtplx"></a>

### `mtplx` — MTPLX

Default `http://127.0.0.1:8000/metrics`. No think/answer split — `/metrics`
never reports `reasoning_tokens`.

<a id="omlx"></a>

### `omlx` — oMLX

Default `http://127.0.0.1:8099`. Requires `omlxApiKey`. No TTFT: its
counters are atomic at completion, so there is nothing to time a first
token against.

<a id="llamacpp"></a>

### `llamacpp` — llama.cpp

Default port 8080, needs `--metrics` (off by default). Use the classic
single-model `llama-server`, not the multi-model router — different
`/props` shape.

```bash
llama-server --hf-repo <user>/<repo> --hf-file <file>.gguf \
  --host 127.0.0.1 --port 8080 --metrics
```

No cache-hit counter, so prompt tokens read low on a cache hit rather than
reporting what was reused.

<a id="llamafile"></a>

### `llamafile` — llamafile

Default port 8003. Publishes identical `llamacpp:` metric names, so it
shares that adapter and can run alongside a real llama.cpp instance.

```bash
llamafile -m model.gguf --server --host 127.0.0.1 --port 8003 --metrics
```

<a id="mlxserve"></a>

### `mlxserve` — mlx-serve

Default port 8095. This is
[raspoli/mlx-serve](https://github.com/raspoli/mlx-serve), not
`mlx_lm.server` itself. Set `mlxServeApiKey` if it runs with `MLX_API_KEY`.
Matches turns by request id, so multi-request turns are summed rather than
dropped. A streamed request reports no prompt count; a non-streamed one has
no separate decode rate. Cold starts are flagged — a model swap runs ~10x
longer than a warm turn.

<a id="splash"></a>

### `splash` — Splash

Default port 8000, nothing to enable. Apple Silicon only.

```bash
splash serve --model <owner/repo>
splash opencode
```

Both phases are engine-timed, and prefill stays honest on a cache hit — it
counts only recomputed tokens, never the whole prompt.

<a id="koboldcpp"></a>

### `koboldcpp` — KoboldCpp

Default port 5001, nothing to enable. Mac arm64 binary is 64MB.

```bash
./koboldcpp --model <model.gguf> --port 5001
```

Prefill/decode arrive already timed. A partial cache hit overstates prefill
— there is no cached-token counter to correct it with. Streaming emits no
usage chunk, so this endpoint is the *only* source of token counts on a
streamed turn.

<a id="vllm"></a>

### `vllm` — vLLM

Default port 8000. On Apple Silicon,
[vllm-metal](https://github.com/vllm-project/vllm-metal) runs upstream vLLM
unchanged. Decode rate reuses OpenCode's turn timing — there is no
per-request duration histogram. TTFT is engine-reported but is a window
average, labelled `(avg)`.

<a id="sglang"></a>

### `sglang` — SGLang

Default port 30000, needs `--enable-metrics`. On Apple Silicon its MLX
backend works despite the docs not saying so:

```bash
SGLANG_USE_MLX=1 python -m sglang.launch_server \
  --model-path <mlx-model> --disable-cuda-graph --enable-metrics
```

(the published docs name an `all_mps` extra the shipped pyproject lacks;
the real one is `srt_mps`). `cached_tokens_total` is registered lazily and
absent until the first cache hit. On a non-streaming turn TTFT is stamped
at completion, collapsing onto total latency.

<a id="vllmmlx"></a>

### `vllmmlx` — vllm-mlx

Default port 8000 — conflicts with `vllm`. `pip install vllm-mlx`, then
start with `--enable-metrics` (not `--metrics`, despite some docs):

```bash
vllm-mlx serve mlx-community/Qwen2.5-0.5B-Instruct-4bit --port 8000 --enable-metrics
```

The only engine here with a true decode rate excluding prefill, from its own
duration histogram. Drops the per-request rate rather than report a blended
one when several requests land in one window.

<a id="aphrodite"></a>

### `aphrodite` — Aphrodite

Default port 2242, CUDA host. A vLLM fork publishing vLLM's shape under an
`aphrodite:` prefix, so it behaves like [`vllm`](#vllm). Not independently
live-tested.

<a id="lmdeploy"></a>

### `lmdeploy` — LMDeploy

Default port 23333, needs `--enable-metrics`, CUDA host. The richest
surface here — prefill and decode are both separately timed histograms, so
neither rate is derived. Not independently live-tested.

<a id="anything-else"></a>

### Anything else (Ollama, MLX-LM, LM Studio, …)

Universal layer only, which on v2 still includes exact token counts, cost
and cache reuse. Ollama: `baseURL: "http://127.0.0.1:11434/v1"`; its own
telemetry is per-caller, not server-wide. MLX-LM has no server-wide
`/metrics` at all.

## Adding an Engine

Same shape for any OpenAI-compatible server:

```jsonc
// ~/.config/opencode/opencode.json
{
  "provider": {
    "<provider-id>": {
      "name": "Display name",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:<port>/v1", "apiKey": "anything" },
      "models": {
        "<model id the server reports at /v1/models>": {
          "name": "Display name for the model",
          "limit": { "context": 32768, "output": 8192 },
          "modalities": { "input": ["text"], "output": ["text"] },
          "tool_call": true
        }
      }
    }
  }
}
```

**The provider id turns on enrichment** — use one from the
[Supported Engines](#supported-engines) table. Any other id still works
fully, with the universal layer only.

## What the numbers mean

**The rate is a decode rate, not a whole-turn rate.** OpenCode's own status
line divides tokens by the whole turn; this divides by the streaming window.
On a turn with a long wait before the first token those differ by ~10x —
measured: 38.1 tok/s over a 0.97s decode window against 3.7 over the same
turn's 10.03s. Both are correct; the TTFT beside the rate is what reconciles
them. A rate that genuinely *is* whole-turn (no stream window available) is
labelled `overall`.

**Every figure is one turn, never a running total.** Four things in this API
are cumulative where a per-turn figure is expected —
`session.usage.updated`, `session.cost()`, raw engine counters, and
`time.streamed` (which is stamped at the *end* of the stream, not the
start, and is therefore not a TTFT). The per-turn figures here are
differenced or measured accordingly.

**Absent is not zero.** A free model shows no cost rather than `$0.00`, a
cold prompt shows no cache line rather than `0 cached`, and a missing
speculative-draft counter shows nothing rather than `0% accepted`.

## Roadmap

- **Session-level metrics** in their own collapsible box — deliberately out
  of 0.1.0, see [`PLAN.md`](PLAN.md).
- **Zen/Go quota** (`opencode.ai/zen/go/v1/usage`) — opt-in, needs a
  `PRIVACY.md` first, since it is the only call here that leaves the
  machine.
- Context percentage is **not** planned beyond the existing opt-in:
  OpenCode 2 shows its own natively.

## License

MIT
