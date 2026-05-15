export const semanticAnimationIds = [
  "idle.default",
  "idle.focused",
  "listen.loop",
  "speak.loop",
  "emote.acknowledge"
] as const;

export type SemanticAnimationId = (typeof semanticAnimationIds)[number] | (string & {});

export type SemanticAnimationPlaybackMode = "loop" | "once";

export interface SemanticAnimationCommand {
  id: SemanticAnimationId;
  source: "shared" | "override";
  playback: SemanticAnimationPlaybackMode;
  intensity?: number;
  durationMs?: number;
}

export interface SemanticAnimationMotionProfile {
  speedMultiplier: number;
  bobAmplitude: number;
  secondaryBobAmplitude: number;
  leanAmplitude: number;
  nodAmplitude: number;
  yawAmplitude: number;
}

export interface SemanticAnimationRuntimeSampling {
  timesS: number[];
  sampleRate?: number;
  sampleCount?: number;
}

export interface SemanticAnimationRuntimeChannel {
  name: string;
  normalizedName: string;
  group?: string;
  valueKind?: string;
  samples: number[];
}

export interface SemanticAnimationRuntimePayload {
  semanticId: SemanticAnimationId;
  playback: SemanticAnimationPlaybackMode;
  durationMs: number;
  motionProfile?: SemanticAnimationMotionProfile;
  channelSpace?: string;
  sampling?: SemanticAnimationRuntimeSampling;
  channels?: SemanticAnimationRuntimeChannel[];
}

export interface BackendAnimationTimingHintDocument {
  mode: string;
  anchor?: string | null;
  anchor_event_id?: string | null;
  offset_ms: number;
  max_start_delay_ms?: number | null;
}

export interface BackendAnimationPolicyDocument {
  interruptible: boolean;
  fallback_semantic_id: string;
  drop_if_late: boolean;
  on_interruption: string;
  on_missing_resolution: string;
}

export interface BackendAnimationResolutionDocument {
  selected_source: string;
  selected_asset_id: string;
  fallback_applied: boolean;
  override_character_id?: string | null;
}

export interface BackendAnimationPlaybackDocument {
  mode: string;
  blend_hint?: string | null;
  expected_duration_ms?: number | null;
  loop: boolean;
}

export interface BackendAnimationCommandDocument {
  schema_version: number;
  command_id: string;
  intent_id: string;
  session_id: string;
  character_id: string;
  semantic_id: string;
  resolved_state: string;
  resolution: BackendAnimationResolutionDocument;
  playback: BackendAnimationPlaybackDocument;
  timing: BackendAnimationTimingHintDocument;
  policy: BackendAnimationPolicyDocument;
  intensity: number;
  parameters: Record<string, string>;
}

export interface BackendSessionAnimationSnapshotDocument {
  schema_version: number;
  session_id: string;
  lifecycle_state: string;
  active_character_id: string;
  command: BackendAnimationCommandDocument;
}

export interface BackendSessionLifecycleUpdateRequestDocument {
  lifecycle_state: string;
  reason: string;
}