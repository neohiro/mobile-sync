# patch-opencode-desktop.ps1
# Patches the OpenCode desktop client's app.asar for shared server support.
# Patches two lines in out/main/index.js:
#   1. Password: accepts OPENCODE_SERVER_PASSWORD env var (was always randomUUID())
#   2. CORS: allows all origins for Tailscale Funnel connections (was only "oc://renderer")
#
# Usage:
#   .\patch-opencode-desktop.ps1            # Patch if needed (idempotent)
#   .\patch-opencode-desktop.ps1 -Force     # Re-patch even if already patched
#   .\patch-opencode-desktop.ps1 -Verify    # Verify patch status without modifying
#   .\patch-opencode-desktop.ps1 -Restore   # Restore original app.asar from backup

param(
    [switch]$Force,
    [switch]$Verify,
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'

# --- Discover desktop install path dynamically ---
function Find-DesktopAsar {
    # Standard install location
    $standard = "$env:LOCALAPPDATA\Programs\@opencode-aidesktop\resources\app.asar"
    if (Test-Path -LiteralPath $standard) { return $standard }

    # Scoop install location
    $scoop = "$env:USERPROFILE\scoop\apps\opencode-desktop\current\resources\app.asar"
    if (Test-Path -LiteralPath $scoop) { return $scoop }

    # Search common Program Files locations
    $searchRoots = @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}")
    foreach ($root in $searchRoots) {
        $found = Get-ChildItem -Path $root -Filter "app.asar" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.DirectoryName -match '@opencode-aidesktop' } |
            Select-Object -First 1 -ExpandProperty FullName
        if ($found) { return $found }
    }

    # WinGet package path
    $winget = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*opencode*" -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "resources\app.asar" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($winget) { return $winget }

    return $null
}

$asarPath = Find-DesktopAsar
if (-not $asarPath) {
    throw "OpenCode Desktop not found. Searched: standard, Scoop, Program Files, WinGet paths.`nInstall from https://opencode.ai/download"
}
$bakPath = "$asarPath.bak"
$tempDir = "$env:TEMP\opencode-asar-patch"

# Strings that indicate the patch is applied
$patchedPasswordStr = 'process.env.OPENCODE_SERVER_PASSWORD || randomUUID()'
$originalPasswordStr = 'randomUUID()'
# SECURITY: read CORS origins from OPENCODE_SERVER_CORS env var rather than
# hardcoding ["*"]. The mobile-sync plugin (start-opencode-desktop.ps1) sets
# this env var to ["oc://renderer","https://<funnel>"] so the sidecar is
# never exposed to wildcard origins. Default fallback is ["*"] only for
# first-run compatibility before the plugin has loaded.
$patchedCorsStr = "cors: JSON.parse(process.env.OPENCODE_SERVER_CORS || '[""*""]')"
$originalCorsStr = 'cors: ["oc://renderer"]'

# --- Verify Python ---
$python = $null
$candidates = @(
    "python"
    "python3"
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe"
    "$env:ProgramFiles\Python312\python.exe"
)
foreach ($c in $candidates) {
    try {
        $null = & $c --version 2>&1
        $python = $c
        break
    } catch { }
}
if (-not $python) {
    throw "Python not found. Required for asar extraction/repack.`nInstall from https://www.python.org/downloads/"
}

Write-Host "app.asar: $asarPath" -ForegroundColor Gray

# --- Helper: extract asar ---
function Expand-Asar {
    if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $src = $asarPath -replace '\\','/'
    $dst = $tempDir -replace '\\','/'
    & $python -c "import asar; asar.extract_archive(__import__('pathlib').Path(r'$src'), __import__('pathlib').Path(r'$dst'))" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract app.asar" }
}

# --- Helper: repack asar ---
function Compress-Asar {
    $src = $tempDir -replace '\\','/'
    $dst = $asarPath -replace '\\','/'
    & $python -c "import asar; asar.create_archive(__import__('pathlib').Path(r'$src'), __import__('pathlib').Path(r'$dst'))" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to repack app.asar" }
}

# --- Helper: check if patch is applied ---
function Test-Patched {
    $indexJs = Join-Path $tempDir "out\main\index.js"
    $sidecarJs = Join-Path $tempDir "out\main\sidecar.js"
    if (-not (Test-Path $indexJs)) { return $false }
    $content = Get-Content $indexJs -Raw
    $hasPasswordPatch = $content.Contains($patchedPasswordStr)
    if (-not (Test-Path $sidecarJs)) { return $false }
    $sidecar = Get-Content $sidecarJs -Raw
    $hasCorsPatch = $sidecar.Contains($patchedCorsStr)
    return ($hasPasswordPatch -and $hasCorsPatch)
}

# --- Helper: write file without BOM (PS5.1 Set-Content adds BOM by default) ---
function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

