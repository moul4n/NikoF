<#
.SYNOPSIS
    NikoF startup "doctor": verifies the machine can actually run the stack, not just
    that prerequisite folders exist.

.DESCRIPTION
    bootstrap.ps1 reports payload *presence*. This preflight goes further and reports
    real *readiness*: tested tool-version ranges, .venv integrity, frontend deps,
    GPU/VRAM capacity, a reachable Ollama daemon with the baseline model, and whether
    GPT-SoVITS can actually synthesise (speaker manifest + reference audio), not just
    whether its payload is on disk.

    Every check resolves to one status:
      ready          - good to go
      warn           - non-blocking advisory (e.g. low VRAM, newer-than-tested runtime)
      auto-fixable    - missing/broken but the safe installer can repair it
      manual-handoff  - needs a human (vendor asset, out-of-range interpreter, etc.)

    The single start-all supervisor calls this first. With -Fix it drives the existing
    install-prerequisites.ps1 safe lane, then re-checks. Exit code is 0 only when no
    auto-fixable or manual-handoff blockers remain, so a launcher can gate on it.

.NOTES
    Windows-first. Read-only unless -Fix is passed.
#>
[CmdletBinding()]
param(
    [string]$LocalRoot,
    [string]$ConfigPath,
    [switch]$Fix,
    [switch]$DryRun,
    [switch]$Json,
    [switch]$Quiet,
    # Tested runtime ranges. The repo declares only requires-python>=3.10, but native
    # wheels (torch / faster-whisper / ctranslate2) lag new interpreters, so we pin a
    # tested ceiling here rather than trusting the loose declaration.
    [version]$PythonMinVersion = '3.10',
    [version]$PythonMaxVersion = '3.12',
    [int[]]$NodeSupportedMajors = @(20, 22, 24),
    [int]$MinVramGb = 10,
    [string]$OllamaEndpoint = 'http://127.0.0.1:11434',
    # Active engine selection. Canonical stack = Kokoro / Parakeet / qwen3:4b
    # (docs/TTS_ENGINE_BENCHMARK.md). Honour env overrides if a shell already set them;
    # otherwise default to the canonical stack that start-all configures.
    [string]$TtsEngine = $(if ($env:NIKOF_TTS_ENGINE) { $env:NIKOF_TTS_ENGINE } else { 'kokoro' }),
    [string]$SttEngine = $(if ($env:NIKOF_STT_ENGINE) { $env:NIKOF_STT_ENGINE } else { 'parakeet' }),
    [string]$BaselineOllamaModel = $(if ($env:NIKOF_LLM_MODEL) { $env:NIKOF_LLM_MODEL } else { 'qwen3:4b' })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $false
}

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $PSScriptRoot 'bootstrap.targets.json'
}

. (Join-Path $PSScriptRoot 'Test-NikoFPrerequisites.ps1')

$repoRoot = Get-NikoFRepoRoot -ScriptRoot $PSScriptRoot
$config = Get-NikoFBootstrapConfig -ConfigPath $ConfigPath
$storageLayout = Get-NikoFStorageLayout -RepoRoot $repoRoot -Config $config -LocalRootOverride $LocalRoot
[void](Initialize-NikoFStorageLayout -StorageLayout $storageLayout)

$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
$frontendModules = Join-Path $repoRoot 'frontend\node_modules'
$installerScript = Join-Path $PSScriptRoot 'install-prerequisites.ps1'

# --- check accumulator ------------------------------------------------------

$script:Checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Category,
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][ValidateSet('ready', 'warn', 'auto-fixable', 'manual-handoff')][string]$Status,
        [string]$Detail = '',
        [string]$Fix = ''
    )

    $script:Checks.Add([pscustomobject]@{
            id       = $Id
            category = $Category
            title    = $Title
            status   = $Status
            detail   = $Detail
            fix      = $Fix
        })
}

function Get-NikoFCommandVersionString {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $resolved = Resolve-NikoFCommandPath -Command $Command
    if (-not $resolved) {
        return $null
    }

    try {
        return ((& $resolved @Arguments 2>&1) | Out-String).Trim()
    }
    catch {
        return $null
    }
}

