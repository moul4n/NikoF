Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Add-Failure {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Message
    )

    $Failures.Add($Message) | Out-Null
}

function Add-Note {
    param(
        [System.Collections.Generic.List[string]]$Notes,
        [string]$Message
    )

    $Notes.Add($Message) | Out-Null
}

function Test-HasProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    return $null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    Get-Content -Raw -Path $Path | ConvertFrom-Json
}

function Assert-NonEmptyString {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Value
    )

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        Add-Failure -Failures $Failures -Message "$Label must be a non-empty string."
    }
}

function Assert-Property {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Object,
        [string]$PropertyName
    )

    if (-not (Test-HasProperty -Object $Object -Name $PropertyName)) {
        Add-Failure -Failures $Failures -Message "$Label is missing required property '$PropertyName'."
        return $false
    }

    return $true
}

function Assert-JsonSchemaFile {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$SchemaPath
    )

    $schema = Read-JsonFile -Path $SchemaPath

    foreach ($propertyName in @('$schema', 'title', 'type')) {
        if (-not (Assert-Property -Failures $Failures -Label $SchemaPath -Object $schema -PropertyName $propertyName)) {
            return
        }
    }

    if ($schema.'$schema' -ne 'https://json-schema.org/draft/2020-12/schema') {
        Add-Failure -Failures $Failures -Message "$SchemaPath must target JSON Schema draft 2020-12."
    }

    if ($schema.type -ne 'object') {
        Add-Failure -Failures $Failures -Message "$SchemaPath must declare an object root."
    }
}

function Assert-ManifestSummaryShape {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Summary
    )

    foreach ($propertyName in @('schema_version', 'character_id', 'display_name', 'identity_source', 'vrm_spec_version', 'supported_states', 'shared_animation_set')) {
        if (-not (Assert-Property -Failures $Failures -Label $Label -Object $Summary -PropertyName $propertyName)) {
            return
        }
    }

    if ($Summary.schema_version -ne 1) {
        Add-Failure -Failures $Failures -Message "$Label schema_version must equal 1."
    }

    foreach ($propertyName in @('character_id', 'display_name', 'identity_source', 'vrm_spec_version', 'shared_animation_set')) {
        Assert-NonEmptyString -Failures $Failures -Label "$Label.$propertyName" -Value $Summary.$propertyName
    }

    if ($Summary.supported_states -isnot [System.Array]) {
        Add-Failure -Failures $Failures -Message "$Label.supported_states must be an array."
        return
    }

    foreach ($requiredState in @('idle', 'listen', 'speak', 'emote')) {
        if ($Summary.supported_states -notcontains $requiredState) {
            Add-Failure -Failures $Failures -Message "$Label.supported_states must include '$requiredState'."
        }
    }
}

function Assert-AnimationEventShape {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Event
    )

    foreach ($propertyName in @('schema_version', 'event_type', 'session_id', 'character_id', 'semantic_id', 'source_category', 'playback', 'fallback')) {
        if (-not (Assert-Property -Failures $Failures -Label $Label -Object $Event -PropertyName $propertyName)) {
            return
        }
    }

    if ($Event.schema_version -ne 1) {
        Add-Failure -Failures $Failures -Message "$Label schema_version must equal 1."
    }

    foreach ($propertyName in @('event_type', 'session_id', 'character_id', 'semantic_id', 'source_category')) {
        Assert-NonEmptyString -Failures $Failures -Label "$Label.$propertyName" -Value $Event.$propertyName
    }

    if ($Event.source_category -notin @('shared-library', 'character-override', 'generated-staged')) {
        Add-Failure -Failures $Failures -Message "$Label.source_category must stay within the approved categories."
    }

    foreach ($objectName in @('playback', 'fallback')) {
        if ($Event.$objectName -isnot [pscustomobject]) {
            Add-Failure -Failures $Failures -Message "$Label.$objectName must be an object."
        }
    }
}

