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
    $catalogLoaderPath = Join-Path $RepoRoot 'frontend\src\avatar\loaders\characterCatalog.ts'
    $appSource = Get-Content -LiteralPath $appPath -Raw
    $characterTypesSource = Get-Content -LiteralPath $characterTypesPath -Raw
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
    $usesCatalogEnvelopeCharacters = [regex]::IsMatch($catalogLoaderSource, '\.characters\b')
    $readsCatalogActiveCharacterId = [regex]::IsMatch($catalogLoaderSource, '\.active_character_id\b')
    $loaderExportsStructuredSyncError = [regex]::IsMatch($catalogLoaderSource, '(?ms)export class\s+ActiveCharacterSyncError\s+extends\s+Error')
    $loaderPreservesRejectionDocument = [regex]::IsMatch(
        $catalogLoaderSource,
        '(?ms)readonly response:\s*BackendActiveCharacterResponseDocument\s*;.*?throw new ActiveCharacterSyncError\(document,\s*response\.status\)'
    )
    $appHandlesStructuredSyncError = [regex]::IsMatch($appSource, 'error\s+instanceof\s+ActiveCharacterSyncError')
    $appUsesRejectedSelectionMessage = [regex]::IsMatch($appSource, 'error\.response\.selection\.message')
    $appReconcilesRejectedSelection = [regex]::IsMatch(
        $appSource,
        '(?ms)if\s*\(error\s+instanceof\s+ActiveCharacterSyncError\)\s*\{.*?const\s+(?<reconciledId>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*loadState\.catalog\s*\?\s*resolveSelectedCharacterId\(\s*loadState\.catalog\s*,\s*error\.response\.active_character\.character_id\s*\)\s*:\s*selectedCharacterId\s*;.*?setSelectedCharacterId\(\s*\k<reconciledId>\s*\);.*?error\.response\.selection\.message'
    )

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
            runner = 'py -3'
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

function Invoke-AnimationContractBoundarySnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $pythonLauncher = Get-PythonLauncher
    $scriptPath = Join-Path $RunRoot 'animation-contract-boundaries.py'
    $pythonScript = @'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def extract_dataclass_fields(source_text: str, class_name: str) -> list[dict[str, object]]:
    class_pattern = re.compile(
        r"@dataclass\([^\n]*\)\s*\nclass\s+" + re.escape(class_name) + r"\s*:\s*\n(?P<body>(?:    .*\n)+)",
        re.MULTILINE,
    )
    match = class_pattern.search(source_text)
    if not match:
        return []

    fields: list[dict[str, object]] = []
    for line in match.group("body").splitlines():
        field_match = re.match(
            r"\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<type>[^=\n]+?)(?:\s*=\s*(?P<default>.+))?$",
            line,
        )
        if not field_match:
            continue

        default_value = field_match.group("default")
        fields.append(
            {
                "name": field_match.group("name"),
                "type": field_match.group("type").strip(),
                "required": default_value is None,
                "default": default_value.strip() if default_value is not None else None,
            }
        )

    return fields


def extract_constant_assignment(source_text: str, name: str) -> str | None:
    match = re.search(r"(?m)^" + re.escape(name) + r"\s*=\s*(?P<value>.+)$", source_text)
    if not match:
        return None
    return match.group("value").strip()


def extract_method_signature(source_text: str, class_name: str, method_name: str) -> dict[str, str | None]:
    class_pattern = re.compile(r"^class\s+" + re.escape(class_name) + r"(?:\([^\)]*\))?\s*:\s*$")
    method_pattern = re.compile(
        r"^\s*def\s+"
        + re.escape(method_name)
        + r"\s*\(\s*self\s*,\s*(?P<arg_name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<arg_type>[^\)]+)\)\s*->\s*(?P<return_type>[^:]+):"
    )

    in_target_class = False
    for line in source_text.splitlines():
        if not in_target_class:
            if class_pattern.match(line):
                in_target_class = True
            continue

        if line and not line.startswith(" "):
            break

        method_match = method_pattern.match(line)
        if method_match:
            return {
                "name": method_name,
                "argument_annotation": method_match.group("arg_type").strip(),
                "return_annotation": method_match.group("return_type").strip(),
            }

    return {"name": method_name, "argument_annotation": None, "return_annotation": None}


def extract_stub_alias_target(source_text: str) -> str | None:
    match = re.search(r"(?m)^StubAnimationService\s*=\s*(?P<target>[A-Za-z_][A-Za-z0-9_]*)$", source_text)
    if not match:
        return None
    return match.group("target")


def extract_shared_animation_ids(source_text: str) -> list[str]:
    match = re.search(
        r"DEFAULT_SHARED_ANIMATION_IDS\s*=\s*frozenset\(\s*\{(?P<body>.*?)\}\s*\)",
        source_text,
        re.DOTALL,
    )
    if not match:
        return []

    return sorted(re.findall(r'"([^"]+)"', match.group("body")))


def extract_shared_animation_id_entries(source_text: str) -> list[str]:
    match = re.search(
        r"DEFAULT_SHARED_ANIMATION_IDS\s*=\s*frozenset\(\s*\{(?P<body>.*?)\}\s*\)",
        source_text,
        re.DOTALL,
    )
    if not match:
        return []

    entries = []
    for line in match.group("body").splitlines():
        stripped = line.strip().rstrip(",")
        if stripped:
            entries.append(stripped)

    return sorted(entries)


repo_root = Path(sys.argv[1]).resolve()
schema_source = (repo_root / "backend" / "app" / "schemas" / "animation.py").read_text(encoding="utf-8")
service_source = (repo_root / "backend" / "app" / "services" / "animation.py").read_text(encoding="utf-8")

target_classes = [
    "AnimationTimingHint",
    "AnimationPolicy",
    "AnimationIntent",
    "AnimationResolution",
    "AnimationPlayback",
    "AnimationCommand",
    "AnimationPlaybackEvent",
]
dataclass_surface = []

for class_name in target_classes:
    class_fields = extract_dataclass_fields(schema_source, class_name)
    dataclass_surface.append(
        {
            "name": class_name,
            "field_order": [field["name"] for field in class_fields],
            "required_field_names": [field["name"] for field in class_fields if field["required"]],
            "fields": class_fields,
        }
    )

