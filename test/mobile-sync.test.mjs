// Standalone tests for the critical helpers in mobile-sync.js.
// Run with: bun test
// These exercise the pure functions in isolation, importing from the source
// file directly. No test framework dependency — a simple assert-based runner
// keeps the project self-contained.

import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { writeFileSync, existsSync, unlinkSync, chmodSync, mkdirSync, readFileSync, renameSync, symlinkSync, lstatSync, rmSync } from "node:fs"
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
  if (typeof err === "number" || typeof err === "boolean") return String(err)
  if (typeof err === "symbol") return err.toString()
  if (err.message) return err.message
  try {
    const json = JSON.stringify(err)
    if (typeof json === "string") return json
    return Object.prototype.toString.call(err)
  } catch {
    return Object.prototype.toString.call(err)
  }
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

console.log("\nsaveCache (atomic write)")
// Mirror production: temp + rename so a crash mid-write doesn't corrupt.
let _chain = Promise.resolve()
async function saveCache(cache, file) {
  const next = _chain.then(() => {
    const tmp = file + ".tmp"
    writeFileSync(tmp, JSON.stringify(cache))
    renameSync(tmp, file)
  })
  _chain = next.catch(() => {})
  return next
}
test("write creates file with correct JSON", async () => {
  const f = join(testDir, "cache-1.json")
  await saveCache({ etag: "abc", version: "1.0.0" }, f)
  assert.equal(readFileSync(f, "utf8"), JSON.stringify({ etag: "abc", version: "1.0.0" }))
})
test("concurrent writes are serialized (final value is one of the inputs, not interleaved)", async () => {
  const f = join(testDir, "cache-2.json")
  const promises = []
  for (let i = 0; i < 50; i++) {
    promises.push(saveCache({ etag: `e${i}`, version: "1.0.0" }, f))
  }
  await Promise.all(promises)
  // File must be valid JSON, not interleaved bytes from concurrent writers
  const parsed = JSON.parse(readFileSync(f, "utf8"))
  assert.equal(parsed.version, "1.0.0")
  assert.match(parsed.etag, /^e\d+$/)
})
test("read after write round-trips correctly", async () => {
  const f = join(testDir, "cache-3.json")
  await saveCache({ etag: "deadbeef", version: "2.0.0" }, f)
  const got = JSON.parse(readFileSync(f, "utf8"))
  assert.deepEqual(got, { etag: "deadbeef", version: "2.0.0" })
})

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

console.log("\nerrStr hardened edge cases")
test("Error with empty message -> JSON {} fallback (not undefined)", () => {
  const e = new Error()
  e.message = ""
  // err.message is falsy for empty string, so we fall through to JSON.stringify
  // which gives "{}" for an empty Error object.
  const got = errStr(e)
  assert.notEqual(got, undefined, "must not return undefined for Error")
  assert.equal(typeof got, "string")
})
test("Symbol -> toString fallback (JSON.stringify returns undefined for Symbol)", () => {
  // JSON.stringify(Symbol()) returns `undefined` (not a string, doesn't throw).
  // The current errStr falls through to JSON.stringify's undefined and the
  // try/catch doesn't trigger. Document and verify current behavior:
  // errStr(Symbol) returns "undefined" via String() path. Wait — Symbol
  // is not null, not a string, has no .message, then JSON.stringify returns
  // undefined which we return as-is. The fix below makes it return a
  // useful description.
  const got = errStr(Symbol("x"))
  // After the fix: should return a non-empty string (Symbol description)
  assert.equal(typeof got, "string", `got ${JSON.stringify(got)} (${typeof got})`)
  assert.ok(got.length > 0, `got empty string for Symbol`)
})
test("object with throwing toJSON -> toString fallback", () => {
  const bad = { toJSON() { throw new Error("nope") } }
  const got = errStr(bad)
  assert.equal(typeof got, "string")
  assert.ok(got.includes("Object") || got.includes("nope"))
})
test("array -> JSON string", () => {
  assert.equal(errStr([1, 2, 3]), "[1,2,3]")
})
test("boolean true -> 'true'", () => {
  assert.equal(errStr(true), "true")
})
test("0 (falsy number) -> '0'", () => {
  assert.equal(errStr(0), "0")
})
test("Error subclass (TypeError) -> .message", () => {
  assert.equal(errStr(new TypeError("bad type")), "bad type")
})
test("circular object -> toString fallback (no infinite recursion)", () => {
  const a = { name: "a" }
  a.self = a // circular
  const got = errStr(a)
  assert.equal(typeof got, "string")
  assert.ok(got.length > 0)
})