function Assert-SessionEventShape {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Event
    )

    foreach ($propertyName in @('schema_version', 'event_type', 'session_id', 'character_id', 'status', 'timestamp')) {
        if (-not (Assert-Property -Failures $Failures -Label $Label -Object $Event -PropertyName $propertyName)) {
            return
        }
    }

    if ($Event.schema_version -ne 1) {
        Add-Failure -Failures $Failures -Message "$Label schema_version must equal 1."
    }

    foreach ($propertyName in @('event_type', 'session_id', 'character_id', 'status', 'timestamp')) {
        Assert-NonEmptyString -Failures $Failures -Label "$Label.$propertyName" -Value $Event.$propertyName
    }
}

function Assert-PathExists {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        [string]$BasePath,
        [string]$RelativePath
    )

    $resolvedPath = Join-Path $BasePath $RelativePath
    if (-not (Test-Path -LiteralPath $resolvedPath)) {
        Add-Failure -Failures $Failures -Message "$Label must point to an existing file: $RelativePath"
    }
}

function Assert-ManifestPackage {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [System.Collections.Generic.List[string]]$Notes,
        [string]$CharacterPath,
        [string]$ExpectedCharacterId,
        [hashtable]$DisplayNames
    )

    $manifestPath = Join-Path $CharacterPath 'manifest.json'
    $manifest = Read-JsonFile -Path $manifestPath

    foreach ($propertyName in @('schema_version', 'character_id', 'display_name', 'identity_source', 'asset_version', 'vrm_spec_version', 'model_file', 'metadata_file', 'supported_states', 'shared_animation_set', 'voice_profile', 'expression_map', 'animation_overrides')) {
        if (-not (Assert-Property -Failures $Failures -Label $manifestPath -Object $manifest -PropertyName $propertyName)) {
            return
        }
    }

    if ($manifest.schema_version -ne 1) {
        Add-Failure -Failures $Failures -Message "$manifestPath schema_version must equal 1."
    }

    if ($manifest.character_id -ne $ExpectedCharacterId) {
        Add-Failure -Failures $Failures -Message "$manifestPath character_id must match folder name '$ExpectedCharacterId'."
    }

    Assert-NonEmptyString -Failures $Failures -Label "$manifestPath.display_name" -Value $manifest.display_name
    if ($DisplayNames.ContainsKey($manifest.display_name)) {
        Add-Failure -Failures $Failures -Message "$manifestPath display_name must be unique. '$($manifest.display_name)' is already used by $($DisplayNames[$manifest.display_name])."
    }
    else {
        $DisplayNames[$manifest.display_name] = $ExpectedCharacterId
    }

    if ($manifest.identity_source -ne 'scaffolded') {
        Add-Failure -Failures $Failures -Message "$manifestPath identity_source must remain 'scaffolded' until reviewed source metadata exists."
    }

    if ($manifest.vrm_spec_version -ne '1.0') {
        Add-Failure -Failures $Failures -Message "$manifestPath vrm_spec_version must equal '1.0'."
    }

    if ($manifest.supported_states -isnot [System.Array]) {
        Add-Failure -Failures $Failures -Message "$manifestPath supported_states must be an array."
    }
    else {
        foreach ($requiredState in @('idle', 'listen', 'speak', 'emote')) {
            if ($manifest.supported_states -notcontains $requiredState) {
                Add-Failure -Failures $Failures -Message "$manifestPath supported_states must include '$requiredState'."
            }
        }
    }

    if ($manifest.voice_profile -isnot [pscustomobject]) {
        Add-Failure -Failures $Failures -Message "$manifestPath voice_profile must be an object."
        return
    }

    foreach ($propertyName in @('profile_id', 'path')) {
        if (-not (Assert-Property -Failures $Failures -Label "$manifestPath.voice_profile" -Object $manifest.voice_profile -PropertyName $propertyName)) {
            return
        }
    }

    Assert-PathExists -Failures $Failures -Label "$manifestPath.metadata_file" -BasePath $CharacterPath -RelativePath $manifest.metadata_file
    Assert-PathExists -Failures $Failures -Label "$manifestPath.voice_profile.path" -BasePath $CharacterPath -RelativePath $manifest.voice_profile.path
    Assert-PathExists -Failures $Failures -Label "$manifestPath.expression_map" -BasePath $CharacterPath -RelativePath $manifest.expression_map
    Assert-PathExists -Failures $Failures -Label "$manifestPath.animation_overrides" -BasePath $CharacterPath -RelativePath $manifest.animation_overrides

    $modelPath = Join-Path $CharacterPath $manifest.model_file
    if (-not (Test-Path -LiteralPath $modelPath)) {
        Add-Note -Notes $Notes -Message "$ExpectedCharacterId is scaffold-valid but still missing $($manifest.model_file); this stays a Phase 1 asset-intake item."
    }

    $identityPath = Join-Path $CharacterPath $manifest.metadata_file
    $identity = Read-JsonFile -Path $identityPath
    foreach ($propertyName in @('character_id', 'display_name', 'identity_status', 'source_vrm', 'review_required')) {
        if (-not (Assert-Property -Failures $Failures -Label $identityPath -Object $identity -PropertyName $propertyName)) {
            return
        }
    }

    if ($identity.character_id -ne $manifest.character_id) {
        Add-Failure -Failures $Failures -Message "$identityPath character_id must match manifest.json."
    }

    if ($identity.display_name -ne $manifest.display_name) {
        Add-Failure -Failures $Failures -Message "$identityPath display_name must match manifest.json."
    }

    if ($identity.identity_status -ne 'scaffolded') {
        Add-Failure -Failures $Failures -Message "$identityPath identity_status must stay 'scaffolded' while source metadata is incomplete."
    }

    if ($identity.source_vrm -isnot [pscustomobject]) {
        Add-Failure -Failures $Failures -Message "$identityPath source_vrm must be an object."
        return
    }

    foreach ($propertyName in @('file_name', 'embedded_name', 'embedded_identifier')) {
        if (-not (Assert-Property -Failures $Failures -Label "$identityPath.source_vrm" -Object $identity.source_vrm -PropertyName $propertyName)) {
            return
        }
    }

    if ($identity.source_vrm.file_name -ne $manifest.model_file) {
        Add-Failure -Failures $Failures -Message "$identityPath source_vrm.file_name must match manifest model_file."
    }

    $sourceMetadataIncomplete = [string]::IsNullOrWhiteSpace([string]$identity.source_vrm.embedded_name) -or [string]::IsNullOrWhiteSpace([string]$identity.source_vrm.embedded_identifier)
    if ($sourceMetadataIncomplete -and -not $identity.review_required) {
        Add-Failure -Failures $Failures -Message "$identityPath must set review_required=true when source VRM metadata is incomplete."
    }

    if ($sourceMetadataIncomplete -and $manifest.identity_source -ne 'scaffolded') {
        Add-Failure -Failures $Failures -Message "$manifestPath must keep identity_source='scaffolded' while fallback identity is still required."
    }

    $voiceProfilePath = Join-Path $CharacterPath $manifest.voice_profile.path
    $voiceProfile = Read-JsonFile -Path $voiceProfilePath
    foreach ($propertyName in @('profile_id', 'provider', 'style')) {
        if (-not (Assert-Property -Failures $Failures -Label $voiceProfilePath -Object $voiceProfile -PropertyName $propertyName)) {
            return
        }
    }

    if ($voiceProfile.profile_id -ne $manifest.voice_profile.profile_id) {
        Add-Failure -Failures $Failures -Message "$voiceProfilePath profile_id must match manifest.voice_profile.profile_id."
    }

    $expressionPath = Join-Path $CharacterPath $manifest.expression_map
    $expressionMap = Read-JsonFile -Path $expressionPath
    foreach ($propertyName in @('preset', 'required', 'fallback')) {
        if (-not (Assert-Property -Failures $Failures -Label $expressionPath -Object $expressionMap -PropertyName $propertyName)) {
            return
        }
    }

    foreach ($expressionName in @('neutral', 'happy', 'sad', 'angry', 'relaxed')) {
        if (-not (Test-HasProperty -Object $expressionMap.required -Name $expressionName)) {
            Add-Failure -Failures $Failures -Message "$expressionPath required expressions must include '$expressionName'."
        }
    }

    $overridePath = Join-Path $CharacterPath $manifest.animation_overrides
    $overrideManifest = Read-JsonFile -Path $overridePath
    foreach ($propertyName in @('character_id', 'shared_set', 'overrides', 'custom_only')) {
        if (-not (Assert-Property -Failures $Failures -Label $overridePath -Object $overrideManifest -PropertyName $propertyName)) {
            return
        }
    }

    if ($overrideManifest.character_id -ne $manifest.character_id) {
        Add-Failure -Failures $Failures -Message "$overridePath character_id must match manifest.json."
    }

    if ($overrideManifest.shared_set -ne $manifest.shared_animation_set) {
        Add-Failure -Failures $Failures -Message "$overridePath shared_set must match manifest shared_animation_set."
    }

    $summary = [pscustomobject]@{
        schema_version = 1
        character_id = $manifest.character_id
        display_name = $manifest.display_name
        identity_source = $manifest.identity_source
        vrm_spec_version = $manifest.vrm_spec_version
        supported_states = $manifest.supported_states
        shared_animation_set = $manifest.shared_animation_set
    }

    Assert-ManifestSummaryShape -Failures $Failures -Label "$ExpectedCharacterId manifest summary" -Summary $summary
}

