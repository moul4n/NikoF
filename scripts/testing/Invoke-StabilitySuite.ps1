[CmdletBinding()]
param(
    [string[]]$Scenario,
    [switch]$RefreshBaselines,
    [string]$SuiteRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $SuiteRoot) {
    $SuiteRoot = Join-Path $PSScriptRoot '..\..\tests\stability'
}

function New-DirectoryIfMissing {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-RepoRoot {
    param(
        [Parameter(Mandatory)]
        [string]$SuiteRootPath
    )

    return (Resolve-Path (Join-Path $SuiteRootPath '..\..')).Path
}

function Normalize-Text {
    param(
        [AllowNull()]
        [string]$Text,
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [string]$ScenarioTempRoot,
        [string]$RunRoot
    )

    if ($null -eq $Text) {
        return $null
    }

    $normalized = $Text

    if ($RunRoot) {
        $normalized = $normalized -replace [regex]::Escape($RunRoot), '<run-artifacts>'
    }

    if ($ScenarioTempRoot) {
        $normalized = $normalized -replace [regex]::Escape($ScenarioTempRoot), '<scenario-temp>'
    }

    $normalized = $normalized -replace [regex]::Escape($RepoRoot), '<repo>'

    return ($normalized -replace '\\', '/')
}

function Get-RepoRelativePath {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$RepoRoot
    )

    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path -replace '\\', '/'
    $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path -replace '\\', '/'

    if ($resolvedPath.StartsWith("$resolvedRepoRoot/")) {
        return $resolvedPath.Substring($resolvedRepoRoot.Length + 1)
    }

    return $resolvedPath
}

function Get-SourceMarkerMatches {
    param(
        [Parameter(Mandatory)]
        [string]$SourceText,
        [Parameter(Mandatory)]
        [object[]]$Markers
    )

    return @(
        $Markers |
            Where-Object { [regex]::IsMatch($SourceText, $_.pattern) } |
            ForEach-Object { $_.name } |
            Sort-Object
    )
}

function ConvertTo-StableJson {
    param(
        [Parameter(Mandatory)]$InputObject
    )

    return ($InputObject | ConvertTo-Json -Depth 20)
}

function Normalize-ComparisonText {
    param(
        [AllowNull()]
        [string]$Text
    )

    if ($null -eq $Text) {
        return $null
    }

    return $Text.TrimEnd("`r", "`n")
}

function ConvertTo-CanonicalComparisonText {
    param(
        [AllowNull()]
        [string]$Text
    )

    $normalized = Normalize-ComparisonText -Text $Text
    if ($null -eq $normalized) {
        return $null
    }

    try {
        return (($normalized | ConvertFrom-Json) | ConvertTo-Json -Depth 20 -Compress)
    }
    catch {
        return $normalized
    }
}

function Get-LineDiff {
    param(
        [Parameter(Mandatory)]
        [string]$BaselineText,
        [Parameter(Mandatory)]
        [string]$CurrentText
    )

    $baselineLines = $BaselineText -split "`r?`n"
    $currentLines = $CurrentText -split "`r?`n"
    $maxLineCount = [Math]::Max($baselineLines.Count, $currentLines.Count)
    $diffLines = New-Object System.Collections.Generic.List[string]

    for ($index = 0; $index -lt $maxLineCount; $index++) {
        $baselineLine = if ($index -lt $baselineLines.Count) { $baselineLines[$index] } else { '<missing>' }
        $currentLine = if ($index -lt $currentLines.Count) { $currentLines[$index] } else { '<missing>' }

        if ($baselineLine -cne $currentLine) {
            $lineNumber = $index + 1
            $diffLines.Add(("L{0} baseline: {1}" -f $lineNumber, $baselineLine)) | Out-Null
            $diffLines.Add(("L{0} current : {1}" -f $lineNumber, $currentLine)) | Out-Null
        }
    }

    return $diffLines
}

function Invoke-ContractValidatorSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $scriptPath = Join-Path $RepoRoot 'scripts\asset_validation\validate-contracts.ps1'
    $outputLines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = 'powershell.exe'
        script = 'scripts/asset_validation/validate-contracts.ps1'
        tracked_inputs = @($Scenario.tracked_inputs)
        exit_code = $exitCode
        output_lines = @($outputLines | ForEach-Object { Normalize-Text -Text $_ -RepoRoot $RepoRoot -RunRoot $RunRoot })
    }
}

function Invoke-BootstrapPrerequisiteSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $helperPath = Join-Path $RepoRoot 'scripts\bootstrap\Test-NikoFPrerequisites.ps1'
    . $helperPath

    $configPath = Join-Path $RepoRoot 'scripts\bootstrap\bootstrap.targets.json'
    $config = Get-NikoFBootstrapConfig -ConfigPath $configPath
    $scenarioTempRoot = Join-Path $RunRoot 'bootstrap-prereq-sandbox'
    New-DirectoryIfMissing -Path $scenarioTempRoot

    $storageLayout = Get-NikoFStorageLayout -RepoRoot $RepoRoot -Config $config -LocalRootOverride $scenarioTempRoot
    $providerResults = @(Get-NikoFProviderStatus -Config $config -StorageLayout $storageLayout)

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = '<scenario-temp>'
        tool_contracts = @(
            $config.tools | ForEach-Object {
                [ordered]@{
                    id = $_.id
                    command = $_.command
                    args = @($_.args)
                }
            }
        )
        provider_payloads = @(
            $providerResults | ForEach-Object {
                [ordered]@{
                    id = $_.id
                    present = [bool]$_.present
                    expected_path = Normalize-Text -Text $_.expected_path -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            }
        )
        missing_provider_payloads = @($providerResults | Where-Object { -not $_.present } | ForEach-Object { $_.id })
    }
}

function Get-OrderedPropertyNames {
    param(
        [Parameter(Mandatory)]$InputObject
    )

    return @($InputObject.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
}

function Get-InterfacePropertyNamesFromSource {
    param(
        [Parameter(Mandatory)]
        [string]$SourceText,
        [Parameter(Mandatory)]
        [string]$InterfaceName
    )

    $interfacePattern = '(?ms)export interface\s+' + [regex]::Escape($InterfaceName) + '\s*\{(?<body>.*?)^\}'
    $match = [regex]::Match($SourceText, $interfacePattern)
    if (-not $match.Success) {
        return @()
    }

    return @(
        [regex]::Matches($match.Groups['body'].Value, '(?m)^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\??\s*:') |
            ForEach-Object { $_.Groups['name'].Value } |
            Sort-Object
    )
}

function Get-AsyncFunctionReturnTypeFromSource {
    param(
        [Parameter(Mandatory)]
        [string]$SourceText,
        [Parameter(Mandatory)]
        [string]$FunctionName
    )

    $functionPattern = '(?ms)async function\s+' + [regex]::Escape($FunctionName) + '\s*\([^)]*\)\s*:\s*(?<type>.*?)\s*\{'
    $match = [regex]::Match($SourceText, $functionPattern)
    if (-not $match.Success) {
        return $null
    }

    return ($match.Groups['type'].Value -replace '\s+', ' ').Trim()
}

function Get-DataclassFieldNamesFromSource {
    param(
        [Parameter(Mandatory)]
        [string]$SourceText,
        [Parameter(Mandatory)]
        [string]$ClassName
    )

    $classPattern = '(?ms)@dataclass(?:\([^)]*\))?\s*class\s+' + [regex]::Escape($ClassName) + '\s*:\s*(?<body>.*?)(?=^@dataclass|^class\s|\Z)'
    $match = [regex]::Match($SourceText, $classPattern)
    if (-not $match.Success) {
        return @()
    }

    return @(
        [regex]::Matches($match.Groups['body'].Value, '(?m)^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*:') |
            ForEach-Object { $_.Groups['name'].Value }
    )
}

function Test-StringArrayEquality {
    param(
        [string[]]$Left,
        [string[]]$Right
    )

    if ($null -eq $Left) {
        $Left = @()
    }

    if ($null -eq $Right) {
        $Right = @()
    }

    if ($Left.Count -ne $Right.Count) {
        return $false
    }

    for ($index = 0; $index -lt $Left.Count; $index++) {
        if ($Left[$index] -cne $Right[$index]) {
            return $false
        }
    }

    return $true
}

function Invoke-BootstrapReportSurfaceSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $helperPath = Join-Path $RepoRoot 'scripts\bootstrap\Test-NikoFPrerequisites.ps1'
    . $helperPath

    $configPath = Join-Path $RepoRoot 'scripts\bootstrap\bootstrap.targets.json'
    $config = Get-NikoFBootstrapConfig -ConfigPath $configPath
    $scenarioTempRoot = Join-Path $RunRoot 'bootstrap-report-sandbox'
    New-DirectoryIfMissing -Path $scenarioTempRoot

    $storageLayout = Get-NikoFStorageLayout -RepoRoot $RepoRoot -Config $config -LocalRootOverride $scenarioTempRoot
    $createdPaths = @(Initialize-NikoFStorageLayout -StorageLayout $storageLayout)
    $toolResults = @(Test-NikoFTooling -Config $config)
    $providerResults = @(Get-NikoFProviderStatus -Config $config -StorageLayout $storageLayout)
    $envFilePath = Export-NikoFSessionEnvFile -StorageLayout $storageLayout -Config $config
    $reportPath = Export-NikoFBootstrapReport -StorageLayout $storageLayout -Config $config -CreatedPaths $createdPaths -ToolResults $toolResults -ProviderResults $providerResults -EnvFilePath $envFilePath
    $reportPayload = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        tracked_inputs = @($Scenario.tracked_inputs)
        report_file = 'bootstrap-report.json'
        report_surface = [ordered]@{
            top_level_keys = @(Get-OrderedPropertyNames -InputObject $reportPayload)
            storage_layout_keys = @(Get-OrderedPropertyNames -InputObject $reportPayload.storage_layout)
            tool_entry_keys = if ($reportPayload.tools.Count -gt 0) {
                @(Get-OrderedPropertyNames -InputObject $reportPayload.tools[0])
            }
            else {
                @()
            }
            provider_entry_keys = if ($reportPayload.providers.Count -gt 0) {
                @(Get-OrderedPropertyNames -InputObject $reportPayload.providers[0])
            }
            else {
                @()
            }
            tool_ids = @($reportPayload.tools | ForEach-Object { $_.id })
            provider_ids = @($reportPayload.providers | ForEach-Object { $_.id })
        }
    }
}

