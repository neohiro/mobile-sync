# mobile-sync

OpenCode plugin that makes your desktop or CLI server accessible via Tailscale Funnel for mobile sync. Works whether or not the OpenCode desktop client is running.

## What It Does

On startup, the plugin automatically:

1. **Runs first-time setup** if needed (password file, desktop patch, Tailscale Funnel)
2. **Launches the desktop sidecar** if port 4096 is not listening and the desktop is installed
3. **Falls back to the CLI server** (`opencode serve`) if the desktop isn't running — keeps mobile access alive from device boot
4. **Starts the auto-repatch watcher** to re-apply desktop patches after updates
5. **Injects** `OPENCODE_PORT=4096` and `OPENCODE_SERVER_PASSWORD` into shell commands
6. **Checks for plugin updates** hourly from GitHub releases

## Why CLI Fallback

The desktop sidecar is the primary server (serves the proper web UI with full functionality). But the desktop client may be closed, updating, or never launched — and the mobile app should still work from device boot.

The CLI server (`opencode serve`) serves the same web UI and uses the same database (`~/.local/share/opencode/opencode.db`). The plugin checks port 4096 and only starts the CLI server if nothing else is listening.

## Install

### Option 1: Ask OpenCode to install it (easiest)

Open OpenCode Desktop and paste this prompt:

```
Install the mobile-sync plugin from https://github.com/neohiro/mobile-sync:

1. Clone: git clone https://github.com/neohiro/mobile-sync.git "$env:TEMP\mobile-sync"
2. Copy plugin: Copy-Item "$env:TEMP\mobile-sync\mobile-sync.js" "$env:USERPROFILE\.config\opencode\plugins\"
3. Copy scripts: New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts" -Force; Copy-Item "$env:TEMP\mobile-sync\scripts\*.ps1" "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\"
4. Verify: Confirm plugins/mobile-sync.js and plugins/mobile-sync-scripts/*.ps1 both exist

After install, restart OpenCode. The plugin auto-loads like auto-resume.js.
```

After restart, verify the plugin loaded by checking for `[mobile-sync]` in the logs, or run:
```powershell
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 50 | Select-String "mobile-sync"
```

To get your mobile app connection details:
```powershell
& "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\show-connection.ps1"
```

### Option 2: Clone and copy (recommended)

```powershell
git clone https://github.com/neohiro/mobile-sync.git "$env:TEMP\mobile-sync"
Copy-Item "$env:TEMP\mobile-sync\mobile-sync.js" "$env:USERPROFILE\.config\opencode\plugins\"
New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts" -Force
Copy-Item "$env:TEMP\mobile-sync\scripts\*.ps1" "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\"
```

### Option 3: Manual copy

```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts" -Force
Copy-Item mobile-sync.js "$env:USERPROFILE\.config\opencode\plugins\"
Copy-Item scripts\*.ps1 "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\"
```

### Option 4: Local development

Clone this repo and add to your config with the full path:

```json
{
  "plugin": ["C:/path/to/mobile-sync/mobile-sync.js"]
}
```

**Install structure:**
```
~/.config/opencode/plugins/
  auto-resume.js          (existing)
  mobile-sync.js          <-- plugin entry (flat, auto-discovered)
  mobile-sync-scripts/    <-- PS1 scripts
    setup-opencode-shared.ps1
    patch-opencode-desktop.ps1
    start-opencode-desktop.ps1
    start-opencode-server.ps1
    watch-opencode-desktop.ps1
    show-connection.ps1
```

## Prerequisites