$repoRoot = Split-Path -Path $PSScriptRoot -Parent | Split-Path -Parent
$failures = New-Object 'System.Collections.Generic.List[string]'
$notes = New-Object 'System.Collections.Generic.List[string]'

$schemaPaths = @(
    (Join-Path $repoRoot 'tests\contracts\schemas\character-manifest.schema.json'),
    (Join-Path $repoRoot 'tests\contracts\schemas\fallback-identity.schema.json'),
    (Join-Path $repoRoot 'tests\contracts\schemas\character-manifest-summary.schema.json'),
    (Join-Path $repoRoot 'tests\contracts\schemas\animation-event.schema.json'),
    (Join-Path $repoRoot 'tests\contracts\schemas\session-event.schema.json')
)

foreach ($schemaPath in $schemaPaths) {
    if (-not (Test-Path -LiteralPath $schemaPath)) {
        Add-Failure -Failures $failures -Message "Missing schema file: $schemaPath"
        continue
    }

    Assert-JsonSchemaFile -Failures $failures -SchemaPath $schemaPath
}

$fixtureRoot = Join-Path $repoRoot 'tests\contracts\fixtures'
$animationEventFixture = Read-JsonFile -Path (Join-Path $fixtureRoot 'animation-event.valid.json')
Assert-AnimationEventShape -Failures $failures -Label 'animation-event.valid.json' -Event $animationEventFixture

