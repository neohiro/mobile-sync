# setup-opencode-shared.ps1
# One-time setup for shared OpenCode server + desktop on Windows.
# Run this once per device to configure Tailscale Funnel, password, and auto-start.
# Each device is independently configured - Android connects to specific devices via their Funnel URL.
#
# Usage:
#   .\setup-opencode-shared.ps1                                # Interactive setup
#   .\setup-opencode-shared.ps1 -Quick                         # Skip prompts, use defaults
#   .\setup-opencode-shared.ps1 -Password "my-password"        # Use a fixed password
#   .\setup-opencode-shared.ps1 -Quick -Password "my-password" # Non-interactive with fixed password
#   .\setup-opencode-shared.ps1 -WhatIf                        # Dry run - show what would happen
#   .\setup-opencode-shared.ps1 -Patch                         # Also patch the desktop client's app.asar
#   .\setup-opencode-shared.ps1 -Quick -Patch                  # Full auto: setup + patch, no prompts
#   .\setup-opencode-shared.ps1 -Rotate                        # Generate new password and rotate

param(
    [switch]$Quick,
    [switch]$WhatIf,
    [switch]$Patch,
    [switch]$Rotate,
    [string]$Password
)

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
if ($WhatIf) {
    Write-Host " OpenCode Shared Server Setup (DRY RUN)" -ForegroundColor Yellow
} elseif ($Rotate) {
    Write-Host " OpenCode Password Rotation" -ForegroundColor Yellow
} else {
    Write-Host " OpenCode Shared Server Setup" -ForegroundColor Cyan
}
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Helper: execute or preview a step
function Invoke-Step {
    param([string]$Description, [scriptblock]$Action, [scriptblock]$Preview)
    if ($WhatIf) {
        if ($Preview) {
            Write-Host "  [DRY RUN] $Description" -ForegroundColor Yellow
            & $Preview
        } else {
            Write-Host "  [DRY RUN] $Description" -ForegroundColor Yellow
        }
    } else {
        & $Action
    }
}

# Helper: generate a random password
function New-SecurePassword {
    param([int]$Length = 24)
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] $Length
    $rng.GetBytes($bytes)
    $result = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    $rng.Dispose()
    return $result
}

# Helper: detect Tailscale hostname
function Get-TailscaleHostname {
    $tsPath = "C:\Program Files\Tailscale\tailscale.exe"
    if (-not (Test-Path $tsPath)) { return $null }
    try {
        $tsJson = & $tsPath status --json 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $tsSelf = ($tsJson | ConvertFrom-Json).Self
        if ($tsSelf) { return $tsSelf.HostName }
    } catch { }
    return $null
}

# Helper: detect Tailscale full DNS name (for Funnel URL)
function Get-TailscaleDnsName {
    $tsPath = "C:\Program Files\Tailscale\tailscale.exe"
    if (-not (Test-Path $tsPath)) { return $null }
    try {
        $tsJson = & $tsPath status --json 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $tsSelf = ($tsJson | ConvertFrom-Json).Self
        if ($tsSelf) { return $tsSelf.DNSName.TrimEnd('.') }
    } catch { }
    return $null
}

$tsPath = "C:\Program Files\Tailscale\tailscale.exe"
$passwordFile = "$env:USERPROFILE\.opencode-server-password"

# --- Step 1: Verify prerequisites ---
Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Yellow

# OpenCode CLI
$exe = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\opencode.exe"
    (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\SST.opencode_*\opencode.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName)
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $exe) {
    Invoke-Step "Install OpenCode CLI" -Action {
        Write-Host "  opencode.exe not found. Installing..." -ForegroundColor Yellow
        try {
            winget install SST.opencode --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "winget install failed with code $LASTEXITCODE" }
        } catch {
            Write-Host "  Failed to install OpenCode: $($_.Exception.Message)" -ForegroundColor Red
            throw
        }
        $exe = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\SST.opencode_*\opencode.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName)
        if (-not $exe) { throw "opencode.exe still not found after install" }
    } -Preview {
        Write-Host "    Would run: winget install SST.opencode" -ForegroundColor DarkGray
    }
}
Write-Host "  OpenCode: $exe" -ForegroundColor Green

