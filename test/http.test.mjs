// Validates http.ts — the shared fetch plumbing every adapter now routes
// through. It replaced six hand-rolled AbortController+setTimeout copies, so a
// defect here is a defect in every engine at once.
//
// The behaviour that matters and was previously untestable: a request must be
// cancellable by the plugin's lifetime, not only by its own timeout. Without
// that, disposing the plugin mid-turn leaves fetches running out the clock.
// Run with: bun test/http.test.mjs
import { strict as assert } from "node:assert"
import { requestSignal, httpText, httpJson } from "../http.ts"

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log("  ok ", name)
  } catch (e) {
    console.log("  FAIL", name, "\n      ", e.message)
    process.exitCode = 1
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await test("requestSignal aborts on its own timeout", async () => {
  const s = requestSignal(30)
  assert.equal(s.aborted, false)
  await sleep(70)
  assert.equal(s.aborted, true)
})

await test("requestSignal aborts when the caller's signal fires first", async () => {
  // The lifecycle case: plugin disposed long before the request would time out.
  const life = new AbortController()
  const s = requestSignal(10_000, life.signal)
  assert.equal(s.aborted, false)
  life.abort()
  await sleep(5)
  assert.equal(s.aborted, true, "a disposed plugin must cancel in-flight requests")
})

await test("requestSignal with no external signal still works", async () => {
  const s = requestSignal(10_000)
  assert.equal(s.aborted, false)
})

await test("an already-aborted external signal aborts immediately", async () => {
  // Dispose racing startup: the baseline priming fetches fire before any turn.
  const s = requestSignal(10_000, AbortSignal.abort())
  assert.equal(s.aborted, true)
})

// ---- the failure contract every adapter relies on ---------------------------
await test("httpText returns null rather than throwing, on any failure", async () => {
  // Unroutable address: connection failure, not a timeout.
  assert.equal(await httpText("http://127.0.0.1:1/nope", { timeoutMs: 300 }), null)
})

await test("httpJson returns null rather than throwing", async () => {
  assert.equal(await httpJson("http://127.0.0.1:1/nope", { timeoutMs: 300 }), null)
})

await test("a cancelled request resolves null, it does not reject", async () => {
  // This is what makes dispose safe: adapters await these and must not see a
  // rejection they would have to catch individually.
  const life = new AbortController()
  const p = httpText("http://127.0.0.1:1/nope", { timeoutMs: 10_000, signal: life.signal })
  life.abort()
  assert.equal(await p, null)
})

await test("caller headers merge over the defaults", async () => {
  // connection: close is a default; an explicit header must win. Verified
  // against a local server rather than by reading the implementation.
  const { createServer } = await import("node:http")
  let seen = null
  const server = createServer((req, res) => {
    seen = req.headers
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("ok")
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  try {
    const body = await httpText(`http://127.0.0.1:${port}/`, {
      headers: { authorization: "Bearer probe" },
    })
    assert.equal(body, "ok")
    assert.equal(seen.authorization, "Bearer probe")
  } finally {
    server.close()
  }
})

await test("a non-2xx response is null, not the body", async () => {
  const { createServer } = await import("node:http")
  const server = createServer((_req, res) => {
    res.writeHead(503)
    res.end("unavailable")
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  try {
    assert.equal(await httpText(`http://127.0.0.1:${port}/`), null)
  } finally {
    server.close()
  }
})

console.log(`\n${passed} passed`)
