/**
 * mobile-sync ΓÇö OpenCode plugin
 *
 * Makes the desktop sidecar (or CLI server as fallback) act as a shared server
 * on port 4096, accessible via Tailscale Funnel for mobile sync.
 *
 * On startup:
 *   1. Runs first-time setup if needed (password file, patch, funnel)
 *   2. Launches the desktop sidecar if port 4096 is not listening
 *   3. Falls back to CLI server if desktop is unavailable
 *   4. Starts the auto-repatch watcher
 *   5. Injects OPENCODE_PORT + OPENCODE_SERVER_PASSWORD into shell env
 *
 * Auto-updates hourly from GitHub releases.
 *
 * Environment variables:
 *   MOBILE_SYNC_ENABLED=0          Disable the plugin entirely
 *   MOBILE_SYNC_DESKTOP_ONLY=1     Skip the CLI server fallback (desktop-only mode)
 *   MOBILE_SYNC_KILL_SERVER_ON_DISPOSE=1
 *                                  When the plugin unloads, also terminate the
 *                                  opencode.exe serve process tree. Default is
 *                                  to leave the server running so mobile clients
 *                                  stay connected.
 */

import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFile, writeFile, mkdir, rm, readdir, rename } from "node:fs/promises"
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, platform, tmpdir } from "node:os"
import { createConnection } from "node:net"

const MOBILE_SYNC_VERSION = "1.0.2"
const GITHUB_REPO = "neohiro/mobile-sync"
const UPDATE_CHECK_INTERVAL_MS = 3_600_000 // hourly
const DEFAULT_PORT = 4096
const GITHUB_API_BASE = "https://api.github.com"

// ΓöÇΓöÇ ETag cache for GitHub release polling (avoids 60/hr rate limit) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Writes are serialized via a module-scope promise chain so concurrent
// checkForUpdates() calls (e.g. one-shot init + hourly interval) can't
// interleave JSON on Windows (which lacks atomic append).
const CACHE_FILE = join(homedir(), ".opencode-sync-release-cache.json")
let _cacheWriteChain = Promise.resolve()
function loadCache() {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8").trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      try { writeFileSync(CACHE_FILE, "{}") } catch {}
      return {}
    }
    return parsed
  } catch {
    try { writeFileSync(CACHE_FILE, "{}") } catch {}
    return {}
  }
}
function saveCache(cache) {
  // Serialize writes so two concurrent updaters can't interleave JSON bytes.
  const next = _cacheWriteChain.then(() => {
    try { writeFileSync(CACHE_FILE, JSON.stringify(cache)) } catch {}
  })
  // Swallow rejections on the chain itself so one bad write doesn't poison
  // subsequent saves. The .then handler already catches its own write errors.
  _cacheWriteChain = next.catch(() => {})
  return next
}

// ΓöÇΓöÇ Helpers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const isWindows = platform() === "win32"

const PS_EXE = "powershell.exe"
const PS_FLAGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-NonInteractive"]

const PASSWORD_FILE = join(homedir(), ".opencode-server-password")
const DIRECTORY_FILE = join(homedir(), ".opencode-server-directory")
const FUNNEL_URL_FILE = join(homedir(), ".opencode-funnel-url")
/**
 * Read the CORS allowlist for the desktop sidecar from FUNNEL_URL_FILE.
 * Always includes "oc://renderer" so the desktop app can reach the sidecar
 * locally. When the funnel file is present and contains a valid https://
 * origin, that origin is appended (the only legitimate remote origin via
 * Tailscale Funnel).
 *
 * SECURITY: this is the allowlist that limits who can reach the opencode
 * sidecar over Tailscale Funnel. Without this, the patched app.asar falls
 * back to ["*"] and the sidecar is exposed to the public internet. The
 * regex on the URL is a defense-in-depth check against arbitrary-origin
 * injection: it must be https://, must have a non-empty hostname that
 * starts and ends with an alphanumeric character.
 */