# Desktop client
$desktopPath = "$env:LOCALAPPDATA\Programs\@opencode-aidesktop\OpenCode.exe"
if (Test-Path $desktopPath) {
    Write-Host "  Desktop:  $desktopPath" -ForegroundColor Green
} else {
    Write-Host "  Desktop:  NOT FOUND (install from https://opencode.ai)" -ForegroundColor Yellow
}

# Tailscale
if (Test-Path $tsPath) {
    $tsVersion = & $tsPath version 2>&1 | Select-Object -First 1
    Write-Host "  Tailscale: $tsVersion" -ForegroundColor Green
    $tsHostname = Get-TailscaleHostname
    if ($tsHostname) {
        Write-Host "  Device:    $tsHostname" -ForegroundColor Green
    }
    $tsDnsName = Get-TailscaleDnsName
    if ($tsDnsName) {
        Write-Host "  URL:       https://$tsDnsName" -ForegroundColor Green
    }
} else {
    Write-Host "  Tailscale: NOT FOUND" -ForegroundColor Yellow
    Write-Host "    Install from https://tailscale.com/download" -ForegroundColor Yellow
}

# --- Step 2: Setup password ---
Write-Host ""
Write-Host "[2/6] Setting up password..." -ForegroundColor Yellow

if ($Rotate) {
    # Password rotation mode
    $newPassword = New-SecurePassword
    $oldPassword = ''
    if (Test-Path -LiteralPath $passwordFile) {
        $oldPassword = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
    }
    Invoke-Step "Rotate password" -Action {
        [System.IO.File]::WriteAllText($passwordFile, $newPassword)
        Write-Host "  Password rotated." -ForegroundColor Green
        Write-Host "  Old: $('*' * ([math]::Max(0, $oldPassword.Length - 4)))" -ForegroundColor Gray
        Write-Host "  New: $newPassword" -ForegroundColor White
        Write-Host ""
        Write-Host "  Update all mobile app configs with the new password." -ForegroundColor Yellow
        Write-Host "  Run: .\show-connection.ps1 to see current connection details." -ForegroundColor Yellow
    } -Preview {
        Write-Host "    Would generate new 24-char random password" -ForegroundColor DarkGray
        Write-Host "    Would overwrite: $passwordFile" -ForegroundColor DarkGray
    }
    # Skip remaining steps in rotate mode
    Write-Host ""
    Write-Host "Password rotation complete." -ForegroundColor Green
    exit 0
}

$defaultPassword = 'NJYA0Uw1A7kePY8fv4BCftNH'
if ($Password) {
    Invoke-Step "Write password from parameter" -Action {
        [System.IO.File]::WriteAllText($passwordFile, $Password)
        Write-Host "  Password set from parameter." -ForegroundColor Green
    } -Preview {
        Write-Host "    Would write to: $passwordFile" -ForegroundColor DarkGray
        Write-Host "    Value: $('*' * ([math]::Max(0, $Password.Length - 4)))" -ForegroundColor DarkGray
    }
} elseif (Test-Path -LiteralPath $passwordFile) {
    Write-Host "  Password file exists: $passwordFile" -ForegroundColor Green
    if (-not $Quick -and -not $WhatIf) {
        $regen = Read-Host "  Regenerate password? (y/N)"
        if ($regen -eq 'y') {
            $newPw = New-SecurePassword
            Invoke-Step "Generate new random password" -Action {
                [System.IO.File]::WriteAllText($passwordFile, $newPw)
                Write-Host "  New password: $newPw" -ForegroundColor White
            } -Preview {
                Write-Host "    Would overwrite: $passwordFile with random password" -ForegroundColor DarkGray
            }
        }
    }
} else {
    Invoke-Step "Create password file" -Action {
        [System.IO.File]::WriteAllText($passwordFile, $defaultPassword)
        Write-Host "  Password file created: $passwordFile" -ForegroundColor Green
    } -Preview {
        Write-Host "    Would create: $passwordFile" -ForegroundColor DarkGray
        Write-Host "    Value: $defaultPassword" -ForegroundColor DarkGray
    }
}

if (Test-Path -LiteralPath $passwordFile) {
    $finalPw = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
    Write-Host "  Password: $finalPw" -ForegroundColor Gray
} else {
    $finalPw = ''
}

