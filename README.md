# mobile-sync — cross-platform

OpenCode plugin that makes **any** OpenCode server accessible via [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) for mobile sync. **Works everywhere OpenCode runs — Windows, macOS, Linux — and with every OpenCode client (Desktop, TUI, web, CLI headless).**

> **v1.1.0 — Native toast + full cross-platform.** The plugin now prefers the built-in `client.tui.showToast({ body: { message, variant } })` API and only falls back to OS notifications when the TUI is unavailable. OS fallback is itself cross-platform: Windows (WinRT toast → balloon tip), macOS (`osascript` Notification Center), Linux (`notify-send` → `kdialog` → `zenity`).

## What It Does

On startup, the plugin automatically:

1. **Runs first-time setup** if needed (password file, desktop patch on Windows, Tailscale Funnel)
2. **Launches the desktop sidecar** if port 4096 is not listening and the desktop is installed
3. **Falls back to the CLI server** (`opencode serve`) if the desktop isn't running — keeps mobile access alive from device boot (now via direct spawn on macOS/Linux, PowerShell on Windows)
4. **Starts the auto-repatch watcher** (Windows) to re-apply desktop patches after updates
5. **Injects** `OPENCODE_PORT=4096` and `OPENCODE_SERVER_PASSWORD` into shell commands
6. **Checks for plugin updates** hourly from GitHub releases
7. **Notifies** via native in-app toast first, OS notification second (never both)

## Compatibility

| Platform | Server mode | Native toast | OS fallback | Funnel |
|----------|-------------|--------------|-------------|--------|
| **Windows 10/11** | Desktop sidecar (patched `app.asar`) **or** CLI `opencode serve` | `client.tui.showToast` (any client) | WinRT toast → `NotifyIcon` balloon | `tailscale funnel 4096` |
| **macOS 13+** | CLI `opencode serve` (direct spawn) | `client.tui.showToast` | `osascript` Notification Center | `tailscale funnel 4096` |
| **Linux** | CLI `opencode serve` (direct spawn) | `client.tui.showToast` | `notify-send` → `kdialog` → `zenity` | `tailscale funnel 4096` |

All clients share the same session DB path (`~/.local/share/opencode/opencode.db` on POSIX, `%LOCALAPPDATA%`-equivalent on Windows via `opencode`).

## Why CLI Fallback

The desktop sidecar is the primary server on Windows (serves the proper web UI with full functionality). But the desktop client may be closed, updating, or never launched — and the mobile app should still work from device boot.

The CLI server (`opencode serve`) serves the same web UI and uses the same database. The plugin checks port 4096 and only starts the CLI server if nothing else is listening. On macOS/Linux it spawns `opencode serve` directly with `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_CORS`; on Windows it delegates to `start-opencode-server.ps1`.

## Install

### Option 1: Ask OpenCode to install it (easiest)

Open OpenCode Desktop and paste this prompt:

```
Install the mobile-sync plugin from https://github.com/neohiro/mobile-sync:

1. Clone: git clone https://github.com/neohiro/mobile-sync.git "$env:TEMP/mobile-sync"
2. Copy plugin: Copy-Item "$env:TEMP/mobile-sync/mobile-sync.js" "$env:USERPROFILE\.config\opencode\plugins\"
3. Copy scripts: New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts" -Force; Copy-Item "$env:TEMP/mobile-sync/scripts/*.ps1" "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\"
4. Verify: Confirm plugins/mobile-sync.js and plugins/mobile-sync-scripts/*.ps1 both exist

After install, restart OpenCode. The plugin auto-loads like auto-resume.js.
```

**macOS / Linux:**

```bash
git clone https://github.com/neohiro/mobile-sync.git /tmp/mobile-sync
mkdir -p ~/.config/opencode/plugins
cp /tmp/mobile-sync/mobile-sync.js ~/.config/opencode/plugins/
# scripts are Windows-only helpers; plugin works without them on POSIX
```

After restart, verify the plugin loaded by checking for `[mobile-sync]` in the logs, or run:

```powershell
# Windows
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 50 | Select-String "mobile-sync"
```
```bash
# macOS / Linux
tail -n 50 ~/.local/share/opencode/log/opencode.log | grep mobile-sync
```

To get your mobile app connection details (Windows):

```powershell
& "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\show-connection.ps1"
```

On macOS/Linux:

```bash
cat ~/.opencode-server-password   # password
tailscale status --json | jq .Self.DNSName  # funnel URL
```

### Option 2: Clone and copy (recommended)

**Windows:**