function Invoke-FrontendStage1BridgeSurfaceSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $backendSurfacePath = Join-Path $RepoRoot 'tests\stability\baselines\backend-stage1-payload-surface.json'
    $backendSurface = Get-Content -LiteralPath $backendSurfacePath -Raw | ConvertFrom-Json
    $backendContractsPath = Join-Path $RepoRoot 'tests\stability\baselines\backend-stage1-contracts.json'
    $backendContracts = Get-Content -LiteralPath $backendContractsPath -Raw | ConvertFrom-Json
    $appPath = Join-Path $RepoRoot 'frontend\src\app\App.tsx'
    $characterTypesPath = Join-Path $RepoRoot 'frontend\src\shared\types\character.ts'
    $backendCharacterFlowPath = Join-Path $RepoRoot 'frontend\src\avatar\loaders\backendCharacterFlow.ts'
    $catalogLoaderPath = Join-Path $RepoRoot 'frontend\src\avatar\loaders\characterCatalog.ts'
    $appSource = Get-Content -LiteralPath $appPath -Raw
    $characterTypesSource = Get-Content -LiteralPath $characterTypesPath -Raw
    $backendCharacterFlowSource = Get-Content -LiteralPath $backendCharacterFlowPath -Raw
    $catalogLoaderSource = Get-Content -LiteralPath $catalogLoaderPath -Raw

    $expectedCatalogKeys = @($backendSurface.response_surface.character_catalog_keys)
    $expectedActiveKeys = @($backendSurface.response_surface.active_character_keys)
    $expectedInvalidSelectionKeys = @($backendSurface.response_surface.invalid_selection_keys)
    $invalidActiveCharacterResponse = $backendContracts.responses.put_active_character_invalid.response
    $invalidActiveCharacterKeys = @(Get-OrderedPropertyNames -InputObject $invalidActiveCharacterResponse)
    $invalidSelectionKeys = @(Get-OrderedPropertyNames -InputObject $invalidActiveCharacterResponse.selection)
    $catalogInterfaceName = 'BackendCharacterCatalogResponseDocument'
    $catalogFetchReturnType = "Promise<$catalogInterfaceName>"
    $catalogInterfaceKeys = @(Get-InterfacePropertyNamesFromSource -SourceText $characterTypesSource -InterfaceName $catalogInterfaceName)
    $activeInterfaceKeys = @(Get-InterfacePropertyNamesFromSource -SourceText $characterTypesSource -InterfaceName 'BackendActiveCharacterResponseDocument')
    $fetchSummariesReturnType = Get-AsyncFunctionReturnTypeFromSource -SourceText $catalogLoaderSource -FunctionName 'fetchBackendCharacterSummaries'
    $usesCatalogEnvelopeCharacters = [regex]::IsMatch($backendCharacterFlowSource, 'summariesDocument\.characters\b')
    $readsCatalogActiveCharacterId = [regex]::IsMatch($backendCharacterFlowSource, 'summariesDocument\.active_character_id\b')
    $loaderExportsStructuredSyncError = [regex]::IsMatch($catalogLoaderSource, '(?ms)export class\s+ActiveCharacterSyncError\s+extends\s+Error')
    $loaderPreservesRejectionDocument = [regex]::IsMatch(
        $catalogLoaderSource,
        '(?ms)readonly response:\s*BackendActiveCharacterResponseDocument\s*;.*?throw new ActiveCharacterSyncError\(document,\s*response\.status\)'
    )
    $appHandlesStructuredSyncError = [regex]::IsMatch($appSource, 'error\s+instanceof\s+ActiveCharacterSyncError')
    $appCallsRejectedSyncHelper = [regex]::IsMatch(
        $appSource,
        '(?ms)if\s*\(error\s+instanceof\s+ActiveCharacterSyncError\)\s*\{.*?const\s+(?<nextSyncState>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*createRejectedActiveCharacterSyncState\(\s*loadState\.catalog\s*,\s*error\.response\s*\);.*?setSelectedCharacterId\(\s*\k<nextSyncState>\.selectedCharacterId\s*\);'
    )
    $helperUsesRejectedSelectionMessage = [regex]::IsMatch(
        $backendCharacterFlowSource,
        '(?ms)export function\s+createRejectedActiveCharacterSyncState\s*\([^)]*\)\s*:\s*ActiveCharacterSyncStatePatch\s*\{.*?message:\s*response\.selection\.message\s*\?\?'
    )
    $helperReconcilesBackendConfirmedCharacter = [regex]::IsMatch(
        $backendCharacterFlowSource,
        '(?ms)export function\s+createRejectedActiveCharacterSyncState\s*\([^)]*\)\s*:\s*ActiveCharacterSyncStatePatch\s*\{.*?selectedCharacterId:\s*resolveBackendConfirmedCharacterId\(\s*catalog\s*,\s*response\.active_character\.character_id\s*\)'
    )
    $appUsesRejectedSelectionMessage =
        [regex]::IsMatch($appSource, 'error\.response\.selection\.message') -or
        ($appCallsRejectedSyncHelper -and $helperUsesRejectedSelectionMessage)
    $appReconcilesRejectedSelection =
        [regex]::IsMatch(
            $appSource,
            '(?ms)if\s*\(error\s+instanceof\s+ActiveCharacterSyncError\)\s*\{.*?const\s+(?<reconciledId>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*loadState\.catalog\s*\?\s*resolveSelectedCharacterId\(\s*loadState\.catalog\s*,\s*error\.response\.active_character\.character_id\s*\)\s*:\s*selectedCharacterId\s*;.*?setSelectedCharacterId\(\s*\k<reconciledId>\s*\);.*?error\.response\.selection\.message'
        ) -or
        ($appCallsRejectedSyncHelper -and $helperReconcilesBackendConfirmedCharacter)

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        tracked_inputs = @($Scenario.tracked_inputs)
        backend_contract_surface = [ordered]@{
            character_catalog_keys = @($expectedCatalogKeys)
            active_character_keys = @($expectedActiveKeys)
            rejection_active_character_keys = @($invalidActiveCharacterKeys)
            rejection_selection_keys = @($invalidSelectionKeys)
        }
        frontend_bridge_surface = [ordered]@{
            catalog_response_interface = if ($catalogInterfaceKeys.Count -gt 0) { $catalogInterfaceName } else { '<missing>' }
            catalog_response_keys = @($catalogInterfaceKeys)
            fetch_summaries_return_type = $fetchSummariesReturnType
            catalog_consumes_envelope_characters = [bool]$usesCatalogEnvelopeCharacters
            catalog_reads_active_character_id = [bool]$readsCatalogActiveCharacterId
            active_response_interface = 'BackendActiveCharacterResponseDocument'
            active_response_keys = @($activeInterfaceKeys)
            sync_error_class = if ($loaderExportsStructuredSyncError) { 'ActiveCharacterSyncError' } else { '<missing>' }
            sync_error_preserves_rejection_document = [bool]$loaderPreservesRejectionDocument
            app_handles_structured_rejection = [bool]$appHandlesStructuredSyncError
            app_uses_rejection_selection_message = [bool]$appUsesRejectedSelectionMessage
            app_reconciles_rejected_selection = [bool]$appReconcilesRejectedSelection
        }
        alignment = [ordered]@{
            catalog_response_keys_match = Test-StringArrayEquality -Left $catalogInterfaceKeys -Right $expectedCatalogKeys
            fetch_summaries_return_type_matches = $fetchSummariesReturnType -ceq $catalogFetchReturnType
            catalog_consumes_envelope_characters = [bool]$usesCatalogEnvelopeCharacters
            catalog_reads_active_character_id = [bool]$readsCatalogActiveCharacterId
            active_response_keys_match = Test-StringArrayEquality -Left $activeInterfaceKeys -Right $expectedActiveKeys
            rejection_active_response_keys_match = Test-StringArrayEquality -Left $invalidActiveCharacterKeys -Right $expectedActiveKeys
            rejection_selection_keys_match = Test-StringArrayEquality -Left $invalidSelectionKeys -Right $expectedInvalidSelectionKeys
            sync_error_preserves_rejection_document = [bool]$loaderPreservesRejectionDocument
            app_handles_structured_rejection = [bool]$appHandlesStructuredSyncError
            app_uses_rejection_selection_message = [bool]$appUsesRejectedSelectionMessage
            app_reconciles_rejected_selection = [bool]$appReconcilesRejectedSelection
        }
    }
}

