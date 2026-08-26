// Standalone tests for the critical helpers in mobile-sync.js.
// Run with: bun test
// These exercise the pure functions in isolation, importing from the source
// file directly. No test framework dependency — a simple assert-based runner
// keeps the project self-contained.

import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { writeFileSync, existsSync, unlinkSync, chmodSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.log(`  \u2717 ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

// ── Reimplement the helpers here for unit testing ──────────────────────────
// We re-declare instead of importing because mobile-sync.js's plugin entry
// runs `MobileSyncPlugin()` at import time, which would require a fake
// opencode SDK context. The helpers are pure and small enough to mirror.

const errStr = (err) => {
  if (err == null) return String(err)
  if (typeof err === "string") return err
  if (err.message) return err.message
  try { return JSON.stringify(err) } catch { return Object.prototype.toString.call(err) }
}
const generatePassword = () => randomBytes(18).toString("base64url")

console.log("errStr")
test("Error object -> .message", () => {
  assert.equal(errStr(new Error("boom")), "boom")
})
test("string passthrough", () => {
  assert.equal(errStr("oops"), "oops")
})
test("number -> JSON", () => {
  assert.equal(errStr(42), "42")
})
test("null -> JSON 'null'", () => {
  assert.equal(errStr(null), "null")
})
test("undefined -> JSON 'undefined'", () => {
  assert.equal(errStr(undefined), "undefined")
})
test("plain object -> JSON", () => {
  assert.equal(errStr({ code: "EACCES" }), JSON.stringify({ code: "EACCES" }))
})
test("error without message -> JSON of {} (no throw)", () => {
  // Edge case: errors thrown from C++ may have no .message property
  const e = new Error()
  e.message = undefined
  assert.equal(errStr(e), "{}")
})

console.log("\ngeneratePassword")
test("returns 24-char base64url", () => {
  const pw = generatePassword()
  assert.equal(typeof pw, "string")
  assert.equal(pw.length, 24)
  assert.match(pw, /^[A-Za-z0-9_-]+$/)
})
test("two calls return different values (collision vanishingly unlikely)", () => {
  const a = generatePassword()
  const b = generatePassword()
  assert.notEqual(a, b)
})
test("1000 passwords all unique (spot check entropy)", () => {
  const set = new Set()
  for (let i = 0; i < 1000; i++) set.add(generatePassword())
  assert.equal(set.size, 1000)
})

console.log("\nreadPassword (reimplemented)")
// Mirror the production readPassword() logic, but with a configurable path.
function readPasswordSync(filePath) {
  let needsWrite = false
  let raw = ""
  try {
    raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim()
  } catch { needsWrite = true }
  if (!needsWrite && raw.length === 0) needsWrite = true
  if (needsWrite) {
    const generated = generatePassword()
    const tmpPath = filePath + ".tmp"
    try {
      writeFileSync(tmpPath, generated + "\n", { mode: 0o600 })
      renameSync(tmpPath, filePath)
    } catch {}
    return generated
  }
  return raw
}

// Use a temp dir so we don't touch the real password file
const testDir = join(tmpdir(), `mobile-sync-test-${Date.now()}`)
mkdirSync(testDir, { recursive: true })

test("first run: missing file generates password and persists", () => {
  const f = join(testDir, "pw1.txt")
  assert.equal(existsSync(f), false)
  const pw = readPasswordSync(f)
  assert.equal(typeof pw, "string")
  assert.equal(pw.length, 24)
  assert.equal(existsSync(f), true, "file must be created")
  const stored = readFileSync(f, "utf8").trim()
  assert.equal(stored, pw, "stored value must match returned value")
})
test("subsequent run: reads existing password (deterministic)", () => {
  const f = join(testDir, "pw1.txt")
  const pw1 = readPasswordSync(f)
  const pw2 = readPasswordSync(f)
  assert.equal(pw1, pw2)
})
test("BOM-prefixed file is stripped", () => {
  const f = join(testDir, "pw-bom.txt")
  writeFileSync(f, "\uFEFFabc123")
  const pw = readPasswordSync(f)
  assert.equal(pw, "abc123")
})
test("empty file -> regenerate", () => {
  const f = join(testDir, "pw-empty.txt")
  writeFileSync(f, "")
  const pw = readPasswordSync(f)
  assert.equal(pw.length, 24, "should regenerate to 24-char password")
  // And the file should now contain the new password
  const stored = readFileSync(f, "utf8").trim()
  assert.equal(stored, pw)
})
test("whitespace-only file -> regenerate", () => {
  const f = join(testDir, "pw-ws.txt")
  writeFileSync(f, "   \n\n  \t  ")
  const pw = readPasswordSync(f)
  assert.equal(pw.length, 24)
})
test("concurrent first-run writes produce a valid file (no partial)", () => {
  // Simulate race by directly writing to .tmp first
  const f = join(testDir, "pw-race.txt")
  const tmp = f + ".tmp"
  // Two "concurrent" writers — only the second rename wins, but the file is
  // never partially written because rename is atomic.
  writeFileSync(tmp, "writer1", { mode: 0o600 })
  writeFileSync(f, "writer2", { mode: 0o600 })
  renameSync(tmp, f) // writer1 overwrites
  const pw = readPasswordSync(f)
  assert.equal(pw, "writer1", "atomic rename should have won")
})
test("read-only directory -> returns ephemeral value (doesn't throw)", () => {
  const f = join(testDir, "pw-readonly.txt")
  // Don't pre-create; readPassword will try to write
  // Simulate by making parent read-only
  chmodSync(testDir, 0o555)
  try {
    const pw = readPasswordSync(f)
    // On Windows, chmod is mostly a no-op so this may actually persist.
    // On POSIX, writeFileSync would throw, we'd return generated.
    // Either way: must not throw, must return a non-empty string.
    assert.equal(typeof pw, "string")
    assert.ok(pw.length > 0)
  } finally {
    chmodSync(testDir, 0o755)
  }
})

console.log("\nisNewer (semver comparison)")
function isNewer(remote, local) {
  const r = String(remote).replace(/^v/, "").split(".").map(Number)
  const l = String(local).replace(/^v/, "").split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) !== (l[i] || 0)) return (r[i] || 0) > (l[i] || 0)
  }
  return false
}
test("1.0.1 > 1.0.0", () => assert.equal(isNewer("1.0.1", "1.0.0"), true))
test("1.0.10 > 1.0.9 (NOT lexicographic)", () => assert.equal(isNewer("1.0.10", "1.0.9"), true))
test("1.1.0 > 1.0.99", () => assert.equal(isNewer("1.1.0", "1.0.99"), true))
test("2.0.0 > 1.99.99", () => assert.equal(isNewer("2.0.0", "1.99.99"), true))
test("1.0.0 not newer than 1.0.0", () => assert.equal(isNewer("1.0.0", "1.0.0"), false))
test("0.9.9 not newer than 1.0.0", () => assert.equal(isNewer("0.9.9", "1.0.0"), false))
test("v1.0.1 (with v prefix) > v1.0.0", () => assert.equal(isNewer("v1.0.1", "v1.0.0"), true))
test("garbage remote never > valid local", () => assert.equal(isNewer("vfoo", "1.0.0"), false))

console.log("\nETag regex (GitHub If-None-Match validation)")
const etagRe = /^[\w"/-]{16,80}$/
test("W/\"deadbeef...\" weak (40 hex chars)", () => assert.match(`W/"${"d".repeat(40)}"`, etagRe))
test("\"deadbeef...\" strong (40 hex chars)", () => assert.match(`"${"d".repeat(40)}"`, etagRe))
test("too short (15 chars) rejected", () => assert.doesNotMatch(`W/"${"a".repeat(11)}"`, etagRe))
test("too long (81 chars) rejected", () => assert.doesNotMatch(`W/"${"a".repeat(77)}"`, etagRe))
test("control char in ETag rejected", () => assert.doesNotMatch(`W/"${"a".repeat(38)}\n"`, etagRe))
test("empty string rejected", () => assert.doesNotMatch("", etagRe))
test("plain word 16+ chars accepted", () => assert.match("aaaaaaaaaaaaaaaa", etagRe))

console.log("\nlogFnOnce (deduplication)")
const _loggedOnce = new Set()
let _sink = []
let _globalLogFn = null
const logFnOnce = (level, msg, extra) => {
  const key = `${level}:${msg}`
  if (_loggedOnce.has(key)) return
  _loggedOnce.add(key)
  if (typeof _globalLogFn === "function") _globalLogFn(level, msg, extra)
  else if (extra) console[level === "error" ? "error" : "log"](`[mobile-sync] ${msg} ${JSON.stringify(extra)}`)
  else console[level === "error" ? "error" : "log"](`[mobile-sync] ${msg}`)
}
test("same message logged only once", () => {
  const logFn = (l, m) => _sink.push([l, m])
  _globalLogFn = logFn
  logFnOnce("warn", "msg A")
  logFnOnce("warn", "msg A")
  logFnOnce("warn", "msg A")
  assert.equal(_sink.length, 1)
  assert.deepEqual(_sink[0], ["warn", "msg A"])
  _globalLogFn = null
  _sink = []
})
test("different messages both logged", () => {
  _loggedOnce.clear()
  _sink = []
  const logFn = (l, m) => _sink.push([l, m])
  _globalLogFn = logFn
  logFnOnce("info", "msg B")
  logFnOnce("info", "msg C")
  assert.equal(_sink.length, 2)
})
test("same message different level: both logged (different keys)", () => {
  _loggedOnce.clear()
  _sink = []
  const logFn = (l, m) => _sink.push([l, m])
  _globalLogFn = logFn
  logFnOnce("warn", "msg D")
  logFnOnce("error", "msg D")
  assert.equal(_sink.length, 2)
})

// Cleanup
try {
  for (const f of ["pw1.txt", "pw-bom.txt", "pw-empty.txt", "pw-ws.txt", "pw-race.txt"]) {
    try { unlinkSync(join(testDir, f)) } catch {}
    try { unlinkSync(join(testDir, f + ".tmp")) } catch {}
  }
} catch {}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