```powershell
git clone https://github.com/neohiro/mobile-sync.git "$env:TEMP\mobile-sync"
Copy-Item "$env:TEMP\mobile-sync\mobile-sync.js" "$env:USERPROFILE\.config\opencode\plugins\"
New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts" -Force
Copy-Item "$env:TEMP\mobile-sync\scripts\*.ps1" "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\"
```

**macOS / Linux:**

```bash
git clone https://github.com/neohiro/mobile-sync.git /tmp/mobile-sync
cp /tmp/mobile-sync/mobile-sync.js ~/.config/opencode/plugins/
```

### Option 3: Manual copy

```powershell
# Windows
New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts" -Force
Copy-Item mobile-sync.js "$env:USERPROFILE\.config\opencode\plugins\"
Copy-Item scripts\*.ps1 "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\"
```
```bash
# POSIX
mkdir -p ~/.config/opencode/plugins
cp mobile-sync.js ~/.config/opencode/plugins/
```

### Option 4: Local development

Clone this repo and add to your config with the full path:

```json
{
  "plugin": ["C:/path/to/mobile-sync/mobile-sync.js"]
}
```
```json
{
  "plugin": ["/home/you/mobile-sync/mobile-sync.js"]
}
```

**Install structure:**

```
~/.config/opencode/plugins/
  auto-resume.js          (existing)
  mobile-sync.js          <-- plugin entry (flat, auto-discovered) — cross-platform
  mobile-sync-scripts/    <-- PowerShell helpers (Windows only, optional on POSIX)
    setup-opencode-shared.ps1
    patch-opencode-desktop.ps1
    start-opencode-desktop.ps1
    start-opencode-server.ps1
    watch-opencode-desktop.ps1
    show-connection.ps1
```

## Prerequisites

