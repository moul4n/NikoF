param(
    [string]$SemanticId = 'idle.default',
    [string]$SourceClip = 'assets/animations/raw/idle.anim',
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$UnityEditorPath,
    [switch]$KeepTempProject
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
        return $discoveredEditors[0]
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

function New-Directory {
    param(
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
}

function Invoke-UnityProcess {
    param(
        [string]$UnityExecutable,
        [string[]]$Arguments,
        [string]$LogPath,
        [string]$FailureContext,
        [int[]]$AllowedExitCodes = @(0)
    )

    $process = Start-Process -FilePath $UnityExecutable -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
    if ($AllowedExitCodes -notcontains $process.ExitCode) {
        $logTail = ''
        if (Test-Path -LiteralPath $LogPath) {
            $logTail = [string]::Join([Environment]::NewLine, (Get-Content -LiteralPath $LogPath -Tail 80))
        }

        throw "$FailureContext failed with exit code $($process.ExitCode).`nUnity log: $LogPath`n$logTail"
    }
}

$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$resolvedSourceClip = Resolve-RepoPath -Path $SourceClip -Root $resolvedRepoRoot
$resolvedUnityExecutable = Resolve-UnityEditorExecutable -RequestedPath $UnityEditorPath
$unityBatchScript = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'unity\RawAnimBatchExporter.cs')

$sourceRelativePath = [System.IO.Path]::GetRelativePath($resolvedRepoRoot, $resolvedSourceClip).Replace('\', '/')
$stagedSidecarOutputPath = Join-Path $resolvedRepoRoot "assets\animations\dsl\shared\$SemanticId.json"
$semanticAssetOutputPath = Join-Path $resolvedRepoRoot "assets\animations\dsl\generated\shared\$SemanticId.json"
$runtimePayloadOutputPath = Join-Path $resolvedRepoRoot "assets\animations\generated\shared\$SemanticId\$SemanticId.runtime.json"
$registryPath = Join-Path $resolvedRepoRoot 'assets\animations\dsl\shared\animations.json'

$tempProjectRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("NikoF-RawAnimExport-{0}" -f [System.Guid]::NewGuid().ToString('N'))
$createProjectLogPath = Join-Path $tempProjectRoot 'create-project.log'
$compilePassLogPath = Join-Path $tempProjectRoot 'compile-pass.log'
$exportLogPath = Join-Path $tempProjectRoot 'export.log'

try {
    New-Directory -Path $tempProjectRoot

    $compilePassArguments = @(
        '-quit',
        '-batchmode',
        '-nographics',
        '-projectPath', $tempProjectRoot,
        '-logFile', $compilePassLogPath,
        '-executeMethod', 'NikoF.AnimationTools.RawAnimBatchExporter.RunFromCommandLine',
        '--repo-root', $resolvedRepoRoot,
        '--semantic-id', $SemanticId,
        '--source-repo-path', $sourceRelativePath,
        '--source-asset-path', 'Assets/Imported/source.anim',
        '--staged-sidecar-output', $stagedSidecarOutputPath,
        '--semantic-asset-output', $semanticAssetOutputPath,
        '--runtime-output', $runtimePayloadOutputPath
    )

    $exportPassArguments = @(
        '-quit',
        '-batchmode',
        '-nographics',
        '-projectPath', $tempProjectRoot,
        '-logFile', $exportLogPath,
        '-executeMethod', 'NikoF.AnimationTools.RawAnimBatchExporter.RunFromCommandLine',
        '--repo-root', $resolvedRepoRoot,
        '--semantic-id', $SemanticId,
        '--source-repo-path', $sourceRelativePath,
        '--source-asset-path', 'Assets/Imported/source.anim',
        '--staged-sidecar-output', $stagedSidecarOutputPath,
        '--semantic-asset-output', $semanticAssetOutputPath,
        '--runtime-output', $runtimePayloadOutputPath
    )

    $createProjectInvocation = @{
        UnityExecutable = $resolvedUnityExecutable
        Arguments = @(
            '-quit',
            '-batchmode',
            '-nographics',
            '-createProject', $tempProjectRoot,
            '-logFile', $createProjectLogPath
        )
        LogPath = $createProjectLogPath
        FailureContext = 'Unity temp project creation'
    }
    Invoke-UnityProcess @createProjectInvocation

    New-Directory -Path (Join-Path $tempProjectRoot 'Assets\Editor')
    New-Directory -Path (Join-Path $tempProjectRoot 'Assets\Imported')

    Copy-Item -LiteralPath $resolvedSourceClip -Destination (Join-Path $tempProjectRoot 'Assets\Imported\source.anim')
    Copy-Item -LiteralPath $unityBatchScript.Path -Destination (Join-Path $tempProjectRoot 'Assets\Editor\RawAnimBatchExporter.cs')

    $compilePassInvocation = @{
        UnityExecutable = $resolvedUnityExecutable
        Arguments = $compilePassArguments
        LogPath = $compilePassLogPath
        FailureContext = 'Unity raw animation compile pass'
        AllowedExitCodes = @(0, 1)
    }
    Invoke-UnityProcess @compilePassInvocation

    $exportPassInvocation = @{
        UnityExecutable = $resolvedUnityExecutable
        Arguments = $exportPassArguments
        LogPath = $exportLogPath
        FailureContext = 'Unity raw animation export'
    }
    Invoke-UnityProcess @exportPassInvocation

    if (Test-Path -LiteralPath $registryPath) {
        $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json -Depth 16
        if (-not $registry.sidecars.PSObject.Properties.Name.Contains($SemanticId)) {
            $entry = [pscustomobject]@{
                path = (Join-Path 'assets/animations/dsl/shared' "$SemanticId.json").Replace('\', '/')
                stage = 'staged_raw_unity_source'
                approved_for_shared_library = $false
            }
            $registry.sidecars | Add-Member -NotePropertyName $SemanticId -NotePropertyValue $entry
            $registry | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $registryPath -Encoding utf8NoBOM
        }
    }

    Write-Host "Unity raw animation export completed for $SemanticId"
    Write-Host "Staged sidecar: $stagedSidecarOutputPath"
    Write-Host "Semantic asset candidate: $semanticAssetOutputPath"
    Write-Host "Runtime payload: $runtimePayloadOutputPath"
}
finally {
    if (-not $KeepTempProject -and (Test-Path -LiteralPath $tempProjectRoot)) {
        Remove-Item -LiteralPath $tempProjectRoot -Recurse -Force
    }
    elseif ($KeepTempProject) {
        Write-Host "Kept temp Unity project at $tempProjectRoot"
    }
}