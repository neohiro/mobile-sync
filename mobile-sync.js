/**
 * mobile-sync — OpenCode plugin
 *
 * Makes the patched desktop sidecar act as a shared server on port 4096,
 * accessible via Tailscale Funnel for mobile sync.
 *
 * On startup:
 *   1. Runs first-time setup if needed (password file, patch, funnel)
 *   2. Launches the desktop sidecar if port 4096 is not listening
 *   3. Starts the auto-repatch watcher
 *   4. Injects OPENCODE_PORT + OPENCODE_SERVER_PASSWORD into shell env
 *
 * Auto-updates daily from GitHub releases.
 */

import { execFile, spawn } from "node:child_process"
import { readFile, writeFile, mkdir, rm, rename, readdir } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, platform, tmpdir } from "node:os"

const MOBILE_SYNC_VERSION = "1.0.1"
const GITHUB_REPO = "neohiro/mobile-sync"
const UPDATE_CHECK_INTERVAL_MS = 3_600_000 // hourly
const DEFAULT_PORT = 4096

// ── Helpers ────────────────────────────────────────────────────────────────

const isWindows = platform() === "win32"

const PS_EXE = "powershell.exe"
const PS_FLAGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-NonInteractive"]

const PASSWORD_FILE = join(homedir(), ".opencode-server-password")
const DEFAULT_PASSWORD = "NJYA0Uw1A7kePY8fv4BCftNH"

// ── OS notifications (same mechanism as auto-resume) ────────────────────────

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

/** Read the password from disk, falling back to default. */
function readPassword() {
  try {
    const raw = readFileSync(PASSWORD_FILE, "utf8").trim()
    return raw || DEFAULT_PASSWORD
  } catch {
    return DEFAULT_PASSWORD
  }
}

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

/** Check if a TCP port is listening. */
function isPortListening(port) {
  return new Promise((resolve) => {
    execFile(PS_EXE, [
      ...PS_FLAGS,
      "-Command",
      `Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -InformationLevel Quiet`
    ], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      resolve(stdout?.trim() === "True")
    })
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

// ── First-time setup ───────────────────────────────────────────────────────

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
    logFn("error", "first-time setup failed", { error: err?.message })
  }
}

// ── Launch sidecar ─────────────────────────────────────────────────────────

async function ensureSidecarRunning(logFn) {
  if (!isWindows || !scriptsDir) return { launched: false, pid: null }

  const portOpen = await isPortListening(DEFAULT_PORT)
  if (portOpen) {
    logFn("info", `sidecar already running on port ${DEFAULT_PORT}`)
    return { launched: false, pid: null }
  }

  const launcher = join(scriptsDir, "start-opencode-desktop.ps1")
  if (!existsSync(launcher)) {
    logFn("warn", "desktop launcher not found", { path: launcher })
    return { launched: false, pid: null }
  }

  logFn("info", "launching desktop sidecar...")
  try {
    // Launch detached (non-blocking). Node's detached: true handles process
    // survival — do NOT also pass -Detached to the script (conflicts).
    const child = spawn(PS_EXE, [...PS_FLAGS, "-File", launcher], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    // Wait up to 15s for port to open
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await isPortListening(DEFAULT_PORT)) {
        logFn("info", `sidecar ready on port ${DEFAULT_PORT}`)
        return { launched: true, pid: child.pid }
      }
    }
    logFn("warn", `sidecar not listening after 15s on port ${DEFAULT_PORT}`)
    return { launched: false, pid: child.pid }
  } catch (err) {
    logFn("error", "failed to launch sidecar", { error: err?.message })
    return { launched: false, pid: null }
  }
}

// ── Start auto-repatch watcher ─────────────────────────────────────────────

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
    logFn("error", "failed to start watcher", { error: err?.message })
    return null
  }
}

// ── Auto-updater ───────────────────────────────────────────────────────────