- **Any OS:** Windows 10/11, macOS 13+, or Linux (x64/arm64)
- [OpenCode CLI](https://opencode.ai) (`winget install SST.opencode` / `brew install` / `npm i -g @opencode-ai/cli`)
- [OpenCode Desktop](https://opencode.ai) — optional, Windows only. CLI fallback works everywhere without it.
- [Tailscale](https://tailscale.com/download) installed and logged in (same tailnet on phone + computer)
- Python 3.12+ — only for Windows desktop patch (`app.asar`); not needed for CLI-only mode on any OS

## How It Works

```
Mobile App (Android)
    |
    v
Tailscale Funnel (https://<device>.<tailnet>.ts.net)
    |
    v
Patched Desktop Sidecar (port 4096)  <-- primary on Windows, if desktop running
       OR
CLI Server `opencode serve` (port 4096)  <-- fallback everywhere (direct spawn on POSIX)
    |
    v
Local Session DB (~/.local/share/opencode/opencode.db)  <-- shared
    |
    v
Toast: client.tui.showToast() succeeds? -> done (no OS toast)
       otherwise -> OS notifier (WinRT / osascript / notify-send)
```

The plugin patches the desktop client's `app.asar` with two changes (Windows only, only if desktop is present):

1. **Password**: Accepts `OPENCODE_SERVER_PASSWORD` env var (was always random UUID)
2. **CORS**: Allows configured origins for Tailscale Funnel (was only `oc://renderer`)

If the desktop is not installed or not running, the plugin starts `opencode serve` instead — no patching required. On POSIX this is a direct `spawn("opencode", ["serve", ...], { env: { OPENCODE_SERVER_PASSWORD, OPENCODE_SERVER_CORS } })` with no PowerShell.

## Scripts

The plugin bundles these PowerShell scripts in `mobile-sync-scripts/` (Windows helpers — POSIX uses direct spawn):

| Script | Purpose | Platform |
|--------|---------|----------|
| `setup-opencode-shared.ps1` | First-time setup (password, patch, funnel) | Windows |
| `patch-opencode-desktop.ps1` | Patch desktop `app.asar` | Windows |
| `start-opencode-desktop.ps1` | Launch patched desktop | Windows |
| `start-opencode-server.ps1` | CLI server fallback | Windows (POSIX spawns directly) |
| `watch-opencode-desktop.ps1` | Auto-repatch after updates | Windows |
| `show-connection.ps1` | Show connection details for mobile app | Windows (POSIX: `cat ~/.opencode-server-password` + `tailscale status`) |

## Notifications

- **Preferred:** `client.tui.showToast({ body: { title, message, variant: "info" | "success" | "warning" | "error", duration: 5000 } })` — renders inside every OpenCode client (desktop TUI, terminal, web). Synchronous: if it returns `true` / no-throw, the OS toast is **cancelled**.
- **Fallback:** OS notification — Windows `Windows.UI.Notifications` → `NotifyIcon` balloon; macOS `osascript display notification`; Linux `notify-send` → `kdialog` → `zenity`. Only runs when the native toast is unavailable (headless `serve`, older server, no TUI attached).

## Auto-Update

The plugin checks for updates on startup and hourly:

- Fetches latest release from GitHub
- Compares version numbers
- Downloads and replaces files if newer version available
- Logs "Restart OpenCode to load" after update
- Shows a native toast (or OS fallback) on successful update

## Multi-Device Setup

Each device runs the plugin independently with its own session database. The mobile app connects to one device at a time via that device's Tailscale Funnel URL.

**To set up a new device:**

1. Install OpenCode (desktop or CLI)
2. Install Tailscale and log in
3. Clone this repo and install the plugin (Options 1-4 above)
4. Restart OpenCode — the plugin auto-runs setup on first launch
5. Run `show-connection.ps1` (Windows) or `cat ~/.opencode-server-password` (POSIX) to get the device's mobile app connection details
6. Add the device to your shared registry (optional, Windows):
    ```powershell
    .\show-connection.ps1 -Register
    ```
7. On any device, list all registered devices (Windows):
    ```powershell
    .\show-connection.ps1 -AllDevices
    ```

**Same password on all devices** is recommended for easy switching. The password file is at `~\.opencode-server-password` (Windows) / `~/.opencode-server-password` (POSIX) and is generated on first run.

**URLs are device-specific** — the plugin dynamically detects the full Tailscale DNS name (e.g., `laptop-xyz.taild879f3.ts.net`) from `tailscale status --json`. No hardcoded hostnames.

## Configuration

| Constant | Value | Description |
|----------|-------|-------------|
| Port | `4096` | Server HTTP port (hardcoded, matches Tailscale Funnel) |
| Password file | `~/.opencode-server-password` | Shared auth password (same on all devices) |
| `MOBILE_SYNC_ENABLED` | `1` (default) | Set to `0`, `false`, or `off` to disable the plugin without removing it |
| `MOBILE_SYNC_DESKTOP_ONLY` | `0` (default) | Set to `1` to never fall back to CLI server (desktop only) |

To disable the plugin, either set `MOBILE_SYNC_ENABLED=0` in your environment or rename `plugins/mobile-sync.js` to `plugins/mobile-sync.js.disabled`.

## Troubleshooting

### Mobile app can't connect

1. Verify Tailscale Funnel: `tailscale funnel status`
2. Verify server is running: `Test-NetConnection -ComputerName 127.0.0.1 -Port 4096` (Windows) / `nc -zv 127.0.0.1 4096` (POSIX)
3. Check connection details: `& "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\show-connection.ps1"` (Windows) / `tailscale status --json` (POSIX)
4. Check that CORS matches the Funnel URL — the `--cors` flag must match your Tailscale DNS name exactly
5. Check logs: `Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 50 | Select-String "mobile-sync"` / `tail -n 50 ~/.local/share/opencode/log/opencode.log | grep mobile-sync`

### Mobile app shows empty project (no sessions)

The CLI server and desktop sidecar share the same DB, but only when launched from the same home directory. The plugin launches `opencode serve` from `$HOME` so all projects are visible. If you started a manual `opencode serve` from a different directory, its project root may be that directory only. Symptoms:
- Android shows empty → server's `location.directory` (via `show-connection.ps1` → `Directory:` field) does not contain your projects.
Fix:
- Stop the manual server, let the plugin relaunch it (or run `start-opencode-server.ps1` / `opencode serve` from `$HOME`).
- Ensure the mobile app's **Directory** field matches `show-connection.ps1`'s Directory output (e.g., `C:\Users\Wout` on Windows).

### Sidecar not launching (Windows)

Check if Python is installed (required for asar patch):
```powershell
python --version
```

Check if the desktop is already running:
```powershell
Get-Process -Name "OpenCode"
```

### Port 4096 already in use

```powershell
# Windows
Get-NetTCPConnection -LocalPort 4096 | Select-Object OwningProcess
Stop-Process -Id <PID>
```
```bash
# POSIX
lsof -i :4096
kill <PID>
```

### Plugin not loading

Check the log for import errors:
```powershell
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 100 | Select-String "mobile-sync|error|ERROR"
```
```bash
tail -n 100 ~/.local/share/opencode/log/opencode.log | grep -E "mobile-sync|error"
```

The plugin file must be at the top level of `~/.config/opencode/plugins/` (not in a subdirectory) for auto-discovery to find it. See install structure above.

## License

MIT
