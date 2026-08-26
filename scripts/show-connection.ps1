# show-connection.ps1
# Shows this device's connection details for the OpenCode mobile app.
# Each device (server) has its own Tailscale hostname - the mobile app
# connects to a specific device via its Funnel URL.
#
# Usage:
#   .\show-connection.ps1              # Show connection details
#   .\show-connection.ps1 -AllDevices  # Show all devices from registry
#   .\show-connection.ps1 -Register    # Register this device in shared registry
#   .\show-connection.ps1 -QR          # Output QR-code-friendly plain text

param(
    [switch]$AllDevices,
    [switch]$Register,
    [switch]$QR
)

$ErrorActionPreference = 'Stop'

$passwordFile = "$env:USERPROFILE\.opencode-server-password"
$deviceRegistry = "$env:USERPROFILE\.opencode-devices.json"

# --- Find Tailscale executable (PATH-first, then default install path) ---
function Resolve-Tailscale {
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Path }
    $default = "C:\Program Files\Tailscale\tailscale.exe"
    if (Test-Path -LiteralPath $default) { return $default }
    return $null
}

# --- Detect this device's Tailscale hostname ---
function Get-TailscaleHostname {
    $tsPath = Resolve-Tailscale
    if (-not $tsPath) { return $null }
    try {
        $tsJson = & $tsPath status --json 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $tsSelf = ($tsJson | ConvertFrom-Json).Self
        if ($tsSelf) { return $tsSelf.HostName }
    } catch { }
    return $null
}

# --- Detect this device's Tailscale full DNS name (for Funnel URL) ---
function Get-TailscaleDnsName {
    $tsPath = Resolve-Tailscale
    if (-not $tsPath) { return $null }
    try {
        $tsJson = & $tsPath status --json 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $tsSelf = ($tsJson | ConvertFrom-Json).Self
        if ($tsSelf) { return $tsSelf.DNSName.TrimEnd('.') }
    } catch { }
    return $null
}

# --- Detect this device's name ---
function Get-DeviceName {
    # Try saved name first
    $nameFile = "$env:USERPROFILE\.opencode-device-name"
    if (Test-Path -LiteralPath $nameFile) {
        return (Get-Content -LiteralPath $nameFile -Raw).Trim()
    }
    # Fall back to Tailscale hostname or computer name
    $hostname = Get-TailscaleHostname
    if ($hostname) { return $hostname }
    return $env:COMPUTERNAME
}

# --- Show all registered devices ---
if ($AllDevices) {
    Write-Host ""
    Write-Host "Registered OpenCode Devices" -ForegroundColor Cyan
    Write-Host "===========================" -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $deviceRegistry)) {
        Write-Host "No devices registered. Run .\show-connection.ps1 -Register on each device." -ForegroundColor Yellow
        exit 0
    }

    $raw = Get-Content -LiteralPath $deviceRegistry -Raw | ConvertFrom-Json
    # Normalize to array (handles legacy single-object format and PSCollection wrapper)
    $devices = @($raw)
    if ($devices.Count -eq 0) {
        Write-Host "No devices registered." -ForegroundColor Yellow
        exit 0
    }

    foreach ($device in $devices) {
        if (-not $device.Hostname) { continue }  # skip non-device entries
        $lastSeen = if ($device.LastSeen) { $device.LastSeen } else { "unknown" }
        $pwLen = if ($device.Password) { $device.Password.Length } else { 0 }
        Write-Host ""
        Write-Host "  $($device.Name)" -ForegroundColor Green
        Write-Host "    URL:      $($device.URL)" -ForegroundColor Gray
        Write-Host "    User:     opencode" -ForegroundColor Gray
        Write-Host "    Password: $('*' * [math]::Max(0, $pwLen - 4))" -ForegroundColor Gray
        Write-Host "    Last seen: $lastSeen" -ForegroundColor DarkGray
    }
    Write-Host ""
    exit 0
}

