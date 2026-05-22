[CmdletBinding()]
param(
    [string]$LocalRoot,
    [string]$ConfigPath,
    [switch]$AllSafe,
    [switch]$InstallBaseToolchain,
    [switch]$InstallRepoDependencies,
    [switch]$InstallOllama,
    [switch]$PullOllamaModel,
    [switch]$InstallFasterWhisperMedium,
    [switch]$InstallFasterWhisperSmall,
    [switch]$InstallGptSovitsV2Pro,
    [switch]$InstallBgeSmallEmbeddings,
    [switch]$InstallMiniLmEmbeddings,
    [string]$SttModelSourcePath,
    [switch]$StageRepoTtsServer,
    [string]$TtsProviderSourcePath,
    [string]$TtsModelSourcePath,
    [switch]$Validate,
    [switch]$ForceRecreateVenv,
    [string]$PreferredPythonVersion = '3.12',
    [string]$PythonWingetId = 'Python.Python.3.12',
    [string]$GitWingetId = 'Git.Git',
    [string]$NodeWingetId = 'OpenJS.NodeJS.LTS',
    [string]$OllamaWingetId = 'Ollama.Ollama',
    [string]$FasterWhisperRepoId = 'Systran/faster-whisper-medium',
    [string]$FasterWhisperSmallRepoId = 'Systran/faster-whisper-small',
    [string]$BgeSmallEmbeddingsRepoId = 'BAAI/bge-small-en-v1.5',
    [string]$MiniLmEmbeddingsRepoId = 'sentence-transformers/all-MiniLM-L6-v2',
    [string]$GptSovitsPackageUrl = 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v2pro-20250604.7z?download=true',
    [string]$GptSovitsSourceUrl = 'https://github.com/RVC-Boss/GPT-SoVITS/archive/refs/tags/20250606v2pro.zip',
    [string]$GptSovitsPackageArchiveName = 'GPT-SoVITS-v2pro-20250604.7z',
    [string]$GptSovitsSourceArchiveName = 'GPT-SoVITS-20250606v2pro-source.zip',
    [string]$GptSovitsPackageExtractRootName = 'GPT-SoVITS-v2pro-20250604',
    [string]$GptSovitsSourceExtractRootName = 'GPT-SoVITS-20250606v2pro'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $false
}

if ($AllSafe) {
    $InstallBaseToolchain = $true
    $InstallRepoDependencies = $true
    $InstallOllama = $true
    $PullOllamaModel = $true
    $InstallFasterWhisperMedium = $true
    $Validate = $true
}

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $PSScriptRoot 'bootstrap.targets.json'
}

. (Join-Path $PSScriptRoot 'Test-NikoFPrerequisites.ps1')

$repoRoot = Get-NikoFRepoRoot -ScriptRoot $PSScriptRoot
$config = Get-NikoFBootstrapConfig -ConfigPath $ConfigPath
$storageLayout = Get-NikoFStorageLayout -RepoRoot $repoRoot -Config $config -LocalRootOverride $LocalRoot
[void](Initialize-NikoFStorageLayout -StorageLayout $storageLayout)
$envFilePath = Export-NikoFSessionEnvFile -StorageLayout $storageLayout -Config $config
. $envFilePath

$bootstrapScript = Join-Path $PSScriptRoot 'bootstrap.ps1'
$contractValidationScript = Join-Path $repoRoot 'scripts\asset_validation\validate-contracts.ps1'
$venvRoot = Join-Path $repoRoot '.venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$frontendRoot = Join-Path $repoRoot 'frontend'
$backendRoot = Join-Path $repoRoot 'backend'
$sttModelRoot = Join-Path $storageLayout.stt_models_root 'faster-whisper-medium'
$sttFallbackModelRoot = Join-Path $storageLayout.stt_models_root 'faster-whisper-small'
$ttsModelRoot = Join-Path $storageLayout.tts_models_root 'gpt-sovits'
$ttsProviderRoot = Join-Path $storageLayout.providers_root 'tts\gpt-sovits'
$embeddingsBaselineRoot = Join-Path $storageLayout.embeddings_root 'bge-small-en'
$embeddingsFallbackRoot = Join-Path $storageLayout.embeddings_root 'MiniLM-L6-v2'
$downloadRoot = Join-Path $storageLayout.cache_root 'downloads'
$stagingRoot = Join-Path $storageLayout.cache_root 'staging'
$ttsProviderRuntimeRoot = Join-Path $ttsProviderRoot 'runtime'
$ttsProviderPackageRoot = Join-Path $ttsProviderRoot 'GPT_SoVITS'
$ttsModelPretrainedRoot = Join-Path $ttsModelRoot 'pretrained_models'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-NikoFStep {
    param(
        [Parameter(Mandatory)]
        [string]$Message
    )

    Write-Host ('== {0} ==' -f $Message)
}