registry_path = repo_root / "assets" / "animations" / "dsl" / "shared" / "animations.json"
registry = json.loads(registry_path.read_text(encoding="utf-8"))
sidecar_snapshots = []

for semantic_id in sorted(registry.get("sidecars", {})):
    entry = registry["sidecars"][semantic_id]
    staged_path = entry["path"]
    sidecar_path = repo_root / staged_path
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sidecar_snapshots.append(
        {
            "semantic_id": semantic_id,
            "registry_path": staged_path,
            "registry_stage": entry.get("stage"),
            "registry_approved_for_shared_library": bool(entry.get("approved_for_shared_library")),
            "sidecar_stage": sidecar.get("stage"),
            "sidecar_approved_for_shared_library": bool(sidecar.get("approved_for_shared_library")),
            "sidecar_promotion_status": sidecar.get("promotion_status"),
            "source_kind": sidecar.get("source", {}).get("kind"),
            "source_path": sidecar.get("source", {}).get("path"),
            "path_stays_in_staged_dsl_root": staged_path.startswith("assets/animations/dsl/shared/"),
            "path_uses_shared_library_root": staged_path.startswith("assets/animations/library/shared/"),
            "path_uses_override_root": staged_path.startswith("assets/animations/overrides/"),
            "path_uses_generated_root": staged_path.startswith("assets/animations/generated/"),
            "stage_matches_sidecar": entry.get("stage") == sidecar.get("stage"),
            "approval_matches_sidecar": bool(entry.get("approved_for_shared_library")) == bool(sidecar.get("approved_for_shared_library")),
        }
    )

payload = {
    "scenario_id": "animation-contract-boundaries",
    "contract_surface": {
        "schema_constants": {
            "ANIMATION_SCHEMA_VERSION": extract_constant_assignment(schema_source, "ANIMATION_SCHEMA_VERSION"),
            "DEFAULT_FALLBACK_SEMANTIC_ID": extract_constant_assignment(schema_source, "DEFAULT_FALLBACK_SEMANTIC_ID"),
        },
        "dataclasses": dataclass_surface,
        "service_surface": {
            "protocol_method": extract_method_signature(service_source, "AnimationService", "resolve_intent"),
            "default_service_method": extract_method_signature(service_source, "DefaultAnimationService", "resolve_intent"),
            "stub_alias_target": extract_stub_alias_target(service_source),
            "default_shared_animation_id_entries": extract_shared_animation_id_entries(service_source),
            "default_shared_animation_ids": extract_shared_animation_ids(service_source),
        },
    },
    "staged_registry_boundary": {
        "registry_version": registry.get("registry_version"),
        "shared_set": registry.get("shared_set"),
        "semantic_ids": [snapshot["semantic_id"] for snapshot in sidecar_snapshots],
        "sidecar_count": len(sidecar_snapshots),
        "sidecars": sidecar_snapshots,
        "all_sidecars_stay_in_staged_dsl_root": all(snapshot["path_stays_in_staged_dsl_root"] for snapshot in sidecar_snapshots),
        "all_sidecars_unapproved_for_shared_library": all(not snapshot["registry_approved_for_shared_library"] for snapshot in sidecar_snapshots),
        "all_sidecars_marked_not_promoted": all(snapshot["sidecar_promotion_status"] == "not_promoted" for snapshot in sidecar_snapshots),
        "any_sidecar_uses_shared_library_root": any(snapshot["path_uses_shared_library_root"] for snapshot in sidecar_snapshots),
        "any_sidecar_uses_override_root": any(snapshot["path_uses_override_root"] for snapshot in sidecar_snapshots),
        "any_sidecar_uses_generated_root": any(snapshot["path_uses_generated_root"] for snapshot in sidecar_snapshots),
        "all_registry_and_sidecar_flags_match": all(
            snapshot["stage_matches_sidecar"] and snapshot["approval_matches_sidecar"]
            for snapshot in sidecar_snapshots
        ),
    },
}

json.dump(payload, sys.stdout, indent=4)
sys.stdout.write("\n")
'@

    Set-Content -LiteralPath $scriptPath -Value $pythonScript -Encoding Ascii

    $outputLines = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($scriptPath, $RepoRoot)) 2>&1 |
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

    $snapshotObject = ($outputLines -join [Environment]::NewLine) | ConvertFrom-Json

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $pythonLauncher.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        contract_surface = $snapshotObject.contract_surface
        staged_registry_boundary = $snapshotObject.staged_registry_boundary
    }
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

function Invoke-BackendSessionAnimationLiveDeliverySnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $pythonLauncher = Get-PythonLauncher
    $scenarioTempRoot = Join-Path $RunRoot 'backend-session-animation-live-delivery'
    $probeScriptPath = Join-Path $scenarioTempRoot 'backend-session-animation-live-delivery.py'
    New-DirectoryIfMissing -Path $scenarioTempRoot

    $pythonScript = @'
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import cast


repo_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repo_root / "backend"))

from app.api.router import _serialize_dataclass_payload
from app.services.animation import SESSION_ANIMATION_STREAM
from tests.test_event_store import (
    FakeHTTPException,
    FakeRequest,
    FakeStreamingResponse,
    SessionLifecycleUpdateRequest,
    build_session_animation_route_endpoints,
    canonicalize_transport_payload,
    collect_streaming_payload,
    parse_sse_messages,
)


def sorted_keys(value: object) -> list[str]:
    if not isinstance(value, dict):
        return []
    return sorted(value.keys())


animation_endpoint, lifecycle_endpoint, live_delivery = build_session_animation_route_endpoints()

snapshot_response = asyncio.run(
    animation_endpoint(FakeRequest(headers={"accept": "application/json"}), cursor=None)
)
snapshot_payload = _serialize_dataclass_payload(snapshot_response)

lifecycle_endpoint(SessionLifecycleUpdateRequest(lifecycle_state="listen"))
lifecycle_endpoint(SessionLifecycleUpdateRequest(lifecycle_state="speak"))
published_updates = live_delivery.read_updates("session-scaffold-01")