$sessionEventFixture = Read-JsonFile -Path (Join-Path $fixtureRoot 'session-event.valid.json')
Assert-SessionEventShape -Failures $failures -Label 'session-event.valid.json' -Event $sessionEventFixture

$manifestSummaryFixture = Read-JsonFile -Path (Join-Path $fixtureRoot 'character-manifest-summary.valid.json')
Assert-ManifestSummaryShape -Failures $failures -Label 'character-manifest-summary.valid.json' -Summary $manifestSummaryFixture

$displayNames = @{}
foreach ($characterId in @('test-vrm-01', 'test-vrm-02', 'test-vrm-03')) {
    $characterPath = Join-Path $repoRoot (Join-Path 'assets\characters' $characterId)
    Assert-ManifestPackage -Failures $failures -Notes $notes -CharacterPath $characterPath -ExpectedCharacterId $characterId -DisplayNames $displayNames
}

Write-Output 'Contract validation summary:'
Write-Output ("- Schemas checked: {0}" -f $schemaPaths.Count)
Write-Output '- Character packages checked: 3'
Write-Output '- Fixture payloads checked: 3'

if ($notes.Count -gt 0) {
    Write-Output 'Notes:'
    foreach ($note in $notes) {
        Write-Output ("  - {0}" -f $note)
    }
}

if ($failures.Count -gt 0) {
    Write-Error ("Contract validation failed:`n- {0}" -f ($failures -join "`n- "))
}

Write-Output 'Contract validation passed.'