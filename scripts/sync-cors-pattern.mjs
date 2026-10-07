#!/usr/bin/env bun
// Single source of truth for the CORS origin pattern.
//
// WHY THIS EXISTS
// ---------------
// The origin regex is security-relevant: it is the allowlist gate for a CORS
// policy that is exposed to the public internet via Tailscale Funnel. It is
// duplicated across four files:
//
//   mobile-sync.js                       readCorsAllowlist()
//   scripts/start-opencode-desktop.ps1   desktop sidecar allowlist
//   scripts/start-opencode-server.ps1    CLI server allowlist
//   test/mobile-sync.test.mjs            the test's copy of readCorsAllowlist
//
// All four have drifted apart at some point. Two bugs shipped that way:
// a copy missed the fix entirely and kept accepting "https://host/anything" as
// an origin, and the test kept asserting against a stale copy while the source
// moved on. Hand-editing N copies is what caused it.
//
// USAGE
//   bun scripts/sync-cors-pattern.mjs           # write the pattern to all copies
//   bun scripts/sync-cors-pattern.mjs --check   # verify only, exit 1 on drift
//
// CI runs --check. Editing the pattern therefore means editing PATTERN below
// and running the sync script, never four regex literals by hand.
//
// Note on formatting: "/" must be escaped inside a JS regex literal but not
// inside a PowerShell single-quoted string, so each target gets its own
// rendering of the same pattern.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The canonical origin pattern.
 *
 * https:// plus a hostname of dot/hyphen separated labels, each starting and
 * ending alphanumeric, plus an optional port. A CORS origin is
 * scheme://host[:port]; rejecting a port would silently drop a legitimate
 * funnel URL and leave the allowlist as oc://renderer only, breaking mobile
 * sync. A path is not part of an origin and is rejected.
 */
const PATTERN = "^https://[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]{1,5})?$"

const jsPattern = PATTERN.replaceAll("/", "\\/")
const psPattern = PATTERN

/** Each target: how to find and replace its literal. */
const TARGETS = [
  {
    file: "mobile-sync.js",
    label: "readCorsAllowlist",
    // if (/PATTERN/i.test(url)) {
    find: /if \(\/\^https[^\n]*?\.test\(url\)\) \{/,
    replace: () => `if (/${jsPattern}/i.test(url)) {`,
  },
  {
    file: "scripts/start-opencode-desktop.ps1",
    label: "$funnelUrl -match",
    // Anchored on the surrounding quotes. An earlier version used [^']* , which
    // matched past the closing quote and ran into the rest of the line -- when
    // the pattern had drifted it spliced the replacement into the following
    // string, corrupting the file. Do not use a bare [^']* here.
    find: /\$funnelUrl -match '\^https[^']*?'/,
    replace: () => `$funnelUrl -match '${psPattern}'`,
  },
  {
    file: "scripts/start-opencode-server.ps1",
    label: "$funnelUrl -match",
    find: /\$funnelUrl -match '\^https[^']*?'/,
    replace: () => `$funnelUrl -match '${psPattern}'`,
  },
  {
    file: "test/mobile-sync.test.mjs",
    label: "test copy of readCorsAllowlist",
    find: /if \(\/\^https[^\n]*?\.test\(url\)\) \{/,
    replace: () => `if (/${jsPattern}/i.test(url)) {`,
  },
]

/** The test also pins the pattern in EXPECTED; keep that in step too. */
const EXPECTED_TARGET = {
  file: "test/mobile-sync.test.mjs",
  label: "EXPECTED",
  find: /const EXPECTED = "[^"]*"/,
  replace: () => `const EXPECTED = "${PATTERN}"`,
}

const check = process.argv.includes("--check")
let drift = 0

/**
 * Apply one target.
 *
 * Locating the existing literal uses a deliberately loose matcher (anything
 * shaped like an origin regex) so a *drifted* pattern is still found and
 * rewritten. An earlier version required the canonical pattern to already be
 * present, which meant it could detect drift but never repair it -- the exact
 * case it exists to handle.
 */
function apply(t) {
  const path = join(ROOT, t.file)
  const text = readFileSync(path, "utf8")
  const wanted = t.replace()

  if (!t.find.test(text)) {
    console.error(`FAIL ${t.file}: could not locate the ${t.label} pattern to ${check ? "check" : "write"}`)
    return { status: "missing" }
  }
  if (text.includes(wanted)) {
    console.log(`ok   ${t.file} (${t.label})`)
    return { status: "ok" }
  }
  if (check) {
    console.error(`FAIL ${t.file}: ${t.label} has drifted from the canonical pattern`)
    return { status: "drift" }
  }
  // NOTE: the replacement MUST be passed as a replacer function, never as a
  // string. The PowerShell replacement ends with "?$'" and in String.replace the
  // sequence "$'" is a special pattern meaning "everything after the match", so
  // the string form spliced the rest of the file into the result: it duplicated
  // ~110 bytes, broke PowerShell parsing, and left the regex literal unterminated.
  // The JS replacements end with "$/" and were unaffected, which is why this only
  // showed up on the .ps1 files. A function is taken literally.
  writeFileSync(path, text.replace(t.find, () => wanted), "utf8")
  console.log(`sync ${t.file} (${t.label})`)
  return { status: "synced" }
}

for (const t of TARGETS) {
  if (apply(t).status !== "ok") drift++
}
if (apply(EXPECTED_TARGET).status !== "ok") drift++

if (drift > 0) {
  if (check) {
    console.error(
      `\n${drift} location(s) drifted. Run: bun scripts/sync-cors-pattern.mjs`,
    )
    process.exit(1)
  }
  const missing = []
  for (const t of [...TARGETS, EXPECTED_TARGET]) {
    if (apply(t).status === "missing") missing.push(t.file)
  }
  if (missing.length) {
    console.error(`\n${missing.length} location(s) could not be located; nothing was written.`)
    process.exit(1)
  }
  console.log("\nall copies synced")
} else {
  console.log(check ? "\nall copies match the canonical pattern" : "\nall copies already in sync")
}