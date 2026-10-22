# OMP Coding Agent Installer for Windows
# Usage: irm https://omp.sh/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Source -Ref v18.8.9
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary -Ref v18.8.9
#
# -Ref takes any tag/commit/branch with -Source; binary installs take a release
# tag (v<version>). Prebuilt distributions come from GitHub Releases: a Windows
# launcher and the shared `cli.js` payload it runs on Node.js, each checked
# against the release's `SHA256SUMS.txt` before install. `$env:OMP_RELEASE_REPO`
# selects the repository and `$env:OMP_RELEASE_BASE` overrides the release base.

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref,
    [string]$Archive
)

$ErrorActionPreference = "Stop"
# PS 5.1's Invoke-WebRequest progress bar throttles large downloads; the
# ~130 MB release archive otherwise crawls for minutes.
$ProgressPreference = "SilentlyContinue"

# Fail fast on hosts older than Windows PowerShell 5.1: cmdlets used below
# (e.g. Invoke-WebRequest -TimeoutSec) are missing or unreliable there and
# fail with cryptic errors halfway through the install. Anything newer,
# including PowerShell 7+, passes this check.
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "Windows PowerShell 5.1 or newer is required (found $($PSVersionTable.PSVersion)). Install PowerShell 7 from https://aka.ms/powershell and re-run the installer."
}

$Repo = if ($env:OMP_RELEASE_REPO) { $env:OMP_RELEASE_REPO.Trim("/") } else { "Alex1990/oh-my-pi" }
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\oyp" }
$ReleaseBase = if ($env:OMP_RELEASE_BASE) { $env:OMP_RELEASE_BASE.TrimEnd("/") } else { "https://github.com/$Repo/releases" }
# Windows PowerShell 5.1 (.NET Framework) does not reliably resolve
# [System.Runtime.InteropServices.RuntimeInformation] without an
# assembly-qualified name, while PowerShell 7+ (Core) loads that type from a
# different assembly — so read the OS architecture from the environment
# instead, which works on both. Prefer PROCESSOR_ARCHITEW6432 so a 32-bit
# host on 64-bit Windows still reports the OS architecture.
# Note: PROCESSOR_ARCHITEW6432 is only set for 32-bit (WOW64) processes, so
# x64 PowerShell under ARM64 emulation reports AMD64 and installs the x64
# binary (runs emulated, not natively). Native ARM64 and x86-on-ARM64 hosts
# still resolve to arm64.
$RawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not $RawArchitecture) {
    throw "Unable to determine Windows architecture"
}
$TargetId = switch ($RawArchitecture.ToUpperInvariant()) {
    "AMD64" { "win32-x64" }
    "ARM64" { "win32-arm64" }
    default { throw "Unsupported Windows architecture: $RawArchitecture" }
}
$AssetName = "oyp-$TargetId.zip"
$MinimumNodeVersion = "22.12.0"
$PnpmVersion = "10.18.0"