streaming_response = cast(
    FakeStreamingResponse,
    asyncio.run(
        animation_endpoint(FakeRequest(headers={"accept": "text/event-stream"}), cursor=None)
    ),
)
messages = parse_sse_messages(collect_streaming_payload(streaming_response))

resume_cursor = published_updates[0].cursor
resume_response = cast(
    FakeStreamingResponse,
    asyncio.run(
        animation_endpoint(
            FakeRequest(headers={"accept": "text/event-stream"}),
            cursor=resume_cursor,
        )
    ),
)
resume_messages = parse_sse_messages(collect_streaming_payload(resume_response))

invalid_cursor_rejection = None
try:
    asyncio.run(
        animation_endpoint(
            FakeRequest(headers={"accept": "text/event-stream"}),
            cursor=f"{SESSION_ANIMATION_STREAM}:wrong-session:1",
        )
    )
except FakeHTTPException as error:
    invalid_cursor_rejection = {
        "status_code": error.status_code,
        "detail": error.detail,
        "detail_contains_session_mismatch": "does not belong" in error.detail,
    }

json.dump(
    {
        "route_surface": {
            "snapshot_path": "/session/animation",
            "lifecycle_update_path": "/session/lifecycle-state",
            "stream_name": SESSION_ANIMATION_STREAM,
        },
        "snapshot_delivery": {
            "response_keys": sorted_keys(snapshot_payload),
            "command_keys": sorted_keys(snapshot_payload.get("command", {})),
            "session_id": snapshot_payload["session_id"],
            "lifecycle_state": snapshot_payload["lifecycle_state"],
            "active_character_id": snapshot_payload["active_character_id"],
            "semantic_id": snapshot_payload["command"]["semantic_id"],
            "resolved_state": snapshot_payload["command"]["resolved_state"],
        },
        "live_delivery": {
            "media_type": streaming_response.media_type,
            "delivery_cursors_seen": live_delivery.cursors,
            "event_count": len(messages),
            "event_names": [message.get("event") for message in messages],
            "cursor_ids": [message.get("id") for message in messages],
            "lifecycle_states": [json.loads(message["data"])["lifecycle_state"] for message in messages],
            "semantic_ids": [json.loads(message["data"])["command"]["semantic_id"] for message in messages],
            "payload_matches_published_updates": [
                canonicalize_transport_payload(json.loads(message["data"]))
                for message in messages
            ]
            == [
                canonicalize_transport_payload(_serialize_dataclass_payload(update.snapshot))
                for update in published_updates
            ],
        },
        "resume_delivery": {
            "requested_cursor": resume_cursor,
            "delivery_cursors_seen": live_delivery.cursors,
            "event_count": len(resume_messages),
            "event_names": [message.get("event") for message in resume_messages],
            "cursor_ids": [message.get("id") for message in resume_messages],
            "lifecycle_states": [json.loads(message["data"])["lifecycle_state"] for message in resume_messages],
            "semantic_ids": [json.loads(message["data"])["command"]["semantic_id"] for message in resume_messages],
            "payload_matches_resumed_update": [
                canonicalize_transport_payload(json.loads(message["data"]))
                for message in resume_messages
            ]
            == [
                canonicalize_transport_payload(_serialize_dataclass_payload(update.snapshot))
                for update in published_updates[1:]
            ],
        },
        "invalid_cursor_rejection": invalid_cursor_rejection,
    },
    sys.stdout,
    indent=2,
)
sys.stdout.write("\n")
'@
    Set-Content -LiteralPath $probeScriptPath -Value $pythonScript -Encoding Ascii

    $probeOutput = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($probeScriptPath, $RepoRoot)) 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $probeExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($probeExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $pythonLauncher.runner
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $probeExitCode
            error_lines = @(
                $probeOutput | ForEach-Object {
                    Normalize-Text -Text $_ -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            )
        }
    }

    $probeSnapshot = ($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $pythonLauncher.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        route_surface = $probeSnapshot.route_surface
        snapshot_delivery = $probeSnapshot.snapshot_delivery
        live_delivery = $probeSnapshot.live_delivery
        resume_delivery = $probeSnapshot.resume_delivery
        invalid_cursor_rejection = $probeSnapshot.invalid_cursor_rejection
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
    $pythonLauncher = Get-PythonLauncher
    $probeScriptPath = Join-Path $RunRoot 'backend-operator-command-surface.py'
    $pythonScript = @'
from __future__ import annotations

import asyncio
import inspect
import json
import sys
import types
from pathlib import Path
from unittest.mock import patch


repo_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repo_root / "backend"))

from app.api.router import _serialize_dataclass_payload, build_api_router
from app.schemas.session import OperatorCommandRequest