function Resolve-NikoFSemanticVersion {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $match = [regex]::Match($Text, '(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $match.Success) {
        return $null
    }

    $patch = if ($match.Groups[3].Success) { [int]$match.Groups[3].Value } else { 0 }
    return [version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, $patch)
}

# --- 1. base tooling: presence + tested version ceilings --------------------

function Test-PythonTooling {
    # The launcher path: what a fresh `py -3 -m venv` would actually use.
    $versionText = Get-NikoFCommandVersionString -Command 'py' -Arguments @('-3', '--version')
    if (-not $versionText) {
        $versionText = Get-NikoFCommandVersionString -Command 'python' -Arguments @('--version')
    }

    if (-not $versionText) {
        Add-Check -Id 'tool-python' -Category 'Toolchain' -Title 'Python interpreter' -Status 'auto-fixable' `
            -Detail 'No system Python found via the py launcher or python on PATH.' `
            -Fix "install-prerequisites.ps1 -InstallBaseToolchain (installs Python $PythonMaxVersion via winget)"
        return
    }

    $version = Resolve-NikoFSemanticVersion -Text $versionText
    if (-not $version) {
        Add-Check -Id 'tool-python' -Category 'Toolchain' -Title 'Python interpreter' -Status 'warn' `
            -Detail "Found Python but could not parse a version from '$versionText'."
        return
    }

    $minor = [version]::new($version.Major, $version.Minor)
    if ($minor -lt [version]::new($PythonMinVersion.Major, $PythonMinVersion.Minor)) {
        Add-Check -Id 'tool-python' -Category 'Toolchain' -Title 'Python interpreter' -Status 'auto-fixable' `
            -Detail "System Python $version is older than the supported floor $PythonMinVersion." `
            -Fix "install-prerequisites.ps1 -InstallBaseToolchain"
        return
    }

    if ($minor -gt [version]::new($PythonMaxVersion.Major, $PythonMaxVersion.Minor)) {
        Add-Check -Id 'tool-python' -Category 'Toolchain' -Title 'Python interpreter' -Status 'warn' `
            -Detail ("System 'py -3' resolves to Python $version, newer than the tested ceiling $PythonMaxVersion. " +
                "Native wheels (torch / faster-whisper / ctranslate2) may not exist for it. " +
                "The .venv check below is what actually matters; install-prerequisites.ps1 creates the venv with Python $PythonMaxVersion when present.") `
            -Fix "install-prerequisites.ps1 -InstallBaseToolchain (adds Python $PythonMaxVersion alongside it)"
        return
    }

    Add-Check -Id 'tool-python' -Category 'Toolchain' -Title 'Python interpreter' -Status 'ready' -Detail "$version (within $PythonMinVersion-$PythonMaxVersion)."
}

function Test-NodeTooling {
    $versionText = Get-NikoFCommandVersionString -Command 'node' -Arguments @('--version')
    if (-not $versionText) {
        Add-Check -Id 'tool-node' -Category 'Toolchain' -Title 'Node.js' -Status 'auto-fixable' `
            -Detail 'Node.js not found on PATH.' `
            -Fix "install-prerequisites.ps1 -InstallBaseToolchain (installs Node.js LTS via winget)"
        return
    }

    $version = Resolve-NikoFSemanticVersion -Text $versionText
    if (-not $version) {
        Add-Check -Id 'tool-node' -Category 'Toolchain' -Title 'Node.js' -Status 'warn' -Detail "Found Node but could not parse '$versionText'."
        return
    }

    if ($NodeSupportedMajors -contains $version.Major) {
        Add-Check -Id 'tool-node' -Category 'Toolchain' -Title 'Node.js' -Status 'ready' -Detail "v$version (supported LTS line)."
        return
    }

    $isEvenLts = ($version.Major % 2) -eq 0
    $status = if ($isEvenLts) { 'warn' } else { 'warn' }
    $lineNote = if ($isEvenLts) { 'an LTS line but newer than tested' } else { 'an odd/non-LTS line' }
    Add-Check -Id 'tool-node' -Category 'Toolchain' -Title 'Node.js' -Status $status `
        -Detail "v$version is $lineNote. Tested majors: $($NodeSupportedMajors -join ', '). Vite/three builds usually tolerate this; pin an LTS if you hit native-module errors." `
        -Fix "install-prerequisites.ps1 -InstallBaseToolchain"
}

function Test-GitTooling {
    $versionText = Get-NikoFCommandVersionString -Command 'git' -Arguments @('--version')
    if ($versionText) {
        Add-Check -Id 'tool-git' -Category 'Toolchain' -Title 'Git' -Status 'ready' -Detail $versionText
    }
    else {
        Add-Check -Id 'tool-git' -Category 'Toolchain' -Title 'Git' -Status 'auto-fixable' `
            -Detail 'Git not found on PATH.' -Fix "install-prerequisites.ps1 -InstallBaseToolchain"
    }
}