function Get-PythonLauncher {
    $pythonCommand = Get-Command -Name python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        return [pscustomobject]@{
            executable = $pythonCommand.Source
            arguments = @()
            runner = 'python'
        }
    }

    $pyLauncher = Get-Command -Name py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        return [pscustomobject]@{
            executable = $pyLauncher.Source
            arguments = @('-3')
            runner = 'python'
        }
    }

    throw 'Python launcher not found. Install Python or add it to PATH before running backend stability scenarios.'
}

function Get-NodeLauncher {
    $nodeCommand = Get-Command -Name node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        return [pscustomobject]@{
            executable = $nodeCommand.Source
            runner = 'node'
        }
    }

    throw 'Node.js launcher not found. Install Node.js or add it to PATH before running frontend runtime stability scenarios.'
}

function Invoke-BackendStage1SnapshotSource {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $pythonLauncher = Get-PythonLauncher
    $scriptPath = Join-Path $RunRoot 'backend-stage1-contracts.py'
    $scenarioTempRoot = Join-Path $RunRoot 'backend-stage1-sandbox'
    New-DirectoryIfMissing -Path $scenarioTempRoot
    $pythonScript = @'
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


repo_root = Path(sys.argv[1]).resolve()
scenario_root = Path(sys.argv[2]).resolve()
os.environ["NIKOF_LOCAL_ROOT"] = str(scenario_root)
os.environ["NIKOF_MODELS_ROOT"] = str(scenario_root / "models")
os.environ["NIKOF_PROVIDERS_ROOT"] = str(scenario_root / "providers")
os.environ["NIKOF_CACHE_ROOT"] = str(scenario_root / "cache")
sys.path.insert(0, str(repo_root / "backend"))

from app.api.router import build_api_contract_snapshot


snapshot = build_api_contract_snapshot()
snapshot["contracts"]["canonical_transcription_event"]["timestamp"] = "<generated-at>"
snapshot["contracts"]["canonical_speech_synthesis_event"]["timestamp"] = "<generated-at>"
for envelope in snapshot["contracts"].get("speech_lifecycle_transport_snapshot", {}).get("events", []):
    envelope["event"]["timestamp"] = "<generated-at>"
snapshot["responses"]["get_active_character"]["session_event"]["timestamp"] = "<generated-at>"
for envelope in snapshot["responses"].get("get_speech_lifecycle", {}).get("events", []):
    envelope["event"]["timestamp"] = "<generated-at>"
snapshot["responses"]["post_operator_command_text_question"]["response"]["session_event"]["timestamp"] = "<generated-at>"
for envelope in snapshot["responses"]["post_operator_command_text_question"]["response"].get("speech_lifecycle_events", []):
    envelope["event"]["timestamp"] = "<generated-at>"
snapshot["responses"]["post_operator_command_tts_preview"]["response"]["session_event"]["timestamp"] = "<generated-at>"
for envelope in snapshot["responses"]["post_operator_command_tts_preview"]["response"].get("speech_lifecycle_events", []):
    envelope["event"]["timestamp"] = "<generated-at>"
snapshot["responses"]["put_active_character"]["response"]["session_event"]["timestamp"] = "<generated-at>"
snapshot["responses"]["put_active_character_invalid"]["response"]["session_event"]["timestamp"] = "<generated-at>"

json.dump(snapshot, sys.stdout, indent=4)
sys.stdout.write("\n")
'@

    Set-Content -LiteralPath $scriptPath -Value $pythonScript -Encoding Ascii

    $outputLines = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($scriptPath, $RepoRoot, $scenarioTempRoot)) 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($exitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $pythonLauncher.runner
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $exitCode
            error_lines = @($outputLines | ForEach-Object { Normalize-Text -Text $_ -RepoRoot $RepoRoot -RunRoot $RunRoot })
        }
    }

    $snapshotPayload = $outputLines -join [Environment]::NewLine
    $snapshotObject = $snapshotPayload | ConvertFrom-Json

    return [pscustomobject][ordered]@{
        runner = $pythonLauncher.runner
        local_root = '<scenario-temp>'
        snapshot = $snapshotObject
    }
}

function Invoke-BackendStage1ContractSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    $snapshotObject = $snapshotSource.snapshot

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = $snapshotSource.local_root
        routes = @(
            $snapshotObject.routes | ForEach-Object {
                [ordered]@{
                    method = $_.method
                    path = $_.path
                    name = $_.name
                }
            }
        )
        responses = $snapshotObject.responses
    }
}

function Invoke-BackendSpeechContractSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = $snapshotSource.local_root
        contracts = $snapshotSource.snapshot.contracts
    }
}

function Invoke-BackendSpeechEventStoreSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    $transportSnapshot = $snapshotSource.snapshot.contracts.speech_lifecycle_transport_snapshot
    $events = @($transportSnapshot.events)
    $persistedRecords = @(
        $events | ForEach-Object {
            [ordered]@{
                event_id = $_.event_id
                sequence = [int]$_.sequence
                cursor = $_.cursor
                event = $_.event
            }
        }
    )

    $sequenceGapFree = $true
    for ($index = 0; $index -lt $persistedRecords.Count; $index++) {
        if ([int]$persistedRecords[$index].sequence -ne ($index + 1)) {
            $sequenceGapFree = $false
            break
        }
    }

    $firstCursor = if ($persistedRecords.Count -gt 0) {
        $persistedRecords[0].cursor
    }
    else {
        $null
    }
    $recordsAfterFirstCursor = if ($persistedRecords.Count -gt 1) {
        @($persistedRecords | Where-Object { [int]$_.sequence -gt 1 })
    }
    else {
        @()
    }

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = $snapshotSource.local_root
        event_store_projection = [ordered]@{
            stream = $transportSnapshot.stream
            session_id = $transportSnapshot.session_id
            delivery = $transportSnapshot.delivery
            record_count = $persistedRecords.Count
            ordered_sequences = @($persistedRecords | ForEach-Object { [int]$_.sequence })
            ordered_event_ids = @($persistedRecords | ForEach-Object { $_.event_id })
            ordered_event_types = @($persistedRecords | ForEach-Object { $_.event.event_type })
            next_cursor = $transportSnapshot.next_cursor
            last_cursor = if ($persistedRecords.Count -gt 0) {
                $persistedRecords[-1].cursor
            }
            else {
                $null
            }
            cursor_prefix = if ($persistedRecords.Count -gt 0) {
                ($persistedRecords[0].cursor -replace ':[0-9]+$', '')
            }
            else {
                $null
            }
            sequence_gap_free = $sequenceGapFree
            persisted_records = $persistedRecords
            cursor_reads = [ordered]@{
                from_origin = [ordered]@{
                    cursor = $null
                    returned_event_ids = @($persistedRecords | ForEach-Object { $_.event_id })
                    returned_event_types = @($persistedRecords | ForEach-Object { $_.event.event_type })
                    returned_count = $persistedRecords.Count
                    next_cursor = $transportSnapshot.next_cursor
                }
                after_first_cursor = [ordered]@{
                    cursor = $firstCursor
                    returned_event_ids = @($recordsAfterFirstCursor | ForEach-Object { $_.event_id })
                    returned_event_types = @($recordsAfterFirstCursor | ForEach-Object { $_.event.event_type })
                    returned_count = $recordsAfterFirstCursor.Count
                    next_cursor = $transportSnapshot.next_cursor
                }
            }
        }
    }
}

function Invoke-BackendTurnPublicationSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $pythonLauncher = Get-PythonLauncher
    $scriptPath = Join-Path $RunRoot 'backend-turn-publication.py'
    $scenarioTempRoot = Join-Path $RunRoot 'backend-turn-publication'
    New-DirectoryIfMissing -Path $scenarioTempRoot
    $pythonScript = @'
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path


repo_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repo_root / "backend"))

from app.schemas.session import SessionSnapshot, SpeechSynthesisContract, SpeechTranscriptionContract
from app.services.session import InMemorySessionEventStore
from app.services.speech import (
    BackendTurnRequest,
    DefaultSessionEventFactory,
    DefaultTurnPipelinePublisher,
    SpeechSynthesisRequest,
    SpeechTranscriptionRequest,
    StubSpeechLifecycleSnapshotService,
    StubSpeechSynthesisService,
    StubSpeechTranscriptionService,
)


@dataclass(slots=True)
class StaticSpeechTranscriptionService:
    contract: SpeechTranscriptionContract

    def transcribe(self, request: SpeechTranscriptionRequest) -> SpeechTranscriptionContract:
        return self.contract


@dataclass(slots=True)
class StaticSpeechSynthesisService:
    contract: SpeechSynthesisContract

    def synthesize(self, request: SpeechSynthesisRequest) -> SpeechSynthesisContract:
        return self.contract


def build_turn_request() -> BackendTurnRequest:
    return BackendTurnRequest(
        character_id="test-vrm-01",
        transcription=SpeechTranscriptionRequest(
            audio_reference="session://speech-sample/transcription.wav",
            locale="en-US",
            transcript_hint="Hey Niko, can you wave after you answer?",
            confidence_hint=0.98,
        ),
        synthesis=SpeechSynthesisRequest(
            text="Sure. I can wave once I finish speaking.",
            locale="en-US",
        ),
    )


def build_transcription_contract(status: str) -> SpeechTranscriptionContract:
    return SpeechTranscriptionContract(
        profile_id="stt.faster-whisper.medium-2026",
        status=status,
        locale="en-US",
        transcript="Hey Niko, can you wave after you answer?",
        confidence=0.98,
    )


