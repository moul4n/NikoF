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

function Assert-NonEmptyTimestampValue {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Value
    )

    if ($Value -is [datetime] -or $Value -is [datetimeoffset]) {
        return
    }

    Assert-NonEmptyString -Failures $Failures -Label $Label -Value $Value
}

function Assert-NonNegativeInteger {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Value
    )

    if (($Value -isnot [int]) -and ($Value -isnot [long])) {
        Add-Failure -Failures $Failures -Message "$Label must be an integer."
        return
    }

    if ($Value -lt 0) {
        Add-Failure -Failures $Failures -Message "$Label must be zero or greater."
    }
}

function Assert-ProbabilityValue {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Value
    )

    if (($Value -isnot [double]) -and ($Value -isnot [float]) -and ($Value -isnot [decimal])) {
        Add-Failure -Failures $Failures -Message "$Label must be numeric."
        return
    }

    if ($Value -lt 0 -or $Value -gt 1) {
        Add-Failure -Failures $Failures -Message "$Label must stay within 0..1."
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

function Assert-AudioFormatShape {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $AudioFormat
    )

    if ($AudioFormat -isnot [pscustomobject]) {
        Add-Failure -Failures $Failures -Message "$Label must be an object."
        return
    }

    foreach ($propertyName in @('container', 'encoding', 'sample_rate_hz', 'channels')) {
        if (-not (Assert-Property -Failures $Failures -Label $Label -Object $AudioFormat -PropertyName $propertyName)) {
            return
        }
    }

    foreach ($propertyName in @('container', 'encoding')) {
        Assert-NonEmptyString -Failures $Failures -Label "$Label.$propertyName" -Value $AudioFormat.$propertyName
    }

    Assert-NonNegativeInteger -Failures $Failures -Label "$Label.sample_rate_hz" -Value $AudioFormat.sample_rate_hz
    Assert-NonNegativeInteger -Failures $Failures -Label "$Label.channels" -Value $AudioFormat.channels
}

function Assert-SpeechSegmentShape {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Segment
    )

    if ($Segment -isnot [pscustomobject]) {
        Add-Failure -Failures $Failures -Message "$Label must be an object."
        return
    }

    foreach ($propertyName in @('start_ms', 'end_ms')) {
        if (-not (Assert-Property -Failures $Failures -Label $Label -Object $Segment -PropertyName $propertyName)) {
            return
        }
    }

    Assert-NonNegativeInteger -Failures $Failures -Label "$Label.start_ms" -Value $Segment.start_ms
    Assert-NonNegativeInteger -Failures $Failures -Label "$Label.end_ms" -Value $Segment.end_ms

    if ($Segment.end_ms -lt $Segment.start_ms) {
        Add-Failure -Failures $Failures -Message "$Label.end_ms must be greater than or equal to start_ms."
    }

    $hasSegmentText = Test-HasProperty -Object $Segment -Name 'text'
    if ($hasSegmentText -and $null -ne $Segment.text) {
        Assert-NonEmptyString -Failures $Failures -Label "$Label.text" -Value $Segment.text
    }
}

function Assert-SpeechSlotShape {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Slot,
        [string]$KeyName
    )

    if ($Slot -isnot [pscustomobject]) {
        Add-Failure -Failures $Failures -Message "$Label must be an object."
        return
    }

    foreach ($propertyName in @($KeyName, 'start_ms', 'end_ms')) {
        if (-not (Assert-Property -Failures $Failures -Label $Label -Object $Slot -PropertyName $propertyName)) {
            return
        }
    }

    Assert-NonEmptyString -Failures $Failures -Label "$Label.$KeyName" -Value $Slot.$KeyName
    Assert-NonNegativeInteger -Failures $Failures -Label "$Label.start_ms" -Value $Slot.start_ms
    Assert-NonNegativeInteger -Failures $Failures -Label "$Label.end_ms" -Value $Slot.end_ms

    if ($Slot.end_ms -lt $Slot.start_ms) {
        Add-Failure -Failures $Failures -Message "$Label.end_ms must be greater than or equal to start_ms."
    }
}