# PowerShell 5.1 raises a terminating NativeCommandError for any line a native
# executable writes to stderr while $ErrorActionPreference is "Stop", regardless
# of the process exit code. Tools like node, pnpm and git emit normal progress
# on stderr, so run them with the preference relaxed to "Continue" and let
# callers gate on $LASTEXITCODE. Global "Stop" stays in effect for the
# cmdlet-driven operations (Invoke-WebRequest/Invoke-RestMethod) that depend on
# it.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-NodeInstalled {
    try {
        $null = Get-Command node -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-NodeVersion {
    try {
        $versionText = (node --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().TrimStart("v").Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-NodeVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-NodeVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-NodeVersion {
    param([string]$MinimumVersion)

    if (-not (Test-NodeVersion $MinimumVersion)) {
        $current = Get-NodeVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Node.js $MinimumVersion or newer is required. Current version: $currentText. Upgrade Node.js at https://nodejs.org/en/download"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".oyp\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new. ConvertFrom-Json -AsHashtable
            # requires PowerShell 6+; build the hashtable manually so Windows
            # PowerShell 5.1 merges instead of clobbering existing settings.
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $parsed = Get-Content $settingsFile -Raw | ConvertFrom-Json
                    foreach ($prop in $parsed.PSObject.Properties) {
                        $settings[$prop.Name] = $prop.Value
                    }
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "[OK] Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "No bash shell found - OMP will use its built-in shell." -ForegroundColor Cyan
            Write-Host "  For shell snapshots and interactive terminals, install Git for Windows:" -ForegroundColor Cyan
            Write-Host "    https://git-scm.com/download/win" -ForegroundColor Cyan
            Write-Host "  Or set a custom path in:" -ForegroundColor Cyan
            Write-Host "    $settingsFile" -ForegroundColor Cyan
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Cyan
        }
    } catch {
        Write-Host "[WARN] Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Node {
    Write-Host "Installing Node.js..."
    $nodeArch = if ($RawArchitecture.ToUpperInvariant() -eq "ARM64") { "arm64" } else { "x64" }
    $baseUrl = "https://nodejs.org/dist/latest-v22.x"
    try {
        $sums = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60).Content
    } catch {
        throw "Failed to download Node.js checksums from $baseUrl`: $_"
    }

    $archive = $null
    $expected = $null
    foreach ($line in ($sums -split "`n")) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -eq 2 -and $parts[1] -match "^node-v[0-9.]+-win-$nodeArch\.zip$") {
            $expected = $parts[0]
            $archive = $parts[1]
            break
        }
    }
    if (-not $archive -or $expected -notmatch '^[0-9a-f]{64}$') {
        throw "Could not find a Node.js win-$nodeArch archive in $baseUrl/SHASUMS256.txt"
    }

    $nodeHome = if ($env:PI_NODE_HOME) { $env:PI_NODE_HOME } else { Join-Path $env:LOCALAPPDATA "oyp\node" }
    $tmpZip = Join-Path ([System.IO.Path]::GetTempPath()) ("node-" + [System.Guid]::NewGuid().ToString("N") + ".zip")
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("node-" + [System.Guid]::NewGuid().ToString("N"))
    try {
        Write-Host "Downloading $archive..."
        Invoke-WebRequest -Uri "$baseUrl/$archive" -OutFile $tmpZip -TimeoutSec 900
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmpZip).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "Checksum mismatch for ${archive}: expected $expected, got $actual"
        }
        Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
        $extracted = Get-ChildItem -LiteralPath $tmpDir -Directory | Select-Object -First 1
        if (-not $extracted) {
            throw "Node.js archive did not contain an extracted directory"
        }
        Remove-Item -Recurse -Force -LiteralPath $nodeHome -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nodeHome) | Out-Null
        Move-Item -LiteralPath $extracted.FullName -Destination $nodeHome
    } finally {
        Remove-Item -Force -LiteralPath $tmpZip -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force -LiteralPath $tmpDir -ErrorAction SilentlyContinue
    }

    $env:Path = "$nodeHome;$env:Path"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$nodeHome*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$nodeHome", "User")
    }
    Assert-NodeVersion $MinimumNodeVersion
}

function Install-Pnpm {
    Write-Host "Installing pnpm..."
    $installed = $false
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        Invoke-Native { corepack enable }
        if ($LASTEXITCODE -eq 0) {
            Invoke-Native { corepack prepare "pnpm@$PnpmVersion" --activate }
            $installed = $LASTEXITCODE -eq 0
        }
    }
    if (-not $installed -and (Get-Command npm -ErrorAction SilentlyContinue)) {
        Invoke-Native { npm install -g "pnpm@$PnpmVersion" }
        $installed = $LASTEXITCODE -eq 0
    }
    if (-not $installed -or -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        throw "Failed to install pnpm $PnpmVersion (corepack or npm is required)"
    }
}

function Install-ViaPnpm {
    Write-Host "Installing via pnpm..."
    if (-not $Ref) {
        throw "-Source requires -Ref <tag>; prebuilt installs need no options."
    }
    if (-not (Test-GitInstalled)) {
        throw "git is required for -Ref when installing from source"
    }

    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("oyp-install-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

    try {
        $repoUrl = "https://github.com/$Repo.git"
        Invoke-Native { git clone --depth 1 --branch $Ref $repoUrl $tmpRoot 2>&1 | Out-Null }
        if ($LASTEXITCODE -ne 0) {
            Invoke-Native { git clone $repoUrl $tmpRoot 2>&1 | Out-Null }
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to clone $repoUrl"
            }
            Push-Location $tmpRoot
            try {
                Invoke-Native { git checkout $Ref 2>&1 | Out-Null }
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to checkout $Ref"
                }
            } finally {
                Pop-Location
            }
        }

        # Pull LFS files
        if (Test-GitLfsInstalled) {
            Push-Location $tmpRoot
            try {
                Invoke-Native { git lfs pull 2>&1 | Out-Null }
            } finally {
                Pop-Location
            }
        }

        $packagePath = Join-Path $tmpRoot "packages\coding-agent"
        if (-not (Test-Path $packagePath)) {
            throw "Expected package at $packagePath"
        }

        Invoke-Native { pnpm add -g $packagePath }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install from $packagePath via pnpm"
        }
    } finally {
        Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "[OK] Installed oyp via pnpm" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'oyp' to get started!"
}