class FakeHTTPException(Exception):
    def __init__(self, *, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeRequest:
    def __init__(self, *, headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}

    async def is_disconnected(self) -> bool:
        return False


class FakeResponse:
    def __init__(self) -> None:
        self.status_code = 200


class FakeStreamingResponse:
    def __init__(self, body_iterator, media_type: str) -> None:
        self.body_iterator = body_iterator
        self.media_type = media_type


class FakeRoute:
    def __init__(self, path: str, endpoint, methods: tuple[str, ...]) -> None:
        self.path = path
        self.endpoint = endpoint
        self.methods = methods


class FakeAPIRouter:
    def __init__(self) -> None:
        self.routes: list[FakeRoute] = []

    def get(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "GET")

    def put(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "PUT")

    def post(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "POST")

    def _register(self, path: str, method: str):
        def decorator(endpoint):
            self.routes.append(FakeRoute(path=path, endpoint=endpoint, methods=(method,)))
            return endpoint

        return decorator


def build_router():
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.APIRouter = FakeAPIRouter
    fake_fastapi.HTTPException = FakeHTTPException
    fake_fastapi.Request = FakeRequest
    fake_fastapi.Response = FakeResponse
    fake_fastapi.status = types.SimpleNamespace(HTTP_400_BAD_REQUEST=400)
    fake_fastapi_responses = types.ModuleType("fastapi.responses")
    fake_fastapi_responses.StreamingResponse = FakeStreamingResponse

    with patch.dict(
        sys.modules,
        {
            "fastapi": fake_fastapi,
            "fastapi.responses": fake_fastapi_responses,
        },
    ):
        return build_api_router()


def get_route(router, path: str, method: str):
    for route in router.routes:
        if route.path == path and method in route.methods:
            return route
    return None


def invoke(endpoint, **provided_arguments):
    call_arguments: dict[str, object] = {}

    for parameter_name, parameter in inspect.signature(endpoint).parameters.items():
        if parameter_name in provided_arguments:
            call_arguments[parameter_name] = provided_arguments[parameter_name]
        elif parameter_name == "request":
            call_arguments[parameter_name] = FakeRequest()
        elif parameter_name == "response":
            call_arguments[parameter_name] = FakeResponse()
        elif parameter.default is inspect.Signature.empty:
            raise RuntimeError(f"Unhandled required endpoint parameter: {parameter_name}")

    result = endpoint(**call_arguments)
    if inspect.isawaitable(result):
        return asyncio.run(result)

    return result


def route_records(router) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for route in router.routes:
        for method in route.methods:
            if method in {"POST", "PUT", "PATCH", "DELETE"}:
                records.append(
                    {
                        "method": method,
                        "path": route.path,
                        "name": route.endpoint.__name__,
                    }
                )
    return records


def build_command_probe(command_type: str, text: str) -> dict[str, object]:
    router = build_router()
    operator_route = get_route(router, "/session/operator-command", "POST")
    speech_route = get_route(router, "/session/speech-lifecycle", "GET")
    animation_route = get_route(router, "/session/animation", "GET")

    if operator_route is None or speech_route is None or animation_route is None:
        return {
            "present": False,
            "request_keys": [],
            "response_keys": [],
            "session_event_type": None,
            "speech_lifecycle_event_types": [],
            "round_trips_through_speech_snapshot": False,
            "animation_surface_session_alignment": False,
        }

    request_payload = {
        "command_type": command_type,
        "text": text,
        "locale": "en-US",
    }
    animation_payload = _serialize_dataclass_payload(invoke(animation_route.endpoint))
    response_payload = _serialize_dataclass_payload(
        invoke(
            operator_route.endpoint,
            command=OperatorCommandRequest(**request_payload),
        )
    )
    speech_payload = _serialize_dataclass_payload(invoke(speech_route.endpoint))

    return {
        "present": True,
        "request_keys": sorted(request_payload.keys()),
        "response_keys": sorted(response_payload.keys()),
        "session_event_type": response_payload["session_event"]["event_type"],
        "speech_lifecycle_event_types": [
            envelope["event"]["event_type"] for envelope in response_payload["speech_lifecycle_events"]
        ],
        "round_trips_through_speech_snapshot": (
            response_payload["speech_lifecycle_events"] == speech_payload["events"]
            and response_payload["next_speech_cursor"] == speech_payload["next_cursor"]
        ),
        "animation_surface_session_alignment": (
            response_payload["session_id"] == animation_payload["session_id"]
            and response_payload["character_id"] == animation_payload["active_character_id"]
        ),
    }


router = build_router()
write_routes = route_records(router)

payload = {
    "writable_routes": write_routes,
    "operator_command_route_count": sum(1 for route in write_routes if route["path"] == "/session/operator-command"),
    "animation_lifecycle_route_present": any(
        route["method"] == "PUT" and route["path"] == "/session/lifecycle-state"
        for route in write_routes
    ),
    "text_question": build_command_probe("text_question", "What should I do next?"),
    "tts_preview": build_command_probe("tts_preview", "This is a voice preview."),
}

json.dump(payload, sys.stdout, indent=2)
sys.stdout.write("\n")
'@

    Set-Content -LiteralPath $probeScriptPath -Value $pythonScript -Encoding Ascii

    $probeOutput = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($probeScriptPath, $RepoRoot)) 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $probeExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($probeExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $pythonLauncher.runner
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $probeExitCode
            error_lines = @($probeOutput | ForEach-Object { Normalize-Text -Text $_ -RepoRoot $RepoRoot -RunRoot $RunRoot })
        }
    }

    $executionSnapshot = ($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json

    $routes = @(
        $snapshotSource.snapshot.routes | ForEach-Object {
            [ordered]@{
                method = $_.method
                path = $_.path
                name = $_.name
            }
        }
    )
    $writeRoutes = @($executionSnapshot.writable_routes)
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
    $textQuestionProbe = $executionSnapshot.text_question
    $ttsPreviewProbe = $executionSnapshot.tts_preview
    $hasTextQuestionExample = [bool]$textQuestionProbe.present
    $hasTtsPreviewExample = [bool]$ttsPreviewProbe.present
    $textQuestionRequestKeys = @($textQuestionProbe.request_keys)
    $textQuestionResponseKeys = @($textQuestionProbe.response_keys)
    $textQuestionSessionEventType = $textQuestionProbe.session_event_type
    $textQuestionSpeechEventTypes = @($textQuestionProbe.speech_lifecycle_event_types)
    $ttsPreviewRequestKeys = @($ttsPreviewProbe.request_keys)
    $ttsPreviewResponseKeys = @($ttsPreviewProbe.response_keys)
    $ttsPreviewSessionEventType = $ttsPreviewProbe.session_event_type
    $ttsPreviewSpeechEventTypes = @($ttsPreviewProbe.speech_lifecycle_event_types)

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $snapshotSource.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        local_root = $snapshotSource.local_root
        route_surface = [ordered]@{
            writable_routes = @($writeRoutes)
            non_selection_write_routes = @($nonSelectionWriteRoutes)
            operator_command_route_count = [int]$executionSnapshot.operator_command_route_count
            operator_command_route_present = [int]$executionSnapshot.operator_command_route_count -gt 0
            animation_lifecycle_route_present = [bool]$executionSnapshot.animation_lifecycle_route_present
            operator_route_markers = @($operatorRouteMarkers)
            dependency = if ([int]$executionSnapshot.operator_command_route_count -gt 0) {
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
            single_operator_command_route_present = [int]$executionSnapshot.operator_command_route_count -eq 1
            operator_command_coexists_with_animation_lifecycle = ([int]$executionSnapshot.operator_command_route_count -eq 1) -and [bool]$executionSnapshot.animation_lifecycle_route_present
            canonical_turn_publication_present = [bool]$turnPipelinePublisherPresent -and ($backendTurnRequestFields.Count -gt 0)
            command_examples_present = [bool]$hasTextQuestionExample -and [bool]$hasTtsPreviewExample
            shared_command_request_shape = Test-StringArrayEquality -Left $textQuestionRequestKeys -Right $ttsPreviewRequestKeys
            shared_command_response_shape = Test-StringArrayEquality -Left $textQuestionResponseKeys -Right $ttsPreviewResponseKeys
            text_question_routes_through_assistant =
                [bool]$hasTextQuestionExample -and
                ($textQuestionSessionEventType -ceq 'session.operator.text-question') -and
                (Test-StringArrayEquality -Left $textQuestionSpeechEventTypes -Right @('assistant.message', 'speech.synthesis')) -and
                [bool]$textQuestionProbe.round_trips_through_speech_snapshot -and
                [bool]$textQuestionProbe.animation_surface_session_alignment
            tts_preview_routes_through_synthesis =
                [bool]$hasTtsPreviewExample -and
                ($ttsPreviewSessionEventType -ceq 'session.operator.tts-preview') -and
                (Test-StringArrayEquality -Left $ttsPreviewSpeechEventTypes -Right @('speech.synthesis')) -and
                [bool]$ttsPreviewProbe.round_trips_through_speech_snapshot -and
                [bool]$ttsPreviewProbe.animation_surface_session_alignment
            operator_command_batch_unblocked =
                ([int]$executionSnapshot.operator_command_route_count -eq 1) -and
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
        & $nodeLauncher.executable $tscPath --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --resolveJsonModule --esModuleInterop --strict --skipLibCheck --types node --typeRoots $typeRootsPath --outDir $scenarioTempRoot --rootDir $RepoRoot @compileTargets 2>&1 |
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
        & $nodeLauncher.executable --experimental-specifier-resolution=node $runtimeScriptPath $snapshotPath 2>&1 |
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
    $compileTargets = @(
        $runtimeScriptSourcePath
        (Join-Path $RepoRoot 'frontend\src\avatar\loaders\speechLifecycle.ts')
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

function Invoke-FrontendAvatarIdleDefaultRuntimeSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $pythonLauncher = Get-PythonLauncher
    $nodeLauncher = Get-NodeLauncher
    $tscPath = Join-Path $RepoRoot 'frontend\node_modules\typescript\bin\tsc'
    if (-not (Test-Path -LiteralPath $tscPath)) {
        throw 'Local TypeScript compiler not found at frontend/node_modules/typescript/bin/tsc. Run npm install in frontend before running frontend runtime stability scenarios.'
    }

    $scenarioTempRoot = Join-Path $RunRoot 'frontend-avatar-idle-default-runtime'
    $typeRootsPath = Join-Path $RepoRoot 'frontend\node_modules\@types'
    $snapshotPath = Join-Path $scenarioTempRoot 'frontend-avatar-idle-default-runtime.json'
    $backendSnapshotScriptPath = Join-Path $scenarioTempRoot 'backend-session-idle-default.py'
    $runtimeScriptSourcePath = Join-Path $RepoRoot 'scripts\testing\frontendAvatarIdleDefault.runtime.ts'
    $runtimeScriptPath = Join-Path $scenarioTempRoot 'scripts\testing\frontendAvatarIdleDefault.runtime.js'
    $compileTargets = @(
        $runtimeScriptSourcePath
        (Join-Path $RepoRoot 'frontend\src\avatar\loaders\sessionAnimation.ts')
        (Join-Path $RepoRoot 'frontend\src\avatar\runtime\baseAnimationMotionProfile.ts')
        (Join-Path $RepoRoot 'frontend\src\avatar\runtime\defaultBaseAnimation.ts')
        (Join-Path $RepoRoot 'frontend\src\avatar\runtime\humanoidChannelPlayback.ts')
        (Join-Path $RepoRoot 'frontend\src\vite-env.d.ts')
        (Join-Path $RepoRoot 'frontend\src\shared\types\animation.ts')
        (Join-Path $RepoRoot 'frontend\src\shared\types\character.ts')
    )

    New-DirectoryIfMissing -Path $scenarioTempRoot

    $backendSnapshotScript = @'
from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path


repo_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repo_root / "backend"))

from app.api.router import build_api_contract_snapshot


contract_snapshot = build_api_contract_snapshot()
snapshot_document = contract_snapshot["responses"]["get_session_animation"]
updated_snapshot_document = contract_snapshot["responses"]["put_session_lifecycle_state"]["response"]
active_character_id = snapshot_document["active_character_id"]

json.dump(
    {
        "active_character_id": active_character_id,
        "snapshot_document": snapshot_document,
        "updated_snapshot_document": updated_snapshot_document,
    },
    sys.stdout,
    indent=2,
)
sys.stdout.write("\n")
'@
    Set-Content -LiteralPath $backendSnapshotScriptPath -Value $backendSnapshotScript -Encoding Ascii

    $backendOutput = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($backendSnapshotScriptPath, $RepoRoot)) 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $backendExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($backendExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $pythonLauncher.runner
            phase = 'backend-source'
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $backendExitCode
            error_lines = @(
                $backendOutput | ForEach-Object {
                    Normalize-Text -Text $_ -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            )
        }
    }

    $backendSnapshot = ($backendOutput -join [Environment]::NewLine) | ConvertFrom-Json

    function New-GeneratedRuntimePayloadSurface {
        param(
            [Parameter(Mandatory)]
            [string]$RuntimeFilePath
        )

        $runtimeDocument = Get-Content -LiteralPath $RuntimeFilePath -Raw | ConvertFrom-Json
        $representativeChannels = @(
            'chest.front_back'
            'head.nod.down_up'
            'head.turn.left_right'
        ) | ForEach-Object {
            $normalizedName = $_
            $channel = @($runtimeDocument.channels | Where-Object { $_.normalized_name -eq $normalizedName }) | Select-Object -First 1

            if ($null -eq $channel) {
                return $null
            }

            [ordered]@{
                normalized_name = $channel.normalized_name
                sample_count = @($channel.samples).Count
                min_value = if ($null -ne $channel.min_value) { [double]$channel.min_value } else { $null }
                max_value = if ($null -ne $channel.max_value) { [double]$channel.max_value } else { $null }
            }
        } | Where-Object { $null -ne $_ }

        return [ordered]@{
            runtime_document = [ordered]@{
                semantic_id = $runtimeDocument.semantic_id
                playback = [ordered]@{
                    mode = $runtimeDocument.playback.mode
                    loop = [bool]$runtimeDocument.playback.loop
                    duration_ms = [int]$runtimeDocument.playback.duration_ms
                }
                motion_profile = [ordered]@{
                    speed_multiplier = [double]$runtimeDocument.motion_profile.speed_multiplier
                    bob_amplitude = [double]$runtimeDocument.motion_profile.bob_amplitude
                    secondary_bob_amplitude = [double]$runtimeDocument.motion_profile.secondary_bob_amplitude
                    lean_amplitude = [double]$runtimeDocument.motion_profile.lean_amplitude
                    nod_amplitude = [double]$runtimeDocument.motion_profile.nod_amplitude
                    yaw_amplitude = [double]$runtimeDocument.motion_profile.yaw_amplitude
                }
            }
            exported_channel_summary = [ordered]@{
                channel_space = $runtimeDocument.channel_space
                channel_count = @($runtimeDocument.channels).Count
                playback_sample_count = if ($null -ne $runtimeDocument.playback.sample_count) {
                    [int]$runtimeDocument.playback.sample_count
                }
                else {
                    $null
                }
                representative_channels = @($representativeChannels)
            }
        }
    }

    $registryPath = Join-Path $RepoRoot 'assets\animations\dsl\shared\animations.json'
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    $registryEntry = $registry.sidecars.'idle.default'
    if ($null -eq $registryEntry) {
        throw 'Shared animation registry does not declare idle.default.'
    }

    $sidecarPath = Join-Path $RepoRoot ($registryEntry.path -replace '/', '\\')
    $sidecar = Get-Content -LiteralPath $sidecarPath -Raw | ConvertFrom-Json
    $schemaDocPath = Join-Path $RepoRoot 'docs\ANIMATION_DSL_SCHEMA.md'
    $schemaDoc = Get-Content -LiteralPath $schemaDocPath -Raw
    $appSource = Get-Content -LiteralPath (Join-Path $RepoRoot 'frontend\src\app\App.tsx') -Raw
    $runtimeSource = Get-Content -LiteralPath (Join-Path $RepoRoot 'frontend\src\avatar\runtime\avatarRuntime.ts') -Raw
    $humanoidPlaybackSource = Get-Content -LiteralPath (Join-Path $RepoRoot 'frontend\src\avatar\runtime\humanoidChannelPlayback.ts') -Raw
    $loaderSource = Get-Content -LiteralPath (Join-Path $RepoRoot 'frontend\src\avatar\loaders\sessionAnimation.ts') -Raw
    $idleRuntimePayloadSurface = New-GeneratedRuntimePayloadSurface -RuntimeFilePath (Join-Path $RepoRoot 'assets\animations\generated\shared\idle.default\idle.default.runtime.json')
    $speakRuntimePayloadSurface = New-GeneratedRuntimePayloadSurface -RuntimeFilePath (Join-Path $RepoRoot 'assets\animations\generated\shared\speak.loop\speak.loop.runtime.json')

    $snapshotInput = [ordered]@{
        backend_session_animation_surface = [ordered]@{
            active_character_id = $backendSnapshot.active_character_id
            snapshot_document = $backendSnapshot.snapshot_document
            updated_snapshot_document = $backendSnapshot.updated_snapshot_document
        }
        promoted_idle_asset = [ordered]@{
            registry_version = $registry.registry_version
            shared_set = $registry.shared_set
            semantic_id = 'idle.default'
            registry_path = $registryEntry.path
            registry_stage = $registryEntry.stage
            registry_approved_for_shared_library = [bool]$registryEntry.approved_for_shared_library
            registry_path_stays_in_staged_dsl_root = $registryEntry.path.StartsWith('assets/animations/dsl/shared/')
            sidecar_stage = $sidecar.stage
            sidecar_promotion_status = $sidecar.promotion_status
            sidecar_approved_for_shared_library = [bool]$sidecar.approved_for_shared_library
            source_kind = $sidecar.source.kind
            source_path = $sidecar.source.path
            source_provenance = $sidecar.source.provenance
            unity_clip_name = $sidecar.unity_clip.name
            unity_clip_sample_rate = $sidecar.unity_clip.sample_rate
            unity_clip_start_time = $sidecar.unity_clip.start_time
            unity_clip_stop_time = $sidecar.unity_clip.stop_time
            unity_clip_loop_time = $sidecar.unity_clip.loop_time
            derived_duration_ms = [math]::Round(([double]$sidecar.unity_clip.stop_time - [double]$sidecar.unity_clip.start_time) * 1000)
            schema_doc_mentions_idle_default_runtime_clip = $schemaDoc -match 'idle\.default\.vrma'
            schema_doc_declares_semantic_fallback = $schemaDoc -match 'fallback\.semantic_id'
        }
        frontend_source_surface = [ordered]@{
            app_mentions_idle_default_sidecar_path = $appSource -match 'assets/animations/dsl/shared/idle\.default\.json'
            app_mentions_animation_asset_root = $appSource -match 'assets/animations/'
            runtime_mentions_idle_default_sidecar_path = $runtimeSource -match 'assets/animations/dsl/shared/idle\.default\.json'
            runtime_mentions_animation_asset_root = $runtimeSource -match 'assets/animations/'
            runtime_load_path_seeds_default_idle = $runtimeSource -match 'baseAnimation:\s*cloneDefaultBaseAnimationCommand\(\)'
            avatar_runtime_wires_humanoid_channel_playback = $runtimeSource -match 'humanoidPlayback:\s*createHumanoidChannelPlayback\(currentAvatar\.vrm,\s*resolvedPayload\)'
            loader_fetches_session_animation_snapshot = $loaderSource -match 'buildBackendApiUrl\("/session/animation"\)'
            loader_live_url_reuses_animation_route = $loaderSource -match 'buildBackendApiUrl\("/session/animation"\)'
            humanoid_playback_factory_present = $humanoidPlaybackSource -match 'export function createHumanoidChannelPlayback'
            humanoid_playback_requires_unity_humanoid_channel_space = $humanoidPlaybackSource -match 'payload\.channelSpace !== "unity_humanoid_muscle"'
            humanoid_playback_binds_representative_channels =
                ($humanoidPlaybackSource -match '"chest\.front_back"') -and
                ($humanoidPlaybackSource -match '"head\.nod\.down_up"') -and
                ($humanoidPlaybackSource -match '"head\.turn\.left_right"')
        }
        generated_runtime_payload_surface = [ordered]@{
            idle_default = $idleRuntimePayloadSurface
            speak_loop = $speakRuntimePayloadSurface
        }
    }

    Set-Content -LiteralPath $snapshotPath -Value (ConvertTo-StableJson -InputObject $snapshotInput) -Encoding Ascii

    $compileOutput = @(
        & $nodeLauncher.executable $tscPath --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --resolveJsonModule --esModuleInterop --strict --skipLibCheck --types node --typeRoots $typeRootsPath --outDir $scenarioTempRoot --rootDir $RepoRoot @compileTargets 2>&1 |
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
        & $nodeLauncher.executable --experimental-specifier-resolution=node $runtimeScriptPath $snapshotPath 2>&1 |
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
    $snapshotObject = Get-Content -LiteralPath $snapshotPath -Raw | ConvertFrom-Json

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $nodeLauncher.runner
        backend_source_runner = $pythonLauncher.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        backend_session_animation_surface = $snapshotObject.backend_session_animation_surface
        promoted_idle_asset = $snapshotObject.promoted_idle_asset
        frontend_source_surface = $snapshotObject.frontend_source_surface
        generated_runtime_payload_surface = $snapshotObject.generated_runtime_payload_surface
        runtime_proof = $runtimeProof
    }
}