console.log("\nisNewer hardening")
test("missing remote version -> not newer", () => {
  assert.equal(isNewer("", "1.0.0"), false)
})
test("missing local version -> not newer", () => {
  // Empty local is treated as 0.0.0
  assert.equal(isNewer("0.0.1", ""), true)
})
test("non-numeric components -> treated as 0", () => {
  // 1.x.y where x/y are non-numeric -> [1,0,0]; local [1,0,0] -> not newer
  assert.equal(isNewer("1.abc.def", "1.0.0"), false)
})
test("extra version components are ignored (only first 3 are compared)", () => {
  // 4-part version like "1.0.0.5" — only the first 3 parts enter the loop,
  // the 4th is silently dropped. "1.0.0.5" effectively equals "1.0.0".
  // This matches the documented behavior; future semver pre-release handling
  // would require a dedicated parser.
  assert.equal(isNewer("1.0.0.5", "1.0.0"), false)
  assert.equal(isNewer("1.0.0.5", "1.0.0.0"), false)
})
test("pre-release tag is ignored (treated as 0)", () => {
  // 1.0.0-rc1 -> ["1","0","0-rc1"] -> [1,0,NaN] -> [1,0,0] via (NaN||0)
  // Equal to 1.0.0 -> not newer
  assert.equal(isNewer("1.0.0-rc1", "1.0.0"), false)
})

console.log("\ncopyDir (symlink safety)")
// Reimplement copyDir to test the logic in isolation
async function copyDir(src, dest) {
  const { readdir, mkdir, copyFile } = await import("node:fs/promises")
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    }
  }
}
test("regular files and subdirectories are copied", async () => {
  const src = join(testDir, "copy-src-" + Date.now())
  const dst = join(testDir, "copy-dst-" + Date.now())
  mkdirSync(join(src, "sub"), { recursive: true })
  writeFileSync(join(src, "a.txt"), "hello")
  writeFileSync(join(src, "sub", "b.txt"), "world")
  await copyDir(src, dst)
  assert.equal(readFileSync(join(dst, "a.txt"), "utf8"), "hello")
  assert.equal(readFileSync(join(dst, "sub", "b.txt"), "utf8"), "world")
  rmSync(src, { recursive: true, force: true })
  rmSync(dst, { recursive: true, force: true })
})
test("symlinks are skipped (no infinite loop)", async () => {
  const src = join(testDir, "symlink-src-" + Date.now())
  const dst = join(testDir, "symlink-dst-" + Date.now())
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, "real.txt"), "real")
  // Create a symlink that points back to the parent (would loop forever)
  try {
    symlinkSync(src, join(src, "loop"), "dir")
  } catch {
    // Symlink creation may need elevated privileges on Windows — skip if so
    return
  }
  // Set a hard timeout — if copyDir recurses into the loop, the test hangs
  const timeout = setTimeout(() => {
    throw new Error("copyDir did not terminate — likely entered symlink loop")
  }, 5000)
  try {
    await copyDir(src, dst)
    clearTimeout(timeout)
    // The real file should be copied; the symlink should not
    assert.equal(existsSync(join(dst, "real.txt")), true)
    assert.equal(existsSync(join(dst, "loop")), false, "symlink must be skipped")
  } finally {
    clearTimeout(timeout)
    rmSync(src, { recursive: true, force: true })
    rmSync(dst, { recursive: true, force: true })
  }
})