# --- Register this device ---
if ($Register) {
    $hostname = Get-TailscaleHostname
    if (-not $hostname) {
        throw "Tailscale not found or not logged in. Cannot register device."
    }
    $dnsName = Get-TailscaleDnsName
    $deviceName = Get-DeviceName
    $password = ''
    if (Test-Path -LiteralPath $passwordFile) {
        $password = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
    }
    if (-not $password) {
        throw "Password file not found: $passwordFile`nRun setup first: .\setup-opencode-shared.ps1"
    }

    $url = if ($dnsName) { "https://$dnsName" } else { "https://$hostname" }
    $entry = [PSCustomObject]@{
        Name     = $deviceName
        URL      = $url
        Hostname = $hostname
        DNSName  = $dnsName
        Password = $password
        LastSeen = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    }

    # Load existing registry or create new (use ArrayList to avoid += wrapping)
    $devices = [System.Collections.ArrayList]::new()
    if (Test-Path -LiteralPath $deviceRegistry) {
        try {
            foreach ($d in (Get-Content -LiteralPath $deviceRegistry -Raw | ConvertFrom-Json | Where-Object { $_.Hostname })) {
                [void]$devices.Add($d)
            }
        } catch {
            $devices = [System.Collections.ArrayList]::new()
        }
    }

    # Update existing entry or add new
    $existing = $devices | Where-Object { $_.Hostname -eq $hostname }
    if ($existing) {
        $newDevices = [System.Collections.ArrayList]::new()
        foreach ($d in $devices) {
            if ($d.Hostname -eq $hostname) { [void]$newDevices.Add($entry) }
            else { [void]$newDevices.Add($d) }
        }
        $devices = $newDevices
        Write-Host "Updated device: $deviceName ($url)" -ForegroundColor Green
    } else {
        [void]$devices.Add($entry)
        Write-Host "Registered device: $deviceName ($url)" -ForegroundColor Green
    }

    # Save registry — use .NET to write without BOM (PS5.1 Set-Content/Out-File add BOM)
    $jsonContent = ConvertTo-Json -InputObject $devices -Depth 4
    [System.IO.File]::WriteAllText($deviceRegistry, $jsonContent, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Registry saved to: $deviceRegistry" -ForegroundColor Gray
    exit 0
}

# --- Load password for both directory detection and display ---
$password = ''
if (Test-Path -LiteralPath $passwordFile) {
    $password = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
}

# --- Detect server's current directory ---
# Query the running server for its active directory (from /api/provider).
# The CLI server defaults to the directory it was started from (global project).
# The mobile app needs this to filter sessions to the right project.
$serverDir = $null
if ($password) {
    try {
        $basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:$password"))
        $headers = @{ "Authorization" = "Basic $basicAuth" }
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:4096/api/provider" -Headers $headers -TimeoutSec 3
        $serverDir = $resp.location.directory
    } catch { }
}

# --- Default: show this device's connection ---
$hostname = Get-TailscaleHostname
$dnsName = Get-TailscaleDnsName
$deviceName = Get-DeviceName

if (-not $hostname) {
    Write-Host ""
    Write-Host "Tailscale not detected. Showing local-only info." -ForegroundColor Yellow
    $url = "http://127.0.0.1:4096"
} else {
    $url = if ($dnsName) { "https://$dnsName" } else { "https://$hostname" }
}

Write-Host ""
Write-Host "OpenCode Mobile Connection - $deviceName" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  URL:      $url" -ForegroundColor White
Write-Host "  User:     opencode" -ForegroundColor White
if ($password) {
    Write-Host "  Password: $password" -ForegroundColor White
} else {
    Write-Host "  Password: (not configured - run setup first)" -ForegroundColor Yellow
}
if ($serverDir) {
    Write-Host "  Directory: $serverDir" -ForegroundColor Cyan
} else {
    Write-Host "  Directory: (server not running or unreachable)" -ForegroundColor Yellow
}
Write-Host ""

if ($QR) {
    Write-Host "QR-code-friendly (copy into QR generator):" -ForegroundColor Gray
    Write-Host ""
    if ($serverDir) {
        Write-Host "opencode|$url|opencode|$password|$serverDir" -ForegroundColor White
    } else {
        Write-Host "opencode|$url|opencode|$password" -ForegroundColor White
    }
    Write-Host ""
}

if ($hostname) {
    # Check if this device is registered
    $registered = $false
    if (Test-Path -LiteralPath $deviceRegistry) {
        try {
            $devices = @(Get-Content -LiteralPath $deviceRegistry -Raw | ConvertFrom-Json | Where-Object { $_.Hostname })
            $registered = [bool]($devices | Where-Object { $_.Hostname -eq $hostname })
        } catch { }
    }

    if (-not $registered) {
        Write-Host "This device is not registered. To track all your devices:" -ForegroundColor Gray
        Write-Host "  .\show-connection.ps1 -Register" -ForegroundColor Gray
        Write-Host "  .\show-connection.ps1 -AllDevices" -ForegroundColor Gray
    }

    # Check funnel status
    $tsPath = Resolve-Tailscale
    if ($tsPath) {
        $funnelStatus = & $tsPath funnel status 2>&1
        if ($funnelStatus -match "4096") {
            Write-Host ""
            Write-Host "  Funnel: ACTIVE ($url -> 127.0.0.1:4096)" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "  Funnel: NOT CONFIGURED" -ForegroundColor Yellow
            Write-Host "  Run: tailscale funnel 4096" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Mobile app will only work on the local network." -ForegroundColor Yellow
    Write-Host "Install Tailscale for remote access: https://tailscale.com/download" -ForegroundColor Yellow
}
Write-Host ""
