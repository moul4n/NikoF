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
        hints_root = Join-Path $RepoRoot $Config.storage.providerHintsRoot
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
        $StorageLayout.report_root,
        $StorageLayout.hints_root
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
        $toolCommand = Get-Command $tool.command -ErrorAction SilentlyContinue | Select-Object -First 1
        $toolCommandPath = $null
        if ($toolCommand) {
            if ($toolCommand.Path) {
                $toolCommandPath = $toolCommand.Path
            }
            elseif ($toolCommand.Source) {
                $toolCommandPath = $toolCommand.Source
            }
        }
        $output = $null
        $isAvailable = $false

        if ($toolCommandPath) {
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

function Resolve-NikoFCommandPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Command
    )

    $resolvedCommand = Get-Command $Command -ErrorAction SilentlyContinue | Select-Object -First 1
    $resolvedCommandPath = $null
    if ($resolvedCommand) {
        if ($resolvedCommand.Path) {
            $resolvedCommandPath = $resolvedCommand.Path
        }
        elseif ($resolvedCommand.Source) {
            $resolvedCommandPath = $resolvedCommand.Source
        }
    }
    if ($resolvedCommandPath) {
        return $resolvedCommandPath
    }

    if ($Command -ieq 'ollama') {
        foreach ($candidatePath in @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
            'C:\Program Files\Ollama\ollama.exe'
        )) {
            if ($candidatePath -and (Test-Path -LiteralPath $candidatePath)) {
                return $candidatePath
            }
        }
    }

    return $null
}

function Resolve-NikoFProviderArtifactSpecs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Provider,

        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout
    )

    $rootKey = [string]$Provider.rootKey
    if (-not $rootKey -or -not ($StorageLayout.PSObject.Properties.Name -contains $rootKey)) {
        return @()
    }

    $rootPath = $StorageLayout.$rootKey
    $artifactSpecs = @()

    if (
        $Provider.PSObject.Properties.Name -contains 'runtimeConfig' -and
        $Provider.runtimeConfig -and
        $Provider.runtimeConfig.PSObject.Properties.Name -contains 'relativePath' -and
        $Provider.runtimeConfig.relativePath
    ) {
        $artifactSpecs += [pscustomobject]@{
            kind = 'runtime_config'
            path = Join-Path $rootPath ([string]$Provider.runtimeConfig.relativePath)
            template = if ($Provider.runtimeConfig.PSObject.Properties.Name -contains 'template') {
                $Provider.runtimeConfig.template
            }
            else {
                $null
            }
        }
    }

    if (
        $Provider.PSObject.Properties.Name -contains 'installPlan' -and
        $Provider.installPlan -and
        $Provider.installPlan.PSObject.Properties.Name -contains 'relativePath' -and
        $Provider.installPlan.relativePath
    ) {
        $artifactSpecs += [pscustomobject]@{
            kind = 'install_plan'
            path = Join-Path $rootPath ([string]$Provider.installPlan.relativePath)
            template = if ($Provider.installPlan.PSObject.Properties.Name -contains 'template') {
                $Provider.installPlan.template
            }
            else {
                $null
            }
        }
    }

    return $artifactSpecs
}

function Initialize-NikoFProviderArtifacts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Provider,

        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout
    )

    $writtenPaths = @()
    foreach ($artifactSpec in @(Resolve-NikoFProviderArtifactSpecs -Provider $Provider -StorageLayout $StorageLayout)) {
        if (-not $artifactSpec.path) {
            continue
        }

        $artifactDirectory = Split-Path -Parent $artifactSpec.path
        if (-not (Test-Path -LiteralPath $artifactDirectory)) {
            New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
        }

        if ((-not (Test-Path -LiteralPath $artifactSpec.path)) -and $null -ne $artifactSpec.template) {
            $artifactSpec.template | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $artifactSpec.path -Encoding UTF8
            $writtenPaths += $artifactSpec.path
        }
    }

    return $writtenPaths
}

function Initialize-NikoFBootstrapArtifacts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Config,

        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout
    )

    $writtenPaths = @()
    foreach ($provider in @($Config.providers | Where-Object {
                $_.PSObject.Properties.Name -contains 'bootstrapScaffold' -and [bool]$_.bootstrapScaffold
            })) {
        $writtenPaths += @(Initialize-NikoFProviderArtifacts -Provider $provider -StorageLayout $StorageLayout)
    }

    return $writtenPaths
}