function Invoke-FrontendSemanticLoopAssetsRuntimeSnapshot {
    param(
        [Parameter(Mandatory)]
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [hashtable]$Scenario,
        [Parameter(Mandatory)]
        [string]$RunRoot
    )

    $pythonLauncher = Get-PythonLauncher
    $nodeLauncher = Get-NodeLauncher
    $tscPath = Join-Path $RepoRoot 'frontend\node_modules\typescript\bin\tsc'
    if (-not (Test-Path -LiteralPath $tscPath)) {
        throw 'Local TypeScript compiler not found at frontend/node_modules/typescript/bin/tsc. Run npm install in frontend before running frontend runtime stability scenarios.'
    }

    $scenarioTempRoot = Join-Path $RunRoot 'frontend-semantic-loop-assets-runtime'
    $typeRootsPath = Join-Path $RepoRoot 'frontend\node_modules\@types'
    $snapshotPath = Join-Path $scenarioTempRoot 'frontend-semantic-loop-assets-runtime.json'
    $backendSnapshotScriptPath = Join-Path $scenarioTempRoot 'backend-session-semantic-loops.py'
    $runtimeScriptSourcePath = Join-Path $RepoRoot 'scripts\testing\frontendSemanticLoopAssets.runtime.ts'
    $runtimeScriptPath = Join-Path $scenarioTempRoot 'scripts\testing\frontendSemanticLoopAssets.runtime.js'
    $compileTargets = @(
        $runtimeScriptSourcePath
        (Join-Path $RepoRoot 'frontend\src\avatar\runtime\baseAnimationMotionProfile.ts')
        (Join-Path $RepoRoot 'frontend\src\avatar\runtime\defaultBaseAnimation.ts')
        (Join-Path $RepoRoot 'frontend\src\vite-env.d.ts')
        (Join-Path $RepoRoot 'frontend\src\shared\types\animation.ts')
    )

    New-DirectoryIfMissing -Path $scenarioTempRoot

    $backendSnapshotScript = @'
from __future__ import annotations

import json
import sys
from pathlib import Path


repo_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repo_root / "backend"))

