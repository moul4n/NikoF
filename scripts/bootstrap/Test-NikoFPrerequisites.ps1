Set-StrictMode -Version Latest

function Get-NikoFBootstrapConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ConfigPath
    )

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Bootstrap config not found: $ConfigPath"
    }

    return Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

function Get-NikoFRepoRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ScriptRoot
    )

    return (Resolve-Path (Join-Path $ScriptRoot "..\..\")).Path
}

function Get-NikoFStorageLayout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,

        [Parameter(Mandatory)]
        [pscustomobject]$Config,

        [string]$LocalRootOverride
    )

    $resolvedLocalRoot = $LocalRootOverride
    if (-not $resolvedLocalRoot) {
        if ($env:NIKOF_LOCAL_ROOT) {
            $resolvedLocalRoot = $env:NIKOF_LOCAL_ROOT
        }
        elseif ($env:LOCALAPPDATA) {
            $resolvedLocalRoot = Join-Path $env:LOCALAPPDATA "NikoF"
        }
        else {
            $resolvedLocalRoot = Join-Path $RepoRoot $Config.storage.repoLocalFallbackRoot
        }
    }

    $modelsRoot = if ($env:NIKOF_MODELS_ROOT) { $env:NIKOF_MODELS_ROOT } else { Join-Path $resolvedLocalRoot "models" }

    return [pscustomobject]@{
        local_data_root = $resolvedLocalRoot
        models_root = $modelsRoot
        llm_models_root = if ($env:NIKOF_LLM_MODELS_ROOT) { $env:NIKOF_LLM_MODELS_ROOT } else { Join-Path $modelsRoot "llm" }
        stt_models_root = if ($env:NIKOF_STT_MODELS_ROOT) { $env:NIKOF_STT_MODELS_ROOT } else { Join-Path $modelsRoot "stt" }
        tts_models_root = if ($env:NIKOF_TTS_MODELS_ROOT) { $env:NIKOF_TTS_MODELS_ROOT } else { Join-Path $modelsRoot "tts" }
        embeddings_root = if ($env:NIKOF_EMBEDDINGS_ROOT) { $env:NIKOF_EMBEDDINGS_ROOT } else { Join-Path $modelsRoot "embeddings" }
        providers_root = if ($env:NIKOF_PROVIDERS_ROOT) { $env:NIKOF_PROVIDERS_ROOT } else { Join-Path $resolvedLocalRoot "providers" }
        cache_root = if ($env:NIKOF_CACHE_ROOT) { $env:NIKOF_CACHE_ROOT } else { Join-Path $resolvedLocalRoot "cache" }
        report_root = Join-Path $RepoRoot $Config.storage.reportRoot
    }
}

function Initialize-NikoFStorageLayout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout
    )

    $createdPaths = @()
    foreach ($pathValue in @(
        $StorageLayout.local_data_root,
        $StorageLayout.models_root,
        $StorageLayout.llm_models_root,
        $StorageLayout.stt_models_root,
        $StorageLayout.tts_models_root,
        $StorageLayout.embeddings_root,
        $StorageLayout.providers_root,
        $StorageLayout.cache_root,
        $StorageLayout.report_root
    )) {
        if (-not (Test-Path -LiteralPath $pathValue)) {
            New-Item -ItemType Directory -Path $pathValue -Force | Out-Null
            $createdPaths += $pathValue
        }
    }

    return $createdPaths
}

function Test-NikoFTooling {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Config
    )

    $results = @()

    foreach ($tool in $Config.tools) {
        $commandInfo = Get-Command $tool.command -ErrorAction SilentlyContinue
        $output = $null
        $isAvailable = $false

        if ($commandInfo) {
            try {
                $commandOutput = & $tool.command @($tool.args) 2>&1
                $output = ($commandOutput | Out-String).Trim()
                $isAvailable = $true
            }
            catch {
                $output = $_.Exception.Message
            }
        }

        $results += [pscustomobject]@{
            id = $tool.id
            display_name = $tool.displayName
            command = $tool.command
            args = @($tool.args)
            available = $isAvailable
            output = $output
            install_url = $tool.installUrl
            manual_install = $tool.manualInstall
        }
    }

    return $results
}

function Get-NikoFProviderStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Config,

        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout
    )

    $results = @()

    foreach ($provider in $Config.providers) {
        $rootPath = $StorageLayout.($provider.rootKey)
        $expectedPath = Join-Path $rootPath $provider.expectedRelativePath
        $results += [pscustomobject]@{
            id = $provider.id
            display_name = $provider.displayName
            root_key = $provider.rootKey
            expected_path = $expectedPath
            present = Test-Path -LiteralPath $expectedPath
            upstream = $provider.upstream
            manual_install = $provider.manualInstall
        }
    }

    return $results
}

