// Prometheus exposition format — reading it, nothing else.
//
// Shared plumbing, like http.ts: it knows the text format and nothing about
// any engine. Three adapters parse Prometheus text (the labelled-counter
// adapter, Splash and llama.cpp), and this used to live inside the first of
// them, which made that file both "the adapter for labelled-counter engines"
// and "the parser everyone borrows". Those are different jobs.
//
// What an adapter supplies is the metric NAMES and what they mean. What this
// supplies is how to get a number out of the text under one of those names.

/**
 * Sums every series sharing `name`, ignoring labels.
 *
 * Summing is the point: engines split counters by rank or cache source
 * (`sglang:cached_tokens_total{cache_source=…}`), and the total across them is
 * the figure that means something.
 *
 * Two traps the matching has to avoid:
 *
 *   - A Prometheus client emits a `_created` line per counter holding a unix
 *     timestamp. `foo_total` must not swallow `foo_total_created`, or a
 *     counter picks up an epoch-sized number, so a match is rejected unless
 *     what follows the name is a label brace or a space.
 *   - Names are not always labelled. llama.cpp writes bare `name value` lines
 *     with no braces at all, and accepting a space above is what lets this
 *     read those too — verified against its live fixtures, which is why that
 *     engine needs no parser of its own.
 */
export function sumLabeledMetric(text: string, name: string): number {
  let total = 0
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue
    const rest = line.slice(name.length)
    if (rest.length > 0 && rest[0] !== "{" && rest[0] !== " ") continue // longer name, same prefix
    const sp = line.lastIndexOf(" ")
    if (sp === -1) continue
    const v = Number(line.slice(sp + 1))
    if (!Number.isNaN(v)) total += v
  }
  return total
}
