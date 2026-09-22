#!/usr/bin/env bash
#
# Capture a real before/after /metrics fixture pair around one generation.
#
# This exists because a synthesized fixture proves only that the parser's
# arithmetic is right. It cannot prove that a live server emits those metric
# names, that the endpoint exists, or that the flag documented to enable it is
# the flag that works — all three have been wrong at least once in this repo.
# Run this against a real server and the fixture becomes evidence.
#
#   ./scripts/capture-fixture.sh <base-url> <prefix> <name> [model]
#
#   ./scripts/capture-fixture.sh http://127.0.0.1:30000 sglang: sglang
#   ./scripts/capture-fixture.sh http://127.0.0.1:2242  aphrodite: aphrodite
#   ./scripts/capture-fixture.sh http://127.0.0.1:23333 lmdeploy: lmdeploy
#
# Writes fixtures/<name>-before.prom and fixtures/<name>-after.prom, each with
# a provenance header recording the machine, engine version and the response's
# own usage block — so the numbers the test asserts can be traced to something.
#
set -uo pipefail

BASE="${1:-}"; PREFIX="${2:-}"; NAME="${3:-}"; MODEL="${4:-}"
if [ -z "$BASE" ] || [ -z "$PREFIX" ] || [ -z "$NAME" ]; then
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
BASE="${BASE%/}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/fixtures"
mkdir -p "$OUT"

die() { echo "error: $*" >&2; exit 1; }

# --- 1. the endpoint must actually exist, and carry this engine's prefix -----
code=$(curl -s -o /tmp/cf-metrics.txt -w '%{http_code}' --max-time 10 "$BASE/metrics") \
  || die "could not reach $BASE/metrics"
[ "$code" = "200" ] || die "$BASE/metrics returned HTTP $code (is the metrics flag enabled?)"
grep -q "^$PREFIX" /tmp/cf-metrics.txt \
  || die "no metric lines start with '$PREFIX' — wrong engine, or it names them differently.
       First few metric lines seen:
$(grep -v '^#' /tmp/cf-metrics.txt | head -3 | sed 's/^/         /')"

# --- 2. pick a model if one wasn't given ------------------------------------
if [ -z "$MODEL" ]; then
  MODEL=$(curl -s --max-time 10 "$BASE/v1/models" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$MODEL" ] || die "could not auto-detect a model; pass one as the 4th argument"
fi
echo "engine prefix : $PREFIX"
echo "model         : $MODEL"

# --- 3. before ---------------------------------------------------------------
curl -s --max-time 10 "$BASE/metrics" -o /tmp/cf-before.txt || die "before-capture failed"

# --- 4. exactly one generation ----------------------------------------------
# One request matters: with a single request in the window, histogram deltas
# are that request's own values rather than an average, which is what makes
# the per-turn assertions meaningful.
resp=$(curl -s --max-time 180 "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Write one sentence about rain.\"}],\"max_tokens\":40}")
usage=$(printf '%s' "$resp" | sed -n 's/.*\("usage":{[^}]*}\).*/\1/p')
[ -n "$usage" ] || die "generation returned no usage block; response was:
$(printf '%s' "$resp" | head -c 300)"
echo "usage         : $usage"

# --- 5. after ----------------------------------------------------------------
sleep 1   # some engines flush counters a beat after the response is sent
curl -s --max-time 10 "$BASE/metrics" -o /tmp/cf-after.txt || die "after-capture failed"

# --- 6. did anything actually move? -----------------------------------------
if cmp -s /tmp/cf-before.txt /tmp/cf-after.txt; then
  die "/metrics is byte-identical before and after a generation.
       That engine's counters do not reflect this request — capture is useless."
fi

# --- 7. write, with provenance ----------------------------------------------
hdr() {
  cat <<EOF
# LIVE CAPTURE — real bytes from a running server, not hand-written.
#   captured : $(date -u '+%Y-%m-%dT%H:%M:%SZ')
#   host     : $(uname -srm)
#   endpoint : $BASE/metrics
#   model    : $MODEL
#   scenario : $1
#   the generation between these two captures reported:
#     $usage
EOF
}
{ hdr "immediately before one generation"; cat /tmp/cf-before.txt; } > "$OUT/$NAME-before.prom"
{ hdr "immediately after that generation"; cat /tmp/cf-after.txt;  } > "$OUT/$NAME-after.prom"

echo
echo "wrote $OUT/$NAME-before.prom"
echo "wrote $OUT/$NAME-after.prom"
echo
echo "counters that moved (${PREFIX}*):"
diff <(grep "^$PREFIX" /tmp/cf-before.txt) <(grep "^$PREFIX" /tmp/cf-after.txt) \
  | grep '^>' | sed 's/^> /  /' | head -20
echo
echo "Next: assert these deltas against the usage block above in"
echo "test/prometheus.test.mjs, then update fixtures/README.md provenance."