function Get-NikoFGptSovitsAcceptanceTargets {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ModelRoot,

        [Parameter(Mandatory)]
        [string[]]$ProviderEntrypointPaths,

        [Parameter(Mandatory)]
        [bool]$PayloadReady,

        [Parameter(Mandatory)]
        [bool]$ProviderEntrypointReady
    )

    return @(
        [pscustomobject]@{
            id = 'gpt-sovits-payload-root'
            label = 'GPT-SoVITS payload root'
            satisfied = $PayloadReady
            expected_path = $ModelRoot
            accepted_paths = @($ModelRoot)
            acceptance_proof = 'At least one non-manifest file or folder must exist under this root; runtime.json and install-plan.json alone do not count.'
        }
        [pscustomobject]@{
            id = 'gpt-sovits-provider-entrypoint'
            label = 'GPT-SoVITS provider entrypoint'
            satisfied = $ProviderEntrypointReady
            expected_path = $ProviderEntrypointPaths[0]
            accepted_paths = @($ProviderEntrypointPaths)
            acceptance_proof = 'One accepted provider entrypoint file must exist under the managed provider root.'
        }
    )
}

function Get-NikoFGptSovitsBlockerDetails {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$State,

        [Parameter(Mandatory)]
        [string]$ModelRoot,

        [Parameter(Mandatory)]
        [string[]]$ProviderEntrypointPaths,

        [string]$ModelRuntimeConfigPath,

        [string]$ModelInstallPlanPath,

        [string]$ProviderRuntimeConfigPath,

        [Parameter(Mandatory)]
        [bool]$PayloadReady,

        [Parameter(Mandatory)]
        [bool]$ProviderEntrypointReady
    )

    $blockers = @()

    if (-not $PayloadReady) {
        $blockers += [pscustomobject]@{
            id = 'missing-gpt-sovits-payload-proof'
            status = if ($State -eq 'missing') { 'missing' } else { 'blocked' }
            summary = 'The approved GPT-SoVITS payload has not been placed under the managed TTS root yet.'
            expected_path = $ModelRoot
            accepted_paths = @($ModelRoot)
            remediation = 'Place the approved GPT-SoVITS runtime payload, weights, and any voice-specific assets under this local-only root. Scaffold manifests alone do not satisfy readiness.'
            evidence = @(
                'Bootstrap treats runtime.json and install-plan.json as scaffold markers only.',
                ('Model runtime config: {0}' -f $ModelRuntimeConfigPath),
                ('Install plan: {0}' -f $ModelInstallPlanPath)
            ) | Where-Object { $_ }
        }
    }

    if (-not $ProviderEntrypointReady) {
        $blockers += [pscustomobject]@{
            id = 'missing-gpt-sovits-provider-entrypoint'
            status = if ($State -eq 'missing') { 'missing' } else { 'blocked' }
            summary = 'The GPT-SoVITS provider entrypoint is still missing from the managed provider root.'
            expected_path = $ProviderEntrypointPaths[0]
            accepted_paths = @($ProviderEntrypointPaths)
            remediation = 'Place one provider entrypoint file under the managed provider root, then rerun bootstrap so startup can confirm the proof.'
            evidence = @(
                ('Accepted entrypoints: {0}' -f (@($ProviderEntrypointPaths) -join ', ')),
                ('Provider runtime config: {0}' -f $ProviderRuntimeConfigPath)
            ) | Where-Object { $_ }
        }
    }

    return $blockers
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
    $fasterWhisperModelProviderId = 'stt-medium'
    $fasterWhisperEntrypointProviderId = 'stt-provider-entrypoint'
    $fasterWhisperScaffoldArtifacts = @('runtime.json', 'install-plan.json')
    $gptSovitsModelProviderId = 'tts-model-gpt-sovits'
    $gptSovitsEntrypointProviderId = 'tts-provider-entrypoint'
    $gptSovitsScaffoldArtifacts = @('runtime.json', 'install-plan.json')

    foreach ($provider in $Config.providers) {
        $providerId = [string]$provider.id
        $rootPath = $StorageLayout.($provider.rootKey)
        $expectedRelativePaths = @()
        if ($provider.PSObject.Properties.Name -contains "expectedRelativePaths") {
            $expectedRelativePaths = @($provider.expectedRelativePaths)
        }
        if ($expectedRelativePaths.Count -eq 0) {
            $expectedRelativePaths = @($provider.expectedRelativePath)
        }

        $expectedPaths = @($expectedRelativePaths | ForEach-Object {
                Join-Path $rootPath $_
            })
        $matchMode = if ($provider.PSObject.Properties.Name -contains "matchMode") {
            [string]$provider.matchMode
        }
        else {
            "all"
        }
        $present = if ($matchMode -eq "any") {
            $expectedPaths.Where({ Test-Path -LiteralPath $_ }).Count -gt 0
        }
        else {
            $expectedPaths.Where({ Test-Path -LiteralPath $_ }).Count -eq $expectedPaths.Count
        }
        if ($providerId -eq 'provider-ollama') {
            $ollamaCommandPath = Resolve-NikoFCommandPath -Command 'ollama'
            $present = $null -ne $ollamaCommandPath
        }
        $expectedPath = if ($present) {
            if ($providerId -eq 'provider-ollama' -and $ollamaCommandPath) {
                $ollamaCommandPath
            }
            else {
                $expectedPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
            }
        }
        else {
            $expectedPaths[0]
        }
        $hookId = $null
        if (
            $provider.PSObject.Properties.Name -contains "remediation" -and
            $provider.remediation -and
            $provider.remediation.PSObject.Properties.Name -contains "id"
        ) {
            $hookId = [string]$provider.remediation.id
        }
        $artifactSpecs = @(Resolve-NikoFProviderArtifactSpecs -Provider $provider -StorageLayout $StorageLayout)
        $runtimeConfigPath = $artifactSpecs | Where-Object { $_.kind -eq 'runtime_config' } | Select-Object -ExpandProperty path -First 1
        $installPlanPath = $artifactSpecs | Where-Object { $_.kind -eq 'install_plan' } | Select-Object -ExpandProperty path -First 1
        $results += [pscustomobject]@{
            id = $providerId
            display_name = $provider.displayName
            root_key = $provider.rootKey
            expected_path = $expectedPath
            expected_paths = @($expectedPaths)
            present = $present
            state = if ($present) { 'ready' } else { 'missing' }
            required = if ($provider.PSObject.Properties.Name -contains "required") { [bool]$provider.required } else { $true }
            upstream = $provider.upstream
            manual_install = $provider.manualInstall
            hook_id = $hookId
            runtime_config_path = $runtimeConfigPath
            install_plan_path = $installPlanPath
            hook_command = if ($hookId) {
                "powershell -ExecutionPolicy Bypass -File .\\scripts\\bootstrap\\bootstrap.ps1 -RunHook $hookId"
            }
            else {
                $null
            }
            remediation = if ($provider.PSObject.Properties.Name -contains "remediation") { $provider.remediation } else { $null }
        }
    }

    $fasterWhisperModelResult = $results | Where-Object { $_.id -eq $fasterWhisperModelProviderId } | Select-Object -First 1
    $fasterWhisperEntrypointResult = $results | Where-Object { $_.id -eq $fasterWhisperEntrypointProviderId } | Select-Object -First 1
    if ($fasterWhisperModelResult -and $fasterWhisperEntrypointResult) {
        $modelRoot = if ($fasterWhisperModelResult.expected_paths -and $fasterWhisperModelResult.expected_paths.Count -gt 0) {
            $fasterWhisperModelResult.expected_paths[0]
        }
        else {
            $fasterWhisperModelResult.expected_path
        }
        $payloadReady = $false
        if (Test-Path -LiteralPath $modelRoot -PathType Container) {
            foreach ($child in @(Get-ChildItem -LiteralPath $modelRoot -Force -ErrorAction SilentlyContinue)) {
                if ($fasterWhisperScaffoldArtifacts -notcontains $child.Name) {
                    $payloadReady = $true
                    break
                }
            }
        }

        $providerEntrypointReady = @($fasterWhisperEntrypointResult.expected_paths | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
        $manifestsPresent = @(
            @(
                $fasterWhisperModelResult.runtime_config_path,
                $fasterWhisperModelResult.install_plan_path,
                $fasterWhisperEntrypointResult.runtime_config_path
            ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
        )
        $fasterWhisperState = if ($payloadReady -and $providerEntrypointReady) {
            'ready'
        }
        elseif ($manifestsPresent.Count -gt 0) {
            'scaffolded'
        }
        else {
            'missing'
        }
        $acceptanceTargets = @(Get-NikoFFasterWhisperAcceptanceTargets `
                -ModelRoot $modelRoot `
                -ProviderEntrypointPaths @($fasterWhisperEntrypointResult.expected_paths) `
                -PayloadReady $payloadReady `
                -ProviderEntrypointReady $providerEntrypointReady)
        $blockerDetails = @(Get-NikoFFasterWhisperBlockerDetails `
                -State $fasterWhisperState `
                -ModelRoot $modelRoot `
                -ProviderEntrypointPaths @($fasterWhisperEntrypointResult.expected_paths) `
                -ModelRuntimeConfigPath $fasterWhisperModelResult.runtime_config_path `
                -ModelInstallPlanPath $fasterWhisperModelResult.install_plan_path `
                -ProviderRuntimeConfigPath $fasterWhisperEntrypointResult.runtime_config_path `
                -PayloadReady $payloadReady `
                -ProviderEntrypointReady $providerEntrypointReady)

        foreach ($providerResult in @($fasterWhisperModelResult, $fasterWhisperEntrypointResult)) {
            $providerResult.state = $fasterWhisperState
            $providerResult.present = $fasterWhisperState -eq 'ready'
            $providerResult | Add-Member -NotePropertyName acceptance_targets -NotePropertyValue $acceptanceTargets -Force
            $providerResult | Add-Member -NotePropertyName blocker_details -NotePropertyValue $blockerDetails -Force
        }
    }

    $gptSovitsModelResult = $results | Where-Object { $_.id -eq $gptSovitsModelProviderId } | Select-Object -First 1
    $gptSovitsEntrypointResult = $results | Where-Object { $_.id -eq $gptSovitsEntrypointProviderId } | Select-Object -First 1
    if ($gptSovitsModelResult -and $gptSovitsEntrypointResult) {
        $modelRoot = if ($gptSovitsModelResult.expected_paths -and $gptSovitsModelResult.expected_paths.Count -gt 0) {
            $gptSovitsModelResult.expected_paths[0]
        }
        else {
            $gptSovitsModelResult.expected_path
        }
        $payloadReady = $false
        if (Test-Path -LiteralPath $modelRoot -PathType Container) {
            foreach ($child in @(Get-ChildItem -LiteralPath $modelRoot -Force -ErrorAction SilentlyContinue)) {
                if ($gptSovitsScaffoldArtifacts -notcontains $child.Name) {
                    $payloadReady = $true
                    break
                }
            }
        }

        $providerEntrypointReady = @($gptSovitsEntrypointResult.expected_paths | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
        $manifestsPresent = @(
            @(
                $gptSovitsModelResult.runtime_config_path,
                $gptSovitsModelResult.install_plan_path,
                $gptSovitsEntrypointResult.runtime_config_path
            ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
        )
        $gptSovitsState = if ($payloadReady -and $providerEntrypointReady) {
            'ready'
        }
        elseif ($manifestsPresent.Count -gt 0) {
            'scaffolded'
        }
        else {
            'missing'
        }
        $acceptanceTargets = @(Get-NikoFGptSovitsAcceptanceTargets `
                -ModelRoot $modelRoot `
                -ProviderEntrypointPaths @($gptSovitsEntrypointResult.expected_paths) `
                -PayloadReady $payloadReady `
                -ProviderEntrypointReady $providerEntrypointReady)
        $blockerDetails = @(Get-NikoFGptSovitsBlockerDetails `
                -State $gptSovitsState `
                -ModelRoot $modelRoot `
                -ProviderEntrypointPaths @($gptSovitsEntrypointResult.expected_paths) `
                -ModelRuntimeConfigPath $gptSovitsModelResult.runtime_config_path `
                -ModelInstallPlanPath $gptSovitsModelResult.install_plan_path `
                -ProviderRuntimeConfigPath $gptSovitsEntrypointResult.runtime_config_path `
                -PayloadReady $payloadReady `
                -ProviderEntrypointReady $providerEntrypointReady)

        foreach ($providerResult in @($gptSovitsModelResult, $gptSovitsEntrypointResult)) {
            $providerResult.state = $gptSovitsState
            $providerResult.present = $gptSovitsState -eq 'ready'
            $providerResult | Add-Member -NotePropertyName acceptance_targets -NotePropertyValue $acceptanceTargets -Force
            $providerResult | Add-Member -NotePropertyName blocker_details -NotePropertyValue $blockerDetails -Force
        }
    }

    return $results
}

function Get-NikoFProviderStateLabel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$ProviderResult
    )

    if ($ProviderResult.PSObject.Properties.Name -contains 'state' -and $null -ne $ProviderResult.state -and [string]$ProviderResult.state -ne '') {
        return [string]$ProviderResult.state
    }

    if ($ProviderResult.present) {
        return 'ready'
    }

    return 'missing'
}

function Write-NikoFRemediationHint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$ProviderResult,

        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout
    )

    $safeName = ($ProviderResult.id -replace '[^A-Za-z0-9._-]', '-')
    $hintPath = Join-Path $StorageLayout.hints_root ($safeName + '.txt')
    $stateLabel = (Get-NikoFProviderStateLabel -ProviderResult $ProviderResult).ToUpperInvariant()
    $lines = @(
        ('Provider: {0}' -f $ProviderResult.display_name),
        ('State: {0}' -f $stateLabel),
        ('Expected path: {0}' -f $ProviderResult.expected_path),
        ('Upstream: {0}' -f $ProviderResult.upstream),
        ''
    )

    if ($ProviderResult.runtime_config_path) {
        $lines += @(
            'Runtime config:',
            [string]$ProviderResult.runtime_config_path,
            ''
        )
    }

    if ($ProviderResult.install_plan_path) {
        $lines += @(
            'Install plan:',
            [string]$ProviderResult.install_plan_path,
            ''
        )
    }

    if ($ProviderResult.expected_paths -and $ProviderResult.expected_paths.Count -gt 1) {
        $lines += 'Accepted path variants:'
        foreach ($expectedPath in $ProviderResult.expected_paths) {
            $lines += ('- {0}' -f $expectedPath)
        }
        $lines += ''
    }

    if (
        $ProviderResult.PSObject.Properties.Name -contains 'acceptance_targets' -and
        $ProviderResult.acceptance_targets -and
        $ProviderResult.acceptance_targets.Count -gt 0
    ) {
        $lines += 'Acceptance targets:'
        foreach ($acceptanceTarget in $ProviderResult.acceptance_targets) {
            $targetStatus = if ($acceptanceTarget.satisfied) { 'READY' } else { 'BLOCKED' }
            $lines += ('- [{0}] {1}' -f $targetStatus, $acceptanceTarget.label)
            $lines += ('  Expected path: {0}' -f $acceptanceTarget.expected_path)
            if ($acceptanceTarget.accepted_paths -and $acceptanceTarget.accepted_paths.Count -gt 1) {
                $lines += ('  Accepted paths: {0}' -f (@($acceptanceTarget.accepted_paths) -join '; '))
            }
            $lines += ('  Acceptance proof: {0}' -f $acceptanceTarget.acceptance_proof)
        }
        $lines += ''
    }

    if (
        $ProviderResult.PSObject.Properties.Name -contains 'blocker_details' -and
        $ProviderResult.blocker_details -and
        $ProviderResult.blocker_details.Count -gt 0
    ) {
        $lines += 'Current blockers:'
        foreach ($blockerDetail in $ProviderResult.blocker_details) {
            $lines += ('- [{0}] {1}' -f $blockerDetail.status.ToUpperInvariant(), $blockerDetail.summary)
            $lines += ('  Expected path: {0}' -f $blockerDetail.expected_path)
            if ($blockerDetail.accepted_paths -and $blockerDetail.accepted_paths.Count -gt 1) {
                $lines += ('  Accepted paths: {0}' -f (@($blockerDetail.accepted_paths) -join '; '))
            }
            $lines += ('  Remediation: {0}' -f $blockerDetail.remediation)
        }
        $lines += ''
    }

    $lines += @(
        'Manual install:',
        $ProviderResult.manual_install,
        ''
    )

    if ($ProviderResult.hook_command) {
        $lines += @(
            'Hook command:',
            $ProviderResult.hook_command,
            ''
        )
    }

    if ($ProviderResult.remediation) {
        if ($ProviderResult.remediation.PSObject.Properties.Name -contains 'successHint') {
            $lines += @(
                'Success hint:',
                [string]$ProviderResult.remediation.successHint,
                ''
            )
        }

        if ($ProviderResult.remediation.PSObject.Properties.Name -contains 'notes') {
            $lines += 'Notes:'
            foreach ($note in @($ProviderResult.remediation.notes)) {
                $lines += ('- {0}' -f $note)
            }
            $lines += ''
        }
    }

    Set-Content -LiteralPath $hintPath -Value $lines -Encoding UTF8
    return $hintPath
}