function Update-NikoFProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machinePath, $userPath) -join ';'
}

function Assert-NikoFLastExitCode {
    param(
        [Parameter(Mandatory)]
        [string]$Action
    )

    if ($LASTEXITCODE -ne 0) {
        throw "$Action failed with exit code $LASTEXITCODE"
    }
}

function Write-NikoFUtf8NoBomFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent -and (-not (Test-Path -LiteralPath $parent))) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Write-NikoFJsonFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [object]$Payload
    )

    Write-NikoFUtf8NoBomFile -Path $Path -Content ($Payload | ConvertTo-Json -Depth 10)
}

function Test-NikoFPayloadProof {
    param(
        [Parameter(Mandatory)]
        [string]$RootPath,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$ScaffoldArtifactNames
    )

    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
        return $false
    }

    foreach ($child in @(Get-ChildItem -LiteralPath $RootPath -Force -ErrorAction SilentlyContinue)) {
        if ($ScaffoldArtifactNames -notcontains $child.Name) {
            return $true
        }
    }

    return $false
}

function Install-NikoFWingetPackage {
    param(
        [Parameter(Mandatory)]
        [string]$PackageId,

        [Parameter(Mandatory)]
        [string]$DisplayName
    )

    $wingetCommand = Get-Command winget -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $wingetCommand) {
        throw "winget is unavailable. Install $DisplayName manually and rerun this script."
    }

    Write-NikoFStep -Message ("Installing {0} via winget" -f $DisplayName)
    & $wingetCommand.Source install --id $PackageId --exact --silent --accept-package-agreements --accept-source-agreements
    Assert-NikoFLastExitCode -Action ("winget install $PackageId")
    Update-NikoFProcessPath
}

function Invoke-NikoFDownloadFile {
    param(
        [Parameter(Mandatory)]
        [string]$Url,

        [Parameter(Mandatory)]
        [string]$DestinationPath,

        [Parameter(Mandatory)]
        [string]$Label
    )

    if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        Write-Host ('{0} download already present at {1}' -f $Label, $DestinationPath)
        return
    }

    $parent = Split-Path -Parent $DestinationPath
    if ($parent -and (-not (Test-Path -LiteralPath $parent))) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    Write-NikoFStep -Message ('Downloading {0}' -f $Label)
    try {
        Start-BitsTransfer -Source $Url -Destination $DestinationPath -DisplayName $Label -Description ('NikoF installer download for ' + $Label)
    }
    catch {
        Remove-Item -LiteralPath $DestinationPath -Force -ErrorAction SilentlyContinue
        Invoke-WebRequest -Uri $Url -OutFile $DestinationPath
    }
}

function Expand-NikoFArchiveEntries {
    param(
        [Parameter(Mandatory)]
        [string]$ArchivePath,

        [Parameter(Mandatory)]
        [string]$DestinationRoot,

        [Parameter(Mandatory)]
        [string[]]$Entries,

        [string[]]$RequiredPaths,

        [Parameter(Mandatory)]
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
        throw ('Archive not found for {0}: {1}' -f $Label, $ArchivePath)
    }

    if (-not (Test-Path -LiteralPath $DestinationRoot)) {
        New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    }

    if ($RequiredPaths -and $RequiredPaths.Count -gt 0) {
        $missingRequiredPaths = @($RequiredPaths | Where-Object { -not (Test-Path -LiteralPath $_) })
        if ($missingRequiredPaths.Count -eq 0) {
            Write-Host ('{0} already staged under {1}' -f $Label, $DestinationRoot)
            return
        }
    }

    Write-NikoFStep -Message ('Extracting {0}' -f $Label)
    & tar -xf $ArchivePath -C $DestinationRoot @Entries
    Assert-NikoFLastExitCode -Action ('Extract ' + $Label)
}