def build_synthesis_contract(status: str) -> SpeechSynthesisContract:
    return SpeechSynthesisContract(
        profile_id="tts.gpt-sovits.2026-stable",
        status=status,
        text="Sure. I can wave once I finish speaking.",
        locale="en-US",
    )


snapshot = SessionSnapshot(
    session_id="session-scaffold-01",
    active_character_id="test-vrm-01",
)
store = InMemorySessionEventStore()
snapshot_service = StubSpeechLifecycleSnapshotService(event_store=store)

before_publication = snapshot_service.get_snapshot(snapshot, character_id="test-vrm-01")

publisher = DefaultTurnPipelinePublisher(
    transcription_service=StubSpeechTranscriptionService(),
    synthesis_service=StubSpeechSynthesisService(),
    session_event_factory=DefaultSessionEventFactory(),
    event_store=store,
)
first_publication = publisher.publish_turn(snapshot, build_turn_request())
after_first_publication = snapshot_service.get_snapshot(snapshot, character_id="test-vrm-01")
second_publication = publisher.publish_turn(snapshot, build_turn_request())

session_events = store.read("session", session_id=snapshot.session_id)
speech_events = store.read("speech.lifecycle", session_id=snapshot.session_id)

degraded_cases = []
for transcription_status, synthesis_status, publication_status in (
    ("unavailable", "ready", "degraded"),
    ("final", "unavailable", "degraded"),
    ("error", "ready", "error"),
    ("final", "error", "error"),
):
    degraded_store = InMemorySessionEventStore()
    degraded_publisher = DefaultTurnPipelinePublisher(
        transcription_service=StaticSpeechTranscriptionService(
            build_transcription_contract(transcription_status)
        ),
        synthesis_service=StaticSpeechSynthesisService(
            build_synthesis_contract(synthesis_status)
        ),
        session_event_factory=DefaultSessionEventFactory(),
        event_store=degraded_store,
    )
    publication = degraded_publisher.publish_turn(snapshot, build_turn_request())
    degraded_cases.append(
        {
            "transcription_status": transcription_status,
            "synthesis_status": synthesis_status,
            "publication_status": publication.session_events[-1].event.status,
            "speech_lifecycle_statuses": [
                publication.speech_lifecycle_events[0].event.status,
                publication.speech_lifecycle_events[1].event.status,
            ],
        }
    )

payload = {
    "scenario_id": "backend-turn-publication",
    "publication_origin": {
        "snapshot_before_publication": {
            "event_count": len(before_publication.events),
            "event_types": [event.event.event_type for event in before_publication.events],
            "next_cursor": before_publication.next_cursor,
        },
        "snapshot_after_first_publication": {
            "event_count": len(after_first_publication.events),
            "event_types": [event.event.event_type for event in after_first_publication.events],
            "event_ids": [event.event_id for event in after_first_publication.events],
            "event_statuses": [event.event.status for event in after_first_publication.events],
            "event_ids_match_publication": [event.event_id for event in after_first_publication.events]
            == [event.event_id for event in first_publication.speech_lifecycle_events],
            "next_cursor": after_first_publication.next_cursor,
        },
    },
    "turn_publication_ordering": {
        "first_publication_ordered_event_types": [
            event.event.event_type for event in first_publication.ordered_events
        ],
        "first_publication_ordered_statuses": [
            event.event.status for event in first_publication.ordered_events
        ],
        "second_publication_speech_sequences": [
            event.sequence for event in second_publication.speech_lifecycle_events
        ],
        "session_stream_event_types": [event.event.event_type for event in session_events],
        "speech_lifecycle_event_types": [event.event.event_type for event in speech_events],
        "speech_lifecycle_sequences": [event.sequence for event in speech_events],
        "speech_lifecycle_next_cursor": store.next_cursor(
            "speech.lifecycle",
            session_id=snapshot.session_id,
        ),
    },
    "degraded_publication_outcomes": degraded_cases,
}

json.dump(payload, sys.stdout, indent=4)
sys.stdout.write("\n")
'@

    Set-Content -LiteralPath $scriptPath -Value $pythonScript -Encoding Ascii

    $outputLines = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($scriptPath, $RepoRoot, $scenarioTempRoot)) 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($exitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $pythonLauncher.runner
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $exitCode
            error_lines = @($outputLines | ForEach-Object { Normalize-Text -Text $_ -RepoRoot $RepoRoot -RunRoot $RunRoot })
        }
    }

    return ($outputLines -join [Environment]::NewLine) | ConvertFrom-Json
}

function Invoke-BackendSpeechRealAdapterDegradedSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    $pythonLauncher = Get-PythonLauncher
    $scriptPath = Join-Path $RunRoot 'backend-speech-real-adapter-degraded.py'
    $scenarioTempRoot = Join-Path $RunRoot 'backend-speech-real-adapter-degraded'
    New-DirectoryIfMissing -Path $scenarioTempRoot
    $pythonScript = @'
from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from pathlib import Path


def normalize_path(value: Path, scenario_root: Path) -> str:
    resolved = value.resolve()
    try:
        relative = resolved.relative_to(scenario_root)
        return f"<scenario-temp>/{relative.as_posix()}" if relative.parts else "<scenario-temp>"
    except ValueError:
        return resolved.as_posix()


repo_root = Path(sys.argv[1]).resolve()
scenario_root = Path(sys.argv[2]).resolve()
os.environ["NIKOF_LOCAL_ROOT"] = str(scenario_root)
os.environ["NIKOF_MODELS_ROOT"] = str(scenario_root / "models")
os.environ["NIKOF_PROVIDERS_ROOT"] = str(scenario_root / "providers")
os.environ["NIKOF_CACHE_ROOT"] = str(scenario_root / "cache")
sys.path.insert(0, str(repo_root / "backend"))

from app.schemas.session import SessionSnapshot
from app.services.session import InMemorySessionEventStore
from app.services.speech import (
    BackendTurnRequest,
    DefaultSessionEventFactory,
    DefaultTurnPipelinePublisher,
    SpeechSynthesisRequest,
    SpeechTranscriptionRequest,
    StubSpeechLifecycleSnapshotService,
    build_speech_service_registry,
)


registry = build_speech_service_registry()
transcription_request = SpeechTranscriptionRequest(
    audio_reference="session://speech-sample/transcription.wav",
    locale="en-US",
    transcript_hint="Hey Niko, can you wave after you answer?",
    confidence_hint=0.98,
)
synthesis_request = SpeechSynthesisRequest(
    text="Sure. I can wave once I finish speaking.",
    locale="en-US",
)

transcription_service = registry.resolve_transcription(transcription_request)
synthesis_service = registry.resolve_synthesis(synthesis_request)
transcription_binding = transcription_service.binding_for(transcription_request)
synthesis_binding = synthesis_service.binding_for(synthesis_request)

snapshot = SessionSnapshot(
    session_id="session-scaffold-01",
    active_character_id="test-vrm-01",
)
store = InMemorySessionEventStore()

lifecycle_service = StubSpeechLifecycleSnapshotService(
    event_store=store,
)
publisher = DefaultTurnPipelinePublisher(
    transcription_service=transcription_service,
    synthesis_service=synthesis_service,
    session_event_factory=DefaultSessionEventFactory(),
    event_store=store,
)
publication = publisher.publish_turn(
    snapshot,
    BackendTurnRequest(
        character_id="test-vrm-01",
        transcription=transcription_request,
        synthesis=synthesis_request,
    ),
)
transport_snapshot = asdict(
    lifecycle_service.get_snapshot(
        snapshot,
        character_id="test-vrm-01",
    )
)
for envelope in transport_snapshot.get("events", []):
    envelope["event"]["timestamp"] = "<generated-at>"

result = {
    "transcription_service_type": type(transcription_service).__name__,
    "synthesis_service_type": type(synthesis_service).__name__,
    "bindings": {
        "transcription": {
            "profile_id": transcription_binding.profile_id,
            "modality": transcription_binding.modality,
            "family": transcription_binding.family,
            "provider_root": normalize_path(transcription_binding.provider_root, scenario_root),
            "model_root": normalize_path(transcription_binding.model_root, scenario_root),
            "invocation_entrypoint": normalize_path(transcription_binding.invocation_entrypoint, scenario_root),
            "configured": transcription_binding.configured,
        },
        "synthesis": {
            "profile_id": synthesis_binding.profile_id,
            "modality": synthesis_binding.modality,
            "family": synthesis_binding.family,
            "provider_root": normalize_path(synthesis_binding.provider_root, scenario_root),
            "model_root": normalize_path(synthesis_binding.model_root, scenario_root),
            "invocation_entrypoint": normalize_path(synthesis_binding.invocation_entrypoint, scenario_root),
            "configured": synthesis_binding.configured,
        },
    },
    "publication_origin": {
        "session_event_types": [
            envelope.event.event_type for envelope in publication.session_events
        ],
        "speech_lifecycle_event_types": [
            envelope.event.event_type for envelope in publication.speech_lifecycle_events
        ],
        "speech_lifecycle_event_count": len(publication.speech_lifecycle_events),
    },
    "contracts": {
        "canonical_transcription_event": transport_snapshot["events"][0]["event"],
        "canonical_speech_synthesis_event": transport_snapshot["events"][1]["event"],
        "speech_lifecycle_transport_snapshot": transport_snapshot,
    },
}