function Export-NikoFSessionEnvFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout,

        [Parameter(Mandatory)]
        [pscustomobject]$Config
    )

    $envFilePath = Join-Path $StorageLayout.report_root $Config.storage.envFileName
    $lines = @(
        '$env:NIKOF_LOCAL_ROOT = "' + $StorageLayout.local_data_root + '"',
        '$env:NIKOF_MODELS_ROOT = "' + $StorageLayout.models_root + '"',
        '$env:NIKOF_LLM_MODELS_ROOT = "' + $StorageLayout.llm_models_root + '"',
        '$env:NIKOF_STT_MODELS_ROOT = "' + $StorageLayout.stt_models_root + '"',
        '$env:NIKOF_TTS_MODELS_ROOT = "' + $StorageLayout.tts_models_root + '"',
        '$env:NIKOF_EMBEDDINGS_ROOT = "' + $StorageLayout.embeddings_root + '"',
        '$env:NIKOF_PROVIDERS_ROOT = "' + $StorageLayout.providers_root + '"',
        '$env:NIKOF_CACHE_ROOT = "' + $StorageLayout.cache_root + '"'
    )

    Set-Content -LiteralPath $envFilePath -Value $lines -Encoding Ascii
    return $envFilePath
}

function Export-NikoFBootstrapReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout,

        [Parameter(Mandatory)]
        [pscustomobject]$Config,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$CreatedPaths,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$ToolResults,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$ProviderResults,

        [Parameter(Mandatory)]
        [string]$EnvFilePath
    )

    $reportPath = Join-Path $StorageLayout.report_root $Config.storage.reportFileName
    $payload = [ordered]@{
        generated_at = (Get-Date).ToString("o")
        storage_layout = $StorageLayout
        created_paths = $CreatedPaths
        env_file = $EnvFilePath
        tools = $ToolResults
        providers = $ProviderResults
    }

    $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    return $reportPath
}

function Write-NikoFBootstrapSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$CreatedPaths,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$ToolResults,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$ProviderResults,

        [Parameter(Mandatory)]
        [string]$EnvFilePath,

        [Parameter(Mandatory)]
        [string]$ReportPath
    )

    Write-Host "== NikoF Bootstrap Scaffold =="
    Write-Host "Local data root : $($StorageLayout.local_data_root)"
    Write-Host "Models root     : $($StorageLayout.models_root)"
    Write-Host "Providers root  : $($StorageLayout.providers_root)"
    Write-Host "Cache root      : $($StorageLayout.cache_root)"
    Write-Host "Env helper      : $EnvFilePath"
    Write-Host "Report          : $ReportPath"
    Write-Host ""

    if ($CreatedPaths.Count -gt 0) {
        Write-Host "Created local directories:"
        foreach ($pathValue in $CreatedPaths) {
            Write-Host "  + $pathValue"
        }
        Write-Host ""
    }

    Write-Host "Tooling status:"
    foreach ($toolResult in $ToolResults) {
        $status = if ($toolResult.available) { "OK" } else { "MISSING" }
        Write-Host ("  [{0}] {1}" -f $status, $toolResult.display_name)
        if ($toolResult.output) {
            Write-Host ("      {0}" -f $toolResult.output)
        }
        if (-not $toolResult.available) {
            Write-Host ("      {0}" -f $toolResult.manual_install)
            Write-Host ("      {0}" -f $toolResult.install_url)
        }
    }
    Write-Host ""

    Write-Host "Provider payload status:"
    foreach ($providerResult in $ProviderResults) {
        $status = if ($providerResult.present) { "READY" } else { "ACTION" }
        Write-Host ("  [{0}] {1}" -f $status, $providerResult.display_name)
        Write-Host ("      Expected path: {0}" -f $providerResult.expected_path)
        if (-not $providerResult.present) {
            Write-Host ("      Source: {0}" -f $providerResult.upstream)
            Write-Host ("      Next step: {0}" -f $providerResult.manual_install)
        }
    }
    Write-Host ""

    Write-Host "Next actions:"
    Write-Host "  1. Install any missing required tools above."
    Write-Host "  2. Review the provider ACTION items and place payloads in the expected local roots."
    Write-Host "  3. Load the generated env helper in your PowerShell session if needed:"
    Write-Host ("     . {0}" -f $EnvFilePath)
    Write-Host "  4. Validate the repo contracts:"
    Write-Host "     powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1"
}