function Resolve-NikoFArchiveExtractRootName {
    param(
        [Parameter(Mandatory)]
        [string]$ArchivePath,

        [Parameter(Mandatory)]
        [string]$PreferredRootName
    )

    $archiveEntries = @(& tar -tf $ArchivePath)
    Assert-NikoFLastExitCode -Action ('List archive entries for ' + $ArchivePath)

    if ($archiveEntries.Count -eq 0) {
        throw ('Archive contains no entries: {0}' -f $ArchivePath)
    }

    $preferredEntry = $archiveEntries | Where-Object {
        $_ -like ($PreferredRootName + '/*') -or $_ -eq ($PreferredRootName + '/') -or $_ -eq $PreferredRootName
    } | Select-Object -First 1
    if ($preferredEntry) {
        return $PreferredRootName
    }

    $firstEntry = $archiveEntries[0].Trim()
    $rootName = ($firstEntry -replace '[\\/].*$', '').Trim()
    if (-not $rootName) {
        throw ('Could not determine archive root for {0}' -f $ArchivePath)
    }

    return $rootName
}

function Get-NikoFPreferredPythonCandidatePaths {
    param(
        [Parameter(Mandatory)]
        [string]$Version
    )

    $compactVersion = $Version -replace '\.', ''
    $candidatePaths = @()

    if ($env:LOCALAPPDATA) {
        $candidatePaths += Join-Path $env:LOCALAPPDATA ("Programs\\Python\\Python{0}\\python.exe" -f $compactVersion)
    }
    if ($env:ProgramFiles) {
        $candidatePaths += Join-Path $env:ProgramFiles ("Python{0}\\python.exe" -f $compactVersion)
    }
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)', 'Process')
    if ($programFilesX86) {
        $candidatePaths += Join-Path $programFilesX86 ("Python{0}\\python.exe" -f $compactVersion)
    }

    return @($candidatePaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
}

function Resolve-NikoFPreferredPythonExecutable {
    param(
        [Parameter(Mandatory)]
        [string]$PreferredVersion,

        [switch]$AllowFallback
    )

    $preferredCandidates = @(Get-NikoFPreferredPythonCandidatePaths -Version $PreferredVersion)
    if ($preferredCandidates.Count -gt 0) {
        return $preferredCandidates[0]
    }

    if ($AllowFallback) {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pythonCommand) {
            if ($pythonCommand.Path) {
                return $pythonCommand.Path
            }
            if ($pythonCommand.Source) {
                return $pythonCommand.Source
            }
        }
    }

    return $null
}

function Ensure-NikoFBaseToolchain {
    Write-NikoFStep -Message 'Ensuring Windows base toolchain'

    if (-not (Resolve-NikoFCommandPath -Command 'git')) {
        Install-NikoFWingetPackage -PackageId $GitWingetId -DisplayName 'Git for Windows'
    }

    if (-not (Resolve-NikoFCommandPath -Command 'node')) {
        Install-NikoFWingetPackage -PackageId $NodeWingetId -DisplayName 'Node.js LTS'
    }

    if (-not (Resolve-NikoFPreferredPythonExecutable -PreferredVersion $PreferredPythonVersion)) {
        Install-NikoFWingetPackage -PackageId $PythonWingetId -DisplayName ("Python {0}" -f $PreferredPythonVersion)
    }

    if (-not (Resolve-NikoFCommandPath -Command 'npm')) {
        throw 'npm is still unavailable after Node.js installation. Reopen the shell and rerun the installer.'
    }
}

function Ensure-NikoFBackendVirtualEnv {
    if ($ForceRecreateVenv -and (Test-Path -LiteralPath $venvRoot)) {
        Write-NikoFStep -Message 'Removing existing .venv'
        Remove-Item -LiteralPath $venvRoot -Recurse -Force
    }

    if (-not (Test-Path -LiteralPath $venvPython)) {
        $resolvedPythonExe = Resolve-NikoFPreferredPythonExecutable -PreferredVersion $PreferredPythonVersion -AllowFallback
        if (-not $resolvedPythonExe) {
            throw 'No usable Python executable was found. Install Python and rerun the installer.'
        }

        Write-NikoFStep -Message ("Creating backend virtual environment with {0}" -f $resolvedPythonExe)
        Push-Location $repoRoot
        try {
            & $resolvedPythonExe -m venv .venv | Out-Null
            Assert-NikoFLastExitCode -Action 'Create backend virtual environment'
        }
        finally {
            Pop-Location
        }
    }

    $venvVersion = (& $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
    if ($venvVersion -ne $PreferredPythonVersion) {
        Write-Warning ("Existing .venv is using Python {0}; preferred version is {1}." -f $venvVersion, $PreferredPythonVersion)
    }

    Write-NikoFStep -Message 'Installing backend dependencies'
    & $venvPython -m pip install --upgrade pip setuptools wheel | Out-Null
    Assert-NikoFLastExitCode -Action 'Upgrade backend packaging tools'
    & $venvPython -m pip install -e (Join-Path $repoRoot 'backend') | Out-Null
    Assert-NikoFLastExitCode -Action 'Install backend package'

    return $venvPython
}

function Ensure-NikoFFrontendDependencies {
    Write-NikoFStep -Message 'Installing frontend dependencies'
    & npm --prefix $frontendRoot ci
    Assert-NikoFLastExitCode -Action 'Install frontend dependencies'
}

function Ensure-NikoFOllamaInstalled {
    if (-not (Resolve-NikoFCommandPath -Command 'ollama')) {
        Install-NikoFWingetPackage -PackageId $OllamaWingetId -DisplayName 'Ollama'
    }

    $resolvedOllama = Resolve-NikoFCommandPath -Command 'ollama'
    if (-not $resolvedOllama) {
        throw 'Ollama is still unavailable after installation.'
    }
}

function Install-NikoFHuggingFaceHub {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe
    )

    & $PythonExe -m pip install 'huggingface-hub>=0.23,<1.0'
    Assert-NikoFLastExitCode -Action 'Install huggingface-hub'
}

