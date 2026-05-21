<#
.SYNOPSIS
    Exports Unity humanoid .anim clips as VRMA files via the VrmaExporter.

.DESCRIPTION
    Creates a temporary Unity project, imports the source .anim file and VrmaExporter.cs,
    then runs Unity in batch mode to produce a .vrma file in the animation library.

.PARAMETER SemanticId
    The semantic animation ID (e.g. "idle.default"). Used for naming and asset resolution.

.PARAMETER SourceClip
    Path to the source .anim file (absolute or relative to RepoRoot).

.PARAMETER RepoRoot
    Path to the repository root. Defaults to two levels up from this script.

.PARAMETER UnityEditorPath
    Optional explicit path to Unity.exe or its parent directory.

.PARAMETER OutputPath
    Optional explicit output path. Defaults to assets/animations/library/shared/{SemanticId}.vrma.

.PARAMETER KeepTempProject
    If set, the temporary Unity project is not deleted after export.

.EXAMPLE
    .\Invoke-VrmaExport.ps1 -SemanticId idle.default -SourceClip assets/animations/raw/idle.anim
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$SemanticId,

    [Parameter(Mandatory = $true)]
    [string]$SourceClip,

    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$UnityEditorPath,

    [string]$OutputPath,

    [switch]$KeepTempProject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Resolve-UnityEditorExecutable {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        if (Test-Path -LiteralPath $RequestedPath -PathType Leaf) {
            return (Resolve-Path -LiteralPath $RequestedPath).Path
        }
        $candidate = Join-Path $RequestedPath 'Editor\Unity.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
        throw "Unity editor path does not resolve to Unity.exe: $RequestedPath"
    }

    $discovered = Get-ChildItem 'C:\Program Files\Unity\Hub\Editor' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'Editor\Unity.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }

    if ($discovered) { return @($discovered)[0] }
    throw 'Unable to locate a Unity editor installation. Pass -UnityEditorPath explicitly.'
}

function Invoke-UnityProcess {
    param(
        [string]$UnityExecutable,
        [string[]]$Arguments,
        [string]$LogPath,
        [string]$FailureContext,
        [int[]]$AllowedExitCodes = @(0)
    )

    $formattedArguments = $Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"{0}"' -f ($_.Replace('"', '\"')) } else { $_ }
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $UnityExecutable
    $startInfo.Arguments = [string]::Join(' ', $formattedArguments)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    Write-Host "  Running Unity: $FailureContext ..."
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $process.WaitForExit()
    $exitCode = $process.ExitCode

    if ($AllowedExitCodes -notcontains $exitCode) {
        $logTail = ''
        if (Test-Path -LiteralPath $LogPath) {
            $logTail = [string]::Join([Environment]::NewLine, (Get-Content -LiteralPath $LogPath -Tail 80))
        }
        throw "$FailureContext failed with exit code $exitCode.`nUnity log: $LogPath`n$logTail"
    }
}

function Remove-DirectoryBestEffort {
    param([string]$Path, [int]$MaxAttempts = 5, [int]$RetryDelayMs = 500)
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $MaxAttempts) {
                Write-Warning "Unable to delete temp project at $Path after $MaxAttempts attempts: $_"
                return
            }
            [System.Threading.Thread]::Sleep($RetryDelayMs)
        }
    }
}

# ─── Main ─────────────────────────────────────────────────────────────────────

$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

# Resolve source clip
if ([System.IO.Path]::IsPathRooted($SourceClip)) {
    $resolvedSourceClip = (Resolve-Path -LiteralPath $SourceClip).Path
} else {
    $resolvedSourceClip = (Resolve-Path -LiteralPath (Join-Path $resolvedRepoRoot $SourceClip)).Path
}

if (-not (Test-Path -LiteralPath $resolvedSourceClip)) {
    throw "Source clip not found: $resolvedSourceClip"
}

# Resolve output path
if (-not $OutputPath) {
    $OutputPath = Join-Path $resolvedRepoRoot "assets\animations\library\shared\$SemanticId.vrma"
}