json.dump(result, sys.stdout, indent=4)
sys.stdout.write("\n")
'@

    Set-Content -LiteralPath $scriptPath -Value $pythonScript -Encoding Ascii

    $outputLines = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($scriptPath, $RepoRoot, $scenarioTempRoot)) 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($exitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $pythonLauncher.runner
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $exitCode
            error_lines = @($outputLines | ForEach-Object { Normalize-Text -Text $_ -RepoRoot $RepoRoot -RunRoot $RunRoot })
        }
    }

    $degradedSnapshot = ($outputLines -join [Environment]::NewLine) | ConvertFrom-Json
    $canonicalContracts = $snapshotSource.snapshot.contracts
    $degradedContracts = $degradedSnapshot.contracts

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $pythonLauncher.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = '<scenario-temp>'
        real_adapter_degraded_mode = [ordered]@{
            transcription_service_type = $degradedSnapshot.transcription_service_type
            synthesis_service_type = $degradedSnapshot.synthesis_service_type
            bindings = $degradedSnapshot.bindings
            degraded_mode_expected = [ordered]@{
                transcription_unconfigured = -not [bool]$degradedSnapshot.bindings.transcription.configured
                synthesis_unconfigured = -not [bool]$degradedSnapshot.bindings.synthesis.configured
            }
            contracts = $degradedContracts
            contract_equivalence = [ordered]@{
                canonical_transcription_event_match = (
                    (ConvertTo-CanonicalComparisonText -Text (ConvertTo-StableJson -InputObject $degradedContracts.canonical_transcription_event)) -eq
                    (ConvertTo-CanonicalComparisonText -Text (ConvertTo-StableJson -InputObject $canonicalContracts.canonical_transcription_event))
                )
                canonical_speech_synthesis_event_match = (
                    (ConvertTo-CanonicalComparisonText -Text (ConvertTo-StableJson -InputObject $degradedContracts.canonical_speech_synthesis_event)) -eq
                    (ConvertTo-CanonicalComparisonText -Text (ConvertTo-StableJson -InputObject $canonicalContracts.canonical_speech_synthesis_event))
                )
                speech_lifecycle_transport_snapshot_match = (
                    (ConvertTo-CanonicalComparisonText -Text (ConvertTo-StableJson -InputObject $degradedContracts.speech_lifecycle_transport_snapshot)) -eq
                    (ConvertTo-CanonicalComparisonText -Text (ConvertTo-StableJson -InputObject $canonicalContracts.speech_lifecycle_transport_snapshot))
                )
            }
        }
    }
}

function Invoke-BackendOperatorCommandSurfaceSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    $routerPath = Join-Path $RepoRoot 'backend\app\api\router.py'
    $sessionSchemaPath = Join-Path $RepoRoot 'backend\app\schemas\session.py'
    $speechServicePath = Join-Path $RepoRoot 'backend\app\services\speech.py'
    $routerSource = Get-Content -LiteralPath $routerPath -Raw
    $sessionSchemaSource = Get-Content -LiteralPath $sessionSchemaPath -Raw
    $speechServiceSource = Get-Content -LiteralPath $speechServicePath -Raw
    $responses = $snapshotSource.snapshot.responses

    $routes = @(
        $snapshotSource.snapshot.routes | ForEach-Object {
            [ordered]@{
                method = $_.method
                path = $_.path
                name = $_.name
            }
        }
    )
    $writeRoutes = @(
        $routes |
            Where-Object { $_.method -in @('POST', 'PUT', 'PATCH', 'DELETE') }
    )
    $nonSelectionWriteRoutes = @(
        $writeRoutes |
            Where-Object { $_.path -ne '/session/active-character' }
    )
    $operatorSchemaMarkers = @(
        [regex]::Matches(
            $sessionSchemaSource,
            '(?m)^class\s+(?<name>[A-Za-z_][A-Za-z0-9_]*(?:Operator|Command)[A-Za-z0-9_]*)\s*:'
        ) |
            ForEach-Object { $_.Groups['name'].Value }
    )
    $operatorRouteMarkers = @(
        [regex]::Matches(
            $routerSource,
            '(?m)^\s*@router\.(?:post|put|patch|delete)\(\s*["''](?<path>[^"'']*(?:operator|command)[^"'']*)["'']'
        ) |
            ForEach-Object { $_.Groups['path'].Value } |
            Select-Object -Unique
    )
    $backendTurnRequestFields = @(Get-DataclassFieldNamesFromSource -SourceText $speechServiceSource -ClassName 'BackendTurnRequest')
    $transcriptionRequestFields = @(Get-DataclassFieldNamesFromSource -SourceText $speechServiceSource -ClassName 'SpeechTranscriptionRequest')
    $synthesisRequestFields = @(Get-DataclassFieldNamesFromSource -SourceText $speechServiceSource -ClassName 'SpeechSynthesisRequest')
    $turnPipelinePublisherPresent = [regex]::IsMatch(
        $speechServiceSource,
        '(?ms)class\s+TurnPipelinePublisher\(Protocol\):.*?def\s+publish_turn\('
    )
    $hasTextQuestionExample = $responses.PSObject.Properties.Name -contains 'post_operator_command_text_question'
    $hasTtsPreviewExample = $responses.PSObject.Properties.Name -contains 'post_operator_command_tts_preview'
    $textQuestionRequestKeys = @()
    $textQuestionResponseKeys = @()
    $textQuestionSessionEventType = $null
    $textQuestionSpeechEventTypes = @()
    if ($hasTextQuestionExample) {
        $textQuestionRequestKeys = @(
            Get-OrderedPropertyNames -InputObject $responses.post_operator_command_text_question.request
        )
        $textQuestionResponseKeys = @(
            Get-OrderedPropertyNames -InputObject $responses.post_operator_command_text_question.response
        )
        $textQuestionSessionEventType = $responses.post_operator_command_text_question.response.session_event.event_type
        $textQuestionSpeechEventTypes = @(
            $responses.post_operator_command_text_question.response.speech_lifecycle_events |
                ForEach-Object { $_.event.event_type }
        )
    }
    $ttsPreviewRequestKeys = @()
    $ttsPreviewResponseKeys = @()
    $ttsPreviewSessionEventType = $null
    $ttsPreviewSpeechEventTypes = @()
    if ($hasTtsPreviewExample) {
        $ttsPreviewRequestKeys = @(
            Get-OrderedPropertyNames -InputObject $responses.post_operator_command_tts_preview.request
        )
        $ttsPreviewResponseKeys = @(
            Get-OrderedPropertyNames -InputObject $responses.post_operator_command_tts_preview.response
        )
        $ttsPreviewSessionEventType = $responses.post_operator_command_tts_preview.response.session_event.event_type
        $ttsPreviewSpeechEventTypes = @(
            $responses.post_operator_command_tts_preview.response.speech_lifecycle_events |
                ForEach-Object { $_.event.event_type }
        )
    }

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = $snapshotSource.local_root
        route_surface = [ordered]@{
            writable_routes = @($writeRoutes)
            non_selection_write_routes = @($nonSelectionWriteRoutes)
            operator_command_route_count = $nonSelectionWriteRoutes.Count
            operator_command_route_present = $nonSelectionWriteRoutes.Count -gt 0
            operator_route_markers = @($operatorRouteMarkers)
            dependency = if ($nonSelectionWriteRoutes.Count -gt 0) {
                $null
            }
            else {
                'Tank''s backend-authored operator command route is still absent, so this guard is prepared but blocked until one writable non-selection path accepts both text-question submission and TTS preview through the backend-owned command seam.'
            }
        }
        canonical_publication_surface = [ordered]@{
            turn_pipeline_publisher_present = [bool]$turnPipelinePublisherPresent
            backend_turn_request_fields = @($backendTurnRequestFields)
            transcription_request_fields = @($transcriptionRequestFields)
            synthesis_request_fields = @($synthesisRequestFields)
            operator_schema_markers = @($operatorSchemaMarkers)
        }
        command_examples = [ordered]@{
            text_question = [ordered]@{
                present = [bool]$hasTextQuestionExample
                request_keys = @($textQuestionRequestKeys)
                response_keys = @($textQuestionResponseKeys)
                session_event_type = $textQuestionSessionEventType
                speech_lifecycle_event_types = @($textQuestionSpeechEventTypes)
            }
            tts_preview = [ordered]@{
                present = [bool]$hasTtsPreviewExample
                request_keys = @($ttsPreviewRequestKeys)
                response_keys = @($ttsPreviewResponseKeys)
                session_event_type = $ttsPreviewSessionEventType
                speech_lifecycle_event_types = @($ttsPreviewSpeechEventTypes)
            }
        }
        alignment = [ordered]@{
            active_character_is_only_writable_route = ($writeRoutes.Count -eq 1) -and ($writeRoutes[0].path -eq '/session/active-character')
            single_operator_command_route_present = $nonSelectionWriteRoutes.Count -eq 1
            canonical_turn_publication_present = [bool]$turnPipelinePublisherPresent -and ($backendTurnRequestFields.Count -gt 0)
            command_examples_present = [bool]$hasTextQuestionExample -and [bool]$hasTtsPreviewExample
            shared_command_request_shape = Test-StringArrayEquality -Left $textQuestionRequestKeys -Right $ttsPreviewRequestKeys
            shared_command_response_shape = Test-StringArrayEquality -Left $textQuestionResponseKeys -Right $ttsPreviewResponseKeys
            text_question_routes_through_transcription =
                [bool]$hasTextQuestionExample -and
                ($textQuestionSessionEventType -ceq 'session.operator.text-question') -and
                (Test-StringArrayEquality -Left $textQuestionSpeechEventTypes -Right @('transcription.status'))
            tts_preview_routes_through_synthesis =
                [bool]$hasTtsPreviewExample -and
                ($ttsPreviewSessionEventType -ceq 'session.operator.tts-preview') -and
                (Test-StringArrayEquality -Left $ttsPreviewSpeechEventTypes -Right @('speech.synthesis'))
            operator_command_batch_unblocked =
                ($nonSelectionWriteRoutes.Count -eq 1) -and
                [bool]$hasTextQuestionExample -and
                [bool]$hasTtsPreviewExample
        }
    }
}

