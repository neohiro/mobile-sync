# watch-opencode-server.ps1
# Watchdog: ensures the OpenCode CLI server stays running.
# - Checks port 4096 every 60 seconds.
# - If port is not listening AND opencode.exe is not running, starts the server.
# - If opencode.exe is running but port is not bound, kills it and restarts cleanly.
# - Self-spawns in a detached loop so it survives the parent shell exit.
# - Writes its PID to a file so the scheduled task can detect prior instances.

param(
    [int]$Port = 4096,
    [int]$IntervalSeconds = 60,
    [string]$ServerScript = "$PSScriptRoot\start-opencode-server.ps1"
)

$ErrorActionPreference = 'Stop'

$pidFile = "$env:USERPROFILE\.opencode-server-watchdog.pid"

# --- Single-instance guard ---
if (Test-Path -LiteralPath $pidFile) {
    $oldPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        # An older watchdog is still running. Exit quietly.
        exit 0
    }
    # Stale PID file — clean it up.
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

[System.IO.File]::WriteAllText($pidFile, $PID)

# --- Start the server if not running ---
function Start-ServerIfDown {
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listening) { return $true }

    # If opencode.exe is running but port is not bound, kill it so a clean restart can bind.
    $stuckProcs = Get-Process -Name "opencode" -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -notmatch '\\OpenCode\.exe$'  # CLI server binary, not the desktop GUI
    }
    foreach ($p in $stuckProcs) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {}
    }

    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ServerScript -Detached
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

# --- Self-detach: relaunch this script with -BackgroundLoop and exit ---
# Running as a non-blocking background process keeps it alive past the
# triggering shell (Task Scheduler, logon, etc.).
$loopFlag = $args -contains '-BackgroundLoop'
if (-not $loopFlag) {
    $selfArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-BackgroundLoop')
    Start-Process -FilePath "powershell.exe" -ArgumentList $selfArgs -WindowStyle Hidden | Out-Null
    exit 0
}

# --- Main loop (background) ---
$firstCheck = $true
while ($true) {
    $ok = Start-ServerIfDown
    if (-not $ok -and $firstCheck) {
        # Only log the first failure to avoid flooding the Application log.
        Write-EventLog -LogName Application -Source "PowerShell" -EventId 1000 `
            -EntryType Warning -Message "OpenCode server failed to start on port $Port" `
            -ErrorAction SilentlyContinue
    }
    $firstCheck = $false
    Start-Sleep -Seconds $IntervalSeconds
}