function Export-NikoFRemediationHints {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$ProviderResults
    )

    $hintMap = [ordered]@{}
    foreach ($providerResult in $ProviderResults) {
        $hintMap[$providerResult.id] = Write-NikoFRemediationHint -ProviderResult $providerResult -StorageLayout $StorageLayout
    }

    return [pscustomobject]$hintMap
}

function Resolve-NikoFRemediationHook {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Config,

        [Parameter(Mandatory)]
        [string]$HookId
    )

    foreach ($provider in $Config.providers) {
        if (
            $provider.PSObject.Properties.Name -contains 'remediation' -and
            $provider.remediation -and
            $provider.remediation.PSObject.Properties.Name -contains 'id' -and
            [string]$provider.remediation.id -eq $HookId
        ) {
            return [pscustomobject]@{
                provider = $provider
                remediation = $provider.remediation
            }
        }
    }

    throw "Bootstrap hook not found: $HookId"
}

function Invoke-NikoFRemediationHook {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Config,

        [Parameter(Mandatory)]
        [pscustomobject]$StorageLayout,

        [Parameter(Mandatory)]
        [string]$HookId
    )

    $resolvedHook = Resolve-NikoFRemediationHook -Config $Config -HookId $HookId
    $provider = $resolvedHook.provider
    $remediation = $resolvedHook.remediation
    $providerResults = @(Get-NikoFProviderStatus -Config $Config -StorageLayout $StorageLayout)
    $providerResult = $providerResults | Where-Object { $_.id -eq $provider.id } | Select-Object -First 1
    $hintPath = Write-NikoFRemediationHint -ProviderResult $providerResult -StorageLayout $StorageLayout

    Write-Host ('== Bootstrap Hook: {0} ==' -f $remediation.displayName)
    Write-Host ('Provider        : {0}' -f $provider.displayName)
    Write-Host ('Expected path   : {0}' -f $providerResult.expected_path)
    Write-Host ('Hint file       : {0}' -f $hintPath)

    $writtenArtifacts = @(Initialize-NikoFProviderArtifacts -Provider $provider -StorageLayout $StorageLayout)
    if ($providerResult.runtime_config_path) {
        Write-Host ('Runtime config  : {0}' -f $providerResult.runtime_config_path)
    }
    if ($providerResult.install_plan_path) {
        Write-Host ('Install plan    : {0}' -f $providerResult.install_plan_path)
    }
    foreach ($writtenArtifact in $writtenArtifacts) {
        Write-Host ('Scaffolded file : {0}' -f $writtenArtifact)
    }

    switch ([string]$remediation.type) {
        'command' {
            if (-not $remediation.safeAutomation) {
                throw "Hook '$HookId' is not marked safe for automation. Review the hint file instead: $hintPath"
            }

            $resolvedCommandPath = Resolve-NikoFCommandPath -Command ([string]$remediation.command)
            if (-not $resolvedCommandPath) {
                throw "Required command '$($remediation.command)' is unavailable. Install it first or review the hint file: $hintPath"
            }

            Write-Host ('Running command : {0} {1}' -f $resolvedCommandPath, ((@($remediation.args) -join ' ')))
            & $resolvedCommandPath @($remediation.args)

            if (
                $remediation.PSObject.Properties.Name -contains 'postSuccessMarkerRelativePath' -and
                $remediation.postSuccessMarkerRelativePath
            ) {
                $markerPath = Join-Path $StorageLayout.($provider.rootKey) ([string]$remediation.postSuccessMarkerRelativePath)
                $markerDirectory = Split-Path -Parent $markerPath
                if (-not (Test-Path -LiteralPath $markerDirectory)) {
                    New-Item -ItemType Directory -Path $markerDirectory -Force | Out-Null
                }

                $markerPayload = [ordered]@{
                    generated_at = (Get-Date).ToString('o')
                    provider_id = $provider.id
                    hook_id = $HookId
                    source = 'bootstrap-hook'
                }
                $markerPayload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $markerPath -Encoding UTF8
                Write-Host ('Wrote marker    : {0}' -f $markerPath)
            }

            if ($remediation.PSObject.Properties.Name -contains 'successHint') {
                Write-Host ('Next step       : {0}' -f $remediation.successHint)
            }
            break
        }
        default {
            Write-Host ('Action type     : {0}' -f $remediation.type)
            Write-Host ('Next step       : {0}' -f $providerResult.manual_install)
            if ($providerResult.hook_command) {
                Write-Host ('Reopen hook     : {0}' -f $providerResult.hook_command)
            }
            if ($remediation.PSObject.Properties.Name -contains 'url') {
                Write-Host ('Upstream        : {0}' -f $remediation.url)
            }
            if ($remediation.PSObject.Properties.Name -contains 'successHint') {
                Write-Host ('Success hint    : {0}' -f $remediation.successHint)
            }
            break
        }
    }

    return $hintPath
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
    $lines = @"