# --- 2. environment integrity ----------------------------------------------

function Test-BackendVenv {
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        Add-Check -Id 'env-venv' -Category 'Environment' -Title 'Backend .venv' -Status 'auto-fixable' `
            -Detail "No virtualenv interpreter at $venvPython." `
            -Fix "install-prerequisites.ps1 -InstallRepoDependencies"
        return
    }

    $venvVersionText = $null
    try {
        $venvVersionText = ((& $venvPython -c "import sys;print('%d.%d.%d'%sys.version_info[:3])" 2>&1) | Out-String).Trim()
    }
    catch {
        $venvVersionText = $null
    }

    $venvVersion = if ($venvVersionText) { Resolve-NikoFSemanticVersion -Text $venvVersionText } else { $null }
    if ($venvVersion) {
        $venvMinor = [version]::new($venvVersion.Major, $venvVersion.Minor)
        if ($venvMinor -lt [version]::new($PythonMinVersion.Major, $PythonMinVersion.Minor) -or
            $venvMinor -gt [version]::new($PythonMaxVersion.Major, $PythonMaxVersion.Minor)) {
            Add-Check -Id 'env-venv-version' -Category 'Environment' -Title 'Backend .venv interpreter' -Status 'manual-handoff' `
                -Detail ("The existing .venv runs Python $venvVersion, outside the tested $PythonMinVersion-$PythonMaxVersion range. " +
                    "Recreate it against a supported interpreter to avoid wheel/runtime breakage.") `
                -Fix "install-prerequisites.ps1 -InstallRepoDependencies -ForceRecreateVenv"
        }
        else {
            Add-Check -Id 'env-venv-version' -Category 'Environment' -Title 'Backend .venv interpreter' -Status 'ready' -Detail "Python $venvVersion."
        }
    }

    # Importability of core backend deps proves the venv is actually populated.
    $importOk = $false
    try {
        & $venvPython -c "import fastapi, uvicorn, psutil" 2>$null
        $importOk = ($LASTEXITCODE -eq 0)
    }
    catch {
        $importOk = $false
    }

    if ($importOk) {
        Add-Check -Id 'env-venv-deps' -Category 'Environment' -Title 'Backend dependencies' -Status 'ready' -Detail 'fastapi, uvicorn, psutil import cleanly.'
    }
    else {
        Add-Check -Id 'env-venv-deps' -Category 'Environment' -Title 'Backend dependencies' -Status 'auto-fixable' `
            -Detail 'Core backend imports (fastapi/uvicorn/psutil) failed; the venv exists but is not fully installed.' `
            -Fix "install-prerequisites.ps1 -InstallRepoDependencies"
    }
}