- Windows 10/11
- [OpenCode Desktop](https://opencode.ai) (optional — CLI fallback works without it)
- [OpenCode CLI](https://opencode.ai) (`winget install SST.opencode`)
- [Tailscale](https://tailscale.com/download) installed and logged in
- Python 3.12+ (only for desktop patch — not needed for CLI-only mode)

## How It Works

```
Mobile App (Android)
    |
    v
Tailscale Funnel (https://<device>.<tailnet>.ts.net)
    |
    v
Patched Desktop Sidecar (port 4096)  <-- primary, if desktop running
       OR
CLI Server `opencode serve` (port 4096)  <-- fallback, if desktop not running
    |
    v
Local Session DB (~/.local/share/opencode/opencode.db)  <-- shared with desktop
```

The plugin patches the desktop client's `app.asar` with two changes (only if desktop is present):

1. **Password**: Accepts `OPENCODE_SERVER_PASSWORD` env var (was always random UUID)
2. **CORS**: Allows all origins for Tailscale Funnel connections (was only `oc://renderer`)

If the desktop is not installed or not running, the plugin starts `opencode serve` instead — no patching required.

## Scripts

The plugin bundles these PowerShell scripts in `mobile-sync-scripts/`:

| Script | Purpose |
|--------|---------|
| `setup-opencode-shared.ps1` | First-time setup (password, patch, funnel) |
| `patch-opencode-desktop.ps1` | Patch desktop app.asar |
| `start-opencode-desktop.ps1` | Launch patched desktop |
| `start-opencode-server.ps1` | CLI server fallback (works without desktop) |
| `watch-opencode-desktop.ps1` | Auto-repatch after updates |
| `show-connection.ps1` | Show connection details for mobile app |

## Auto-Update

The plugin checks for updates on startup and hourly:

- Fetches latest release from GitHub
- Compares version numbers
- Downloads and replaces files if newer version available
- Logs "Restart OpenCode to load" after update

## Multi-Device Setup

Each device runs the plugin independently with its own session database. The mobile app connects to one device at a time via that device's Tailscale Funnel URL.

**To set up a new device:**

1. Install OpenCode (desktop or CLI)
2. Install Tailscale and log in
3. Clone this repo and install the plugin (Options 1-4 above)
4. Restart OpenCode — the plugin auto-runs setup on first launch
5. Run `show-connection.ps1` to get the device's mobile app connection details
6. Add the device to your shared registry (optional):
   ```powershell
   .\show-connection.ps1 -Register
   ```
7. On any device, list all registered devices:
   ```powershell
   .\show-connection.ps1 -AllDevices
   ```

**Same password on all devices** is recommended for easy switching. The password file is at `~\.opencode-server-password` and is generated on first run.

**URLs are device-specific** — the plugin dynamically detects the full Tailscale DNS name (e.g., `laptop-xyz.taild879f3.ts.net`) from `tailscale status --json`. No hardcoded hostnames.

## Configuration

| Constant | Value | Description |
|----------|-------|-------------|
| Port | `4096` | Server HTTP port (hardcoded, matches Tailscale Funnel) |
| Password file | `~\.opencode-server-password` | Shared auth password (same on all devices) |
| `MOBILE_SYNC_ENABLED` | `1` (default) | Set to `0`, `false`, or `off` to disable the plugin without removing it |
| `MOBILE_SYNC_DESKTOP_ONLY` | `0` (default) | Set to `1` to never fall back to CLI server (desktop only) |

To disable the plugin, either set `MOBILE_SYNC_ENABLED=0` in your environment or rename `plugins/mobile-sync.js` to `plugins/mobile-sync.js.disabled`.

## Troubleshooting

### Mobile app can't connect

1. Verify Tailscale Funnel: `tailscale funnel status`
2. Verify server is running: `Test-NetConnection -ComputerName 127.0.0.1 -Port 4096`
3. Check connection details: `& "$env:USERPROFILE\.config\opencode\plugins\mobile-sync-scripts\show-connection.ps1"`
4. Check that CORS matches the Funnel URL — the `--cors` flag in `start-opencode-server.ps1` must match your Tailscale DNS name exactly

### Sidecar not launching

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
Get-NetTCPConnection -LocalPort 4096 | Select-Object OwningProcess
Stop-Process -Id <PID>
```

### Plugin not loading

Check the log for import errors:
```powershell
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 100 | Select-String "mobile-sync|error|ERROR"
```

The plugin file must be at the top level of `~/.config/opencode/plugins/` (not in a subdirectory) for auto-discovery to find it. See install structure above.

## License

MIT
