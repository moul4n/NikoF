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

export type BackendRuntimePrerequisiteState = "missing" | "scaffolded" | "ready" | (string & {});

export interface BackendDiagnosticProbeDocument {
  name: string;
  configured_by: string;
  required_for_stage: string;
  available: boolean;
}

export interface BackendRuntimePrerequisiteAcceptanceTargetDocument {
  id: string;
  label: string;
  satisfied: boolean;
  expected_path: string;
  accepted_paths: string[];
  acceptance_proof: string;
}

export interface BackendRuntimePrerequisiteBlockerDetailDocument {
  id: string;
  status: string;
  summary: string;
  expected_path: string;
  accepted_paths: string[];
  remediation: string;
  evidence: string[];
}

export interface BackendRuntimePrerequisiteDocument {
  id: string;
  display_name: string;
  root_key: string;
  expected_path: string;
  expected_paths?: string[];
  present: boolean;
  required: boolean;
  upstream: string;
  manual_install: string;
  hook_id?: string | null;
  hook_command?: string | null;
  runtime_config_path?: string | null;
  install_plan_path?: string | null;
  hint_path?: string | null;
  state: BackendRuntimePrerequisiteState;
  acceptance_targets?: BackendRuntimePrerequisiteAcceptanceTargetDocument[];
  blocker_details?: BackendRuntimePrerequisiteBlockerDetailDocument[];
}

export interface BackendRuntimePrerequisiteLaneBlockerDocument {
  id: string;
  status: string;
  summary: string;
}

export interface BackendRuntimePrerequisiteLaneDocument {
  id: string;
  display_name: string;
  state: BackendRuntimePrerequisiteState;
  blockers?: BackendRuntimePrerequisiteLaneBlockerDocument[];
}

export interface BackendHealthDiagnosticsDocument {
  character_packages_available: number;
  storage_probes: BackendDiagnosticProbeDocument[];
  notes?: string[];
  prerequisite_lanes?: BackendRuntimePrerequisiteLaneDocument[];
}

export interface BackendHealthPayloadDocument {
  status: string;
  mode: string;
  diagnostics: BackendHealthDiagnosticsDocument;
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

export interface BackendSpeechMouthCueSlotDocument {
  cue: string;
  start_ms: number;
  end_ms: number;
  weight?: number | null;
}

export interface BackendSpeechMouthCueTrackDocument {
  track_id: string;
  cue_namespace: string;
  cues: BackendSpeechMouthCueSlotDocument[];
}

export interface BackendSpeechLipSyncDebugDocument {
  timing_source?: string | null;
  source_slot_type?: string | null;
  generated_track_ids: string[];
  phoneme_slot_count: number;
  viseme_slot_count: number;
}

export interface BackendSpeechLipSyncPayloadDocument {
  default_track_id?: string | null;
  mouth_cue_tracks: BackendSpeechMouthCueTrackDocument[];
  debug?: BackendSpeechLipSyncDebugDocument | null;
}

export interface BackendSpeechTimingMetadataDocument {
  utterance_duration_ms: number;
  segment_ranges: BackendSpeechSegmentRangeDocument[];
  audio_format?: BackendAudioFormatMetadataDocument | null;
  phoneme_slots: BackendSpeechPhonemeSlotDocument[];
  viseme_slots: BackendSpeechVisemeSlotDocument[];
  lip_sync?: BackendSpeechLipSyncPayloadDocument | null;
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
  audio_reference?: string | null;
  timing?: BackendSpeechTimingMetadataDocument | null;
  // Multi-segment streaming fields (Phase 1). Present on every synthesis event;
  // utterance_id/segment_count are omitted when null. A non-segmented reply is
  // a single final segment (segment_index 0, is_final true, no utterance_id).
  utterance_id?: string | null;
  segment_index?: number | null;
  segment_count?: number | null;
  is_final?: boolean | null;
}

export interface BackendAssistantFeelingDocument {
  name: string;
  intensity?: number | null;
}

export interface BackendAssistantMessageDocument {
  profile_id: string;
  status: string;
  text: string;
  locale: string;
  feeling?: BackendAssistantFeelingDocument | null;
}

export type BackendSessionEventType =
  | "assistant.message"
  | "session.operator.text-question"
  | "session.stt.accepted"
  | "session.operator.tts-preview"
  | "speech.synthesis"
  | "transcription.status"
  | (string & {});

export interface BackendSessionEventDocument {
  schema_version: number;
  event_type: BackendSessionEventType;
  session_id: string;
  character_id: CharacterId;
  status: string;
  timestamp: string;
  reason?: string | null;
  transcription?: BackendSpeechTranscriptionDocument | null;
  assistant?: BackendAssistantMessageDocument | null;
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

export interface BackendSttInputDeviceDocument {
  device_id: string;
  label: string;
  default: boolean;
  sample_rate_hz?: number | null;
  max_input_channels?: number | null;
}

export interface BackendSttTranscriptChunkDocument {
  chunk_id: string;
  transcript: string;
  locale: string;
  captured_at: number;
  duration_ms: number;
  confidence?: number | null;
  accepted_for_dispatch: boolean;
  dispatch_state: string;
  dispatch_target?: string | null;
  dispatch_detail?: string | null;
}

export interface BackendSttStateDocument {
  schema_version: number;
  state: string;
  available: boolean;
  listening: boolean;
  model_name?: string | null;
  selected_device_id?: string | null;
  selected_device_label?: string | null;
  latest_confirmed_text?: string | null;
  latest_confirmed_at?: number | null;
  total_processed: number;
  total_submitted: number;
  average_latency_ms?: number | null;
  last_error?: string | null;
  compute_device?: string | null;
  compute_type?: string | null;
  next_sequence: number;
  transcript_chunks?: BackendSttTranscriptChunkDocument[];
}

export interface BackendAttentionInputDeviceDocument {
  device_id: string;
  label: string;
  default: boolean;
}

export interface BackendAttentionSubjectDocument {
  normalized_x: number;
  normalized_y: number;
  face_width?: number | null;
  face_height?: number | null;
}

export interface BackendAttentionStateDocument {
  schema_version: number;
  state: string;
  available: boolean;
  enabled: boolean;
  tracking: boolean;
  selected_device_id?: string | null;
  selected_device_label?: string | null;
  confidence?: number | null;
  subject?: BackendAttentionSubjectDocument | null;
  last_observed_at?: number | null;
  last_error?: string | null;
  fps_target: number;
  frame_width: number;
  frame_height: number;
  next_sequence: number;
}

export interface BackendTtsReferenceSettingsDocument {
  schema_version: number;
  prompt_text: string;
  prompt_language: string;
  text_language: string;
  configured: boolean;
  has_reference_audio: boolean;
  reference_audio_path?: string | null;
  reference_audio_file_name?: string | null;
  speaker_manifest_path: string;
  reference_audio_root: string;
  max_reference_audio_bytes: number;
  allowed_extensions: string[];
}