function Test-FrontendDependencies {
    if (Test-Path -LiteralPath $frontendModules -PathType Container) {
        Add-Check -Id 'env-frontend' -Category 'Environment' -Title 'Frontend dependencies' -Status 'ready' -Detail 'frontend/node_modules present.'
    }
    else {
        Add-Check -Id 'env-frontend' -Category 'Environment' -Title 'Frontend dependencies' -Status 'auto-fixable' `
            -Detail 'frontend/node_modules is missing.' -Fix "install-prerequisites.ps1 -InstallRepoDependencies"
    }
}

# --- 3. GPU / VRAM (probe + warn, per project decision) ---------------------

function Test-GpuVram {
    $smi = Resolve-NikoFCommandPath -Command 'nvidia-smi'
    if (-not $smi) {
        Add-Check -Id 'gpu-vram' -Category 'Hardware' -Title 'NVIDIA GPU / VRAM' -Status 'warn' `
            -Detail 'nvidia-smi not found. Cannot confirm GPU capacity; models will fall back to CPU and run slowly if no CUDA GPU is present.'
        return
    }

    $totalMib = $null
    try {
        $line = ((& $smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null) | Select-Object -First 1)
        if ($line) { $totalMib = [int]($line.Trim()) }
    }
    catch {
        $totalMib = $null
    }

    if (-not $totalMib) {
        Add-Check -Id 'gpu-vram' -Category 'Hardware' -Title 'NVIDIA GPU / VRAM' -Status 'warn' -Detail 'nvidia-smi present but VRAM query returned no value.'
        return
    }

    $totalGb = [math]::Round($totalMib / 1024.0, 1)
    if ($totalGb -ge $MinVramGb) {
        Add-Check -Id 'gpu-vram' -Category 'Hardware' -Title 'NVIDIA GPU / VRAM' -Status 'ready' -Detail "$totalGb GB VRAM detected."
    }
    else {
        Add-Check -Id 'gpu-vram' -Category 'Hardware' -Title 'NVIDIA GPU / VRAM' -Status 'warn' `
            -Detail ("$totalGb GB VRAM detected (below the $MinVramGb GB comfort line). " +
                "Prefer Faster-Whisper Small for STT and avoid keeping STT+TTS+LLM all resident at once. " +
                "Set the STT model to 'small' in NIKOF_STT_MODELS_ROOT\faster-whisper-medium\runtime.json or install the small payload with -InstallFasterWhisperSmall.")
    }
}

# --- 4. provider payloads (reuse bootstrap status) --------------------------

function Test-ProviderPayloads {
    # bootstrap.targets.json is the LEGACY engine catalog. With the perf stack canonical,
    # the legacy TTS/STT/LLM payloads are optional fallback, not blockers — the active
    # engines are gated separately in Test-ActiveEngineReadiness. Ollama itself stays
    # required (the LLM runs through it regardless of model).
    $legacyFallbackIds = @(
        'llm-model-ollama-llama3.1-8b', 'stt-medium', 'stt-provider-entrypoint', 'stt-small',
        'tts-model-gpt-sovits', 'tts-provider-entrypoint'
    )
    $providerResults = @(Get-NikoFProviderStatus -Config $config -StorageLayout $storageLayout)
    foreach ($provider in $providerResults) {
        $required = if ($provider.PSObject.Properties.Name -contains 'required') { [bool]$provider.required } else { $true }
        if ($provider.id -in $legacyFallbackIds) { $required = $false }
        $state = Get-NikoFProviderStateLabel -ProviderResult $provider

        if ($state -eq 'ready') {
            Add-Check -Id ("provider-" + $provider.id) -Category 'Providers' -Title $provider.display_name -Status 'ready' -Detail "Payload present: $($provider.expected_path)"
            continue
        }

        if (-not $required) {
            Add-Check -Id ("provider-" + $provider.id) -Category 'Providers' -Title $provider.display_name -Status 'warn' `
                -Detail "Optional payload not present ($state): $($provider.expected_path)"
            continue
        }

        # Required + not ready. Ollama model + Faster-Whisper are safe-installable;
        # GPT-SoVITS is a vendor handoff.
        $autoFixable = $provider.id -in @('llm-model-ollama-llama3.1-8b', 'stt-medium', 'stt-provider-entrypoint', 'provider-ollama')
        $status = if ($autoFixable) { 'auto-fixable' } else { 'manual-handoff' }
        $fix = if ($provider.hook_command) { $provider.hook_command } elseif ($provider.manual_install) { $provider.manual_install } else { '' }
        Add-Check -Id ("provider-" + $provider.id) -Category 'Providers' -Title $provider.display_name -Status $status `
            -Detail "Required payload not ready ($state): $($provider.expected_path)" -Fix $fix
    }
}

# --- 5. active engine readiness (what start-all will actually run) ----------
# These gate the launch: start-all hard-stops when the configured engine's model
# is missing. Checks the SELECTED engine (canonical: Kokoro TTS / Parakeet STT),
# not just whether some payload exists on disk.

function Test-ActiveEngineReadiness {
    # --- TTS ---
    $ttsName = $TtsEngine.Trim().ToLowerInvariant()
    switch ($ttsName) {
        'kokoro' {
            $kokoroDir = Join-Path $storageLayout.tts_models_root 'kokoro'
            $modelPath = Join-Path $kokoroDir 'kokoro-v1.0.onnx'
            $voicesPath = Join-Path $kokoroDir 'voices-v1.0.bin'
            if ((Test-Path -LiteralPath $modelPath -PathType Leaf) -and (Test-Path -LiteralPath $voicesPath -PathType Leaf)) {
                Add-Check -Id 'engine-tts' -Category 'Active engines' -Title 'TTS engine (Kokoro)' -Status 'ready' -Detail 'kokoro-v1.0.onnx + voices-v1.0.bin present.'
            }
            else {
                Add-Check -Id 'engine-tts' -Category 'Active engines' -Title 'TTS engine (Kokoro)' -Status 'auto-fixable' `
                    -Detail "Kokoro model files missing under $kokoroDir (need kokoro-v1.0.onnx + voices-v1.0.bin)." `
                    -Fix 'install-prerequisites.ps1 -InstallKokoro'
            }
        }
        'gpt-sovits' {
            $ttsRoot = Join-Path $storageLayout.tts_models_root 'gpt-sovits'
            $speakerManifest = Join-Path $ttsRoot 'speakers\default.json'
            $referenceRoot = Join-Path $ttsRoot 'reference-audio'
            $speakerOk = Test-Path -LiteralPath $speakerManifest -PathType Leaf
            $refCount = 0
            if (Test-Path -LiteralPath $referenceRoot -PathType Container) {
                $refCount = @(Get-ChildItem -LiteralPath $referenceRoot -File -ErrorAction SilentlyContinue).Count
            }
            if ($speakerOk -and $refCount -gt 0) {
                Add-Check -Id 'engine-tts' -Category 'Active engines' -Title 'TTS engine (GPT-SoVITS)' -Status 'ready' -Detail "Voice profile present ($refCount reference clip(s))."
            }
            else {
                Add-Check -Id 'engine-tts' -Category 'Active engines' -Title 'TTS engine (GPT-SoVITS)' -Status 'manual-handoff' `
                    -Detail "GPT-SoVITS synthesis needs a voice profile (speakers\default.json + a reference wav) under $ttsRoot." `
                    -Fix "Place an approved speakers\default.json and a reference clip under $referenceRoot, then re-run preflight."
            }
        }
        default {
            Add-Check -Id 'engine-tts' -Category 'Active engines' -Title "TTS engine ($TtsEngine)" -Status 'warn' `
                -Detail "NIKOF_TTS_ENGINE='$TtsEngine' is not a recognised engine; the backend will fall back to its default. Preflight cannot verify its model."
        }
    }

    # --- STT ---
    $sttName = $SttEngine.Trim().ToLowerInvariant()
    switch ($sttName) {
        'parakeet' {
            $parakeetDir = Join-Path $storageLayout.stt_models_root 'parakeet-tdt-0.6b-v2'
            $hasPayload = (Test-Path -LiteralPath $parakeetDir -PathType Container) -and `
                (@(Get-ChildItem -LiteralPath $parakeetDir -File -Recurse -ErrorAction SilentlyContinue).Count -gt 0)
            if ($hasPayload) {
                Add-Check -Id 'engine-stt' -Category 'Active engines' -Title 'STT engine (Parakeet)' -Status 'ready' -Detail "Model present under $parakeetDir."
            }
            else {
                Add-Check -Id 'engine-stt' -Category 'Active engines' -Title 'STT engine (Parakeet)' -Status 'auto-fixable' `
                    -Detail "Parakeet model missing under $parakeetDir." `
                    -Fix 'install-prerequisites.ps1 -InstallParakeet  (add -HfEndpoint https://hf-mirror.com if huggingface.co is blocked)'
            }
        }
        'faster-whisper' {
            $fwDir = Join-Path $storageLayout.stt_models_root 'faster-whisper-medium'
            $hasPayload = (Test-Path -LiteralPath $fwDir -PathType Container) -and `
                (@(Get-ChildItem -LiteralPath $fwDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('runtime.json', 'install-plan.json') }).Count -gt 0)
            if ($hasPayload) {
                Add-Check -Id 'engine-stt' -Category 'Active engines' -Title 'STT engine (Faster-Whisper)' -Status 'ready' -Detail "Model present under $fwDir."
            }
            else {
                Add-Check -Id 'engine-stt' -Category 'Active engines' -Title 'STT engine (Faster-Whisper)' -Status 'auto-fixable' `
                    -Detail "Faster-Whisper Medium model missing under $fwDir." -Fix 'install-prerequisites.ps1 -InstallFasterWhisperMedium'
            }
        }
        default {
            Add-Check -Id 'engine-stt' -Category 'Active engines' -Title "STT engine ($SttEngine)" -Status 'warn' `
                -Detail "NIKOF_STT_ENGINE='$SttEngine' is not a recognised engine; the backend will fall back to its default. Preflight cannot verify its model."
        }
    }
}