function Install-NikoFFasterWhisperMediumModel {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe
    )

    if (Test-NikoFPayloadProof -RootPath $sttModelRoot -ScaffoldArtifactNames @('runtime.json', 'install-plan.json')) {
        Write-Host ('Faster-Whisper Medium payload already present under {0}' -f $sttModelRoot)
        return
    }

    if ($SttModelSourcePath) {
        Copy-NikoFDirectoryContents -SourcePath $SttModelSourcePath -DestinationPath $sttModelRoot -Label 'Faster-Whisper Medium model payload'
        return
    }

    Install-NikoFHuggingFaceHub -PythonExe $PythonExe
    Write-NikoFStep -Message 'Downloading Faster-Whisper Medium model payload'
    $downloadCommand = "from huggingface_hub import snapshot_download; snapshot_download(repo_id=r'{0}', local_dir=r'{1}')" -f $FasterWhisperRepoId, $sttModelRoot
    & $PythonExe -c $downloadCommand
    if ($LASTEXITCODE -ne 0) {
        throw 'Download Faster-Whisper Medium model payload failed. If Hugging Face is blocked on this machine, rerun the installer with -SttModelSourcePath from an approved local copy.'
    }
}

function Install-NikoFHuggingFaceSnapshotPayload {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe,

        [Parameter(Mandatory)]
        [string]$RepoId,

        [Parameter(Mandatory)]
        [string]$DestinationRoot,

        [Parameter(Mandatory)]
        [string]$Label
    )

    if (Test-NikoFPayloadProof -RootPath $DestinationRoot -ScaffoldArtifactNames @()) {
        Write-Host ('{0} payload already present under {1}' -f $Label, $DestinationRoot)
        return
    }

    Install-NikoFHuggingFaceHub -PythonExe $PythonExe
    Write-NikoFStep -Message ('Downloading {0}' -f $Label)
    $downloadCommand = "from huggingface_hub import snapshot_download; snapshot_download(repo_id=r'{0}', local_dir=r'{1}')" -f $RepoId, $DestinationRoot
    & $PythonExe -c $downloadCommand
    if ($LASTEXITCODE -ne 0) {
        throw ('Download {0} payload failed. If Hugging Face is blocked on this machine, place an approved local copy under {1} and rerun bootstrap validation.' -f $Label, $DestinationRoot)
    }
}

function Install-NikoFFasterWhisperSmallModel {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe
    )

    Install-NikoFHuggingFaceSnapshotPayload -PythonExe $PythonExe -RepoId $FasterWhisperSmallRepoId -DestinationRoot $sttFallbackModelRoot -Label 'Faster-Whisper Small fallback model'
}

function Install-NikoFBgeSmallEmbeddings {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe
    )

    Install-NikoFHuggingFaceSnapshotPayload -PythonExe $PythonExe -RepoId $BgeSmallEmbeddingsRepoId -DestinationRoot $embeddingsBaselineRoot -Label 'bge-small-en baseline embeddings'
}

function Install-NikoFMiniLmEmbeddings {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe
    )

    Install-NikoFHuggingFaceSnapshotPayload -PythonExe $PythonExe -RepoId $MiniLmEmbeddingsRepoId -DestinationRoot $embeddingsFallbackRoot -Label 'MiniLM-L6-v2 fallback embeddings'
}

