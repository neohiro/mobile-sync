# start-opencode-server.ps1
# Starts a CLI opencode serve on port 4096 (fallback if desktop sidecar is not running).
# The patched desktop sidecar (start-opencode-desktop.ps1) is the primary server.
# Both share the same session database at ~/.local/share/opencode/opencode.db
#
# Usage:
#   .\start-opencode-server.ps1                          # Start server (foreground)
#   .\start-opencode-server.ps1 -Detached                # Start server in background
#   .\start-opencode-server.ps1 -Password "my-password"  # Use a fixed password

param(
    [switch]$Detached,
    [string]$Password
)

$ErrorActionPreference = 'Stop'

$port = 4096
$bindHost = '127.0.0.1'
$passwordFile = "$env:USERPROFILE\.opencode-server-password"

# --- Load saved funnel URL or detect from Tailscale ---
$funnelConfigFile = "$env:USERPROFILE\.opencode-funnel-url"
$funnelUrl = ''
if (Test-Path -LiteralPath $funnelConfigFile) {
    $funnelUrl = (Get-Content -LiteralPath $funnelConfigFile -Raw).Trim()
}
if (-not $funnelUrl) {
    $tsPath = "C:\Program Files\Tailscale\tailscale.exe"
    if (Test-Path $tsPath) {
        $tsJson = & $tsPath status --json 2>&1
        if ($LASTEXITCODE -eq 0) {
            try {
                $tsSelf = ($tsJson | ConvertFrom-Json).Self
                if ($tsSelf) {
                    $dnsName = $tsSelf.DNSName.TrimEnd('.')
                    $hostName = $tsSelf.HostName
                    $funnelUrl = "https://$dnsName"
                    [System.IO.File]::WriteAllText($funnelConfigFile, $funnelUrl)
                    Write-Host "Detected Tailscale Funnel URL: $funnelUrl (hostname: $hostName)" -ForegroundColor DarkGray
                }
            } catch { /* ConvertFrom-Json failed on malformed output */ }
        }
    }
}

# --- Guard: port already in use ---
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $existingPid = $existing.OwningProcess
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }
    Write-Host "Port $port already in use by PID $existingPid ($procName)" -ForegroundColor Yellow
    Write-Host "  If this is the desktop sidecar, it is already serving on port $port." -ForegroundColor Yellow
    Write-Host "  You do not need to start a separate CLI server." -ForegroundColor Yellow
    exit 0
}

# --- Guard: password file ---
$defaultPassword = 'NJYA0Uw1A7kePY8fv4BCftNH'
if ($Password) {
    # Use the explicitly provided password; persist it for next time
    [System.IO.File]::WriteAllText($passwordFile, $Password)
} elseif (-not (Test-Path -LiteralPath $passwordFile)) {
    Write-Host "Creating password file with default password: $passwordFile" -ForegroundColor Cyan
    [System.IO.File]::WriteAllText($passwordFile, $defaultPassword)
}
$password = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
if (-not $password) { throw "Password file is empty: $passwordFile" }

# --- Find opencode.exe ---
$exe = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\opencode.exe"
    (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\SST.opencode_*\opencode.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName)
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $exe) { throw "opencode.exe not found. Install via: winget install SST.opencode" }

# --- IMPORTANT: env vars are process-scoped only ---
# NEVER set OPENCODE_* globally in the registry - it bricks the desktop client.
$env:OPENCODE_SERVER_PASSWORD = $password

Write-Host ""
Write-Host "OpenCode Shared Server" -ForegroundColor Green
Write-Host "  Address:  ${bindHost}:${port}" -ForegroundColor Gray
Write-Host "  User:     opencode" -ForegroundColor Gray
$maskLen = [math]::Max(0, $password.Length - 4)
$masked = ('*' * $maskLen) + $password.Substring($maskLen)
Write-Host "  Password: $masked" -ForegroundColor Gray
if ($funnelUrl) {
    Write-Host "  Funnel:   $funnelUrl -> ${bindHost}:${port}" -ForegroundColor Cyan
} else {
    Write-Host "  Funnel:   not configured (run: tailscale funnel $port)" -ForegroundColor Yellow
}
Write-Host "  DB:       ~/.local/share/opencode/opencode.db" -ForegroundColor Gray
Write-Host ""
Write-Host "This is a fallback CLI server. The patched desktop sidecar" -ForegroundColor DarkGray
Write-Host "is the primary server on port 4096." -ForegroundColor DarkGray
Write-Host "  Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

if ($Detached) {
    $serveArgs = @("serve", "--hostname", $bindHost, "--port", $port)
    if ($funnelUrl) { $serveArgs += "--cors=$funnelUrl" }
    $proc = Start-Process -FilePath $exe -ArgumentList $serveArgs `
        -WindowStyle Hidden -PassThru
    Write-Host "Server started (PID $($proc.Id)). Waiting for port $port..." -ForegroundColor Green

    # Health check: wait up to 10s for the port to become available
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($listening) { $ready = $true; break }
    }
    if ($ready) {
        Write-Host "  Port $port is listening. Server ready." -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Port $port not yet listening after 10s. Server may still be starting." -ForegroundColor Yellow
    }
} else {
    if ($funnelUrl) {
        & $exe serve --hostname $bindHost --port $port --cors=$funnelUrl
    } else {
        & $exe serve --hostname $bindHost --port $port
    }
}