from app.schemas.session import SessionSnapshot
from app.services.animation import DefaultAnimationService


service = DefaultAnimationService()
session_id = "session-scaffold-01"
active_character_id = "test-vrm-01"
states = ("idle", "listen", "speak")

commands = []
for lifecycle_state in states:
    command = service.resolve_session_command(
        SessionSnapshot(
            session_id=session_id,
            active_character_id=active_character_id,
            lifecycle_state=lifecycle_state,
        )
    )
    commands.append(
        {
            "lifecycle_state": lifecycle_state,
            "character_id": command.character_id,
            "semantic_id": command.semantic_id,
            "selected_source": command.resolution.selected_source,
            "playback_mode": command.playback.mode,
            "expected_duration_ms": command.playback.expected_duration_ms,
        }
    )

json.dump({"session_animation_commands": commands}, sys.stdout, indent=2)
sys.stdout.write("\n")
'@
    Set-Content -LiteralPath $backendSnapshotScriptPath -Value $backendSnapshotScript -Encoding Ascii

    $backendOutput = @(
        & $pythonLauncher.executable @($pythonLauncher.arguments + @($backendSnapshotScriptPath, $RepoRoot)) 2>&1 |
            ForEach-Object { [string]$_ }
    )
    $backendExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if ($backendExitCode -ne 0) {
        return [ordered]@{
            scenario_id = $Scenario.id
            scenario_name = $Scenario.name
            runner = $pythonLauncher.runner
            phase = 'backend-source'
            tracked_inputs = @($Scenario.tracked_inputs)
            exit_code = $backendExitCode
            error_lines = @(
                $backendOutput | ForEach-Object {
                    Normalize-Text -Text $_ -RepoRoot $RepoRoot -ScenarioTempRoot $scenarioTempRoot -RunRoot $RunRoot
                }
            )
        }
    }

    $registryPath = Join-Path $RepoRoot 'assets\animations\dsl\shared\animations.json'
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    $stagedListenPath = Join-Path $RepoRoot 'assets\animations\dsl\shared\listen.loop.json'
    $stagedSpeakPath = Join-Path $RepoRoot 'assets\animations\dsl\shared\speak.loop.json'
    $generatedListenPath = Join-Path $RepoRoot 'assets\animations\dsl\generated\shared\listen.loop.json'
    $generatedSpeakPath = Join-Path $RepoRoot 'assets\animations\dsl\generated\shared\speak.loop.json'
    $runtimeListenPath = Join-Path $RepoRoot 'assets\animations\generated\shared\listen.loop\listen.loop.runtime.json'
    $runtimeSpeakPath = Join-Path $RepoRoot 'assets\animations\generated\shared\speak.loop\speak.loop.runtime.json'

    $snapshotInput = [ordered]@{
        session_animation_commands = ($backendOutput -join [Environment]::NewLine | ConvertFrom-Json).session_animation_commands
        asset_surface = [ordered]@{
            shared_registry_semantic_ids = @($registry.sidecars.PSObject.Properties.Name | Sort-Object)
            staged_sidecars = @(
                (Get-Content -LiteralPath $stagedListenPath -Raw | ConvertFrom-Json),
                (Get-Content -LiteralPath $stagedSpeakPath -Raw | ConvertFrom-Json)
            )
            generated_candidates = @(
                (Get-Content -LiteralPath $generatedListenPath -Raw | ConvertFrom-Json),
                (Get-Content -LiteralPath $generatedSpeakPath -Raw | ConvertFrom-Json)
            )
            generated_runtime_payloads = @(
                (Get-Content -LiteralPath $runtimeListenPath -Raw | ConvertFrom-Json),
                (Get-Content -LiteralPath $runtimeSpeakPath -Raw | ConvertFrom-Json)
            )
        }
    }

    Set-Content -LiteralPath $snapshotPath -Value (ConvertTo-StableJson -InputObject $snapshotInput) -Encoding Ascii

    $compileOutput = @(
        & $nodeLauncher.executable $tscPath --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --resolveJsonModule --esModuleInterop --strict --skipLibCheck --types node --typeRoots $typeRootsPath --outDir $scenarioTempRoot --rootDir $RepoRoot @compileTargets 2>&1 |
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
        & $nodeLauncher.executable --experimental-specifier-resolution=node $runtimeScriptPath $snapshotPath 2>&1 |
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

    $snapshotObject = Get-Content -LiteralPath $snapshotPath -Raw | ConvertFrom-Json
    $runtimeProof = ($runtimeOutput -join [Environment]::NewLine) | ConvertFrom-Json

    return [ordered]@{
        scenario_id = $Scenario.id
        scenario_name = $Scenario.name
        runner = $nodeLauncher.runner
        backend_source_runner = $pythonLauncher.runner
        tracked_inputs = @($Scenario.tracked_inputs)
        backend_session_animation_surface = [ordered]@{
            session_animation_commands = $snapshotObject.session_animation_commands
        }
        asset_surface = $snapshotObject.asset_surface
        runtime_proof = $runtimeProof.runtime_proof
        alignment = [ordered]@{
            shared_registry_declares_semantic_loops =
                @($snapshotObject.asset_surface.shared_registry_semantic_ids) -contains 'listen.loop' -and
                @($snapshotObject.asset_surface.shared_registry_semantic_ids) -contains 'speak.loop'
            staged_sidecars_preserve_semantic_loops = @($snapshotObject.asset_surface.staged_sidecars | Where-Object {
                $_.semantic_id -in @('listen.loop', 'speak.loop')
            }).Count -eq 2
            generated_candidates_preserve_semantic_loops = @($snapshotObject.asset_surface.generated_candidates | Where-Object {
                $_.semantic_id -in @('listen.loop', 'speak.loop')
            }).Count -eq 2
            generated_runtime_payloads_preserve_semantic_loops = @($snapshotObject.asset_surface.generated_runtime_payloads | Where-Object {
                $_.semantic_id -in @('listen.loop', 'speak.loop')
            }).Count -eq 2
            all_backend_commands_use_shared_source = [bool]$runtimeProof.alignment.all_backend_commands_use_shared_source
            all_runtime_payloads_resolve = [bool]$runtimeProof.alignment.all_runtime_payloads_resolve
            all_runtime_payloads_match_backend_semantic_id = [bool]$runtimeProof.alignment.all_runtime_payloads_match_backend_semantic_id
            all_runtime_payloads_match_backend_playback = [bool]$runtimeProof.alignment.all_runtime_payloads_match_backend_playback
            all_runtime_payloads_match_backend_duration = [bool]$runtimeProof.alignment.all_runtime_payloads_match_backend_duration
            listen_payload_avoids_idle_alias = [bool]$runtimeProof.alignment.listen_payload_avoids_idle_alias
            speak_payload_avoids_idle_alias = [bool]$runtimeProof.alignment.speak_payload_avoids_idle_alias
            listen_motion_profile_differs_from_idle = [bool]$runtimeProof.alignment.listen_motion_profile_differs_from_idle
            speak_motion_profile_differs_from_idle = [bool]$runtimeProof.alignment.speak_motion_profile_differs_from_idle
            dedicated_semantic_loop_payloads_preserved = [bool]$runtimeProof.alignment.dedicated_semantic_loop_payloads_preserved
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
        'animation-contract-boundaries' {
            return Invoke-AnimationContractBoundarySnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
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
        'backend-session-animation-live-delivery' {
            return Invoke-BackendSessionAnimationLiveDeliverySnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
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
        'frontend-stage1-character-flow-runtime' {
            return Invoke-FrontendStage1CharacterFlowRuntimeSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'frontend-speech-lifecycle-runtime' {
            return Invoke-FrontendSpeechLifecycleRuntimeSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'frontend-avatar-idle-default-runtime' {
            return Invoke-FrontendAvatarIdleDefaultRuntimeSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
        }
        'frontend-semantic-loop-assets-runtime' {
            return Invoke-FrontendSemanticLoopAssetsRuntimeSnapshot -RepoRoot $RepoRoot -Scenario $Scenario -RunRoot $RunRoot
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