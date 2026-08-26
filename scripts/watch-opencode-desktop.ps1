# watch-opencode-desktop.ps1
# Watches the OpenCode desktop app.asar for changes (e.g. after an update)
# and automatically re-applies the shared server patches.
#
# Run in background or as a scheduled task. Monitors every N seconds.
# When app.asar is modified AND patches are lost, re-applies them automatically.
#
# Usage:
#   .\watch-opencode-desktop.ps1                      # Run until Ctrl+C
#   .\watch-opencode-desktop.ps1 -IntervalSeconds 30 # Check every 30s
#   .\watch-opencode-desktop.ps1 -Detached            # Run in background
#   .\watch-opencode-desktop.ps1 -Stop                # Stop a running background watcher

param(
    [ValidateRange(10, 3600)]
    [int]$IntervalSeconds = 60,
    [switch]$Detached,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$pidFile = "$env:TEMP\opencode-watcher.pid"
$tempDir = "$env:TEMP\opencode-asar-watch"
$patchScript = Join-Path $PSScriptRoot "patch-opencode-desktop.ps1"

# --- Stop mode: kill a running background watcher ---
if ($Stop) {
    if (-not (Test-Path -LiteralPath $pidFile)) {
        Write-Host "No watcher PID file found. Watcher may not be running." -ForegroundColor Yellow
        exit 0
    }
    $watcherPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $proc = Get-Process -Id $watcherPid -ErrorAction SilentlyContinue
    if ($proc) {
        Stop-Process -Id $watcherPid -Force -ErrorAction SilentlyContinue
        Write-Host "Watcher (PID $watcherPid) stopped." -ForegroundColor Green
    } else {
        Write-Host "Watcher (PID $watcherPid) was not running." -ForegroundColor Yellow
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

if (-not (Test-Path -LiteralPath $patchScript)) {
    throw "patch-opencode-desktop.ps1 not found in: $PSScriptRoot"
}

# --- Discover app.asar path ---
function Find-DesktopAsar {
    $standard = "$env:LOCALAPPDATA\Programs\@opencode-aidesktop\resources\app.asar"
    if (Test-Path -LiteralPath $standard) { return $standard }
    $scoop = "$env:USERPROFILE\scoop\apps\opencode-desktop\current\resources\app.asar"
    if (Test-Path -LiteralPath $scoop) { return $scoop }
    $searchRoots = @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}")
    foreach ($root in $searchRoots) {
        $found = Get-ChildItem -Path $root -Filter "app.asar" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.DirectoryName -match '@opencode-aidesktop' } |
            Select-Object -First 1 -ExpandProperty FullName
        if ($found) { return $found }
    }
    $winget = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*opencode*" -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "resources\app.asar" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($winget) { return $winget }
    return $null
}

$asarPath = Find-DesktopAsar
if (-not $asarPath) {
    throw "OpenCode Desktop not found."
}

# --- Discover Python ---
$python = $null
$pyCandidates = @("python", "python3",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe")
foreach ($c in $pyCandidates) {
    try { $null = & $c --version 2>&1; $python = $c; break } catch { }
}
if (-not $python) {
    throw "Python not found. Required for asar extraction.`nInstall from https://www.python.org/downloads/"
}

# --- If detached, re-launch ourselves hidden and exit ---
if ($Detached) {
    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`"" `
        -WindowStyle Hidden -PassThru
    Write-Host "Watcher started in background (PID $($proc.Id))." -ForegroundColor Green
    Set-Content $pidFile $proc.Id -Encoding Ascii
    Write-Host "PID saved to: $pidFile"
    Write-Host "Stop with: .\watch-opencode-desktop.ps1 -Stop" -ForegroundColor Gray
    exit 0
}

# --- Patch markers ---
$patchedPasswordStr = 'process.env.OPENCODE_SERVER_PASSWORD || randomUUID()'
$patchedCorsStr = 'cors: ["*"]'

# Write PID file even in foreground mode (for -Stop compatibility)
Set-Content $pidFile $PID -Encoding Ascii

try {
    # --- Main loop ---
    Write-Host ""
    Write-Host "OpenCode Desktop Watcher" -ForegroundColor Cyan
    Write-Host "  Monitoring: $asarPath" -ForegroundColor Gray
    Write-Host "  Interval:   ${IntervalSeconds}s" -ForegroundColor Gray
    Write-Host "  Patch:      $patchScript" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Gray
    Write-Host ""

    $lastWriteTime = (Get-Item -LiteralPath $asarPath).LastWriteTimeUtc
    $lastSize = (Get-Item -LiteralPath $asarPath).Length
    $checkCount = 0
    $patchCount = 0

    while ($true) {
        Start-Sleep -Seconds $IntervalSeconds
        $checkCount++

        $current = Get-Item -LiteralPath $asarPath -ErrorAction SilentlyContinue
        if (-not $current) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] app.asar not found. Waiting..." -ForegroundColor Yellow
            continue
        }

        $changed = ($current.LastWriteTimeUtc -ne $lastWriteTime) -or ($current.Length -ne $lastSize)

        if ($changed) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] app.asar changed. Checking patches..." -ForegroundColor Yellow

            if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

            $src = $asarPath -replace '\\','/'
            $dst = $tempDir -replace '\\','/'
            & $python -c "import asar; asar.extract_archive(__import__('pathlib').Path(r'$src'), __import__('pathlib').Path(r'$dst'))" 2>&1 | Out-Null
            $extractFailed = ($LASTEXITCODE -ne 0)

            $needsPatch = $false
            if ($extractFailed) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Failed to extract asar. Will retry next cycle." -ForegroundColor Red
                $needsPatch = $true
            } else {
                $indexJs = Join-Path $tempDir "out\main\index.js"
                $sidecarJs = Join-Path $tempDir "out\main\sidecar.js"
                if (Test-Path $indexJs) {
                    $content = Get-Content $indexJs -Raw
                    $sidecar = if (Test-Path $sidecarJs) { Get-Content $sidecarJs -Raw } else { "" }
                    $pwOk = $content.Contains($patchedPasswordStr)
                    $corsOk = $sidecar.Contains($patchedCorsStr)
                    $needsPatch = -not ($pwOk -and $corsOk)
                } else {
                    $needsPatch = $true
                }
            }

            Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

            if ($needsPatch) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Patches lost! Re-applying..." -ForegroundColor Yellow
                try {
                    & $patchScript -Force
                    $patchCount++
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Re-patch #$patchCount complete." -ForegroundColor Green
                } catch {
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Re-patch FAILED: $($_.Exception.Message)" -ForegroundColor Red
                }
            } else {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Patches still intact after update." -ForegroundColor Green
            }

            $lastWriteTime = $current.LastWriteTimeUtc
            $lastSize = $current.Length
        }

        # Periodic heartbeat (every 10 checks)
        if ($checkCount % 10 -eq 0) {
            $mb = [math]::Round($current.Length / 1MB, 1)
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Watching... (checks: $checkCount, re-patches: $patchCount, size: ${mb}MB)" -ForegroundColor DarkGray
        }
    }
} finally {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Watcher stopped. PID file and temp dir cleaned up." -ForegroundColor Gray
}
