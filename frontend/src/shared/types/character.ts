export type CharacterId = string;

export type CharacterRuntimeState = "idle" | "listen" | "speak" | "emote" | (string & {});

export interface CharacterCatalogSeed {
  characterId: CharacterId;
  manifestUrl: string;
}

export interface CharacterVoiceProfileDocument {
  profile_id: string;
  path: string;
}

export interface CharacterManifestDocument {
  schema_version: number;
  character_id: CharacterId;
  display_name: string;
  identity_source: string;
  asset_version: string;
  vrm_spec_version: string;
  model_file: string;
  metadata_file: string;
  supported_states: CharacterRuntimeState[];
  shared_animation_set: string;
  voice_profile: CharacterVoiceProfileDocument;
  expression_map: string;
  animation_overrides: string;
}

export interface CharacterVoiceProfileSummary {
  profileId: string;
  url: string;
}

export interface CharacterAssetPaths {
  baseUrl: string;
  manifestUrl: string;
  modelUrl: string;
  metadataUrl: string;
  expressionMapUrl: string;
  animationOverridesUrl: string;
  voiceProfile: CharacterVoiceProfileSummary;
}

export type CharacterAssetUrlOverrides = Partial<Record<string, string>>;

export interface CharacterManifestSummary {
  schemaVersion: number;
  characterId: CharacterId;
  displayName: string;
  identitySource: string;
  assetVersion: string;
  vrmSpecVersion: string;
  supportedStates: CharacterRuntimeState[];
  sharedAnimationSet: string;
  assets: CharacterAssetPaths;
}

export interface CharacterCatalogEntry {
  manifestUrl: string;
  summary: CharacterManifestSummary;
}

export interface CharacterCatalog {
  entries: CharacterCatalogEntry[];
  defaultCharacterId: CharacterId | null;
  loadedAt: string;
}

export interface BackendCharacterSummaryDocument {
  schema_version: number;
  character_id: CharacterId;
  display_name: string;
  identity_source: string;
  vrm_spec_version: string;
  shared_animation_set: string;
  supported_states: CharacterRuntimeState[];
}

export interface BackendCharacterCatalogResponseDocument {
  schema_version: number;
  active_character_id: CharacterId;
  characters: BackendCharacterSummaryDocument[];
}

export interface BackendAudioFormatMetadataDocument {
  container: string;
  encoding: string;
  sample_rate_hz: number;
  channels: number;
}

export interface BackendSpeechSegmentRangeDocument {
  start_ms: number;
  end_ms: number;
  text?: string | null;
}

export interface BackendSpeechPhonemeSlotDocument {
  phoneme: string;
  start_ms: number;
  end_ms: number;
}

export interface BackendSpeechVisemeSlotDocument {
  viseme: string;
  start_ms: number;
  end_ms: number;
}

export interface BackendSpeechTimingMetadataDocument {
  utterance_duration_ms: number;
  segment_ranges: BackendSpeechSegmentRangeDocument[];
  audio_format?: BackendAudioFormatMetadataDocument | null;
  phoneme_slots: BackendSpeechPhonemeSlotDocument[];
  viseme_slots: BackendSpeechVisemeSlotDocument[];
}

export interface BackendSpeechTranscriptionDocument {
  profile_id: string;
  status: string;
  locale: string;
  transcript?: string | null;
  confidence?: number | null;
  timing?: BackendSpeechTimingMetadataDocument | null;
}

export interface BackendSpeechSynthesisDocument {
  profile_id: string;
  status: string;
  text: string;
  locale: string;
  timing?: BackendSpeechTimingMetadataDocument | null;
}

export interface BackendSessionEventDocument {
  schema_version: number;
  event_type: string;
  session_id: string;
  character_id: CharacterId;
  status: string;
  timestamp: string;
  reason?: string | null;
  transcription?: BackendSpeechTranscriptionDocument | null;
  synthesis?: BackendSpeechSynthesisDocument | null;
}

export interface BackendSpeechLifecycleEventEnvelopeDocument {
  event_id: string;
  sequence: number;
  cursor: string;
  event: BackendSessionEventDocument;
}

export interface BackendSpeechLifecycleTransportSnapshotDocument {
  schema_version: number;
  stream: string;
  delivery: string;
  session_id: string;
  next_cursor: string;
  events: BackendSpeechLifecycleEventEnvelopeDocument[];
}

export interface BackendActiveCharacterSelectionDocument {
  requested_character_id: CharacterId;
  applied: boolean;
  error_code?: string | null;
  message?: string | null;
}

export interface BackendActiveCharacterResponseDocument {
  schema_version: number;
  session_id: string;
  lifecycle_state: string;
  active_character: BackendCharacterSummaryDocument;
  selection: BackendActiveCharacterSelectionDocument;
  session_event: BackendSessionEventDocument;
}

export type BackendOperatorCommandType = "text_question" | "tts_preview";

export interface BackendOperatorCommandRequestDocument {
  command_type: BackendOperatorCommandType;
  text: string;
  locale: string;
}

export interface BackendOperatorCommandResponseDocument {
  schema_version: number;
  session_id: string;
  command_type: BackendOperatorCommandType;
  character_id: CharacterId;
  status: string;
  session_event: BackendSessionEventDocument;
  next_speech_cursor: string;
  speech_lifecycle_events: BackendSpeechLifecycleEventEnvelopeDocument[];
}