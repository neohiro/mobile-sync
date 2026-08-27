# run-opencode-server-loop.ps1
# Persistent CLI server supervisor. Restarts the server in a tight loop on
# any exit, with exponential backoff capped at 30s. This is what the
# scheduled task should run — it never returns, so the task's "Restart on
# failure" never fires (the task IS succeeding forever by design).
#
# Bound to: Task Scheduler -> OpenCode Server (Logon trigger, user context)

$ErrorActionPreference = 'Continue'
$serverScript = Join-Path $PSScriptRoot "start-opencode-server.ps1"

if (-not (Test-Path -LiteralPath $serverScript)) {
    Write-EventLog -LogName Application -Source "PowerShell" -EventId 1001 `
        -EntryType Error -Message "Cannot find $serverScript" -ErrorAction SilentlyContinue
    exit 1
}

$backoffMs = 1000
$maxBackoffMs = 30_000

while ($true) {
    # Run the server (foreground mode = blocks until exit).
    # Any non-zero exit is treated as a crash; zero is treated as user-requested stop.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $serverScript 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        # Graceful exit. Wait a moment, then check if port is up (might be a
        # different server is now bound) before deciding to restart.
        Start-Sleep -Seconds 2
        $listening = Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue
        if ($listening) {
            # Another server is now serving. Stay out of the way.
            Start-Sleep -Seconds 5
            continue
        }
    }

    # Crash or unexpected exit. Back off, then retry.
    Write-EventLog -LogName Application -Source "PowerShell" -EventId 1002 `
        -EntryType Warning -Message "OpenCode server exited (code $code), restarting in $backoffMs ms" `
        -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds $backoffMs
    $backoffMs = [Math]::Min($backoffMs * 2, $maxBackoffMs)
}
