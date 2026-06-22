export const semanticAnimationIds = [
  "dance.hiphop.loop",
  "emote.laugh.once",
  "gesture.nod.once",
  "gesture.nod.thoughtful.once",
  "gesture.shake.once",
  "gesture.shake.thoughtful.once",
  "gesture.shrug.once",
  "greet.bow.once",
  "greet.bow.casual.once",
  "idle.bored.loop",
  "idle.talking.loop",
  "idle.talking.alt.loop",
  "emote.acknowledge",
  "emote.angry.once",
  "emote.excited.once",
  "emote.happy.alt.once",
  "emote.happy.once",
  "emote.reject.once",
  "emote.surprised.once",
  "gesture.crazy.once",
  "greet.wave.once",
  "greet.wave.small.once",
  "idle.confident",
  "idle.default",
  "idle.focused",
  "idle.happy",
  "idle.neutral",
  "listen.loop",
  "idle.sad",
  "speak.loop"
] as const;

export type SemanticAnimationId = (typeof semanticAnimationIds)[number] | (string & {});

export type SemanticAnimationPlaybackMode = "loop" | "once";

export interface SemanticAnimationCommand {
  id: SemanticAnimationId;
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

export interface SemanticAnimationRuntimeQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface SemanticAnimationRuntimeQuaternionSampleSeries {
  x: number[];
  y: number[];
  z: number[];
  w: number[];
}

export interface SemanticAnimationRuntimePositionSampleSeries {
  x: number[];
  y: number[];
  z: number[];
}

export interface SemanticAnimationRuntimeBoneTransformComparisonBone {
  name: string;
  humanBodyBone?: string;
  group?: string;
  muscleChannels?: string[];
  finalLocalRotation?: SemanticAnimationRuntimeQuaternion;
  localRotationSamples?: SemanticAnimationRuntimeQuaternionSampleSeries;
  localPositionSamples?: SemanticAnimationRuntimePositionSampleSeries;
}

export interface SemanticAnimationRuntimeAnchor {
  type: string;
  bones?: string[];
}

export interface SemanticAnimationRuntimeBoneTransformComparison {
  clipGateSemanticId?: string;
  comparisonKind?: string;
  samplingMode?: string;
  avatarSource?: string;
  usesRuntimeSamplingTimes?: boolean;
  boneCount?: number;
  anchor?: SemanticAnimationRuntimeAnchor;
  bones: SemanticAnimationRuntimeBoneTransformComparisonBone[];
}

export interface SemanticAnimationRuntimeExportAudit {
  limbRotationSpace?: string;
  lowerArmRotationHintSource?: string;
  boneTransformComparison?: SemanticAnimationRuntimeBoneTransformComparison;
}

export interface SemanticAnimationRuntimeSourceAsset {
  kind?: string;
  path: string;
  sourceAssetPath?: string;
}

export interface SemanticAnimationRuntimePayload {
  semanticId: SemanticAnimationId;
  playback: SemanticAnimationPlaybackMode;
  durationMs: number;
  motionProfile?: SemanticAnimationMotionProfile;
  channelSpace?: string;
  sampling?: SemanticAnimationRuntimeSampling;
  channels?: SemanticAnimationRuntimeChannel[];
  exportAudit?: SemanticAnimationRuntimeExportAudit;
  sourceAsset?: SemanticAnimationRuntimeSourceAsset;
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