`$env:NIKOF_LOCAL_ROOT = "$($StorageLayout.local_data_root)"
`$env:NIKOF_MODELS_ROOT = "$($StorageLayout.models_root)"
`$env:NIKOF_LLM_MODELS_ROOT = "$($StorageLayout.llm_models_root)"
`$env:NIKOF_STT_MODELS_ROOT = "$($StorageLayout.stt_models_root)"
`$env:NIKOF_TTS_MODELS_ROOT = "$($StorageLayout.tts_models_root)"
`$env:NIKOF_EMBEDDINGS_ROOT = "$($StorageLayout.embeddings_root)"
`$env:NIKOF_PROVIDERS_ROOT = "$($StorageLayout.providers_root)"
`$env:NIKOF_CACHE_ROOT = "$($StorageLayout.cache_root)"
"@

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
        [pscustomobject]$HintFiles,

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
        remediation_hints = $HintFiles
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
        [object[]]$ScaffoldedArtifacts,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$ToolResults,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$ProviderResults,

        [Parameter(Mandatory)]
        [pscustomobject]$HintFiles,

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
    Write-Host "Hints root      : $($StorageLayout.hints_root)"
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

    if ($ScaffoldedArtifacts.Count -gt 0) {
        Write-Host "Scaffolded local manifest files:"
        foreach ($artifactPath in $ScaffoldedArtifacts) {
            Write-Host "  + $artifactPath"
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
        $status = (Get-NikoFProviderStateLabel -ProviderResult $providerResult).ToUpperInvariant()
        Write-Host ("  [{0}] {1}" -f $status, $providerResult.display_name)
        Write-Host ("      Expected path: {0}" -f $providerResult.expected_path)
        if (
            $providerResult.PSObject.Properties.Name -contains 'acceptance_targets' -and
            $providerResult.acceptance_targets -and
            $providerResult.acceptance_targets.Count -gt 0
        ) {
            Write-Host '      Acceptance targets:'
            foreach ($acceptanceTarget in $providerResult.acceptance_targets) {
                $targetStatus = if ($acceptanceTarget.satisfied) { 'READY' } else { 'BLOCKED' }
                Write-Host ("        - [{0}] {1}" -f $targetStatus, $acceptanceTarget.label)
                Write-Host ("          Expected path: {0}" -f $acceptanceTarget.expected_path)
                if ($acceptanceTarget.accepted_paths -and $acceptanceTarget.accepted_paths.Count -gt 1) {
                    Write-Host ("          Accepted paths: {0}" -f (@($acceptanceTarget.accepted_paths) -join ', '))
                }
                Write-Host ("          Acceptance proof: {0}" -f $acceptanceTarget.acceptance_proof)
            }
        }
        if (
            $providerResult.PSObject.Properties.Name -contains 'blocker_details' -and
            $providerResult.blocker_details -and
            $providerResult.blocker_details.Count -gt 0
        ) {
            Write-Host '      Current blockers:'
            foreach ($blockerDetail in $providerResult.blocker_details) {
                Write-Host ("        - [{0}] {1}" -f $blockerDetail.status.ToUpperInvariant(), $blockerDetail.summary)
                Write-Host ("          Expected path: {0}" -f $blockerDetail.expected_path)
                if ($blockerDetail.accepted_paths -and $blockerDetail.accepted_paths.Count -gt 1) {
                    Write-Host ("          Accepted paths: {0}" -f (@($blockerDetail.accepted_paths) -join ', '))
                }
                Write-Host ("          Remediation: {0}" -f $blockerDetail.remediation)
            }
        }
        if ($providerResult.runtime_config_path) {
            Write-Host ("      Runtime config: {0}" -f $providerResult.runtime_config_path)
        }
        if ($providerResult.install_plan_path) {
            Write-Host ("      Install plan: {0}" -f $providerResult.install_plan_path)
        }
        if (-not $providerResult.present) {
            Write-Host ("      Source: {0}" -f $providerResult.upstream)
            Write-Host ("      Next step: {0}" -f $providerResult.manual_install)
            if ($providerResult.hook_command) {
                Write-Host ("      Hook: {0}" -f $providerResult.hook_command)
            }
            $hintFilePath = $HintFiles.($providerResult.id)
            if ($hintFilePath) {
                Write-Host ("      Hint file: {0}" -f $hintFilePath)
            }
        }
    }
    Write-Host ""

    Write-Host "Next actions:"
    Write-Host "  1. Install any missing required tools above."
    Write-Host "  2. Run a printed hook command or open the matching hint file for each provider ACTION item."
    Write-Host "  3. Load the generated env helper in your PowerShell session if needed:"
    Write-Host ("     . {0}" -f $EnvFilePath)
    Write-Host "  4. Validate the repo contracts:"
    Write-Host "     powershell -ExecutionPolicy Bypass -File .\scripts\asset_validation\validate-contracts.ps1"
}