# --- Helper: apply patches ---
function Set-Patches {
    $indexJs = Join-Path $tempDir "out\main\index.js"
    $sidecarJs = Join-Path $tempDir "out\main\sidecar.js"

    # Patch 1: password fallback
    $content = Get-Content $indexJs -Raw
    if ($content.Contains($patchedPasswordStr)) {
        Write-Host "  Password patch already applied." -ForegroundColor Gray
    } elseif ($content.Contains("const password = $originalPasswordStr")) {
        $content = $content.Replace("const password = $originalPasswordStr", "const password = $patchedPasswordStr")
        Write-Utf8NoBom $indexJs $content
        Write-Host "  Password patch applied." -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Could not find password line to patch." -ForegroundColor Yellow
    }

    # Patch 2: CORS
    $sidecar = Get-Content $sidecarJs -Raw
    if ($sidecar.Contains($patchedCorsStr)) {
        Write-Host "  CORS patch already applied." -ForegroundColor Gray
    } elseif ($sidecar.Contains($originalCorsStr)) {
        $sidecar = $sidecar.Replace($originalCorsStr, $patchedCorsStr)
        Write-Utf8NoBom $sidecarJs $sidecar
        Write-Host "  CORS patch applied." -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Could not find CORS line to patch." -ForegroundColor Yellow
    }
}

# --- Restore mode ---
if ($Restore) {
    if (-not (Test-Path -LiteralPath $bakPath)) {
        throw "No backup found at: $bakPath"
    }
    $bakSize = (Get-Item -LiteralPath $bakPath).Length
    if ($bakSize -lt 10MB) {
        throw "Backup suspiciously small (${bakSize} bytes). Expected ~143MB. Not restoring to avoid bricking."
    }
    Copy-Item $bakPath $asarPath -Force
    Write-Host "Restored original app.asar from backup." -ForegroundColor Green
    $hash = (Get-FileHash $asarPath -Algorithm MD5).Hash
    Write-Host "  MD5: $hash" -ForegroundColor Gray
    exit 0
}

# --- Verify mode ---
if ($Verify) {
    Expand-Asar
    if (Test-Patched) {
        Write-Host "app.asar is PATCHED (password + CORS)." -ForegroundColor Green
    } else {
        $indexJs = Join-Path $tempDir "out\main\index.js"
        $sidecarJs = Join-Path $tempDir "out\main\sidecar.js"
        $content = Get-Content $indexJs -Raw
        $sidecar = Get-Content $sidecarJs -Raw
        $pw = if ($content.Contains($patchedPasswordStr)) { "YES" } else { "NO" }
        $cors = if ($sidecar.Contains($patchedCorsStr)) { "YES" } else { "NO" }
        Write-Host "app.asar is NOT fully patched:" -ForegroundColor Yellow
        Write-Host "  Password patch: $pw" -ForegroundColor $(if ($pw -eq "YES") { "Green" } else { "Yellow" })
        Write-Host "  CORS patch:     $cors" -ForegroundColor $(if ($cors -eq "YES") { "Green" } else { "Yellow" })
    }
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

# --- Default: patch if needed ---
# Check if desktop is running (asar may be locked)
$desktopProcs = Get-Process -Name "OpenCode" -ErrorAction SilentlyContinue
if ($desktopProcs) {
    Write-Host "WARNING: Desktop client is running ($($desktopProcs.Count) process(es))." -ForegroundColor Yellow
    Write-Host "  The asar may be locked. Close the desktop before patching." -ForegroundColor Yellow
    if (-not $Force) {
        Write-Host "  Use -Force to attempt patching anyway." -ForegroundColor Yellow
        throw "Desktop client is running. Close it before patching, or use -Force."
    }
    Write-Host "  -Force specified. Attempting patch anyway..." -ForegroundColor Yellow
}

Expand-Asar

if ((Test-Patched) -and -not $Force) {
    Write-Host "app.asar is already patched. Use -Force to re-patch." -ForegroundColor Green
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

Write-Host "Patching app.asar..." -ForegroundColor Cyan

# Backup if no backup exists
if (-not (Test-Path -LiteralPath $bakPath)) {
    Copy-Item $asarPath $bakPath -Force
    Write-Host "  Backup created: $bakPath" -ForegroundColor Gray
}

Set-Patches

Write-Host "  Repacking app.asar..." -ForegroundColor Cyan
Compress-Asar

# Verify
Expand-Asar
if (Test-Patched) {
    Write-Host "app.asar patched successfully." -ForegroundColor Green
} else {
    Write-Host "ERROR: Patch verification failed after repack!" -ForegroundColor Red
    Write-Host "  Restoring backup..." -ForegroundColor Yellow
    Copy-Item $bakPath $asarPath -Force
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    throw "Patch failed. Original restored."
}

# Cleanup
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Patches applied:" -ForegroundColor Green
Write-Host "  1. Password: OPENCODE_SERVER_PASSWORD env var respected" -ForegroundColor Gray
Write-Host "  2. CORS: OPENCODE_SERVER_CORS env var (funnel URL + oc://renderer); wildcard fallback only if env var unset" -ForegroundColor Gray
Write-Host ""
Write-Host "Launch with: .\start-opencode-desktop.ps1" -ForegroundColor Cyan