function Install-Binary {
    $DownloadedArchive = $false
    if ($Archive) {
        if (-not (Test-Path -LiteralPath $Archive)) {
            throw "Archive not found: $Archive"
        }
        $DownloadPath = (Resolve-Path -LiteralPath $Archive).Path
        Write-Host "Installing from $DownloadPath"
    } else {
        if ($Ref) {
            if ($Ref -notmatch '^v(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$') {
                throw "Binary installs take a release tag (v<version>) for -Ref, got: $Ref`nFor branch/commit installs, use -Source with -Ref."
            }
            $Version = $Matches[1]
            $ReleasePath = "download/$Ref"
            Write-Host "Fetching oyp $Version..."
        } else {
            $Version = ""
            $ReleasePath = "latest/download"
            Write-Host "Fetching latest release..."
        }
        $AssetUrl = "$ReleaseBase/$ReleasePath/$AssetName"
        $SumsUrl = "$ReleaseBase/$ReleasePath/SHA256SUMS.txt"
        try {
            $SumsRaw = (Invoke-WebRequest -Uri $SumsUrl -TimeoutSec 60 -UseBasicParsing).Content
            # GitHub's redirect target is served as octet-stream: PS 5.1 then hands
            # back byte[] instead of text.
            $Sums = if ($SumsRaw -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($SumsRaw) } else { [string]$SumsRaw }
        } catch {
            throw "Failed to fetch ${SumsUrl}: $_"
        }
        $Checksums = @{}
        foreach ($line in ($Sums -split "`r?`n")) {
            if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
                $Checksums[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
            }
        }
        $ExpectedSha256 = $Checksums[$AssetName]
        if (-not $ExpectedSha256) {
            throw "No checksum for $AssetName in $SumsUrl"
        }
        if ($Version) {
            Write-Host "Using version: $Version"
        } else {
            Write-Host "Using the latest release"
        }

        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        $DownloadPath = Join-Path $InstallDir ".oyp.download.zip"
        $DownloadedArchive = $true
        Write-Host "Downloading $AssetName..."
        Invoke-WebRequest -Uri $AssetUrl -OutFile $DownloadPath -TimeoutSec 900 -UseBasicParsing
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $stream = [System.IO.File]::OpenRead($DownloadPath)
            try {
                $ActualSha256 = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
            } finally {
                $stream.Dispose()
            }
        } finally {
            $sha256.Dispose()
        }
        if ($ActualSha256 -ne $ExpectedSha256) {
            throw "Checksum mismatch for ${AssetName}: expected $ExpectedSha256, got $ActualSha256"
        }
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $OutPath = Join-Path $InstallDir "oyp.cmd"
    $ExtractDir = Join-Path $InstallDir ".oyp.extract"
    try {
        if (Test-Path $ExtractDir) {
            Remove-Item -Recurse -Force $ExtractDir
        }
        New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
        Expand-Archive -LiteralPath $DownloadPath -DestinationPath $ExtractDir -Force
        $SrcDir = Join-Path $ExtractDir "oyp-$TargetId"
        foreach ($required in @("oyp.cmd", "runtime\node.exe")) {
            if (-not (Test-Path (Join-Path $SrcDir $required))) {
                throw "Archive is missing $required"
            }
        }
        foreach ($owned in @("app", "runtime")) {
            $existing = Join-Path $InstallDir $owned
            if (Test-Path $existing) {
                Remove-Item -Recurse -Force $existing
            }
            Move-Item -Force -LiteralPath (Join-Path $SrcDir $owned) -Destination $existing
        }
        Move-Item -Force -LiteralPath (Join-Path $SrcDir "oyp.cmd") -Destination $OutPath
    } finally {
        if ($DownloadedArchive) {
            Remove-Item -Force -LiteralPath $DownloadPath -ErrorAction SilentlyContinue
        }
        Remove-Item -Recurse -Force -LiteralPath $ExtractDir -ErrorAction SilentlyContinue
    }

    # The archive carries its own Node runtime and addons: verify it starts.
    $Smoke = & $OutPath --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Installed oyp cannot start: $Smoke"
    }

    Write-Host ""
    Write-Host "[OK] Installed oyp to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'oyp' to get started!"
    } else {
        Write-Host "Run 'oyp' to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-NodeInstalled)) {
        Install-Node
    }
    Assert-NodeVersion $MinimumNodeVersion
    Install-Pnpm
    Install-ViaPnpm
} else {
    # Default (and -Binary): the prebuilt launcher and cli.js from the latest
    # release. `-Source -Ref <tag>` builds from a checkout instead.
    Install-Binary
}