function Ensure-NikoFSttProviderWrappers {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe
    )

    Write-NikoFStep -Message 'Generating Faster-Whisper provider wrappers'
    Push-Location $backendRoot
    try {
        & $PythonExe -c "from app.core.settings import get_app_paths; from app.services.stt_server import load_server_config; load_server_config(get_app_paths())"
        Assert-NikoFLastExitCode -Action 'Generate Faster-Whisper provider wrappers'
    }
    finally {
        Pop-Location
    }
}

function Copy-NikoFDirectoryContents {
    param(
        [Parameter(Mandatory)]
        [string]$SourcePath,

        [Parameter(Mandatory)]
        [string]$DestinationPath,

        [Parameter(Mandatory)]
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) {
        throw ("{0} source path does not exist: {1}" -f $Label, $SourcePath)
    }

    if (-not (Test-Path -LiteralPath $DestinationPath)) {
        New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
    }

    Write-NikoFStep -Message ("Copying {0} into managed local root" -f $Label)
    $robocopyCommand = Get-Command robocopy -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($robocopyCommand) {
        & $robocopyCommand.Source $SourcePath $DestinationPath /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -gt 7) {
            throw ("Copy {0} failed with robocopy exit code {1}" -f $Label, $LASTEXITCODE)
        }
        return
    }

    foreach ($item in @(Get-ChildItem -LiteralPath $SourcePath -Force)) {
        Copy-Item -LiteralPath $item.FullName -Destination $DestinationPath -Recurse -Force
    }
}

function Ensure-NikoFGptSovitsReferenceRoots {
    foreach ($relativePath in @('generated', 'reference-audio', 'speakers')) {
        $fullPath = Join-Path $ttsModelRoot $relativePath
        if (-not (Test-Path -LiteralPath $fullPath)) {
            New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
        }
    }
}

function Write-NikoFGptSovitsRuntimeManifests {
    Ensure-NikoFGptSovitsReferenceRoots

    $modelRuntimePath = Join-Path $ttsModelRoot 'runtime.json'
    $providerRuntimePath = Join-Path $ttsProviderRoot 'runtime.json'

    $modelRuntime = [ordered]@{
        gpt_model = '.\\pretrained_models\\s1v3.ckpt'
        sovits_model = '.\\pretrained_models\\v2Pro\\s2Gv2Pro.pth'
        bert_path = '.\\pretrained_models\\chinese-roberta-wwm-ext-large'
        cnhubert_path = '.\\pretrained_models\\chinese-hubert-base'
        speaker_manifest = '.\\speakers\\default.json'
        reference_audio_root = '.\\reference-audio'
        notes = @(
            'Machine-local GPT-SoVITS model metadata belongs here after you place the vendor payload under NIKOF_TTS_MODELS_ROOT\\gpt-sovits.',
            'The sidecar can start from the staged v2Pro payload, but actual synthesis still requires speakers\\default.json plus at least one reference audio clip and prompt text.'
        )
    }

    $providerRuntime = [ordered]@{
        entrypoint = 'api_server.py'
        server_script = 'api_server.py'
        python_executable = (Join-Path $ttsProviderRuntimeRoot 'python.exe')
        timeout_seconds = 240
        notes = @(
            'Optional machine-local adapter overrides for GPT-SoVITS invocation.',
            'This machine-local install uses the vendor runtime Python from the managed provider root.',
            'server_script is pinned to api_server.py so the backend keeps the normalized NikoF HTTP contract instead of launching vendor api_v2.py directly.'
        )
    }

    Write-NikoFJsonFile -Path $modelRuntimePath -Payload $modelRuntime
    Write-NikoFJsonFile -Path $providerRuntimePath -Payload $providerRuntime
}

function Get-NikoFGptSovitsReferenceStatus {
    $speakerManifestPath = Join-Path $ttsModelRoot 'speakers\default.json'
    $referenceAudioRoot = Join-Path $ttsModelRoot 'reference-audio'
    $referenceAudioFiles = @()
    if (Test-Path -LiteralPath $referenceAudioRoot -PathType Container) {
        $referenceAudioFiles = @(Get-ChildItem -LiteralPath $referenceAudioRoot -File -ErrorAction SilentlyContinue)
    }

    return [pscustomobject]@{
        speaker_manifest_path = $speakerManifestPath
        speaker_manifest_present = Test-Path -LiteralPath $speakerManifestPath -PathType Leaf
        reference_audio_root = $referenceAudioRoot
        reference_audio_count = $referenceAudioFiles.Count
    }
}