function Assert-SpeechTimingShape {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Label,
        $Timing
    )

    if ($Timing -isnot [pscustomobject]) {
        Add-Failure -Failures $Failures -Message "$Label must be an object."
        return
    }

    if (-not (Assert-Property -Failures $Failures -Label $Label -Object $Timing -PropertyName 'utterance_duration_ms')) {
        return
    }

    Assert-NonNegativeInteger -Failures $Failures -Label "$Label.utterance_duration_ms" -Value $Timing.utterance_duration_ms

    $hasSegmentRanges = Test-HasProperty -Object $Timing -Name 'segment_ranges'
    if ($hasSegmentRanges -and $null -ne $Timing.segment_ranges) {
        if ($Timing.segment_ranges -isnot [System.Array]) {
            Add-Failure -Failures $Failures -Message "$Label.segment_ranges must be an array when present."
        }
        else {
            foreach ($segment in $Timing.segment_ranges) {
                Assert-SpeechSegmentShape -Failures $Failures -Label "$Label.segment_ranges[]" -Segment $segment
            }
        }
    }

    $hasAudioFormat = Test-HasProperty -Object $Timing -Name 'audio_format'
    if ($hasAudioFormat -and $null -ne $Timing.audio_format) {
        Assert-AudioFormatShape -Failures $Failures -Label "$Label.audio_format" -AudioFormat $Timing.audio_format
    }

    $hasPhonemeSlots = Test-HasProperty -Object $Timing -Name 'phoneme_slots'
    if ($hasPhonemeSlots -and $null -ne $Timing.phoneme_slots) {
        if ($Timing.phoneme_slots -isnot [System.Array]) {
            Add-Failure -Failures $Failures -Message "$Label.phoneme_slots must be an array when present."
        }
        else {
            foreach ($slot in $Timing.phoneme_slots) {
                Assert-SpeechSlotShape -Failures $Failures -Label "$Label.phoneme_slots[]" -Slot $slot -KeyName 'phoneme'
            }
        }
    }

    $hasVisemeSlots = Test-HasProperty -Object $Timing -Name 'viseme_slots'
    if ($hasVisemeSlots -and $null -ne $Timing.viseme_slots) {
        if ($Timing.viseme_slots -isnot [System.Array]) {
            Add-Failure -Failures $Failures -Message "$Label.viseme_slots must be an array when present."
        }
        else {
            foreach ($slot in $Timing.viseme_slots) {
                Assert-SpeechSlotShape -Failures $Failures -Label "$Label.viseme_slots[]" -Slot $slot -KeyName 'viseme'
            }
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

    foreach ($propertyName in @('event_type', 'session_id', 'character_id', 'status')) {
        Assert-NonEmptyString -Failures $Failures -Label "$Label.$propertyName" -Value $Event.$propertyName
    }

    Assert-NonEmptyTimestampValue -Failures $Failures -Label "$Label.timestamp" -Value $Event.timestamp

    $baselineSttProfileIds = @(
        'stt.faster-whisper.medium-2026',
        'stt.faster-whisper.small-2026'
    )
    $baselineTtsProfileIds = @(
        'tts.gpt-sovits.2026-stable'
    )

    $hasTranscription = Test-HasProperty -Object $Event -Name 'transcription'
    if ($hasTranscription -and $null -ne $Event.transcription) {
        if ($Event.transcription -isnot [pscustomobject]) {
            Add-Failure -Failures $Failures -Message "$Label.transcription must be an object when present."
        }
        else {
            foreach ($propertyName in @('profile_id', 'status', 'locale')) {
                if (-not (Assert-Property -Failures $Failures -Label "$Label.transcription" -Object $Event.transcription -PropertyName $propertyName)) {
                    return
                }
            }

            foreach ($propertyName in @('profile_id', 'status', 'locale')) {
                Assert-NonEmptyString -Failures $Failures -Label "$Label.transcription.$propertyName" -Value $Event.transcription.$propertyName
            }

            if ($baselineSttProfileIds -notcontains $Event.transcription.profile_id) {
                Add-Failure -Failures $Failures -Message "$Label.transcription.profile_id must use a locked Stage 3 baseline id."
            }

            $hasTranscript = Test-HasProperty -Object $Event.transcription -Name 'transcript'
            if ($hasTranscript -and $null -ne $Event.transcription.transcript) {
                Assert-NonEmptyString -Failures $Failures -Label "$Label.transcription.transcript" -Value $Event.transcription.transcript
            }

            $hasConfidence = Test-HasProperty -Object $Event.transcription -Name 'confidence'
            if ($hasConfidence -and $null -ne $Event.transcription.confidence) {
                Assert-ProbabilityValue -Failures $Failures -Label "$Label.transcription.confidence" -Value $Event.transcription.confidence
            }

            $hasTranscriptionTiming = Test-HasProperty -Object $Event.transcription -Name 'timing'
            if ($hasTranscriptionTiming -and $null -ne $Event.transcription.timing) {
                Assert-SpeechTimingShape -Failures $Failures -Label "$Label.transcription.timing" -Timing $Event.transcription.timing
            }
        }
    }

    $hasSynthesis = Test-HasProperty -Object $Event -Name 'synthesis'
    if ($hasSynthesis -and $null -ne $Event.synthesis) {
        if ($Event.synthesis -isnot [pscustomobject]) {
            Add-Failure -Failures $Failures -Message "$Label.synthesis must be an object when present."
        }
        else {
            foreach ($propertyName in @('profile_id', 'status', 'text', 'locale')) {
                if (-not (Assert-Property -Failures $Failures -Label "$Label.synthesis" -Object $Event.synthesis -PropertyName $propertyName)) {
                    return
                }
            }

            foreach ($propertyName in @('profile_id', 'status', 'text', 'locale')) {
                Assert-NonEmptyString -Failures $Failures -Label "$Label.synthesis.$propertyName" -Value $Event.synthesis.$propertyName
            }

            if ($baselineTtsProfileIds -notcontains $Event.synthesis.profile_id) {
                Add-Failure -Failures $Failures -Message "$Label.synthesis.profile_id must use the locked Stage 3 baseline id."
            }

            $hasSynthesisTiming = Test-HasProperty -Object $Event.synthesis -Name 'timing'
            if ($hasSynthesisTiming -and $null -ne $Event.synthesis.timing) {
                Assert-SpeechTimingShape -Failures $Failures -Label "$Label.synthesis.timing" -Timing $Event.synthesis.timing
            }
        }
    }

    if ($Event.event_type -eq 'transcription.status' -and (-not $hasTranscription -or $null -eq $Event.transcription)) {
        Add-Failure -Failures $Failures -Message "$Label must include transcription when event_type is transcription.status."
    }

    if ($Event.event_type -eq 'speech.synthesis' -and (-not $hasSynthesis -or $null -eq $Event.synthesis)) {
        Add-Failure -Failures $Failures -Message "$Label must include synthesis when event_type is speech.synthesis."
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

$sessionEventTranscriptionFixture = Read-JsonFile -Path (Join-Path $fixtureRoot 'session-event.transcription.valid.json')
Assert-SessionEventShape -Failures $failures -Label 'session-event.transcription.valid.json' -Event $sessionEventTranscriptionFixture

$sessionEventSynthesisFixture = Read-JsonFile -Path (Join-Path $fixtureRoot 'session-event.synthesis.valid.json')
Assert-SessionEventShape -Failures $failures -Label 'session-event.synthesis.valid.json' -Event $sessionEventSynthesisFixture

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