# --- Step 3: Setup Tailscale Funnel ---
Write-Host ""
Write-Host "[3/6] Configuring Tailscale Funnel..." -ForegroundColor Yellow

if (Test-Path $tsPath) {
    $tsStatus = & $tsPath status 2>&1
    if ($tsStatus -match "Logged out" -or $tsStatus -match "NeedsLogin") {
        Write-Host "  Tailscale not logged in. Run: tailscale up" -ForegroundColor Yellow
    } else {
        $funnelUrl = ''
        $tsDnsName = Get-TailscaleDnsName
        if ($tsDnsName) {
            $funnelUrl = "https://$tsDnsName"
        } else {
            try {
                $tsJson = & $tsPath status --json 2>&1
                if ($LASTEXITCODE -ne 0) { throw "tailscale status failed" }
                $tsSelf = ($tsJson | ConvertFrom-Json).Self
                if ($tsSelf) {
                    $tsDnsName = $tsSelf.DNSName.TrimEnd('.')
                    if ($tsDnsName) {
                        $funnelUrl = "https://$tsDnsName"
                    }
                }
            } catch {
                Write-Host "  Could not detect Tailscale DNS name: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }

        if ($funnelUrl) {
            $funnelStatus = & $tsPath funnel status 2>&1
            if ($funnelStatus -match "4096") {
                Write-Host "  Funnel already configured: $funnelUrl -> 127.0.0.1:4096" -ForegroundColor Green
            } else {
                Invoke-Step "Configure Tailscale Funnel" -Action {
                    Write-Host "  Setting up Funnel: $funnelUrl -> 127.0.0.1:4096" -ForegroundColor Cyan
                    & $tsPath funnel 4096 2>&1
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "  Funnel setup failed. Run manually: tailscale funnel 4096" -ForegroundColor Yellow
                    } else {
                        Write-Host "  Funnel configured." -ForegroundColor Green
                    }
                } -Preview {
                    Write-Host "    Would run: tailscale funnel 4096" -ForegroundColor DarkGray
                    Write-Host "    Target: $funnelUrl -> 127.0.0.1:4096" -ForegroundColor DarkGray
                }
            }

            Invoke-Step "Save funnel URL" -Action {
                $configFile = "$env:USERPROFILE\.opencode-funnel-url"
                [System.IO.File]::WriteAllText($configFile, $funnelUrl)
                Write-Host "  Saved funnel URL: $configFile" -ForegroundColor Gray
            } -Preview {
                Write-Host "    Would write to: $env:USERPROFILE\.opencode-funnel-url" -ForegroundColor DarkGray
                Write-Host "    Value: $funnelUrl" -ForegroundColor DarkGray
            }
        }
    }
} else {
    Write-Host "  Tailscale not installed. Skipping funnel setup." -ForegroundColor Yellow
}

# --- Step 4: Verify database ---
Write-Host ""
Write-Host "[4/6] Checking session database..." -ForegroundColor Yellow

$dbPath = "$env:USERPROFILE\.local\share\opencode\opencode.db"
if (Test-Path $dbPath) {
    $dbSize = [math]::Round((Get-Item $dbPath).Length / 1MB, 1)
    Write-Host "  Database: $dbPath ($dbSize MB)" -ForegroundColor Green
    $sessions = & $exe session list 2>&1
    $sessionLines = @($sessions | Where-Object { $_ -match '^ses_' })
    Write-Host "  Sessions: $($sessionLines.Count)" -ForegroundColor Green
} else {
    Write-Host "  Database not found at $dbPath" -ForegroundColor Yellow
    Write-Host "  It will be created when you first run opencode." -ForegroundColor Yellow
}

# --- Step 5: Create scheduled task (optional) ---
Write-Host ""
Write-Host "[5/6] Auto-start configuration..." -ForegroundColor Yellow

if (-not $Quick) {
    $autoStart = Read-Host "  Start server automatically on login? (Y/n)"
} else {
    $autoStart = 'y'
}

if ($autoStart -ne 'n') {
    $taskName = "OpenCode Shared Server"
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Write-Host "  Scheduled task already exists." -ForegroundColor Green
    } else {
        $serverScript = "$PSScriptRoot\start-opencode-server.ps1"
        if (Test-Path $serverScript) {
            Invoke-Step "Create scheduled task" -Action {
                $action = New-ScheduledTaskAction -Execute "powershell.exe" `
                    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serverScript`""
                $trigger = New-ScheduledTaskTrigger -AtLogon
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)

                Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
                    -Settings $settings -Description "OpenCode shared server for Tailscale Funnel" | Out-Null
                Write-Host "  Scheduled task created: $taskName" -ForegroundColor Green
            } -Preview {
                Write-Host "    Task name: $taskName" -ForegroundColor DarkGray
                Write-Host "    Trigger: AtLogon" -ForegroundColor DarkGray
                Write-Host "    Action: powershell.exe -File `"$serverScript`"" -ForegroundColor DarkGray
            }
        } else {
            Write-Host "  Server script not found: $serverScript" -ForegroundColor Yellow
        }
    }
}

# --- Step 6: Patch desktop client (optional) ---
Write-Host ""
Write-Host "[6/6] Desktop client patching..." -ForegroundColor Yellow

$patchScript = "$PSScriptRoot\patch-opencode-desktop.ps1"
if (Test-Path $desktopPath) {
    if ($Patch) {
        if (Test-Path $patchScript) {
            Invoke-Step "Patch desktop app.asar (password + CORS)" -Action {
                & $patchScript
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "  Patch failed. You can retry with: .\patch-opencode-desktop.ps1" -ForegroundColor Red
                }
            } -Preview {
                Write-Host "    Would run: $patchScript" -ForegroundColor DarkGray
                Write-Host "    Patches: password fallback + CORS wildcard" -ForegroundColor DarkGray
            }
        } else {
            Write-Host "  Patch script not found: $patchScript" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  Desktop found. Use -Patch to patch app.asar for shared server support." -ForegroundColor Gray
        Write-Host "  Without the patch, the sidecar uses a random password each launch." -ForegroundColor Gray
    }
} else {
    Write-Host "  Desktop not installed. Skipping patch." -ForegroundColor Gray
}

# --- Done ---
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
if ($WhatIf) {
    Write-Host " Dry Run Complete" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "No changes were made. Run without -WhatIf to apply." -ForegroundColor Gray
} else {
    Write-Host " Setup Complete!" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    # Show this device's connection details
    if ($tsHostname) {
        $url = if ($tsDnsName) { "https://$tsDnsName" } else { "https://$tsHostname" }
        Write-Host "This device: $tsHostname" -ForegroundColor Green
        Write-Host ""
        Write-Host "Mobile app connection for THIS device:" -ForegroundColor White
        Write-Host "  URL:      $url" -ForegroundColor Gray
        Write-Host "  User:     opencode" -ForegroundColor Gray
        if ($finalPw) {
            Write-Host "  Password: $finalPw" -ForegroundColor Gray
        } else {
            Write-Host "  Password: (not set)" -ForegroundColor Yellow
        }
        Write-Host ""
    }

    Write-Host "To start everything:" -ForegroundColor White
    Write-Host "  1. .\start-opencode-desktop.ps1  (patched desktop + sidecar on port 4096)" -ForegroundColor Gray
    Write-Host "  2. Or: .\start-opencode-server.ps1  (CLI server fallback)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Multi-device commands:" -ForegroundColor White
    Write-Host "  .\show-connection.ps1              # Show this device's mobile connection info" -ForegroundColor Gray
    Write-Host "  .\show-connection.ps1 -Register    # Register this device in shared registry" -ForegroundColor Gray
    Write-Host "  .\show-connection.ps1 -AllDevices  # List all registered devices" -ForegroundColor Gray
    Write-Host "  .\show-connection.ps1 -QR          # QR-code-friendly output" -ForegroundColor Gray
    Write-Host ""
    if ($Patch) {
        Write-Host "Auto-repatch after desktop updates:" -ForegroundColor White
        Write-Host "  .\watch-opencode-desktop.ps1 -Detached    # Run watcher in background" -ForegroundColor Gray
        Write-Host "  .\watch-opencode-desktop.ps1 -Stop        # Stop the background watcher" -ForegroundColor Gray
        Write-Host ""
    }
    Write-Host "Password management:" -ForegroundColor White
    Write-Host "  .\setup-opencode-shared.ps1 -Rotate       # Generate new random password" -ForegroundColor Gray
    Write-Host ""
}