function Install-NikoFGptSovitsV2ProPayload {
    $packageArchivePath = Join-Path $downloadRoot $GptSovitsPackageArchiveName
    $sourceArchivePath = Join-Path $downloadRoot $GptSovitsSourceArchiveName
    $providerPretrainedRoot = Join-Path $ttsProviderRoot 'GPT_SoVITS\pretrained_models'
    $providerSvCheckpoint = Join-Path $providerPretrainedRoot 'sv\pretrained_eres2netv2w24s4ep4.ckpt'

    Invoke-NikoFDownloadFile -Url $GptSovitsPackageUrl -DestinationPath $packageArchivePath -Label 'GPT-SoVITS v2Pro Windows package'
    Invoke-NikoFDownloadFile -Url $GptSovitsSourceUrl -DestinationPath $sourceArchivePath -Label 'GPT-SoVITS v2Pro source archive'

    $resolvedPackageExtractRootName = Resolve-NikoFArchiveExtractRootName -ArchivePath $packageArchivePath -PreferredRootName $GptSovitsPackageExtractRootName
    $resolvedSourceExtractRootName = Resolve-NikoFArchiveExtractRootName -ArchivePath $sourceArchivePath -PreferredRootName $GptSovitsSourceExtractRootName
    $packageStageRoot = Join-Path $stagingRoot $resolvedPackageExtractRootName
    $sourceStageRoot = Join-Path $stagingRoot $resolvedSourceExtractRootName
    $packageRuntimeExe = Join-Path $packageStageRoot 'runtime\python.exe'
    $packageV2ProWeights = Join-Path $packageStageRoot 'GPT_SoVITS\pretrained_models\v2Pro\s2Gv2Pro.pth'
    $packageSvCheckpoint = Join-Path $packageStageRoot 'GPT_SoVITS\pretrained_models\sv\pretrained_eres2netv2w24s4ep4.ckpt'

    $packagePayloadAlreadyReady = (Test-Path -LiteralPath $packageRuntimeExe -PathType Leaf) -and
        (Test-Path -LiteralPath $packageV2ProWeights -PathType Leaf) -and
        ((Test-Path -LiteralPath $packageSvCheckpoint -PathType Leaf) -or (Test-Path -LiteralPath $providerSvCheckpoint -PathType Leaf))
    if ($packagePayloadAlreadyReady) {
        Write-Host ('GPT-SoVITS v2Pro Windows package payloads already staged under {0}' -f $packageStageRoot)
    }
    else {
        Expand-NikoFArchiveEntries -ArchivePath $packageArchivePath -DestinationRoot $stagingRoot -Entries @(
            ("{0}/runtime" -f $resolvedPackageExtractRootName),
            ("{0}/GPT_SoVITS/pretrained_models" -f $resolvedPackageExtractRootName)
        ) -RequiredPaths @(
            $packageRuntimeExe,
            $packageV2ProWeights,
            $packageSvCheckpoint
        ) -Label 'GPT-SoVITS v2Pro Windows package payloads'
    }

    Expand-NikoFArchiveEntries -ArchivePath $sourceArchivePath -DestinationRoot $stagingRoot -Entries @(
        ("{0}/config.py" -f $resolvedSourceExtractRootName),
        ("{0}/tools" -f $resolvedSourceExtractRootName),
        ("{0}/GPT_SoVITS" -f $resolvedSourceExtractRootName)
    ) -RequiredPaths @(
        (Join-Path $sourceStageRoot 'config.py'),
        (Join-Path $sourceStageRoot 'tools'),
        (Join-Path $sourceStageRoot 'GPT_SoVITS')
    ) -Label 'GPT-SoVITS v2Pro source runtime'

    $packagePretrainedRoot = Join-Path $packageStageRoot 'GPT_SoVITS\pretrained_models'

    if (-not (Test-Path -LiteralPath $packagePretrainedRoot -PathType Container)) {
        throw ('Expected GPT-SoVITS package pretrained_models root was not extracted: {0}' -f $packagePretrainedRoot)
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sourceStageRoot 'GPT_SoVITS') -PathType Container)) {
        throw ('Expected GPT-SoVITS source package root was not extracted: {0}' -f $sourceStageRoot)
    }

    Stage-NikoFRepoTtsServer
    Copy-NikoFDirectoryContents -SourcePath (Join-Path $sourceStageRoot 'GPT_SoVITS') -DestinationPath (Join-Path $ttsProviderRoot 'GPT_SoVITS') -Label 'GPT-SoVITS provider package'
    Copy-NikoFDirectoryContents -SourcePath (Join-Path $sourceStageRoot 'tools') -DestinationPath (Join-Path $ttsProviderRoot 'tools') -Label 'GPT-SoVITS provider tools'
    Copy-Item -LiteralPath (Join-Path $sourceStageRoot 'config.py') -Destination (Join-Path $ttsProviderRoot 'config.py') -Force
    Copy-NikoFDirectoryContents -SourcePath (Join-Path $packageStageRoot 'runtime') -DestinationPath $ttsProviderRuntimeRoot -Label 'GPT-SoVITS vendor runtime'
    Copy-NikoFDirectoryContents -SourcePath $packagePretrainedRoot -DestinationPath $providerPretrainedRoot -Label 'GPT-SoVITS provider pretrained models'
    Copy-NikoFDirectoryContents -SourcePath $packagePretrainedRoot -DestinationPath $ttsModelPretrainedRoot -Label 'GPT-SoVITS model pretrained payload'

    Write-NikoFGptSovitsRuntimeManifests

    $referenceStatus = Get-NikoFGptSovitsReferenceStatus
    if ((-not $referenceStatus.speaker_manifest_present) -or $referenceStatus.reference_audio_count -lt 1) {
        Write-Warning ('GPT-SoVITS runtime is staged, but synthesis still needs a speaker manifest and reference wav. Missing now: speaker manifest={0}, reference wav count={1}. Expected paths: {2}, {3}' -f $referenceStatus.speaker_manifest_present, $referenceStatus.reference_audio_count, $referenceStatus.speaker_manifest_path, $referenceStatus.reference_audio_root)
    }
}

