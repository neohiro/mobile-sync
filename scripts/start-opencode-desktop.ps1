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
$defaultPassword = 'NJYA0Uw1A7kePY8fv4BCftNH'

# --- Load password from file (matches start-opencode-server.ps1 behavior) ---
if (Test-Path -LiteralPath $passwordFile) {
    $password = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
} else {
    $password = $defaultPassword
}
if (-not $password) { $password = $defaultPassword }

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
# These are inherited by the sidecar via utilityProcess.fork()
$env:OPENCODE_PORT = $port
$env:OPENCODE_SERVER_PASSWORD = $password

Write-Host ""
Write-Host "OpenCode Desktop (Patched)" -ForegroundColor Green
Write-Host "  Sidecar port:  $port" -ForegroundColor Gray
Write-Host "  Password:      $('*' * ([math]::Max(0, $password.Length - 4)))" -ForegroundColor Gray
Write-Host "  DB:            ~/.local/share/opencode/opencode.db" -ForegroundColor Gray
Write-Host ""

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