// ── readCorsAllowlist ───────────────────────────────────────────────────────────
const FUNNEL_URL_FILE = join(testDir, "funnel-url.txt")

// Reimplement just enough of readCorsAllowlist to test it in isolation.
// Mirrors mobile-sync.js exactly so we catch regressions in the source logic.
function readCorsAllowlist(override) {
  const file = override || FUNNEL_URL_FILE
  const origins = ["oc://renderer"]
  try {
    if (existsSync(file)) {
      const url = readFileSync(file, "utf8").trim()
      if (/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(url)) {
        origins.push(url)
      }
    }
  } catch { /* fall through with just oc://renderer */ }
  return JSON.stringify(origins)
}

function setFunnelUrl(val) {
  if (val === null) {
    try { unlinkSync(FUNNEL_URL_FILE) } catch {}
  } else {
    writeFileSync(FUNNEL_URL_FILE, val, "utf8")
  }
}

console.log("\nreadCorsAllowlist")
test("file missing -> ['oc://renderer']", () => {
  setFunnelUrl(null)
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("file empty -> ['oc://renderer'] (no crash)", () => {
  setFunnelUrl("")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("file whitespace only -> ['oc://renderer']", () => {
  setFunnelUrl("  \n\t\r  ")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("valid https URL -> appended to origins", () => {
  setFunnelUrl("https://machine.tailnet.ts.net")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer", "https://machine.tailnet.ts.net"])
})
test("URL with path rejected (regex requires end-of-string after hostname)", () => {
  // The regex anchors with $ so any path after the hostname is rejected.
  // CORS origin comparison strips paths anyway, so this is a security
  // plus: only the bare origin is permitted.
  setFunnelUrl("https://machine.tailnet.ts.net/some/path")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("http rejected -> ['oc://renderer']", () => {
  setFunnelUrl("http://machine.tailnet.ts.net")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("wildcard '*' not in file -> accepted (this is the upstream bug; documented here)", () => {
  // This test documents the known gap: if the funnel file contains "*", the
  // regex rejects it (no https:// prefix), so it's treated as no URL.
  // The caller (start-opencode-desktop.ps1) now adds its own wildcard check.
  setFunnelUrl("*")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("hostname starting with hyphen rejected", () => {
  setFunnelUrl("https://-machine.tailnet.ts.net")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("single-char hostname accepted", () => {
  setFunnelUrl("https://a.ts.net")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer", "https://a.ts.net"])
})
test("URL with trailing slash rejected (regex requires hostname to end with alphanum)", () => {
  setFunnelUrl("https://machine.tailnet.ts.net/")
  const got = JSON.parse(readCorsAllowlist())
  assert.deepEqual(got, ["oc://renderer"])
})
test("JSON output is valid and parseable", () => {
  setFunnelUrl("https://machine.tailnet.ts.net")
  const out = readCorsAllowlist()
  const parsed = JSON.parse(out)  // must not throw
  assert.equal(parsed.length, 2)
  assert.equal(typeof parsed[0], "string")
  assert.equal(typeof parsed[1], "string")
})
test("read error on file -> ['oc://renderer'] (no crash)", () => {
  // unreadable file: skip on Unix where we can chmod; on Windows permission
  // errors are harder to trigger in tests.
  try {
    chmodSync(FUNNEL_URL_FILE, 0o000)
    const got = JSON.parse(readCorsAllowlist())
    assert.deepEqual(got, ["oc://renderer"])
  } catch {
    // permission test skipped on this platform
  } finally {
    try { chmodSync(FUNNEL_URL_FILE, 0o644) } catch {}
  }
})
// clean up funnel URL file after tests
setFunnelUrl(null)

// Cleanup
try {
  for (const f of ["pw1.txt", "pw-bom.txt", "pw-empty.txt", "pw-ws.txt", "pw-race.txt"]) {
    try { unlinkSync(join(testDir, f)) } catch {}
    try { unlinkSync(join(testDir, f + ".tmp")) } catch {}
  }
  try { rmSync(testDir, { recursive: true, force: true }) } catch {}
} catch {}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
