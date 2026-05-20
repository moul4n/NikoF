param(
    [string]$AssetRelativePath = 'assets/characters/maria',
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$UnityEditorPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-UnityEditorExecutable {
    param(
        [string]$RequestedPath
    )

    if ($RequestedPath) {
        if (Test-Path -LiteralPath $RequestedPath -PathType Leaf) {
            return (Resolve-Path -LiteralPath $RequestedPath).Path
        }

        $candidateExecutable = Join-Path $RequestedPath 'Editor\Unity.exe'
        if (Test-Path -LiteralPath $candidateExecutable -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidateExecutable).Path
        }

        throw "Unity editor path does not resolve to Unity.exe: $RequestedPath"
    }

    $discoveredEditors = Get-ChildItem 'C:\Program Files\Unity\Hub\Editor' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'Editor\Unity.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }

    if ($discoveredEditors) {
        return @($discoveredEditors)[0]
    }

    throw 'Unable to locate a Unity editor installation. Pass -UnityEditorPath explicitly.'
}

function Resolve-RepoPath {
    param(
        [string]$Path,
        [string]$Root
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return (Resolve-Path -LiteralPath $Path).Path
    }

    return (Resolve-Path -LiteralPath (Join-Path $Root $Path)).Path
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
        if ($_ -match '[\s"]') {
            '"{0}"' -f ($_.Replace('"', '\"'))
        }
        else {
            $_
        }
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $UnityExecutable
    $startInfo.Arguments = [string]::Join(' ', $formattedArguments)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

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

function Get-ExpectedMetaPaths {
    param(
        [string]$TargetPath
    )

    $expected = [System.Collections.Generic.List[string]]::new()
    $expected.Add("$TargetPath.meta")

    if (Test-Path -LiteralPath $TargetPath -PathType Container) {
        Get-ChildItem -LiteralPath $TargetPath -Force -Recurse | ForEach-Object {
            if (-not $_.Name.EndsWith('.meta', [System.StringComparison]::OrdinalIgnoreCase)) {
                $expected.Add("$($_.FullName).meta")
            }
        }
    }

    return $expected
}

$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$resolvedUnityExecutable = Resolve-UnityEditorExecutable -RequestedPath $UnityEditorPath
$resolvedTargetPath = Resolve-RepoPath -Path $AssetRelativePath -Root $resolvedRepoRoot
$normalizedAssetRelativePath = $AssetRelativePath.Replace('\\', '/')
$logRoot = Join-Path $resolvedRepoRoot '.local\unity-meta-import'

if (-not (Test-Path -LiteralPath $logRoot)) {
    New-Item -ItemType Directory -Path $logRoot | Out-Null
}

$compilePassLogPath = Join-Path $logRoot 'compile-pass.log'
$importLogPath = Join-Path $logRoot 'import.log'

$unityArguments = @(
    '-quit',
    '-batchmode',
    '-nographics',
    '-projectPath', $resolvedRepoRoot,
    '-executeMethod', 'NikoF.AssetTools.CharacterMetaGenerator.RunFromCommandLine',
    '--asset-relative-path', $normalizedAssetRelativePath
)

Invoke-UnityProcess -UnityExecutable $resolvedUnityExecutable -Arguments ($unityArguments + @('-logFile', $compilePassLogPath)) -LogPath $compilePassLogPath -FailureContext 'Unity character meta compile pass' -AllowedExitCodes @(0, 1)
Invoke-UnityProcess -UnityExecutable $resolvedUnityExecutable -Arguments ($unityArguments + @('-logFile', $importLogPath)) -LogPath $importLogPath -FailureContext 'Unity character meta import'

$missingMetaPaths = Get-ExpectedMetaPaths -TargetPath $resolvedTargetPath | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
if ($missingMetaPaths) {
    $missingList = [string]::Join([Environment]::NewLine, $missingMetaPaths)
    throw "Unity import finished but some .meta files are still missing:`n$missingList"
}

Write-Host "Unity metadata generated for $normalizedAssetRelativePath"
Write-Host "Verified $(@(Get-ExpectedMetaPaths -TargetPath $resolvedTargetPath).Count) .meta files."
Write-Host "Import log: $importLogPath"