# --- 6. Ollama daemon + baseline model -------------------------------------

function Test-OllamaDaemon {
    $tagsUrl = ($OllamaEndpoint.TrimEnd('/')) + '/api/tags'
    $models = $null
    try {
        $resp = Invoke-RestMethod -Uri $tagsUrl -TimeoutSec 4 -ErrorAction Stop
        if ($resp -and ($resp.PSObject.Properties.Name -contains 'models') -and $resp.models) {
            $models = @($resp.models | ForEach-Object { $_.name })
        }
        else {
            $models = @()
        }
    }
    catch {
        $models = $null
    }

    if ($null -eq $models) {
        $ollamaInstalled = $null -ne (Resolve-NikoFCommandPath -Command 'ollama')
        $detail = if ($ollamaInstalled) {
            "Ollama is installed but the daemon did not answer at $OllamaEndpoint. It usually starts on demand; the backend will start it if owned, or run 'ollama serve'."
        }
        else {
            "No Ollama daemon reachable at $OllamaEndpoint and the ollama command was not found."
        }
        $pullFlag = if ($BaselineOllamaModel -like 'qwen3*') { '-PullQwen3' } else { '-PullOllamaModel' }
        $status = if ($ollamaInstalled) { 'warn' } else { 'auto-fixable' }
        $fix = if ($ollamaInstalled) { '' } else { "install-prerequisites.ps1 -InstallOllama $pullFlag" }
        Add-Check -Id 'ollama-daemon' -Category 'Active engines' -Title 'LLM (Ollama daemon)' -Status $status -Detail $detail -Fix $fix
        return
    }

    $hasBaseline = $false
    foreach ($name in $models) {
        if ($name -eq $BaselineOllamaModel -or $name -like ($BaselineOllamaModel + '*')) { $hasBaseline = $true; break }
    }

    if ($hasBaseline) {
        Add-Check -Id 'ollama-daemon' -Category 'Active engines' -Title "LLM (Ollama: $BaselineOllamaModel)" -Status 'ready' -Detail "Daemon up; model '$BaselineOllamaModel' present."
    }
    else {
        $pullFlag = if ($BaselineOllamaModel -like 'qwen3*') { '-PullQwen3' } else { '-PullOllamaModel' }
        Add-Check -Id 'ollama-daemon' -Category 'Active engines' -Title "LLM (Ollama: $BaselineOllamaModel)" -Status 'auto-fixable' `
            -Detail "Daemon up at $OllamaEndpoint but model '$BaselineOllamaModel' is not pulled. Found: $([string]::Join(', ', $models))" `
            -Fix "install-prerequisites.ps1 $pullFlag"
    }
}

