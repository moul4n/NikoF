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
            runner = 'py -3'
        }
    }

    throw 'Python launcher not found. Install Python or add it to PATH before running backend stability scenarios.'
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
snapshot["responses"]["get_active_character"]["session_event"]["timestamp"] = "<generated-at>"
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

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $pythonLauncher.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = '<scenario-temp>'
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

function Invoke-BackendStage1PayloadSurfaceSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $snapshotObject = Invoke-BackendStage1ContractSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot

    if (($snapshotObject.PSObject.Properties.Name -contains 'exit_code') -and ([int]$snapshotObject.exit_code -ne 0)) {
        return $snapshotObject
    }

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
        runner = $snapshotObject.runner
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
        'backend-stage1-payload-surface' {
            return Invoke-BackendStage1PayloadSurfaceSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
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