function Invoke-BackendStage1PayloadSurfaceSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    $snapshotObject = $snapshotSource.snapshot
    $healthResponse = $snapshotObject.responses.health
    $charactersResponse = $snapshotObject.responses.characters
    $activeCharacterResponse = $snapshotObject.responses.get_active_character
    $putActiveCharacterResponse = $snapshotObject.responses.put_active_character
    $invalidActiveCharacterResponse = if ($snapshotObject.responses.PSObject.Properties.Name -contains 'put_active_character_invalid') {
        $snapshotObject.responses.put_active_character_invalid
    }
    else {
        $null
    }

    $characterCatalogKeys = @()
    $characterSummary = $null
    if ($charactersResponse.PSObject.Properties.Name -contains 'characters') {
        $characterCatalogKeys = @(Get-OrderedPropertyNames -InputObject $charactersResponse)
        if ($charactersResponse.characters.Count -gt 0) {
            $characterSummary = $charactersResponse.characters[0]
        }
    }
    elseif ($charactersResponse.Count -gt 0) {
        $characterSummary = $charactersResponse[0]
    }

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        response_surface = [ordered]@{
            response_keys = @(Get-OrderedPropertyNames -InputObject $snapshotObject.responses)
            health_keys = @(Get-OrderedPropertyNames -InputObject $healthResponse)
            health_diagnostics_keys = @(Get-OrderedPropertyNames -InputObject $healthResponse.diagnostics)
            health_storage_probe_keys = @(Get-OrderedPropertyNames -InputObject $healthResponse.diagnostics.storage_probes[0])
            character_catalog_keys = @($characterCatalogKeys)
            character_summary_keys = if ($null -ne $characterSummary) {
                @(Get-OrderedPropertyNames -InputObject $characterSummary)
            }
            else {
                @()
            }
            active_character_keys = @(Get-OrderedPropertyNames -InputObject $activeCharacterResponse)
            active_selection_keys = if ($activeCharacterResponse.PSObject.Properties.Name -contains 'selection') {
                @(Get-OrderedPropertyNames -InputObject $activeCharacterResponse.selection)
            }
            else {
                @()
            }
            put_active_character_keys = @(Get-OrderedPropertyNames -InputObject $putActiveCharacterResponse)
            selection_request_keys = @(Get-OrderedPropertyNames -InputObject $putActiveCharacterResponse.request)
            session_event_keys = @(Get-OrderedPropertyNames -InputObject $activeCharacterResponse.session_event)
            invalid_response_keys = if ($null -ne $invalidActiveCharacterResponse) {
                @(Get-OrderedPropertyNames -InputObject $invalidActiveCharacterResponse)
            }
            else {
                @()
            }
            invalid_selection_keys = if (($null -ne $invalidActiveCharacterResponse) -and ($invalidActiveCharacterResponse.PSObject.Properties.Name -contains 'response')) {
                @(Get-OrderedPropertyNames -InputObject $invalidActiveCharacterResponse.response.selection)
            }
            else {
                @()
            }
        }
    }
}

function Invoke-FrontendShellSplitSurfaceSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $entrypointRoot = Join-Path $RepoRoot 'frontend\src'
    $appRoot = Join-Path $RepoRoot 'frontend\src\app'
    $entrypointMarkers = @(
        [pscustomobject]@{ name = 'create-root'; pattern = '\bcreateRoot\b' }
        [pscustomobject]@{ name = 'import-app'; pattern = 'from\s+["'']\./app/App["'']' }
        [pscustomobject]@{ name = 'render-app'; pattern = 'render\(\s*<App\b' }
    )
    $backendSyncMarkers = @(
        [pscustomobject]@{ name = 'active-sync-error'; pattern = '\bActiveCharacterSyncError\b' }
        [pscustomobject]@{ name = 'bridge-character-catalog'; pattern = '\bbridgeCharacterCatalogWithBackend\b' }
        [pscustomobject]@{ name = 'resolve-selected-character'; pattern = '\bresolveSelectedCharacterId\b' }
        [pscustomobject]@{ name = 'sync-active-character-selection'; pattern = '\bsyncActiveCharacterSelection\b' }
    )
    $speechLifecycleMarkers = @(
        [pscustomobject]@{ name = 'speech-lifecycle-stream'; pattern = 'speech\.lifecycle' }
        [pscustomobject]@{ name = 'speech-lifecycle-snapshot-type'; pattern = '\bConsumedSpeechLifecycleSnapshot\b' }
        [pscustomobject]@{ name = 'speech-lifecycle-delivery-mode'; pattern = '\bSpeechLifecycleDeliveryMode\b' }
        [pscustomobject]@{ name = 'start-speech-lifecycle-live-consumption'; pattern = '\bstartSpeechLifecycleLiveConsumption\b' }
    )
    $operatorCommandMarkers = @(
        [pscustomobject]@{ name = 'submit-operator-command'; pattern = '\bsubmitOperatorCommand\b' }
        [pscustomobject]@{ name = 'text-question-command'; pattern = '"text_question"' }
        [pscustomobject]@{ name = 'tts-preview-command'; pattern = '"tts_preview"' }
    )
    $operatorCommandLoaderPath = Join-Path $RepoRoot 'frontend\src\avatar\loaders\operatorCommand.ts'
    $sharedTypesPath = Join-Path $RepoRoot 'frontend\src\shared\types\character.ts'

    $entrypointFiles = @(
        Get-ChildItem -LiteralPath $entrypointRoot -File -Filter '*.tsx' |
            Sort-Object FullName
    )
    $surfaceFiles = @(
        Get-ChildItem -LiteralPath $appRoot -Recurse -File -Filter '*.tsx' |
            Sort-Object FullName
    )
    $entrypointRecords = New-Object System.Collections.Generic.List[object]
    $surfaceRecords = New-Object System.Collections.Generic.List[object]

    foreach ($entrypointFile in $entrypointFiles) {
        $sourceText = Get-Content -LiteralPath $entrypointFile.FullName -Raw
        $relativePath = Get-RepoRelativePath -Path $entrypointFile.FullName -RepoRoot $RepoRoot
        $matchedEntrypointMarkers = @(Get-SourceMarkerMatches -SourceText $sourceText -Markers $entrypointMarkers)
        $matchedBackendSyncMarkers = @(Get-SourceMarkerMatches -SourceText $sourceText -Markers $backendSyncMarkers)
        $matchedSpeechLifecycleMarkers = @(Get-SourceMarkerMatches -SourceText $sourceText -Markers $speechLifecycleMarkers)
        $rendersApp = ($matchedEntrypointMarkers -contains 'import-app') -and ($matchedEntrypointMarkers -contains 'render-app')

        $entrypointRecords.Add(
            [pscustomobject][ordered]@{
                path = $relativePath
                entrypoint_markers = $matchedEntrypointMarkers
                backend_sync_markers = $matchedBackendSyncMarkers
                speech_lifecycle_markers = $matchedSpeechLifecycleMarkers
                renders_app = $rendersApp
                owns_backend_sync_path = $matchedBackendSyncMarkers.Count -gt 0
                owns_speech_lifecycle_path = $matchedSpeechLifecycleMarkers.Count -gt 0
            }
        ) | Out-Null
    }

    foreach ($surfaceFile in $surfaceFiles) {
        $sourceText = Get-Content -LiteralPath $surfaceFile.FullName -Raw
        $relativePath = Get-RepoRelativePath -Path $surfaceFile.FullName -RepoRoot $RepoRoot
        $matchedBackendSyncMarkers = @(Get-SourceMarkerMatches -SourceText $sourceText -Markers $backendSyncMarkers)
        $matchedSpeechLifecycleMarkers = @(Get-SourceMarkerMatches -SourceText $sourceText -Markers $speechLifecycleMarkers)
        $matchedOperatorCommandMarkers = @(Get-SourceMarkerMatches -SourceText $sourceText -Markers $operatorCommandMarkers)
        $ownsBackendSyncPath = $matchedBackendSyncMarkers.Count -gt 0
        $ownsSpeechLifecyclePath = $matchedSpeechLifecycleMarkers.Count -gt 0
        $ownsOperatorCommandClient = $matchedOperatorCommandMarkers.Count -gt 0

        $surfaceRecords.Add(
            [pscustomobject][ordered]@{
                path = $relativePath
                backend_sync_markers = $matchedBackendSyncMarkers
                speech_lifecycle_markers = $matchedSpeechLifecycleMarkers
                operator_command_markers = $matchedOperatorCommandMarkers
                owns_backend_sync_path = $ownsBackendSyncPath
                owns_speech_lifecycle_path = $ownsSpeechLifecyclePath
                owns_operator_command_client = $ownsOperatorCommandClient
                presentation_only = (-not $ownsBackendSyncPath) -and (-not $ownsSpeechLifecyclePath) -and (-not $ownsOperatorCommandClient)
            }
        ) | Out-Null
    }

    $entrypointBackendSyncOwnerFiles = @($entrypointRecords | Where-Object { $_.owns_backend_sync_path } | ForEach-Object { $_.path })
    $entrypointSpeechLifecycleOwnerFiles = @($entrypointRecords | Where-Object { $_.owns_speech_lifecycle_path } | ForEach-Object { $_.path })
    $entrypointsWithoutApp = @($entrypointRecords | Where-Object { -not $_.renders_app } | ForEach-Object { $_.path })
    $backendSyncOwnerFiles = @($surfaceRecords | Where-Object { $_.owns_backend_sync_path } | ForEach-Object { $_.path })
    $speechLifecycleOwnerFiles = @($surfaceRecords | Where-Object { $_.owns_speech_lifecycle_path } | ForEach-Object { $_.path })
    $operatorCommandOwnerFiles = @($surfaceRecords | Where-Object { $_.owns_operator_command_client } | ForEach-Object { $_.path })
    $splitEntrypointsPresent = $entrypointRecords.Count -gt 1
    $entrypointsRouteThroughApp = ($entrypointsWithoutApp.Count -eq 0) -and ($entrypointBackendSyncOwnerFiles.Count -eq 0) -and ($entrypointSpeechLifecycleOwnerFiles.Count -eq 0)
    $operatorCommandLoaderSource = Get-Content -LiteralPath $operatorCommandLoaderPath -Raw
    $sharedTypesSource = Get-Content -LiteralPath $sharedTypesPath -Raw
    $operatorCommandRouteMatch = [regex]::Match($operatorCommandLoaderSource, 'buildBackendApiUrl\(\s*["''](?<path>[^"'']+)["'']\s*\)')
    $operatorCommandTypeMatch = [regex]::Match($sharedTypesSource, '(?m)^export\s+type\s+BackendOperatorCommandType\s*=\s*(?<types>.+);\s*$')
    $publishedCommandTypes = if ($operatorCommandTypeMatch.Success) {
        @([regex]::Matches($operatorCommandTypeMatch.Groups['types'].Value, '["''](?<type>[^"'']+)["'']') | ForEach-Object { $_.Groups['type'].Value })
    }
    else {
        @()
    }
    $displayReadOnlyForOperatorCommands = -not (@($surfaceRecords | Where-Object { $_.path -eq 'frontend/src/app/App.tsx' -and $_.owns_operator_command_client }).Count -gt 0)

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        tracked_inputs = @($Scenario.tracked_inputs)
        entrypoint_state = [ordered]@{
            entrypoint_files = @($entrypointRecords | ForEach-Object { $_.path })
            total_entrypoint_file_count = $entrypointRecords.Count
            split_entrypoints_present = $splitEntrypointsPresent
            entrypoints_render_app = $entrypointsWithoutApp.Count -eq 0
            entrypoints_without_app = $entrypointsWithoutApp
            entrypoint_backend_sync_owner_files = $entrypointBackendSyncOwnerFiles
            entrypoint_speech_lifecycle_owner_files = $entrypointSpeechLifecycleOwnerFiles
            dependency = if ($splitEntrypointsPresent) {
                $null
            }
            else {
                "Switch's real control/display entrypoint split is still absent under frontend/src/*.tsx, so this guard is prepared but blocked until separate /control and /display surfaces route through the same App-owned backend sync and speech.lifecycle path."
            }
        }
        app_owner_state = [ordered]@{
            app_files = @($surfaceRecords | ForEach-Object { $_.path })
            total_app_surface_file_count = $surfaceRecords.Count
            backend_sync_owner_files = $backendSyncOwnerFiles
            speech_lifecycle_owner_files = $speechLifecycleOwnerFiles
            operator_command_owner_files = $operatorCommandOwnerFiles
            secondary_backend_sync_path_present = $backendSyncOwnerFiles.Count -gt 1
            secondary_speech_lifecycle_path_present = $speechLifecycleOwnerFiles.Count -gt 1
        }
        operator_command_state = [ordered]@{
            owner_files = $operatorCommandOwnerFiles
            single_operator_command_owner = $operatorCommandOwnerFiles.Count -eq 1
            owner_outside_app = ($operatorCommandOwnerFiles.Count -eq 1) -and ($operatorCommandOwnerFiles[0] -cne 'frontend/src/app/App.tsx')
            display_surface_read_only = $displayReadOnlyForOperatorCommands
            backend_operator_command_path = if ($operatorCommandRouteMatch.Success) { $operatorCommandRouteMatch.Groups['path'].Value } else { $null }
            backend_operator_command_seam_locked = $operatorCommandRouteMatch.Success -and ($operatorCommandRouteMatch.Groups['path'].Value -ceq '/session/operator-command')
            published_command_types = $publishedCommandTypes
            published_command_types_locked = Test-StringArrayEquality -Left $publishedCommandTypes -Right @('text_question', 'tts_preview')
        }
        entrypoint_files = @($entrypointRecords | ForEach-Object { $_ })
        surface_files = @($surfaceRecords | ForEach-Object { $_ })
        alignment = [ordered]@{
            single_backend_sync_owner = $backendSyncOwnerFiles.Count -eq 1
            single_speech_lifecycle_owner = $speechLifecycleOwnerFiles.Count -eq 1
            single_operator_command_owner = $operatorCommandOwnerFiles.Count -eq 1
            duplicate_backend_sync_path_blocked = $backendSyncOwnerFiles.Count -le 1
            duplicate_speech_lifecycle_path_blocked = $speechLifecycleOwnerFiles.Count -le 1
            duplicate_operator_command_owner_blocked = $operatorCommandOwnerFiles.Count -le 1
            entrypoints_route_through_app = $entrypointsRouteThroughApp
            split_batch_unblocked = $splitEntrypointsPresent -and $entrypointsRouteThroughApp
            entrypoint_split_present = $splitEntrypointsPresent
            display_surface_read_only_for_operator_commands = $displayReadOnlyForOperatorCommands
        }
    }
}

function Invoke-FrontendStage1CharacterFlowRuntimeSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    $nodeLauncher = Get-NodeLauncher
    $tscPath = Join-Path $RepoRoot 'frontend\node_modules\typescript\bin\tsc'
    if (-not (Test-Path -LiteralPath $tscPath)) {
        throw 'Local TypeScript compiler not found at frontend/node_modules/typescript/bin/tsc. Run npm install in frontend before running frontend runtime stability scenarios.'
    }

    $scenarioTempRoot = Join-Path $RunRoot 'frontend-stage1-character-flow-runtime'
    $typeRootsPath = Join-Path $RepoRoot 'frontend\node_modules\@types'
    $snapshotPath = Join-Path $scenarioTempRoot 'backend-stage1-contracts.json'
    $runtimeScriptSourcePath = Join-Path $RepoRoot 'scripts\testing\frontendStage1CharacterFlow.runtime.ts'
    $runtimeScriptPath = Join-Path $scenarioTempRoot 'scripts\testing\frontendStage1CharacterFlow.runtime.js'
    $compileTargets = @(
        $runtimeScriptSourcePath
        (Join-Path $RepoRoot 'frontend\src\avatar\loaders\backendCharacterFlow.ts')
        (Join-Path $RepoRoot 'frontend\src\shared\types\character.ts')
    )

    New-DirectoryIfMissing -Path $scenarioTempRoot
    Set-Content -LiteralPath $snapshotPath -Value (ConvertTo-StableJson -InputObject $snapshotSource.snapshot) -Encoding Ascii

    $compileOutput = @(
        & $nodeLauncher.executable $tscPath --target ES2020 --module NodeNext --moduleResolution NodeNext --resolveJsonModule --esModuleInterop --strict --skipLibCheck --types node --typeRoots $typeRootsPath --outDir $scenarioTempRoot --rootDir $RepoRoot @compileTargets 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $compileExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($compileExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $nodeLauncher.runner
            phase = 'compile'
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $compileExitCode
            error_lines = @(
                $compileOutput | ForEach-Object {
                    Normalize-Text -Text $_ -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            )
        }
    }

    $runtimeOutput = @(
        & $nodeLauncher.executable $runtimeScriptPath $snapshotPath 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $runtimeExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($runtimeExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $nodeLauncher.runner
            phase = 'runtime'
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $runtimeExitCode
            error_lines = @(
                $runtimeOutput | ForEach-Object {
                    Normalize-Text -Text $_ -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            )
        }
    }

    $runtimeProof = ($runtimeOutput -join [Environment]::NewLine) | ConvertFrom-Json

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $nodeLauncher.runner
        backend_source_runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = $snapshotSource.local_root
        runtime_proof = $runtimeProof
    }
}

