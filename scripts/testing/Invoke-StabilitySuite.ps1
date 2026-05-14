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

    return ($InputObject | ConvertTo-Json -Depth 10)
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
    $toolResults = @(Test-NikoFTooling -Config $config)
    $providerResults = @(Get-NikoFProviderStatus -Config $config -StorageLayout $storageLayout)

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = '<scenario-temp>'
        tooling = @(
            $toolResults | ForEach-Object {
                [ordered]@{
                    id = $_.id
                    available = [bool]$_.available
                }
            }
        )
        missing_tools = @($toolResults | Where-Object { -not $_.available } | ForEach-Object { $_.id })
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
        'backend-stage1-contracts' {
            return Invoke-BackendStage1ContractSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
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
        if ($baselineJson -cne $currentJson) {
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