# --- run all checks ---------------------------------------------------------

function Invoke-AllChecks {
    $script:Checks.Clear()
    Test-GitTooling
    Test-PythonTooling
    Test-NodeTooling
    Test-BackendVenv
    Test-FrontendDependencies
    Test-GpuVram
    Test-ProviderPayloads
    Test-ActiveEngineReadiness
    Test-OllamaDaemon
}

function Get-CheckCounts {
    # Materialise the List[object] to object[] before piping: enumerating a generic
    # List through @()/Where-Object trips a PowerShell interpreter binder bug
    # ("Argument types do not match" from PSToObjectArrayBinder). Hyphen-free property
    # names keep the result safe to embed in a pscustomobject literal.
    $all = $script:Checks.ToArray()
    return [pscustomobject]@{
        ready         = @($all | Where-Object { $_.status -eq 'ready' }).Count
        warn          = @($all | Where-Object { $_.status -eq 'warn' }).Count
        autoFixable   = @($all | Where-Object { $_.status -eq 'auto-fixable' }).Count
        manualHandoff = @($all | Where-Object { $_.status -eq 'manual-handoff' }).Count
    }
}

function Write-PreflightSummary {
    $statusGlyphs = @{ 'ready' = 'OK  '; 'warn' = 'WARN'; 'auto-fixable' = 'FIX '; 'manual-handoff' = 'STOP' }

    Write-Host ''
    Write-Host '== NikoF Preflight =='
    $currentCategory = ''
    foreach ($check in $script:Checks) {
        if ($check.category -ne $currentCategory) {
            $currentCategory = $check.category
            Write-Host ''
            Write-Host ("[{0}]" -f $currentCategory)
        }
        Write-Host ("  {0}  {1}" -f $statusGlyphs[$check.status], $check.title)
        if ($check.detail) { Write-Host ("        {0}" -f $check.detail) }
        if ($check.fix -and $check.status -ne 'ready') { Write-Host ("        -> {0}" -f $check.fix) }
    }

    $counts = Get-CheckCounts
    Write-Host ''
    Write-Host ("Summary: {0} ready, {1} warn, {2} auto-fixable, {3} manual-handoff" -f $counts.ready, $counts.warn, $counts.autoFixable, $counts.manualHandoff)
    Write-Host ''
}