function Stage-NikoFRepoTtsServer {
    $sourcePath = Join-Path $repoRoot 'scripts\tts_server\api_server.py'
    if (-not (Test-Path -LiteralPath $ttsProviderRoot)) {
        New-Item -ItemType Directory -Path $ttsProviderRoot -Force | Out-Null
    }

    Write-NikoFStep -Message 'Staging repo GPT-SoVITS server entrypoint'
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $ttsProviderRoot 'api_server.py') -Force
    Write-Warning 'The repo entrypoint alone does not install the approved GPT-SoVITS runtime or model payload. Supply -InstallGptSovitsV2Pro or -TtsProviderSourcePath and -TtsModelSourcePath to bring the TTS lane fully up to spec.'
}

function Invoke-NikoFValidation {
    param(
        [Parameter(Mandatory)]
        [string]$PythonExe
    )

    Write-NikoFStep -Message 'Validating bootstrap surface'
    & powershell -ExecutionPolicy Bypass -File $bootstrapScript -LocalRoot $storageLayout.local_data_root -ConfigPath $ConfigPath
    Assert-NikoFLastExitCode -Action 'Run bootstrap validation'

    Write-NikoFStep -Message 'Validating repo contracts'
    & powershell -ExecutionPolicy Bypass -File $contractValidationScript
    Assert-NikoFLastExitCode -Action 'Run contract validation'

    Write-NikoFStep -Message 'Running backend prerequisite tests'
    Push-Location $backendRoot
    try {
        & $PythonExe -m unittest tests.test_runtime_bindings tests.test_stt_sidecar_runtime tests.test_tts_sidecar_runtime tests.test_dev_server
        Assert-NikoFLastExitCode -Action 'Run backend prerequisite tests'

        if (Test-NikoFPayloadProof -RootPath $sttModelRoot -ScaffoldArtifactNames @('runtime.json', 'install-plan.json')) {
            Write-NikoFStep -Message 'Checking STT sidecar configuration'
            & $PythonExe -c "from app.core.settings import get_app_paths; from app.services.stt_server import FasterWhisperServerManager, load_server_config; manager = FasterWhisperServerManager(load_server_config(get_app_paths())); raise SystemExit(0 if manager.server_configured else 1)"
            Assert-NikoFLastExitCode -Action 'Check STT sidecar configuration'
        }

        $ttsProviderEntrypoint = Join-Path $ttsProviderRoot 'api_server.py'
        if ((Test-NikoFPayloadProof -RootPath $ttsModelRoot -ScaffoldArtifactNames @('runtime.json', 'install-plan.json')) -and (Test-Path -LiteralPath $ttsProviderEntrypoint -PathType Leaf)) {
            Write-NikoFStep -Message 'Checking GPT-SoVITS sidecar startup'
            & $PythonExe -c "from app.core.settings import get_app_paths; from app.services.tts_server import GPTSoVITSServerManager, load_server_config; manager = GPTSoVITSServerManager(load_server_config(get_app_paths())); started = manager.start(); healthy = manager.is_healthy; manager.stop(); raise SystemExit(0 if (started and healthy) else 1)"
            Assert-NikoFLastExitCode -Action 'Check GPT-SoVITS sidecar startup'
        }
    }
    finally {
        Pop-Location
    }
}