function readCorsAllowlist() {
  const origins = ["oc://renderer"]
  try {
    if (existsSync(FUNNEL_URL_FILE)) {
      const url = readFileSync(FUNNEL_URL_FILE, "utf8").trim()
      if (/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(url)) {
        origins.push(url)
      }
    }
  } catch { /* fall through with just oc://renderer */ }
  return JSON.stringify(origins)
}
/**
 * Generate a cryptographically random URL-safe password (24 chars, ~142 bits entropy).
 * Used on first install when no password file exists yet.
 */
const generatePassword = () => randomBytes(18).toString("base64url")

/**
 * Normalize any thrown value into a string for logging. Handles Error objects,
 * strings, numbers, booleans, arrays, plain objects, Symbols, null, and undefined.
 *
 * Edge cases handled:
 *   - `JSON.stringify(Symbol())` returns `undefined` (not a string, doesn't throw)
 *     so we fall back to `String(symbol)` which yields "Symbol(desc)".
 *   - Circular references cause `JSON.stringify` to throw; fallback to
 *     `Object.prototype.toString.call`.
 *   - Objects with throwing `toJSON` are caught by the try/catch.
 */
const errStr = (err) => {
  if (err == null) return String(err) // null -> "null", undefined -> "undefined"
  if (typeof err === "string") return err
  if (typeof err === "number" || typeof err === "boolean") return String(err)
  if (typeof err === "symbol") return err.toString() // "Symbol(desc)"
  if (err.message) return err.message
  try {
    const json = JSON.stringify(err)
    // JSON.stringify returns undefined for Symbol, Function, undefined values
    if (typeof json === "string") return json
    return Object.prototype.toString.call(err)
  } catch {
    return Object.prototype.toString.call(err)
  }
}

// ΓöÇΓöÇ OS notifications (same mechanism as auto-resume) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"

const windowsToastPs = (title, message) => `
$ErrorActionPreference = 'Stop'
$title = ${psQuote(title)}
$text  = ${psQuote(message)}
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $xml.GetElementsByTagName('text')
  [void]$nodes.Item(0).AppendChild($xml.CreateTextNode($title))
  [void]$nodes.Item(1).AppendChild($xml.CreateTextNode($text))
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
    [Windows.UI.Notifications.ToastNotification]::new($xml))
  exit 0
} catch {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $tip = New-Object System.Windows.Forms.NotifyIcon
    $tip.Icon = [System.Drawing.SystemIcons]::Information
    $tip.Visible = $true
    $tip.BalloonTipTitle = $title
    $tip.BalloonTipText = $text
    $tip.ShowBalloonTip(10000)
    Start-Sleep -Seconds 11
    $tip.Dispose()
    exit 0
  } catch { exit 1 }
}`