function Export-PreflightReport {
    $reportPath = Join-Path $storageLayout.report_root 'preflight-report.json'
    $reportDir = Split-Path -Parent $reportPath
    if (-not (Test-Path -LiteralPath $reportDir)) {
        New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
    }

    # Compute embedded values into locals first; evaluating function calls inside an
    # [ordered]@{} literal can raise a spurious "Argument types do not match".
    $countsValue = Get-CheckCounts
    $checksValue = $script:Checks.ToArray()
    $generatedAt = (Get-Date).ToString('o')
    $rangesValue = [pscustomobject]@{
        python_min     = $PythonMinVersion.ToString()
        python_max     = $PythonMaxVersion.ToString()
        node_supported = $NodeSupportedMajors
        min_vram_gb    = $MinVramGb
    }

    $payload = [pscustomobject]@{
        generated_at = $generatedAt
        repo_root    = $repoRoot
        ranges       = $rangesValue
        counts       = $countsValue
        checks       = $checksValue
    }
    $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    return $reportPath
}

Invoke-AllChecks

if ($Fix) {
    $autoFixable = @($script:Checks.ToArray() | Where-Object { $_.status -eq 'auto-fixable' })
    if ($autoFixable.Count -gt 0) {
        if ($DryRun) {
            Write-Host ''
            Write-Host ("[DryRun] {0} auto-fixable item(s) would be repaired via the safe installer lane:" -f $autoFixable.Count)
            foreach ($check in $autoFixable) { Write-Host ("  - {0}: {1}" -f $check.title, $check.fix) }
            Write-Host '[DryRun] Would run: install-prerequisites.ps1 -AllSafe'
        }
        else {
            Write-Host ''
            Write-Host ("Repairing {0} auto-fixable item(s) via install-prerequisites.ps1 -AllSafe ..." -f $autoFixable.Count)
            & powershell -ExecutionPolicy Bypass -File $installerScript -LocalRoot $storageLayout.local_data_root -ConfigPath $ConfigPath -AllSafe
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Safe installer exited with code $LASTEXITCODE; re-running checks to report what remains."
            }
            Invoke-AllChecks
        }
    }
    else {
        Write-Host ''
        Write-Host 'No auto-fixable items; nothing for the safe installer to repair.'
    }
}

if (-not $Quiet) {
    Write-PreflightSummary
}

$reportPath = Export-PreflightReport
if (-not $Quiet) {
    Write-Host ("Report: {0}" -f $reportPath)
}

if ($Json) {
    $script:Checks.ToArray() | ConvertTo-Json -Depth 6
}

$counts = Get-CheckCounts
$blockers = $counts.autoFixable + $counts.manualHandoff
if ($blockers -gt 0) {
    exit 1
}
exit 0