Write-NikoFStep -Message 'Preparing managed local roots'
Write-Host ('Repo root        : {0}' -f $repoRoot)
Write-Host ('Local data root  : {0}' -f $storageLayout.local_data_root)
Write-Host ('Models root      : {0}' -f $storageLayout.models_root)
Write-Host ('Providers root   : {0}' -f $storageLayout.providers_root)
Write-Host ('Session env file : {0}' -f $envFilePath)

if ($InstallBaseToolchain) {
    Ensure-NikoFBaseToolchain
}

$resolvedPythonExe = $null
if ($InstallRepoDependencies -or $InstallFasterWhisperMedium -or $InstallFasterWhisperSmall -or $InstallBgeSmallEmbeddings -or $InstallMiniLmEmbeddings -or $Validate) {
    $resolvedPythonExe = Ensure-NikoFBackendVirtualEnv
}

if ($InstallRepoDependencies) {
    Ensure-NikoFFrontendDependencies
}

if ($InstallOllama) {
    Ensure-NikoFOllamaInstalled
}

if ($PullOllamaModel) {
    Write-NikoFStep -Message 'Pulling Ollama baseline model'
    & powershell -ExecutionPolicy Bypass -File $bootstrapScript -LocalRoot $storageLayout.local_data_root -ConfigPath $ConfigPath -RunHook ollama-pull-llama3.1-8b
    Assert-NikoFLastExitCode -Action 'Pull Ollama baseline model'
}

if ($InstallFasterWhisperMedium) {
    if (-not $resolvedPythonExe) {
        $resolvedPythonExe = Ensure-NikoFBackendVirtualEnv
    }

    Install-NikoFFasterWhisperMediumModel -PythonExe $resolvedPythonExe
    Ensure-NikoFSttProviderWrappers -PythonExe $resolvedPythonExe
}

if ($InstallFasterWhisperSmall) {
    if (-not $resolvedPythonExe) {
        $resolvedPythonExe = Ensure-NikoFBackendVirtualEnv
    }

    Install-NikoFFasterWhisperSmallModel -PythonExe $resolvedPythonExe
}

if ($InstallBgeSmallEmbeddings) {
    if (-not $resolvedPythonExe) {
        $resolvedPythonExe = Ensure-NikoFBackendVirtualEnv
    }

    Install-NikoFBgeSmallEmbeddings -PythonExe $resolvedPythonExe
}

if ($InstallMiniLmEmbeddings) {
    if (-not $resolvedPythonExe) {
        $resolvedPythonExe = Ensure-NikoFBackendVirtualEnv
    }

    Install-NikoFMiniLmEmbeddings -PythonExe $resolvedPythonExe
}

if ($InstallGptSovitsV2Pro) {
    Install-NikoFGptSovitsV2ProPayload
}

if ($StageRepoTtsServer) {
    Stage-NikoFRepoTtsServer
}

if ($TtsProviderSourcePath) {
    Copy-NikoFDirectoryContents -SourcePath $TtsProviderSourcePath -DestinationPath $ttsProviderRoot -Label 'GPT-SoVITS provider runtime'
}

if ($TtsModelSourcePath) {
    Copy-NikoFDirectoryContents -SourcePath $TtsModelSourcePath -DestinationPath $ttsModelRoot -Label 'GPT-SoVITS model payload'
}

if ($Validate) {
    if (-not $resolvedPythonExe) {
        $resolvedPythonExe = Ensure-NikoFBackendVirtualEnv
    }

    Invoke-NikoFValidation -PythonExe $resolvedPythonExe
}

Write-NikoFStep -Message 'Installer finished'
Write-Host 'Next recommended manual checks:'
Write-Host ('  1. Dot-source {0} in a new PowerShell session if you want the managed local roots loaded interactively.' -f $envFilePath)
Write-Host ('  2. Start the backend with {0} -m app.dev_server from {1}.' -f $venvPython, $backendRoot)
Write-Host ('  3. If you want the installer to acquire GPT-SoVITS v2Pro directly, rerun it with -InstallGptSovitsV2Pro.')
Write-Host ('  4. GPT-SoVITS synthesis still needs speakers\default.json plus at least one reference wav under {0}.' -f (Join-Path $ttsModelRoot 'reference-audio'))