const NOTIFIER_TIMEOUT_MS = 15_000
function createOsNotifier({ $, systemRoot = process.env.SystemRoot } = {}) {
  const withTimeout = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`notifier timed out after ${NOTIFIER_TIMEOUT_MS}ms`)), NOTIFIER_TIMEOUT_MS)
      }),
    ])
  const runPowerShellToast = async (exe, title, message) => {
    const encoded = Buffer.from(windowsToastPs(title, message), "utf16le").toString("base64")
    await withTimeout($`${exe} -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}`.quiet())
  }
  return async (title, message) => {
    try {
      if (!($ && typeof $ === "function")) return false
      if (isWindows) {
        await runPowerShellToast(
          `${systemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          title, message)
        return true
      }
    } catch { return false }
  }
}

/** Resolve the directory this plugin file lives in. */
const pluginDir = (() => {
  try {
    if (!import.meta.url.startsWith("file:")) return null
    const p = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")
    return dirname(p)
  } catch {
    return null
  }
})()

/** Scripts live in a sibling directory to avoid auto-discovery conflicts. */
const scriptsDir = pluginDir ? join(pluginDir, "mobile-sync-scripts") : null

/**
 * Read the password from disk. On first run (no file), generate a random
 * password, persist it, and return it. The user is shown this password once
 * in the startup log so they can configure their mobile app.
 * Empty, BOM-only, or corrupted files are regenerated (self-healing).
 * NEVER falls back to a hardcoded value ΓÇö every install gets a unique secret.
 *
 * Thread-safety: writes use a temp file + atomic rename so concurrent calls
 * from multiple processes produce a consistent file (last writer wins, but
 * no partial-file corruption). File mode 0o600 ΓÇö world-inaccessible on POSIX;
 * Windows enforces per-user ACLs regardless.
 */
function readPassword() {
  let needsWrite = false
  let raw = ""
  try {
    raw = readFileSync(PASSWORD_FILE, "utf8").replace(/^\uFEFF/, "").trim()
  } catch {
    needsWrite = true
  }
  if (!needsWrite && raw.length === 0) needsWrite = true
  if (needsWrite) {
    const generated = generatePassword()
    const tmpPath = PASSWORD_FILE + ".tmp"
    try {
      writeFileSync(tmpPath, generated + "\n", { mode: 0o600 })
      renameSync(tmpPath, PASSWORD_FILE) // atomic on same filesystem
    } catch (err) {
      logFnOnce("warn", "could not persist generated password; using ephemeral one", { error: errStr(err) })
      return generated
    }
    return generated
  }
  return raw
}

/** Log a message at most once across the lifetime of the plugin. */
const _loggedOnce = new Set()
function logFnOnce(level, msg, extra) {
  const key = `${level}:${msg}`
  if (_loggedOnce.has(key)) return
  _loggedOnce.add(key)
  // Defer to the per-instance logFn defined in MobileSyncPlugin. If called
  // before plugin init, fall back to console directly.
  if (typeof _globalLogFn === "function") _globalLogFn(level, msg, extra)
  else if (extra) console[level === "error" ? "error" : "log"](`[mobile-sync] ${msg} ${JSON.stringify(extra)}`)
  else console[level === "error" ? "error" : "log"](`[mobile-sync] ${msg}`)
}
let _globalLogFn = null

/** Run a PowerShell script file and return a promise. */
function runPS(scriptPath, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const allArgs = [...PS_FLAGS, "-File", scriptPath, ...args]
    execFile(PS_EXE, allArgs, {
      windowsHide: true,
      timeout: opts.timeout || 60_000,
      encoding: "utf8",
    }, (err, stdout, stderr) => {
      if (err && !opts.allowFail) reject(err)
      else resolve({ stdout: stdout || "", stderr: stderr || "", code: err?.code || 0 })
    })
  })
}

/** Run a PowerShell command string (not a file) and return a promise. */
function runPSCommand(command, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(PS_EXE, [...PS_FLAGS, "-Command", command], {
      windowsHide: true,
      timeout: opts.timeout || 60_000,
      encoding: "utf8",
    }, (err, stdout, stderr) => {
      if (err && !opts.allowFail) reject(err)
      else resolve({ stdout: stdout || "", stderr: stderr || "", code: err?.code || 0 })
    })
  })
}

/**
 * Check if a TCP port is listening on localhost (IPv4 only).
 * Pure Node ΓÇö no PowerShell overhead (8ms vs ~500ms).
 * family: 4 is intentional: the opencode sidecar/CLI binds to 127.0.0.1.
 * If a future version binds to IPv6 (::1), this will false-negative ΓÇö
 * update family to 0 (dual-stack) and host to "localhost".
 */
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, family: 4 })
    socket.setTimeout(2_000)
    let resolved = false
    const done = (result) => {
      if (resolved) return
      resolved = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

/** Semver comparison: returns true if remote > local. */
function isNewer(remote, local) {
  const r = String(remote).replace(/^v/, "").split(".").map(Number)
  const l = String(local).replace(/^v/, "").split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) !== (l[i] || 0)) return (r[i] || 0) > (l[i] || 0)
  }
  return false
}

// ΓöÇΓöÇ First-time setup ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async function runFirstTimeSetup(logFn) {
  if (!isWindows || !scriptsDir) return

  const setupScript = join(scriptsDir, "setup-opencode-shared.ps1")
  if (!existsSync(setupScript)) {
    logFn("warn", "setup script not found, skipping first-time setup", { path: setupScript })
    return
  }

  // Check if already set up (password file exists)
  if (existsSync(PASSWORD_FILE)) {
    logFn("info", "password file exists, skipping first-time setup")
    return
  }

  logFn("info", "running first-time setup...")
  try {
    await runPS(setupScript, ["-Quick", "-Patch"], { timeout: 120_000 })
    logFn("info", "first-time setup complete")
  } catch (err) {
    logFn("error", "first-time setup failed", { error: errStr(err) })
  }
}

// ΓöÇΓöÇ Launch sidecar ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async function ensureSidecarRunning(logFn) {
  if (!isWindows || !scriptsDir) return { launched: false, pid: null }

  const portOpen = await isPortListening(DEFAULT_PORT)
  if (portOpen) {
    logFn("info", `sidecar already running on port ${DEFAULT_PORT}`)
    return { launched: false, pid: null }
  }

  // CLI fallback: skip if MOBILE_SYNC_DESKTOP_ONLY is set
  if (process.env.MOBILE_SYNC_DESKTOP_ONLY === "1") {
    logFn("info", "MOBILE_SYNC_DESKTOP_ONLY=1, not starting CLI fallback")
    return { launched: false, pid: null }
  }

  const launcher = join(scriptsDir, "start-opencode-server.ps1")
  if (!existsSync(launcher)) {
    logFn("warn", "server launcher not found", { path: launcher })
    return { launched: false, pid: null }
  }

  logFn("info", "launching CLI server (desktop not running)...")
  try {
    // Launch detached (non-blocking). Node's detached: true handles process
    // survival ΓÇö do NOT also pass -Detached to the script (conflicts).
    const child = spawn(PS_EXE, [...PS_FLAGS, "-File", launcher, "-Detached"], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    // Wait up to 15s for port to open
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await isPortListening(DEFAULT_PORT)) {
        logFn("info", `CLI server ready on port ${DEFAULT_PORT}`)
        return { launched: true, pid: child.pid }
      }
    }
    logFn("warn", `CLI server not listening after 15s on port ${DEFAULT_PORT}`)
    return { launched: false, pid: child.pid }
  } catch (err) {
    logFn("error", "failed to launch CLI server", { error: errStr(err) })
    return { launched: false, pid: null }
  }
}

// ΓöÇΓöÇ Start auto-repatch watcher ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function startWatcher(logFn) {
  if (!isWindows || !scriptsDir) return null

  const watcherScript = join(scriptsDir, "watch-opencode-desktop.ps1")
  if (!existsSync(watcherScript)) {
    logFn("warn", "watcher script not found, skipping", { path: watcherScript })
    return null
  }

  logFn("info", "starting auto-repatch watcher...")
  try {
    const child = spawn(PS_EXE, [...PS_FLAGS, "-File", watcherScript], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    logFn("info", `watcher started (PID ${child.pid})`)
    return child
  } catch (err) {
    logFn("error", "failed to start watcher", { error: errStr(err) })
    return null
  }
}

// ΓöÇΓöÇ Auto-updater ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

// Serialize concurrent checkForUpdates() calls so only one runs at a time.
// The in-flight promise is awaited by subsequent callers instead of starting
// duplicate fetches/downloads.
let _updateInFlight = null

async function checkForUpdates(logFn, osNotify) {
  if (!pluginDir || !scriptsDir) return

  // If an update check is already running, wait for its result instead of
  // starting a second concurrent fetch (which would double bandwidth and race writes).
  if (_updateInFlight) {
    try { await _updateInFlight } catch {}
    return
  }

  const work = _runUpdate(logFn, osNotify)
  _updateInFlight = work
  try { await work } finally { _updateInFlight = null }
}

async function _runUpdate(logFn, osNotify) {
  try {
    const cache = loadCache()
    const headers = {
      "user-agent": `mobile-sync-plugin/${MOBILE_SYNC_VERSION}`,
      accept: "application/vnd.github.v3+json",
    }
    // Validate ETag before sending as header ΓÇö guards against malformed cache
    // file. GitHub ETags are weak (`W/"hex"`) or strong (`"hex"`) with a 64-char
    // hex digest. Allowed chars: word chars, slash, dash, quote; 16-80 length.
    if (typeof cache.etag === "string" && /^[\w"/-]{16,80}$/.test(cache.etag)) {
      headers["if-none-match"] = cache.etag
    }

    const res = await fetch(
      `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`,
      { headers, signal: AbortSignal.timeout(15_000) }
    )

    if (res.status === 304) {
      logFn("debug", "up to date (304 Not Modified)", { local: MOBILE_SYNC_VERSION })
      return
    }
    if (!res.ok) {
      logFn("debug", `GitHub API returned ${res.status}`, { status: res.status })
      return
    }

    const release = await res.json()
    const newEtag = res.headers.get("etag")
    if (newEtag) {
      await saveCache({ etag: newEtag, version: MOBILE_SYNC_VERSION })
    }
    const remoteVersion = (release.tag_name || "").replace(/^v/, "")
    if (!remoteVersion || !isNewer(remoteVersion, MOBILE_SYNC_VERSION)) {
      logFn("debug", "up to date", { local: MOBILE_SYNC_VERSION, remote: remoteVersion })
      return
    }

    logFn("info", `update available: ${MOBILE_SYNC_VERSION} -> ${remoteVersion}`)

    const zipball = release.zipball_url
    if (!zipball) return

    const zipRes = await fetch(zipball, {
      headers: {
        "user-agent": `mobile-sync-plugin/${MOBILE_SYNC_VERSION}`,
        accept: "application/octet-stream",
      },
      signal: AbortSignal.timeout(60_000),
    })
    if (!zipRes.ok) return
    const zipBytes = Buffer.from(await zipRes.arrayBuffer())

    const tempDir = join(tmpdir(), `mobile-sync-update-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
    try {
      const zipPath = join(tempDir, "update.zip")
      await writeFile(zipPath, zipBytes)

      if (isWindows) {
        const extractDir = join(tempDir, "extracted")
        // Use psQuote (PowerShell single-quote escape) for defense-in-depth.
        // Paths here come from Date.now()/tmpdir() (safe today) but this guards
        // against any future path containing a single quote.
        await runPSCommand(
          `Expand-Archive -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(extractDir)} -Force`,
          { timeout: 30_000 }
        )

        const entries = await readdir(extractDir)
        if (entries.length === 0) return
        const srcDir = join(extractDir, entries[0])

        const scriptsSrc = join(srcDir, "scripts")
        if (existsSync(scriptsSrc)) {
          const scriptsDest = scriptsDir
          // Try to remove the existing scripts directory first. This can fail on
          // Windows if a running PowerShell process (e.g. the CLI server) has one
          // of the scripts open with an exclusive lock. In that case we fall back
          // to a per-file copy (files that were removed in the new release will
          // persist as orphans ΓÇö acceptable; new/updated files are still deployed).
          try {
            await rm(scriptsDest, { recursive: true, force: true })
          } catch (rmErr) {
            logFn("debug", "could not remove scripts dir (locked), doing per-file copy", { error: errStr(rmErr) })
          }
          await copyDir(scriptsSrc, scriptsDest)
        }

        const pluginSrc = join(srcDir, "mobile-sync.js")
        if (existsSync(pluginSrc)) {
          const pluginDest = join(pluginDir, "mobile-sync.js")
          const backup = `${pluginDest}.bak`
          try {
            await rename(pluginDest, backup)
          } catch (renameErr) {
            // File may be locked (still loaded by host). Log and abort update ΓÇö
            // overwriting without a backup would brick the plugin permanently.
            logFn("warn", "could not back up plugin file, skipping update", {
              error: errStr(renameErr),
              hint: "plugin may be loaded by host; restart and retry",
            })
            return
          }
          try {
            await copyFile(pluginSrc, pluginDest)
          } catch (copyErr) {
            // Restore the previous version so the next load still works.
            await rename(backup, pluginDest).catch((restoreErr) => {
              logFn("error", "could not restore plugin backup after failed copy", {
                error: errStr(restoreErr),
                hint: "plugin may be in inconsistent state; check $backup file",
              })
            })
            throw copyErr
          }
          // Successful update — remove the backup to avoid accumulating
          // stale .bak files across many updates. Log if cleanup fails so the
          // user can manually clean up rather than wondering why a .bak persists.
          await rm(backup, { force: true }).catch((rmErr) => {
            logFn("debug", "could not remove plugin backup file", { error: errStr(rmErr) })
          })
        }

        const pkgSrc = join(srcDir, "package.json")
        if (existsSync(pkgSrc)) {
          await copyFile(pkgSrc, join(pluginDir, "package.json"))
        }

        logFn("info", `self-updated to ${remoteVersion}. Restart OpenCode to load.`)
        // .catch guards against unhandled rejection in the fire-and-forget toast.
        osNotify("mobile-sync Updated", `Updated to v${remoteVersion}. Restart OpenCode to apply.`)
          .catch((err) => logFn("debug", "update toast failed", { error: errStr(err) }))
      }
    } finally {
      // Best-effort temp cleanup — log on failure so orphaned dirs don't go unnoticed.
      await rm(tempDir, { recursive: true, force: true }).catch((rmErr) => {
        logFn("debug", "could not remove update temp dir", { error: errStr(rmErr), path: tempDir })
      })
    }
  } catch (err) {
    logFn("debug", "update check skipped", { error: errStr(err) })
  }
}

/**
 * Recursively copy a directory's contents into `dest`.
 * Skips symbolic links and junctions to prevent infinite recursion if the
 * zipball contains a self-referential entry (a malformed release). Plain
 * files and subdirectories are copied as-is.
 */
async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    // isSymbolicLink() covers symlinks AND junctions on Windows. isDirectory()
    // returns true for the target of a junction, so we must check symlink
    // FIRST to avoid recursing into a cycle.
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

/** Copy a file. */
async function copyFile(src, dest) {
  const data = await readFile(src)
  await writeFile(dest, data)
}

// ΓöÇΓöÇ Plugin Export ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const MobileSyncPlugin = async ({ $ }) => {
  // Allow disabling via env var (0/false/off = disabled)
  const enabled = (process.env.MOBILE_SYNC_ENABLED ?? "1").toLowerCase()
  if (["0", "false", "off"].includes(enabled)) {
    return { dispose: async () => {} }
  }

  const port = DEFAULT_PORT
  // Set up logging FIRST so readPassword() can log through it.
  const TAG = "[mobile-sync]"
  const logFn = (level, msg, extra) => {
    const line = `${TAG} ${msg}`
    const fn = level === "error" ? "error"
      : level === "warn" ? "warn"
      : level === "debug" ? "debug"
      : "log"
    if (extra) console[fn](`${line} ${JSON.stringify(extra)}`)
    else console[fn](line)
  }
  _globalLogFn = logFn

  const password = readPassword()  // may log a one-time warning if regeneration occurred
  let watcherProc = null
  let launcherPid = null   // PID of the PowerShell wrapper that launched the sidecar
  let updateTimer = null
  let startupToastTimer = null
  let lastUpdateCheckAt = 0
  let lastRelaunchAt = 0    // wall-clock of last relaunch attempt
  let portWasDown = false   // true while port is known to be down (cooldown gates on this)
  const RELAUNCH_COOLDOWN_MS = 60_000  // don't relaunch more than once per minute while port is down
  let relaunching = false  // debounce guard for concurrent event-driven relaunch
  const osNotify = createOsNotifier({ $ })

  // Mask password: show last 4 chars so the user can still identify it.
  // Show the full value ONCE at startup ΓÇö this is the only time the user
  // will see it. They must copy it into the Android app's connection config.
  const maskedPw = password
    ? (password.length <= 4 ? "*".repeat(password.length) : "*".repeat(password.length - 4) + password.slice(-4))
    : "(not set)"
  logFn("info", `v${MOBILE_SYNC_VERSION} loading`)
  logFn("info", `PASSWORD: ${password}  <-- copy this into the Android app`)
  logFn("info", `hooks ready (port ${port}, password ${maskedPw})`)

  // Set up hourly update check (with error handling)
  updateTimer = setInterval(() => {
    if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return
    lastUpdateCheckAt = Date.now()
    checkForUpdates(logFn, osNotify).catch((err) => {
      logFn("debug", "periodic update check failed", { error: errStr(err) })
    })
  }, UPDATE_CHECK_INTERVAL_MS)
  if (updateTimer.unref) updateTimer.unref()

  // ── Watchdog: keep the CLI server alive ────────────────────────────────
  // The scheduled task provides the first boot, but once the plugin is
  // loaded it becomes the primary watchdog: every 30s we confirm the port
  // is listening and the opencode.exe process exists. If the port is down
  // we try to relaunch via the script. Cooldown gates the rate of restarts
  // so we don't spam in a tight loop.
  let watchdogTimer = null
  const WATCHDOG_INTERVAL_MS = 30_000
  let lastWatchdogAt = 0
  let watchdogStarting = false  // re-entrancy guard for the watchdog itself
  const ensureServerHealthy = async () => {
    if (watchdogStarting) return
    if (Date.now() - lastWatchdogAt < WATCHDOG_INTERVAL_MS - 1_000) return
    lastWatchdogAt = Date.now()
    if (await isPortListening(port)) {
      portWasDown = false
      return
    }
    if (Date.now() - lastRelaunchAt < RELAUNCH_COOLDOWN_MS) return
    watchdogStarting = true
    lastRelaunchAt = Date.now()
    portWasDown = true
    try {
      logFn("warn", "watchdog: port down, restarting server")
      const result = await ensureSidecarRunning(logFn)
      if (result.pid) launcherPid = result.pid
      if (await isPortListening(port)) {
        portWasDown = false
        logFn("info", "watchdog: server recovered")
      }
    } catch (err) {
      logFn("debug", "watchdog restart failed", { error: errStr(err) })
    } finally {
      watchdogStarting = false
    }
  }
  // Only enable the watchdog on Windows where the CLI server runs.
  if (isWindows) {
    watchdogTimer = setInterval(() => {
      ensureServerHealthy().catch((err) =>
        logFn("debug", "watchdog tick failed", { error: errStr(err) })
      )
    }, WATCHDOG_INTERVAL_MS)
    if (watchdogTimer.unref) watchdogTimer.unref()
  }

  // ΓöÇΓöÇ Deferred init: run heavy work AFTER returning hooks ΓöÇΓöÇ
  // This prevents the plugin from blocking OpenCode's GUI startup.
  // All errors are caught so a failure here never bricks the client.
  (async () => {
    try {
      await runFirstTimeSetup(logFn)

      const sidecar = await ensureSidecarRunning(logFn)
      launcherPid = sidecar.pid

      // Start watcher only if desktop is installed (watcher re-patches desktop app.asar).
      // CLI server doesn't need a watcher.
      const desktopInstalled = existsSync(join(scriptsDir, "start-opencode-desktop.ps1"))
      const portIsUp = sidecar.launched || (await isPortListening(port))
      if (portIsUp && desktopInstalled) {
        watcherProc = startWatcher(logFn)
      }

      await checkForUpdates(logFn, osNotify)
      lastUpdateCheckAt = Date.now()

      logFn("info", `initialized (port ${port})`)

      // Delayed startup toast ΓÇö shows after GUI has loaded (5s).
      // Tracked so dispose can cancel it if plugin unloads before it fires.
      // .catch guards against unhandled rejection in the fire-and-forget timer.
      startupToastTimer = setTimeout(() => {
        startupToastTimer = null
        osNotify("mobile-sync Ready", `v${MOBILE_SYNC_VERSION} active on port ${port}`)
          .catch((err) => logFn("debug", "startup toast failed", { error: errStr(err) }))
      }, 5_000)
      if (startupToastTimer?.unref) startupToastTimer.unref()
    } catch (err) {
      logFn("error", "deferred init failed", { error: errStr(err) })
    }
  })()

  // ΓöÇΓöÇ Hooks (returned immediately, never blocks) ΓöÇΓöÇ
  return {
    // Inject OPENCODE_PORT + OPENCODE_SERVER_PASSWORD into shell command env.
    // SECURITY: the password is injected as plain text into EVERY shell command
    // run by OpenCode (not just opencode-related ones). This means `env`, error
    // messages, and any process the shell spawns can see it. The auth scheme
    // is HTTP Basic ΓÇö these env vars are equivalent to bearer tokens.
    //
    // This is by design: the user explicitly set up the shared server, and
    // injecting the env avoids re-typing the password for every curl/wget
    // command. Mitigations:
    //   - Only set if not already present in output.env (explicit overrides win)
    //   - Password is read from a per-user file the user already controls
    //   - The opencode server uses Basic auth over Tailscale Funnel (TLS),
    //     so the password only travels over encrypted channels
    //   - Users on multi-tenant systems should set OPENCODE_SERVER_PASSWORD
    //     themselves to override (the if-not-present check respects this)
    "shell.env": async (_input, output) => {
      if (!output.env.OPENCODE_PORT) {
        output.env.OPENCODE_PORT = String(port)
      }
      if (!output.env.OPENCODE_SERVER_PASSWORD) {
        output.env.OPENCODE_SERVER_PASSWORD = password
      }
      // Set the CORS allowlist for the patched app.asar sidecar. Defaults to
      // ["oc://renderer"] before the funnel URL is configured; after setup the
      // allowlist includes the Tailscale Funnel URL. Without this injection the
      // app.asar sidecar falls back to wildcard CORS (security issue).
      if (!output.env.OPENCODE_SERVER_CORS) {
        output.env.OPENCODE_SERVER_CORS = readCorsAllowlist()
      }
    },

    // Periodic health check on session idle.
    // Cooldown: if port is down, attempt relaunch at most once per minute.
    // When port comes back up, cooldown resets so we react quickly next time it drops.
    event: async (input) => {
      try {
        const event = input && typeof input === "object" ? input.event : null
        if (!event || typeof event.type !== "string") return

        if (event.type === "session.idle") {
          if (!isWindows || relaunching) return
          // If we just attempted a relaunch, give the new process a few
          // seconds to bind the port before probing again. The watchdog
          // (running every 30s) handles the long-term recovery; this hook
          // is just a fast-path for when OpenCode goes idle soon after a crash.
          if (portWasDown && (Date.now() - lastRelaunchAt) < 10_000) return
          const portOpen = await isPortListening(port)
          if (portOpen) {
            // Port is back ΓÇö clear the down flag so the next outage triggers fast recovery
            portWasDown = false
            return
          }
          if (!portWasDown || (Date.now() - lastRelaunchAt) >= RELAUNCH_COOLDOWN_MS) {
            portWasDown = true
            lastRelaunchAt = Date.now()
            relaunching = true
            logFn("warn", "sidecar not responding, re-launching...")
            try {
              const result = await ensureSidecarRunning(logFn)
              if (result.pid) launcherPid = result.pid
              if (await isPortListening(port)) {
                portWasDown = false
                logFn("info", "sidecar recovered")
              }
            } finally {
              relaunching = false
            }
          }
        }
      } catch (err) {
        logFn("debug", "event handler error", { error: errStr(err) })
      }
    },

    // Cleanup on unload.
    // The CLI server (opencode.exe serve) is intentionally LEFT RUNNING when
    // the plugin unloads: mobile clients connect to it independently of the
    // OpenCode desktop app, and killing it would disconnect them. Set
    // MOBILE_SYNC_KILL_SERVER_ON_DISPOSE=1 to override.
    dispose: async () => {
      if (updateTimer) {
        clearInterval(updateTimer)
        updateTimer = null
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer)
        watchdogTimer = null
      }
      if (startupToastTimer) {
        clearTimeout(startupToastTimer)
        startupToastTimer = null
      }
      if (watcherProc) {
        try { watcherProc.kill() } catch {}
        watcherProc = null
      }
      // Best-effort: kill the wrapper that launched the sidecar. This is
      // usually a no-op (the wrapper has already exited), but if MOBILE_SYNC_KILL_SERVER_ON_DISPOSE
      // is set we also walk the process tree to terminate the opencode.exe grandchild.
      if (launcherPid) {
        const tree = process.env.MOBILE_SYNC_KILL_SERVER_ON_DISPOSE === "1"
        if (isWindows && tree) {
          // /T = terminate child tree, /F = force. Ignore exit code ΓÇö the
          // wrapper may have already exited and taskkill returns non-zero
          // in that case, which is fine.
          execFile("taskkill", ["/T", "/F", "/PID", String(launcherPid)], { windowsHide: true }, () => {})
        }
        launcherPid = null
      }
      logFn("info", "disposed")
    },
  }
}

export default {
  id: "mobile-sync",
  server: MobileSyncPlugin
}