$resolvedUnityExecutable = Resolve-UnityEditorExecutable -RequestedPath $UnityEditorPath
$vrmaExporterScript = Join-Path $PSScriptRoot 'unity\VrmaExporter.cs'

if (-not (Test-Path -LiteralPath $vrmaExporterScript)) {
    throw "VrmaExporter.cs not found at: $vrmaExporterScript"
}

$tempProjectRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("NikoF-VrmaExport-{0}" -f [System.Guid]::NewGuid().ToString('N'))
$exportLogPath = Join-Path $tempProjectRoot 'export.log'

Write-Host "═══════════════════════════════════════════════════════════"
Write-Host "VRMA Export: $SemanticId"
Write-Host "  Source:  $resolvedSourceClip"
Write-Host "  Output:  $OutputPath"
Write-Host "  Unity:   $resolvedUnityExecutable"
Write-Host "  Temp:    $tempProjectRoot"
Write-Host "═══════════════════════════════════════════════════════════"

try {
    # 1. Create minimal Unity project structure manually (avoids -createProject PM race)
    $editorDir = Join-Path $tempProjectRoot 'Assets\Editor'
    $importedDir = Join-Path $tempProjectRoot 'Assets\Imported'
    $packagesDir = Join-Path $tempProjectRoot 'Packages'
    $projectSettingsDir = Join-Path $tempProjectRoot 'ProjectSettings'

    New-Item -ItemType Directory -Path $editorDir -Force | Out-Null
    New-Item -ItemType Directory -Path $importedDir -Force | Out-Null
    New-Item -ItemType Directory -Path $packagesDir -Force | Out-Null
    New-Item -ItemType Directory -Path $projectSettingsDir -Force | Out-Null

    # Minimal manifest — no packages needed, VrmaExporter only uses UnityEngine/UnityEditor
    Set-Content -LiteralPath (Join-Path $packagesDir 'manifest.json') -Value '{"dependencies":{}}'
    # Minimal ProjectSettings so Unity doesn't complain
    Set-Content -LiteralPath (Join-Path $projectSettingsDir 'ProjectVersion.txt') -Value "m_EditorVersion: 6000.4.7f1"

    # 2. Stage files into the temp project
    $sourceExtension = [System.IO.Path]::GetExtension($resolvedSourceClip)
    $importedFileName = "source$sourceExtension"
    Copy-Item -LiteralPath $resolvedSourceClip -Destination (Join-Path $importedDir $importedFileName)
    Copy-Item -LiteralPath $vrmaExporterScript -Destination (Join-Path $editorDir 'VrmaExporter.cs')

    # 3. Ensure output directory exists
    $outputDir = Split-Path -Parent $OutputPath
    if (-not (Test-Path -LiteralPath $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }

    # 4. Run Unity batch mode to export
    $exportArguments = @(
        '-quit',
        '-batchmode',
        '-nographics',
        '-projectPath', $tempProjectRoot,
        '-logFile', $exportLogPath,
        '-executeMethod', 'NikoF.AnimationTools.VrmaExporter.RunFromCommandLine',
        '--semantic-id', $SemanticId,
        '--repo-root', $resolvedRepoRoot,
        '--source-asset-path', "Assets/Imported/$importedFileName",
        '--vrma-output', $OutputPath
    )

    Invoke-UnityProcess `
        -UnityExecutable $resolvedUnityExecutable `
        -Arguments $exportArguments `
        -LogPath $exportLogPath `
        -FailureContext "VRMA export ($SemanticId)"

    # 5. Verify output
    if (Test-Path -LiteralPath $OutputPath) {
        $fileInfo = Get-Item -LiteralPath $OutputPath
        Write-Host ""
        Write-Host "SUCCESS: $OutputPath ($($fileInfo.Length) bytes)" -ForegroundColor Green
    } else {
        throw "Export completed but output file not found: $OutputPath"
    }
}
finally {
    if (-not $KeepTempProject -and (Test-Path -LiteralPath $tempProjectRoot)) {
        Write-Host "  Cleaning up temp project..."
        Remove-DirectoryBestEffort -Path $tempProjectRoot
    } elseif ($KeepTempProject) {
        Write-Host "  Kept temp Unity project at: $tempProjectRoot"
    }
}