async function checkForUpdates(logFn, osNotify) {
  if (!pluginDir || !scriptsDir) return

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest?t=${Date.now()}`,
      {
        headers: {
          "user-agent": `mobile-sync-plugin/${MOBILE_SYNC_VERSION}`,
          accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!res.ok) return
    const release = await res.json()
    const remoteVersion = (release.tag_name || "").replace(/^v/, "")
    if (!remoteVersion || !isNewer(remoteVersion, MOBILE_SYNC_VERSION)) {
      logFn("debug", "up to date", { local: MOBILE_SYNC_VERSION, remote: remoteVersion })
      return
    }

    logFn("info", `update available: ${MOBILE_SYNC_VERSION} -> ${remoteVersion}`)

    // Download the zipball
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

    // Write zip to temp, extract, replace
    const tempDir = join(tmpdir(), `mobile-sync-update-${Date.now()}`)
    const zipPath = join(tempDir, "update.zip")
    await mkdir(tempDir, { recursive: true })
    await writeFile(zipPath, zipBytes)

    // Extract with PowerShell
    if (isWindows) {
      const extractDir = join(tempDir, "extracted")
      // Use runPSCommand for inline -Command (not runPS which uses -File)
      await runPSCommand(
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
        { timeout: 30_000 }
      )

      // Find the extracted folder (GitHub zip contains a single folder)
      const entries = await readdir(extractDir)
      if (entries.length === 0) return
      const srcDir = join(extractDir, entries[0])

      // Copy scripts/ if present
      const scriptsSrc = join(srcDir, "scripts")
      if (existsSync(scriptsSrc)) {
        const scriptsDest = scriptsDir
        await rm(scriptsDest, { recursive: true, force: true })
        await copyDir(scriptsSrc, scriptsDest)
      }

      // Copy updated plugin file (with rollback on failure)
      const pluginSrc = join(srcDir, "mobile-sync.js")
      if (existsSync(pluginSrc)) {
        const pluginDest = join(pluginDir, "mobile-sync.js")
        const backup = `${pluginDest}.bak`
        await rename(pluginDest, backup).catch(() => {})
        try {
          await copyFile(pluginSrc, pluginDest)
        } catch (copyErr) {
          // Rollback: restore .bak as current so plugin isn't bricked
          await rename(backup, pluginDest).catch(() => {})
          throw copyErr
        }
      }

      // Copy package.json if present
      const pkgSrc = join(srcDir, "package.json")
      if (existsSync(pkgSrc)) {
        await copyFile(pkgSrc, join(pluginDir, "package.json"))
      }

      logFn("info", `self-updated to ${remoteVersion}. Restart OpenCode to load.`)
      osNotify("mobile-sync Updated", `Updated to v${remoteVersion}. Restart OpenCode to apply.`)
    }

    // Cleanup temp
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  } catch (err) {
    logFn("debug", "update check skipped", { error: err?.message })
  }
}

/** Recursively copy a directory. */
async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await copyFile(srcPath, destPath)
    }
  }
}

/** Copy a file. */
async function copyFile(src, dest) {
  const data = await readFile(src)
  await writeFile(dest, data)
}

// ── Plugin Export ───────────────────────────────────────────────────────────

const MobileSyncPlugin = async ({ client, $ }) => {
  // Allow disabling via env var (0/false/off = disabled)
  const enabled = (process.env.MOBILE_SYNC_ENABLED ?? "1").toLowerCase()
  if (["0", "false", "off"].includes(enabled)) {
    return { dispose: async () => {} }
  }

  const port = DEFAULT_PORT
  const password = readPassword()
  let watcherProc = null
  let launcherPid = null   // PID of the PowerShell wrapper that launched the sidecar
  let updateTimer = null
  let lastUpdateCheckAt = 0
  let relaunching = false // debounce guard for event-driven relaunch
  const osNotify = createOsNotifier({ $ })

  const TAG = "[mobile-sync]"
  const logFn = (level, msg, extra) => {
    const line = `${TAG} ${msg}`
    if (extra) console[level === "error" ? "error" : "log"](`${line} ${JSON.stringify(extra)}`)
    else console[level === "error" ? "error" : "log"](line)
  }

  logFn("info", `v${MOBILE_SYNC_VERSION} loading`)

  // Mask password: show last 4 chars (consistent with PS1 scripts)
  const maskedPw = password.length <= 4
    ? "*".repeat(password.length)
    : "*".repeat(password.length - 4) + password.slice(-4)
  logFn("info", `hooks ready (port ${port}, password ${maskedPw})`)

  // Set up hourly update check (with error handling)
  updateTimer = setInterval(() => {
    if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return
    lastUpdateCheckAt = Date.now()
    checkForUpdates(logFn, osNotify).catch((err) => {
      logFn("debug", "periodic update check failed", { error: err?.message })
    })
  }, UPDATE_CHECK_INTERVAL_MS)
  if (updateTimer.unref) updateTimer.unref()

  // ── Deferred init: run heavy work AFTER returning hooks ──
  // This prevents the plugin from blocking OpenCode's GUI startup.
  // All errors are caught so a failure here never bricks the client.
  const deferredInit = (async () => {
    try {
      await runFirstTimeSetup(logFn)

      const sidecar = await ensureSidecarRunning(logFn)
      launcherPid = sidecar.pid

      if (sidecar.launched || (await isPortListening(port))) {
        watcherProc = startWatcher(logFn)
      }

      await checkForUpdates(logFn, osNotify)
      lastUpdateCheckAt = Date.now()

      logFn("info", `initialized (port ${port})`)

      // Delayed startup toast — shows after GUI has loaded (5s)
      setTimeout(() => {
        osNotify("mobile-sync Ready", `v${MOBILE_SYNC_VERSION} active on port ${port}`)
      }, 5_000)
    } catch (err) {
      logFn("error", "deferred init failed", { error: err?.message })
    }
  })()

  // ── Hooks (returned immediately, never blocks) ──
  return {
    // Set environment variables for all shell commands.
    // Only set if not already present (respect user overrides).
    "shell.env": async (_input, output) => {
      if (!output.env.OPENCODE_PORT) {
        output.env.OPENCODE_PORT = String(port)
      }
      if (!output.env.OPENCODE_SERVER_PASSWORD) {
        output.env.OPENCODE_SERVER_PASSWORD = password
      }
    },

    // Periodic health check on session idle
    event: async (input) => {
      try {
        const event = input && typeof input === "object" ? input.event : null
        if (!event || typeof event.type !== "string") return

        if (event.type === "session.idle") {
          if (!isWindows || relaunching) return
          const portOpen = await isPortListening(port)
          if (!portOpen) {
            relaunching = true
            logFn("warn", "sidecar not responding, re-launching...")
            try {
              const result = await ensureSidecarRunning(logFn)
              if (result.pid) launcherPid = result.pid
            } finally {
              relaunching = false
            }
          }
        }
      } catch (err) {
        logFn("debug", "event handler error", { error: err?.message })
      }
    },

    // Cleanup on unload
    dispose: async () => {
      if (updateTimer) {
        clearInterval(updateTimer)
        updateTimer = null
      }
      if (watcherProc) {
        try { watcherProc.kill() } catch {}
        watcherProc = null
      }
      // Kill the PowerShell launcher wrapper only — the desktop/electron
      // sidecar runs independently and is NOT our child process.
      if (launcherPid) {
        try { process.kill(launcherPid, "SIGTERM") } catch {}
        launcherPid = null
      }
      logFn("info", "disposed")
    },
  }
}

export const MobileSyncPluginExport = {
  id: "mobile-sync",
  server: MobileSyncPlugin
}

export default MobileSyncPluginExport