function Get-NikoFFasterWhisperAcceptanceTargets {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ModelRoot,

        [Parameter(Mandatory)]
        [string[]]$ProviderEntrypointPaths,

        [Parameter(Mandatory)]
        [bool]$PayloadReady,

        [Parameter(Mandatory)]
        [bool]$ProviderEntrypointReady
    )

    return @(
        [pscustomobject]@{
            id = 'faster-whisper-medium-model-root'
            label = 'Faster-Whisper Medium model root'
            satisfied = $PayloadReady
            expected_path = $ModelRoot
            accepted_paths = @($ModelRoot)
            acceptance_proof = 'At least one non-manifest file or folder must exist under this root; runtime.json and install-plan.json alone do not count.'
        }
        [pscustomobject]@{
            id = 'faster-whisper-provider-entrypoint'
            label = 'Faster-Whisper provider entrypoint'
            satisfied = $ProviderEntrypointReady
            expected_path = $ProviderEntrypointPaths[0]
            accepted_paths = @($ProviderEntrypointPaths)
            acceptance_proof = 'One accepted provider entrypoint file must exist under the managed provider root.'
        }
    )
}

function Get-NikoFFasterWhisperBlockerDetails {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$State,

        [Parameter(Mandatory)]
        [string]$ModelRoot,

        [Parameter(Mandatory)]
        [string[]]$ProviderEntrypointPaths,

        [string]$ModelRuntimeConfigPath,

        [string]$ModelInstallPlanPath,

        [string]$ProviderRuntimeConfigPath,

        [Parameter(Mandatory)]
        [bool]$PayloadReady,

        [Parameter(Mandatory)]
        [bool]$ProviderEntrypointReady
    )

    $blockers = @()

    if (-not $PayloadReady) {
        $blockers += [pscustomobject]@{
            id = 'missing-faster-whisper-medium-payload-proof'
            status = if ($State -eq 'missing') { 'missing' } else { 'blocked' }
            summary = 'The approved Faster-Whisper Medium payload has not been placed under the managed STT root yet.'
            expected_path = $ModelRoot
            accepted_paths = @($ModelRoot)
            remediation = 'Place the approved Faster-Whisper Medium model files under this local-only root. Scaffold manifests alone do not satisfy readiness.'
            evidence = @(
                'Bootstrap treats runtime.json and install-plan.json as scaffold markers only.',
                ('Model runtime config: {0}' -f $ModelRuntimeConfigPath),
                ('Install plan: {0}' -f $ModelInstallPlanPath)
            ) | Where-Object { $_ }
        }
    }

    if (-not $ProviderEntrypointReady) {
        $blockers += [pscustomobject]@{
            id = 'missing-faster-whisper-provider-entrypoint'
            status = if ($State -eq 'missing') { 'missing' } else { 'blocked' }
            summary = 'The Faster-Whisper provider entrypoint is still missing from the managed provider root.'
            expected_path = $ProviderEntrypointPaths[0]
            accepted_paths = @($ProviderEntrypointPaths)
            remediation = 'Place one provider entrypoint file under the managed provider root, then rerun bootstrap so startup can confirm the proof.'
            evidence = @(
                ('Accepted entrypoints: {0}' -f (@($ProviderEntrypointPaths) -join ', ')),
                ('Provider runtime config: {0}' -f $ProviderRuntimeConfigPath)
            ) | Where-Object { $_ }
        }
    }

    return $blockers
}