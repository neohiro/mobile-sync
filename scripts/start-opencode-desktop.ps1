# start-opencode-desktop.ps1
# Launch the patched OpenCode desktop client with fixed port and password.
# The sidecar will bind to port 4096 with the shared password,
# making it accessible via Tailscale Funnel for mobile sync.
#
# Usage:
#   .\start-opencode-desktop.ps1            # Launch desktop (foreground)
#   .\start-opencode-desktop.ps1 -Detached  # Launch desktop in background

param(
    [switch]$Detached
)

$ErrorActionPreference = 'Stop'

$port = 4096
$passwordFile = "$env:USERPROFILE\.opencode-server-password"
$directoryFile = "$env:USERPROFILE\.opencode-server-directory"
$funnelConfigFile = "$env:USERPROFILE\.opencode-funnel-url"

# --- Build CORS allowlist from funnel URL + oc://renderer (desktop) ---
# SECURITY: without this the desktop sidecar's wildcard CORS is exposed to
# the public internet via Tailscale Funnel. Reading the funnel URL from
# the config file written by setup-opencode-shared.ps1 keeps a single
# source of truth. URL regex must match the same check the plugin uses
# (mobile-sync.js readCorsAllowlist) so we reject the same malformed
# inputs — defense in depth: the asar's JSON.parse is lenient, but a
# half-written or hand-edited config file should not leak through.
$corsOrigins = @('oc://renderer')
if (Test-Path -LiteralPath $funnelConfigFile) {
    $funnelUrl = (Get-Content -LiteralPath $funnelConfigFile -Raw).Trim()
    # Validate: must be https://, must have a non-empty hostname that starts
    # and ends with an alphanumeric. The `*` origin wildcard is also rejected
    # here because it would defeat the whole point of the allowlist.
    if ($funnelUrl -and $funnelUrl -ne '*' -and $funnelUrl -match '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$') {
        $corsOrigins += $funnelUrl
    } elseif ($funnelUrl) {
        Write-Host "WARN: $funnelConfigFile contains invalid URL: '$funnelUrl' (expected https://hostname). Ignoring." -ForegroundColor Yellow
    }
}
$corsJson = ($corsOrigins | ConvertTo-Json -Compress)

# --- Load password from file. If missing, exit — the plugin generates it
# on its first run, or setup-opencode-shared.ps1 does the same. We never
# fall back to a hardcoded value: every install gets its own unique secret.
$password = $null
if (Test-Path -LiteralPath $passwordFile) {
    $password = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
    if (-not $password) { $password = $null }
}
if (-not $password) {
    Write-Host "Password file not found: $passwordFile" -ForegroundColor Red
    Write-Host "  Run setup-opencode-shared.ps1 first, or load the plugin once to generate one." -ForegroundColor Yellow
    exit 1
}

# --- Save home directory so the mobile app can find the server's working dir ---
# Desktop launches from the user's current location, but the server still
# references the saved directory file for the mobile app to read.
if (-not (Test-Path -LiteralPath $directoryFile)) {
    [System.IO.File]::WriteAllText($directoryFile, $env:USERPROFILE)
}

# --- Discover desktop executable ---
function Find-DesktopExe {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\@opencode-aidesktop\OpenCode.exe"
        "$env:USERPROFILE\scoop\apps\opencode-desktop\current\OpenCode.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    # Search common Program Files locations
    $searchRoots = @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}")
    foreach ($root in $searchRoots) {
        $found = Get-ChildItem -Path $root -Filter "OpenCode.exe" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.DirectoryName -match '@opencode-aidesktop' } |
            Select-Object -First 1 -ExpandProperty FullName
        if ($found) { return $found }
    }
    # Search WinGet packages
    $winget = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*opencode*" -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "OpenCode.exe" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($winget) { return $winget }
    return $null
}

$desktop = Find-DesktopExe
if (-not $desktop) {
    throw "Desktop client not found. Install from https://opencode.ai/download"
}

# --- Guard: port already in use ---
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $existingPid = $existing.OwningProcess
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }
    Write-Host "Port $port already in use by PID $existingPid ($procName)" -ForegroundColor Yellow
    Write-Host "Desktop sidecar may already be running. Skipping." -ForegroundColor Yellow
    exit 0
}

# --- Set env vars for the desktop process ---
# These are inherited by the sidecar via utilityProcess.fork().
# OPENCODE_SERVER_CORS restricts the sidecar's CORS allowlist to the funnel URL
# instead of wildcard; patch-opencode-desktop.ps1 makes the asar read this env var.
# We clear them in a finally block so they don't persist in the parent shell.
$env:OPENCODE_PORT = $port
$env:OPENCODE_SERVER_PASSWORD = $password
$env:OPENCODE_SERVER_CORS = $corsJson

Write-Host ""
Write-Host "OpenCode Desktop (Patched)" -ForegroundColor Green
Write-Host "  Sidecar port:  $port" -ForegroundColor Gray
$maskLen = [math]::Max(0, $password.Length - 4)
$masked = ('*' * $maskLen) + $password.Substring($maskLen)
Write-Host "  Password:      $masked" -ForegroundColor Gray
Write-Host "  DB:            ~/.local/share/opencode/opencode.db" -ForegroundColor Gray
Write-Host ""

try {
if ($Detached) {
    Start-Process -FilePath $desktop -WindowStyle Normal
    Write-Host "Desktop launched. Waiting for sidecar on port $port..." -ForegroundColor Green

    # Health check: wait up to 15s for the sidecar to bind the port
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($listening) { $ready = $true; break }
    }
    if ($ready) {
        Write-Host "  Sidecar ready on port $port." -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Port $port not yet listening after 15s. Sidecar may still be starting." -ForegroundColor Yellow
    }
} else {
    & $desktop
}
} finally {
    Remove-Item Env:\OPENCODE_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:\OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\OPENCODE_SERVER_CORS -ErrorAction SilentlyContinue
}