function Invoke-FrontendSpeechLifecycleRuntimeSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotSource = Invoke-BackendStage1SnapshotSource -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotSource.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotSource.exit_code -ne 0)) {
        return $snapshotSource
    }

    $nodeLauncher = Get-NodeLauncher
    $tscPath = Join-Path $RepoRoot 'frontend\node_modules\typescript\bin\tsc'
    if (-not (Test-Path -LiteralPath $tscPath)) {
        throw 'Local TypeScript compiler not found at frontend/node_modules/typescript/bin/tsc. Run npm install in frontend before running frontend runtime stability scenarios.'
    }

    $scenarioTempRoot = Join-Path $RunRoot 'frontend-speech-lifecycle-runtime'
    $typeRootsPath = Join-Path $RepoRoot 'frontend\node_modules\@types'
    $snapshotPath = Join-Path $scenarioTempRoot 'backend-speech-contracts.json'
    $runtimeScriptSourcePath = Join-Path $RepoRoot 'scripts\testing\frontendSpeechLifecycle.runtime.ts'
    $runtimeScriptPath = Join-Path $scenarioTempRoot 'scripts\testing\frontendSpeechLifecycle.runtime.js'
    $speechLifecycleLoaderSourcePath = Join-Path $RepoRoot 'frontend\src\avatar\loaders\speechLifecycle.ts'
    $appSourcePath = Join-Path $RepoRoot 'frontend\src\app\App.tsx'
    $compileTargets = @(
        $runtimeScriptSourcePath
        $speechLifecycleLoaderSourcePath
        (Join-Path $RepoRoot 'frontend\src\shared\types\character.ts')
    )

    New-DirectoryIfMissing -Path $scenarioTempRoot
    $speechContractsSnapshot = [ordered]@{
        contracts = $snapshotSource.snapshot.contracts
    }
    Set-Content -LiteralPath $snapshotPath -Value (ConvertTo-StableJson -InputObject $speechContractsSnapshot) -Encoding Ascii

    $compileOutput = @(
        & $nodeLauncher.executable $tscPath --target ES2020 --module NodeNext --moduleResolution NodeNext --resolveJsonModule --esModuleInterop --strict --skipLibCheck --types node --typeRoots $typeRootsPath --outDir $scenarioTempRoot --rootDir $RepoRoot @compileTargets 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $compileExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($compileExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $nodeLauncher.runner
            phase = 'compile'
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $compileExitCode
            error_lines = @(
                $compileOutput | ForEach-Object {
                    Normalize-Text -Text $_ -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            )
        }
    }

    $runtimeOutput = @(
        & $nodeLauncher.executable $runtimeScriptPath $snapshotPath $speechLifecycleLoaderSourcePath $appSourcePath 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $runtimeExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($runtimeExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $nodeLauncher.runner
            phase = 'runtime'
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $runtimeExitCode
            error_lines = @(
                $runtimeOutput | ForEach-Object {
                    Normalize-Text -Text $_ -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            )
        }
    }

    $runtimeProof = ($runtimeOutput -join [Environment]::NewLine) | ConvertFrom-Json

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $nodeLauncher.runner
        backend_source_runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = $snapshotSource.local_root
        runtime_proof = $runtimeProof
    }
}

function Invoke-ScenarioSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    switch ($Scenario.harness) {
        'contract-validator' {
            return Invoke-ContractValidatorSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'bootstrap-prerequisites' {
            return Invoke-BootstrapPrerequisiteSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'bootstrap-report-surface' {
            return Invoke-BootstrapReportSurfaceSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'backend-stage1-contracts' {
            return Invoke-BackendStage1ContractSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'backend-speech-contracts' {
            return Invoke-BackendSpeechContractSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'backend-speech-event-store' {
            return Invoke-BackendSpeechEventStoreSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'backend-turn-publication' {
            return Invoke-BackendTurnPublicationSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'backend-speech-real-adapter-degraded' {
            return Invoke-BackendSpeechRealAdapterDegradedSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'backend-operator-command-surface' {
            return Invoke-BackendOperatorCommandSurfaceSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'backend-stage1-payload-surface' {
            return Invoke-BackendStage1PayloadSurfaceSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'frontend-stage1-bridge-surface' {
            return Invoke-FrontendStage1BridgeSurfaceSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'frontend-shell-split-surface' {
            return Invoke-FrontendShellSplitSurfaceSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'frontend-stage1-character-flow-runtime' {
            return Invoke-FrontendStage1CharacterFlowRuntimeSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'frontend-speech-lifecycle-runtime' {
            return Invoke-FrontendSpeechLifecycleRuntimeSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        default {
            throw "Unsupported harness '$($Scenario.harness)' for scenario '$($Scenario.id)'."
        }
    }
}

$resolvedSuiteRoot = (Resolve-Path $SuiteRoot).Path
$repoRoot = Get-RepoRoot -SuiteRootPath $resolvedSuiteRoot
$manifestPath = Join-Path $resolvedSuiteRoot 'scenarios\scenarios.psd1'
$manifest = Import-PowerShellDataFile -Path $manifestPath

$scenarioList = @($manifest.scenarios)
if ($Scenario -and $Scenario.Count -gt 0) {
    $scenarioList = @($scenarioList | Where-Object { $_.id -in $Scenario })
}

if ($scenarioList.Count -eq 0) {
    throw 'No stability scenarios matched the requested filter.'
}

$currentRoot = Join-Path $resolvedSuiteRoot 'artifacts\current'
$reportRoot = Join-Path $resolvedSuiteRoot 'artifacts\reports'
New-DirectoryIfMissing -Path $currentRoot
New-DirectoryIfMissing -Path $reportRoot

$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$runRoot = Join-Path $currentRoot $runId
New-DirectoryIfMissing -Path $runRoot

$results = New-Object System.Collections.Generic.List[object]

foreach ($scenarioDefinition in $scenarioList) {
    $scenarioData = @{}
    foreach ($entry in $scenarioDefinition.GetEnumerator()) {
        $scenarioData[$entry.Key] = $entry.Value
    }

    $baselinePath = Join-Path $resolvedSuiteRoot $scenarioData.baseline
    $snapshotObject = Invoke-ScenarioSnapshot -RepoRoot $repoRoot -Scenario $scenarioData -RunRoot $runRoot
    $snapshotJson = ConvertTo-StableJson -InputObject $snapshotObject
    $currentSnapshotPath = Join-Path $runRoot ("{0}.json" -f $scenarioData.id)
    $diffPath = Join-Path $runRoot ("{0}.diff.txt" -f $scenarioData.id)
    Set-Content -LiteralPath $currentSnapshotPath -Value $snapshotJson -Encoding Ascii

    $status = 'pass'
    $diffPreview = @()

    if ($RefreshBaselines) {
        $baselineDirectory = Split-Path -Parent $baselinePath
        New-DirectoryIfMissing -Path $baselineDirectory
        Copy-Item -LiteralPath $currentSnapshotPath -Destination $baselinePath -Force
        $status = 'baseline-updated'
    }
    elseif (-not (Test-Path -LiteralPath $baselinePath)) {
        $status = 'pending-baseline'
        $diffPreview = @('Baseline file is missing. Run with -RefreshBaselines to create it intentionally.')
    }
    else {
        $baselineJson = Normalize-ComparisonText -Text (Get-Content -LiteralPath $baselinePath -Raw)
        $currentJson = Normalize-ComparisonText -Text $snapshotJson
        $baselineCanonical = ConvertTo-CanonicalComparisonText -Text $baselineJson
        $currentCanonical = ConvertTo-CanonicalComparisonText -Text $currentJson
        if ($baselineCanonical -cne $currentCanonical) {
            $status = 'diff'
            $diffPreview = @(Get-LineDiff -BaselineText $baselineJson -CurrentText $currentJson)
        }
    }

    if ($diffPreview.Count -gt 0) {
        Set-Content -LiteralPath $diffPath -Value $diffPreview -Encoding Ascii
    }
    elseif (Test-Path -LiteralPath $diffPath) {
        Remove-Item -LiteralPath $diffPath -Force
    }

    $resolvedDiffPath = if (Test-Path -LiteralPath $diffPath) { $diffPath } else { $null }
    $resultRecord = [pscustomobject][ordered]@{
        id = $scenarioData.id
        name = $scenarioData.name
        baseline = $scenarioData.baseline
        current_snapshot = $currentSnapshotPath
        status = $status
        diff_path = $resolvedDiffPath
        diff_preview = @($diffPreview | Select-Object -First 12)
    }

    $results.Add($resultRecord) | Out-Null
}

$resultStatuses = @($results | ForEach-Object { $_.status })
$hasDifferences = ($resultStatuses -contains 'diff') -or ($resultStatuses -contains 'pending-baseline')
$overallStatus = if ($hasDifferences) { 'attention' } else { 'pass' }
$refreshEnabled = [bool]$RefreshBaselines
$scenarioResults = @($results | ForEach-Object { $_ })
$report = [pscustomobject][ordered]@{
    generated_at = (Get-Date).ToString('o')
    refresh_baselines = $refreshEnabled
    overall_status = $overallStatus
    run_id = $runId
    scenarios = $scenarioResults
}

$reportPath = Join-Path $reportRoot ("stability-report-{0}.json" -f $runId)
Set-Content -LiteralPath $reportPath -Value (ConvertTo-StableJson -InputObject $report) -Encoding Ascii

Write-Host ("Stability suite: {0}" -f $overallStatus)
Write-Host ("Report: {0}" -f $reportPath)
foreach ($result in $results) {
    Write-Host ("- [{0}] {1}" -f $result.status.ToUpperInvariant(), $result.id)
    if ($result.diff_preview.Count -gt 0) {
        foreach ($line in $result.diff_preview) {
            Write-Host ("    {0}" -f $line)
        }
    }
}

if ($overallStatus -ne 'pass') {
    exit 1
}

exit 0