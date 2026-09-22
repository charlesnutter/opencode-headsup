// Static reference check for tui.tsx.
//
// tui.tsx imports the TUI runtime (solid-js, @opentui/solid), which is not
// installed here — OpenCode supplies it at load time — so the file cannot be
// imported and unit tested like the other modules. That gap is not theoretical:
// extracting the universal layer into universal.ts moved `getJson` out of
// tui.tsx without re-importing it, and because a ReferenceError inside a
// function body only throws when that path runs, and adapter failures are
// caught so a broken engine never blanks the panel, the MTPLX and oMLX
// adapters were dead for several commits with no visible symptom. The panel
// quietly showed the universal line instead.
//
// Importing the module would not have caught it either — the call sites are
// inside functions. So this parses the source and checks that every free
// function call resolves to something the file defines or imports.
// Run with: bun test/references.test.mjs
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.join(dir, "..", f), "utf8")

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log("  ok ", name)
  } catch (e) {
    console.log("  FAIL", name, "\n      ", e.message)
    process.exitCode = 1
  }
}

/** Strip comments and string/template literals so prose cannot look like code. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``")
    .replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""')
    .replace(/'(?:[^'\\]|\\[\s\S])*'/g, "''")
}

function declared(s) {
  const out = new Set()
  const add = (re, group = 1) => {
    for (const m of s.matchAll(re)) if (m[group]) out.add(m[group])
  }
  add(/(?:async\s+)?function\s+(\w+)/g)
  add(/(?:const|let|var)\s+(\w+)\s*[=:]/g)
  add(/(?:interface|type|class|enum)\s+(\w+)/g)
  add(/\(\s*(\w+)[^)]*\)\s*=>/g) // single/first arrow parameter
  add(/\bfor\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\b/g) // loop bindings
  // Anchored per line and barred from crossing newlines: unanchored, a greedy
  // `[^)]*` lets `register({ … sidebar_footer() {` match as `register`,
  // swallowing the shorthand that follows it.
  add(/^\s*(\w+)\s*\([^)\n]*\)\s*\{/gm)
  // every parameter of every function(...) signature
  for (const m of s.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const n = p.trim().split(":")[0].trim().replace(/^\.\.\./, "")
      if (/^\w+$/.test(n)) out.add(n)
    }
  }
  return out
}

function imported(s) {
  const out = new Set()
  for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop().trim()
      if (n) out.add(n)
    }
  }
  for (const m of s.matchAll(/import\s+(\w+)\s+from/g)) out.add(m[1])
  return out
}

// Language constructs and host globals that read as calls but resolve at runtime.
const AMBIENT = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "await", "async",
  "super", "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "isFinite", "isNaN", "parseFloat", "parseInt", "require", "structuredClone",
])

test("tui.tsx: every free function call resolves to a definition or an import", () => {
  const s = strip(read("tui.tsx"))
  const known = new Set([...declared(s), ...imported(s), ...AMBIENT])
  // Lowercase-initial calls not preceded by a dot: free functions, not methods
  // and not JSX/constructors.
  const calls = new Set([...s.matchAll(/(?<![.\w$])([a-z_]\w*)\s*\(/g)].map((m) => m[1]))
  const missing = [...calls].filter((c) => !known.has(c)).sort()
  assert.deepEqual(
    missing,
    [],
    `unresolved in tui.tsx: ${missing.join(", ")} — moved out during a refactor without re-importing?`
  )
})

test("tui.tsx: every local module it imports from actually exports those names", () => {
  const s = strip(read("tui.tsx"))
  const problems = []
  for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*""/g)) void m // strings were stripped
  // Re-read unstripped to recover the module specifiers.
    // The specifier may be nested (./adapters/omlx). Matching only \w+ would
  // skip those silently — a guard that quietly stops guarding.
  for (const m of read("tui.tsx").matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/((?:\w+\/)*\w+)"/g)) {
    // Strip the inline `type` modifier: `import { a, type B }` is valid and B
    // is still an export to verify, just a type-only one.
    const names = m[1]
      .split(",")
      .map((p) => p.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    const mod = strip(read(`${m[2]}.ts`))
    for (const n of names) {
      const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|interface|type|class)\\s+${n}\\b`)
      if (!re.test(mod)) problems.push(`${n} is not exported by ./${m[2]}`)
    }
  }
  assert.deepEqual(problems, [], problems.join("; "))
})

console.log(`\n${passed} passed`)
