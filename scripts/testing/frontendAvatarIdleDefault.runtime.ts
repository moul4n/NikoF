import * as THREE from "three";
import { readFile } from "fs/promises";
import {
  startSessionAnimationLiveConsumption,
  type ConsumedSessionAnimationSnapshot
} from "../../frontend/src/avatar/loaders/sessionAnimation.js";
import { resolveBaseAnimationMotionProfile } from "../../frontend/src/avatar/runtime/baseAnimationMotionProfile.js";
import {
  createHumanoidChannelPlayback,
  type HumanoidChannelPlaybackDebugPoseSnapshot
} from "../../frontend/src/avatar/runtime/humanoidChannelPlayback.js";
import { createOfficialBoneLocalClipPlayback } from "../../frontend/src/avatar/runtime/officialPunchClipPlayback.js";
import { resolveAvatarRuntimePlayback } from "../../frontend/src/avatar/runtime/avatarRuntimePlaybackRoute.js";
import type {
  BackendAnimationCommandDocument,
  BackendSessionAnimationSnapshotDocument,
  SemanticAnimationCommand,
  SemanticAnimationMotionProfile,
  SemanticAnimationRuntimeBoneTransformComparison,
  SemanticAnimationRuntimeBoneTransformComparisonBone,
  SemanticAnimationRuntimeChannel,
  SemanticAnimationRuntimeExportAudit,
  SemanticAnimationRuntimePayload,
  SemanticAnimationRuntimeQuaternion,
  SemanticAnimationRuntimeQuaternionSampleSeries
} from "../../frontend/src/shared/types/animation.js";

type AvatarRuntimePlaybackPath =
  | "custom_muscle"
  | "idle_fallback_humanoid"
  | "official_idle_stability"
  | "official_mixer_spike";

type FrontendAvatarIdleDefaultRuntimeSnapshot = {
  backend_session_animation_surface: {
    active_character_id: string;
    snapshot_document: BackendSessionAnimationSnapshotDocument;
    updated_snapshot_document: BackendSessionAnimationSnapshotDocument;
  };
  promoted_idle_asset: {
    semantic_id: string;
    derived_duration_ms?: number;
  };
  frontend_source_surface: {
    app_mentions_idle_default_sidecar_path: boolean;
    app_mentions_animation_asset_root: boolean;
    runtime_mentions_idle_default_sidecar_path: boolean;
    runtime_mentions_animation_asset_root: boolean;
    runtime_load_path_seeds_default_idle: boolean;
    avatar_runtime_default_playback_path: AvatarRuntimePlaybackPath | null;
    avatar_runtime_wires_humanoid_channel_playback: boolean;
    avatar_runtime_distinguishes_official_idle_from_fallback: boolean;
    loader_fetches_session_animation_snapshot: boolean;
    loader_live_url_reuses_animation_route: boolean;
    official_idle_playback_factory_present: boolean;
    official_idle_playback_requires_unity_humanoid_channel_space: boolean;
    official_idle_playback_targets_follow_through_bones: boolean;
    humanoid_playback_factory_present: boolean;
    humanoid_playback_requires_unity_humanoid_channel_space: boolean;
    humanoid_idle_fallback_uses_punch_only_comparison_bindings: boolean;
    humanoid_playback_binds_representative_channels: boolean;
  };
  generated_runtime_payload_surface: {
    idle_default: GeneratedRuntimePayloadSurface;
    speak_loop: GeneratedRuntimePayloadSurface;
  };
};

type ExportedChannelSummary = {
  channel_space: string | null;
  channel_count: number;
  playback_sample_count: number | null;
  representative_channels: Array<{
    normalized_name: string;
    sample_count: number;
    min_value: number | null;
    max_value: number | null;
  }>;
};

type GeneratedRuntimePayloadSurface = {
  runtime_document: SharedAnimationRuntimeSidecarDocument;
  exported_channel_summary: ExportedChannelSummary;
};

type SharedAnimationRuntimeSidecarDocument = {
  semantic_id?: string;
  channel_space?: string;
  export_audit?: {
    limb_rotation_space?: string;
    lower_arm_rotation_hint_source?: string;
    bone_transform_comparison?: {
      clip_gate_semantic_id?: string;
      comparison_kind?: string;
      sampling_mode?: string;
      avatar_source?: string;
      uses_runtime_sampling_times?: boolean;
      bone_count?: number;
      bones?: Array<{
        name?: string;
        human_body_bone?: string;
        group?: string;
        muscle_channels?: string[];
        local_rotation_samples?: {
          x?: number[];
          y?: number[];
          z?: number[];
          w?: number[];
        };
        final_local_rotation?: {
          x?: number;
          y?: number;
          z?: number;
          w?: number;
        };
      }>;
    };
  };
  playback?: {
    mode?: string;
    loop?: boolean;
    sample_rate?: number;
    duration_ms?: number;
    sample_count?: number;
  };
  motion_profile?: {
    speed_multiplier?: number;
    bob_amplitude?: number;
    secondary_bob_amplitude?: number;
    lean_amplitude?: number;
    nod_amplitude?: number;
    yaw_amplitude?: number;
  };
  sampling?: {
    times_s?: number[];
  };
  channels?: Array<{
    name?: string;
    normalized_name?: string;
    group?: string;
    value_kind?: string;
    samples?: number[];
  }>;
};

const REPRESENTATIVE_CHANNEL_NAMES = ["chest.front_back", "head.nod.down_up", "head.turn.left_right"];
const OFFICIAL_IDLE_ROOT_FINGER_BONE_NAMES = [
  "leftThumbMetacarpal",
  "leftIndexProximal",
  "leftMiddleProximal",
  "leftRingProximal",
  "leftLittleProximal",
  "rightThumbMetacarpal",
  "rightIndexProximal",
  "rightMiddleProximal",
  "rightRingProximal",
  "rightLittleProximal"
] as const;
const OFFICIAL_IDLE_TARGET_BONE_NAMES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  ...OFFICIAL_IDLE_ROOT_FINGER_BONE_NAMES.slice(0, 5),
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  ...OFFICIAL_IDLE_ROOT_FINGER_BONE_NAMES.slice(5),
  "rightShoulder",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes"
] as const;
const OFFICIAL_IDLE_GROUND_CONTACT_BONE_NAMES = [
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes"
] as const;
const OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES = [
  "leftFoot",
  "rightFoot",
  "leftToes",
  "rightToes"
] as const;
const OFFICIAL_IDLE_RUNTIME_GROUNDING_FOOT_BONE_NAMES = [
  "leftFoot",
  "rightFoot"
] as const;
const OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES = [
  "hips",
  "chest",
  "upperChest",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  ...OFFICIAL_IDLE_ROOT_FINGER_BONE_NAMES.slice(0, 5),
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  ...OFFICIAL_IDLE_ROOT_FINGER_BONE_NAMES.slice(5),
  "rightShoulder"
] as const;
const OFFICIAL_IDLE_ACCEPTED_PROOF_BONE_NAMES = [
  "hips",
  "chest",
  "upperChest",
  "leftShoulder",
  "leftUpperArm",
  "rightUpperArm",
  "rightShoulder"
] as const;
const OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES = [
  "leftLowerArm",
  "leftHand",
  "rightLowerArm",
  "rightHand"
] as const;
const OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES = OFFICIAL_IDLE_ROOT_FINGER_BONE_NAMES;
const OFFICIAL_IDLE_RENDERED_PITCH_ROLL_PROOF_BONE_NAMES = [
  "hips",
  "chest",
  "upperChest",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "rightUpperArm",
  "rightLowerArm",
  "rightShoulder"
] as const;
const OFFICIAL_IDLE_RENDERED_PROOF_SAMPLE_INDEX = 176;
const OFFICIAL_IDLE_RENDERED_PITCH_ROLL_NOISE_FLOOR_RADIANS = 0.01;
const OFFICIAL_IDLE_FINAL_FRAME_BASELINE_EPSILON_RADIANS = 0.05;
const OFFICIAL_IDLE_RENDERED_RAW_NORMALIZED_SEPARATION_EPSILON_RADIANS = 0.01;
const OFFICIAL_IDLE_RENDERED_EXCURSION_EPSILON_RADIANS = 0.004;
const OFFICIAL_IDLE_FINGER_RENDERED_ARTICULATION_EPSILON_RADIANS = 0.0002;
const OFFICIAL_IDLE_GROUND_CONTACT_WORLD_Y_EPSILON = 0.001;
const NEUTRAL_QUATERNION: [number, number, number, number] = [0, 0, 0, 1];
const OFFICIAL_IDLE_FAKE_RAW_REST_OFFSETS: Readonly<Partial<Record<OfficialIdleRenderedProofBoneName, [number, number, number, number]>>> = {
  hips: [0, 0.01499943750632809, 0, 0.9998875021093592],
  chest: [0, -0.01999866669333308, 0, 0.9998000066665778],
  upperChest: [0, 0.024997395914712332, 0, 0.9996875162757026],
  leftShoulder: [0, -0.018998856298578733, 0, 0.9998195142047436],
  leftUpperArm: [0, -0.02999550020249566, 0, 0.9995500337489875],
  leftLowerArm: [0, -0.015999317342071415, 0, 0.9998720027306434],
  leftHand: [0, -0.012999633836450738, 0, 0.9999155023802722],
  rightUpperArm: [0, 0.02999550020249566, 0, 0.9995500337489875],
  rightLowerArm: [0, 0.015999317342071415, 0, 0.9998720027306434],
  rightHand: [0, 0.012999633836450738, 0, 0.9999155023802722],
  rightShoulder: [0, 0.018998856298578733, 0, 0.9998195142047436]
};
const OFFICIAL_IDLE_FAKE_BONE_POSITIONS: Readonly<Record<string, [number, number, number]>> = {
  hips: [0, 1, 0],
  spine: [0, 0.25, 0],
  chest: [0, 0.22, 0],
  upperChest: [0, 0.18, 0],
  neck: [0, 0.12, 0],
  head: [0, 0.12, 0],
  leftShoulder: [-0.12, 0.08, 0],
  rightShoulder: [0.12, 0.08, 0],
  leftUpperArm: [-0.16, 0, 0],
  leftLowerArm: [-0.22, 0, 0],
  leftHand: [-0.18, 0, 0],
  leftThumbMetacarpal: [-0.05, -0.02, -0.06],
  leftIndexProximal: [-0.07, 0, -0.02],
  leftMiddleProximal: [-0.08, 0, 0],
  leftRingProximal: [-0.07, 0, 0.02],
  leftLittleProximal: [-0.06, 0, 0.04],
  rightUpperArm: [0.16, 0, 0],
  rightLowerArm: [0.22, 0, 0],
  rightHand: [0.18, 0, 0],
  rightThumbMetacarpal: [0.05, -0.02, -0.06],
  rightIndexProximal: [0.07, 0, -0.02],
  rightMiddleProximal: [0.08, 0, 0],
  rightRingProximal: [0.07, 0, 0.02],
  rightLittleProximal: [0.06, 0, 0.04],
  leftUpperLeg: [-0.1, -0.45, 0],
  leftLowerLeg: [0, -0.45, 0],
  leftFoot: [0, -0.1, 0.05],
  leftToes: [0, 0, 0.15],
  rightUpperLeg: [0.1, -0.45, 0],
  rightLowerLeg: [0, -0.45, 0],
  rightFoot: [0, -0.1, 0.05],
  rightToes: [0, 0, 0.15]
};
const OFFICIAL_IDLE_FAKE_FINGER_TIP_MARKER_OFFSETS: Readonly<Record<string, [number, number, number]>> = {
  leftThumbMetacarpal: [-0.04, -0.015, -0.03],
  leftIndexProximal: [-0.06, 0.004, -0.02],
  leftMiddleProximal: [-0.065, 0.002, 0],
  leftRingProximal: [-0.06, -0.002, 0.02],
  leftLittleProximal: [-0.05, -0.005, 0.035],
  rightThumbMetacarpal: [0.04, -0.015, -0.03],
  rightIndexProximal: [0.06, 0.004, -0.02],
  rightMiddleProximal: [0.065, 0.002, 0],
  rightRingProximal: [0.06, -0.002, 0.02],
  rightLittleProximal: [0.05, -0.005, 0.035]
};

type OfficialIdleRenderedProofBoneName = (typeof OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES)[number];
type OfficialIdleRenderedPitchRollProofBoneName = (typeof OFFICIAL_IDLE_RENDERED_PITCH_ROLL_PROOF_BONE_NAMES)[number];
type OfficialIdleTargetBoneName = (typeof OFFICIAL_IDLE_TARGET_BONE_NAMES)[number];
type OfficialIdleLowerArmHandProofBoneName = (typeof OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES)[number];
type OfficialIdleFingerProofBoneName = (typeof OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES)[number];
type OfficialIdleHandProofBoneName = "leftHand" | "rightHand";
type OfficialIdleProofSlice = "previously_accepted" | "lower_arm_hand_follow_through" | "finger_root_follow_through";

interface OfficialIdleFingerChannelBindingDefinition {
  boneName: OfficialIdleFingerProofBoneName;
  stretchNormalizedName: string;
  spreadNormalizedName: string;
  spreadScale: number;
}

const OFFICIAL_IDLE_FINGER_CHANNEL_BINDINGS: readonly OfficialIdleFingerChannelBindingDefinition[] = [
  {
    boneName: "leftThumbMetacarpal",
    stretchNormalizedName: "lefthand_thumb_1.stretched",
    spreadNormalizedName: "lefthand_thumb_spread",
    spreadScale: -0.15
  },
  {
    boneName: "leftIndexProximal",
    stretchNormalizedName: "lefthand_index_1.stretched",
    spreadNormalizedName: "lefthand_index_spread",
    spreadScale: -0.15
  },
  {
    boneName: "leftMiddleProximal",
    stretchNormalizedName: "lefthand_middle_1.stretched",
    spreadNormalizedName: "lefthand_middle_spread",
    spreadScale: -0.15
  },
  {
    boneName: "leftRingProximal",
    stretchNormalizedName: "lefthand_ring_1.stretched",
    spreadNormalizedName: "lefthand_ring_spread",
    spreadScale: -0.15
  },
  {
    boneName: "leftLittleProximal",
    stretchNormalizedName: "lefthand_little_1.stretched",
    spreadNormalizedName: "lefthand_little_spread",
    spreadScale: -0.15
  },
  {
    boneName: "rightThumbMetacarpal",
    stretchNormalizedName: "righthand_thumb_1.stretched",
    spreadNormalizedName: "righthand_thumb_spread",
    spreadScale: 0.15
  },
  {
    boneName: "rightIndexProximal",
    stretchNormalizedName: "righthand_index_1.stretched",
    spreadNormalizedName: "righthand_index_spread",
    spreadScale: 0.15
  },
  {
    boneName: "rightMiddleProximal",
    stretchNormalizedName: "righthand_middle_1.stretched",
    spreadNormalizedName: "righthand_middle_spread",
    spreadScale: 0.15
  },
  {
    boneName: "rightRingProximal",
    stretchNormalizedName: "righthand_ring_1.stretched",
    spreadNormalizedName: "righthand_ring_spread",
    spreadScale: 0.15
  },
  {
    boneName: "rightLittleProximal",
    stretchNormalizedName: "righthand_little_1.stretched",
    spreadNormalizedName: "righthand_little_spread",
    spreadScale: 0.15
  }
];

type FakePoseTransform = {
  rotation?: [number, number, number, number];
};

type FakePose = Record<string, FakePoseTransform>;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  onmessage: ((event: { data?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(eventName: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }

  emit(eventName: string, data?: string): void {
    this.listeners.get(eventName)?.forEach((listener) => {
      listener({ data });
    });

    if (eventName === "message") {
      this.onmessage?.({ data });
    }
  }

  close(): void {
    this.closed = true;
  }
}

function resolveFrontendPlaybackMode(mode: string, loop: boolean): "loop" | "once" | string {
  if (loop || mode === "loop") {
    return "loop";
  }

  if (mode === "oneshot") {
    return "once";
  }

  return mode;
}

function buildRuntimeCommand(command: BackendAnimationCommandDocument): SemanticAnimationCommand {
  return {
    id: command.semantic_id,
    source: "shared",
    playback: resolveFrontendPlaybackMode(command.playback.mode, command.playback.loop) === "once" ? "once" : "loop",
    durationMs: command.playback.expected_duration_ms ?? undefined
  };
}

function cloneDefaultBaseAnimationCommand(): SemanticAnimationCommand {
  return {
    id: "idle.default",
    source: "shared",
    playback: "loop"
  };
}

function resolveRuntimePlaybackMode(runtimeDocument: SharedAnimationRuntimeSidecarDocument): "loop" | "once" | null {
  const playbackMode = runtimeDocument.playback?.mode;

  if (playbackMode === "loop" || playbackMode === "once") {
    return playbackMode;
  }

  if (typeof runtimeDocument.playback?.loop === "boolean") {
    return runtimeDocument.playback.loop ? "loop" : "once";
  }

  return null;
}

function sampleNumericSeries(samples: number[], timesS: number[], elapsedSeconds: number): number | null {
  const sampleCount = Math.min(samples.length, timesS.length);

  if (sampleCount === 0) {
    return null;
  }

  if (sampleCount === 1 || elapsedSeconds <= timesS[0]) {
    return samples[0] ?? null;
  }

  const lastIndex = sampleCount - 1;

  if (elapsedSeconds >= timesS[lastIndex]) {
    return samples[lastIndex] ?? null;
  }

  for (let upperIndex = 1; upperIndex < sampleCount; upperIndex += 1) {
    const upperTime = timesS[upperIndex];

    if (upperTime < elapsedSeconds) {
      continue;
    }

    const lowerIndex = upperIndex - 1;
    const lowerTime = timesS[lowerIndex];
    const lowerSample = samples[lowerIndex];
    const upperSample = samples[upperIndex];

    if (!Number.isFinite(lowerSample) || !Number.isFinite(upperSample)) {
      return null;
    }

    if (upperTime <= lowerTime) {
      return upperSample;
    }

    const progress = (elapsedSeconds - lowerTime) / (upperTime - lowerTime);
    return THREE.MathUtils.lerp(lowerSample, upperSample, progress);
  }

  return samples[lastIndex] ?? null;
}

function resolveRuntimeMotionProfile(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument
): SemanticAnimationMotionProfile | undefined {
  const motionProfile = runtimeDocument.motion_profile;

  if (
    !motionProfile ||
    typeof motionProfile.speed_multiplier !== "number" ||
    !Number.isFinite(motionProfile.speed_multiplier) ||
    typeof motionProfile.bob_amplitude !== "number" ||
    !Number.isFinite(motionProfile.bob_amplitude) ||
    typeof motionProfile.secondary_bob_amplitude !== "number" ||
    !Number.isFinite(motionProfile.secondary_bob_amplitude) ||
    typeof motionProfile.lean_amplitude !== "number" ||
    !Number.isFinite(motionProfile.lean_amplitude) ||
    typeof motionProfile.nod_amplitude !== "number" ||
    !Number.isFinite(motionProfile.nod_amplitude) ||
    typeof motionProfile.yaw_amplitude !== "number" ||
    !Number.isFinite(motionProfile.yaw_amplitude)
  ) {
    return undefined;
  }

  return {
    speedMultiplier: motionProfile.speed_multiplier,
    bobAmplitude: motionProfile.bob_amplitude,
    secondaryBobAmplitude: motionProfile.secondary_bob_amplitude,
    leanAmplitude: motionProfile.lean_amplitude,
    nodAmplitude: motionProfile.nod_amplitude,
    yawAmplitude: motionProfile.yaw_amplitude
  };
}

function resolveRuntimeQuaternion(
  quaternionDocument:
    | {
        x?: number;
        y?: number;
        z?: number;
        w?: number;
      }
    | null
    | undefined
): SemanticAnimationRuntimeQuaternion | undefined {
  if (!quaternionDocument) {
    return undefined;
  }

  const { x, y, z, w } = quaternionDocument;

  if (![x, y, z, w].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return undefined;
  }

  return {
    x: x as number,
    y: y as number,
    z: z as number,
    w: w as number
  };
}

function resolveRuntimeQuaternionSampleSeries(
  quaternionSamplesDocument:
    | {
        x?: number[];
        y?: number[];
        z?: number[];
        w?: number[];
      }
    | null
    | undefined,
  expectedSampleCount: number | null
): SemanticAnimationRuntimeQuaternionSampleSeries | undefined {
  if (!quaternionSamplesDocument) {
    return undefined;
  }

  const sampledX = quaternionSamplesDocument.x?.filter((value) => typeof value === "number" && Number.isFinite(value));
  const sampledY = quaternionSamplesDocument.y?.filter((value) => typeof value === "number" && Number.isFinite(value));
  const sampledZ = quaternionSamplesDocument.z?.filter((value) => typeof value === "number" && Number.isFinite(value));
  const sampledW = quaternionSamplesDocument.w?.filter((value) => typeof value === "number" && Number.isFinite(value));

  if (!sampledX || !sampledY || !sampledZ || !sampledW) {
    return undefined;
  }

  if (
    sampledX.length === 0 ||
    sampledX.length !== sampledY.length ||
    sampledX.length !== sampledZ.length ||
    sampledX.length !== sampledW.length
  ) {
    return undefined;
  }

  if (expectedSampleCount !== null && sampledX.length !== expectedSampleCount) {
    return undefined;
  }

  return {
    x: sampledX,
    y: sampledY,
    z: sampledZ,
    w: sampledW
  };
}

function resolveRuntimeBoneTransformComparison(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument,
  expectedSampleCount: number | null
): SemanticAnimationRuntimeBoneTransformComparison | undefined {
  const comparisonDocument = runtimeDocument.export_audit?.bone_transform_comparison;

  if (!comparisonDocument) {
    return undefined;
  }

  const bones = comparisonDocument.bones
    ?.map((boneDocument): SemanticAnimationRuntimeBoneTransformComparisonBone | null => {
      const name = boneDocument.name?.trim();

      if (!name) {
        return null;
      }

      return {
        name,
        humanBodyBone: boneDocument.human_body_bone?.trim() || undefined,
        group: boneDocument.group?.trim() || undefined,
        muscleChannels: boneDocument.muscle_channels?.filter((channel) => typeof channel === "string" && channel.trim().length > 0),
        localRotationSamples: resolveRuntimeQuaternionSampleSeries(
          boneDocument.local_rotation_samples,
          expectedSampleCount
        ),
        finalLocalRotation: resolveRuntimeQuaternion(boneDocument.final_local_rotation)
      };
    })
    .filter((bone): bone is SemanticAnimationRuntimeBoneTransformComparisonBone => bone !== null);

  if (!bones || bones.length === 0) {
    return undefined;
  }

  return {
    clipGateSemanticId: comparisonDocument.clip_gate_semantic_id?.trim() || undefined,
    comparisonKind: comparisonDocument.comparison_kind?.trim() || undefined,
    samplingMode: comparisonDocument.sampling_mode?.trim() || undefined,
    avatarSource: comparisonDocument.avatar_source?.trim() || undefined,
    usesRuntimeSamplingTimes:
      typeof comparisonDocument.uses_runtime_sampling_times === "boolean"
        ? comparisonDocument.uses_runtime_sampling_times
        : undefined,
    boneCount:
      typeof comparisonDocument.bone_count === "number" && Number.isFinite(comparisonDocument.bone_count)
        ? comparisonDocument.bone_count
        : undefined,
    bones
  };
}

function resolveRuntimeExportAudit(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument,
  expectedSampleCount: number | null
): SemanticAnimationRuntimeExportAudit | undefined {
  const exportAuditDocument = runtimeDocument.export_audit;

  if (!exportAuditDocument) {
    return undefined;
  }

  return {
    limbRotationSpace: exportAuditDocument.limb_rotation_space?.trim() || undefined,
    lowerArmRotationHintSource: exportAuditDocument.lower_arm_rotation_hint_source?.trim() || undefined,
    boneTransformComparison: resolveRuntimeBoneTransformComparison(runtimeDocument, expectedSampleCount)
  };
}

function resolveRuntimeChannels(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument,
  expectedSampleCount: number | null
): SemanticAnimationRuntimeChannel[] | undefined {
  const channels = runtimeDocument.channels
    ?.map((channelDocument): SemanticAnimationRuntimeChannel | null => {
      const name = channelDocument.name?.trim();
      const normalizedName = channelDocument.normalized_name?.trim();
      const samples = channelDocument.samples?.filter((value) => typeof value === "number" && Number.isFinite(value));

      if (!name || !normalizedName || !samples || samples.length === 0) {
        return null;
      }

      if (expectedSampleCount !== null && samples.length !== expectedSampleCount) {
        return null;
      }

      return {
        name,
        normalizedName,
        group: channelDocument.group?.trim() || undefined,
        valueKind: channelDocument.value_kind?.trim() || undefined,
        samples
      };
    })
    .filter((channel): channel is SemanticAnimationRuntimeChannel => channel !== null);

  return channels && channels.length > 0 ? channels : undefined;
}

function resolveRuntimePayloadFromDocument(
  command: SemanticAnimationCommand,
  runtimeDocument: SharedAnimationRuntimeSidecarDocument
): SemanticAnimationRuntimePayload | null {
  if (command.source !== "shared" || runtimeDocument.semantic_id?.trim() !== command.id) {
    return null;
  }

  const samplingTimes = runtimeDocument.sampling?.times_s?.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  ) ?? [];
  const expectedSampleCount = samplingTimes.length > 0 ? samplingTimes.length : null;
  const durationMs =
    typeof runtimeDocument.playback?.duration_ms === "number" && Number.isFinite(runtimeDocument.playback.duration_ms)
      ? runtimeDocument.playback.duration_ms
      : command.durationMs;

  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }

  return {
    semanticId: command.id,
    playback: resolveRuntimePlaybackMode(runtimeDocument) ?? command.playback,
    durationMs,
    motionProfile: resolveRuntimeMotionProfile(runtimeDocument),
    channelSpace: runtimeDocument.channel_space?.trim() || undefined,
    sampling:
      samplingTimes.length > 0
        ? {
            timesS: samplingTimes,
            sampleRate:
              typeof runtimeDocument.playback?.sample_rate === "number" && Number.isFinite(runtimeDocument.playback.sample_rate)
                ? runtimeDocument.playback.sample_rate
                : undefined,
            sampleCount:
              typeof runtimeDocument.playback?.sample_count === "number" && Number.isFinite(runtimeDocument.playback.sample_count)
                ? runtimeDocument.playback.sample_count
                : undefined
          }
        : undefined,
    channels: resolveRuntimeChannels(runtimeDocument, expectedSampleCount),
    exportAudit: resolveRuntimeExportAudit(runtimeDocument, expectedSampleCount)
  };
}

function areMotionProfilesEqual(
  left: SemanticAnimationMotionProfile | null,
  right: SemanticAnimationMotionProfile | null
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.speedMultiplier === right.speedMultiplier &&
    left.bobAmplitude === right.bobAmplitude &&
    left.secondaryBobAmplitude === right.secondaryBobAmplitude &&
    left.leanAmplitude === right.leanAmplitude &&
    left.nodAmplitude === right.nodAmplitude &&
    left.yawAmplitude === right.yawAmplitude
  );
}

function exportedChannelSummaryHasRepresentativeCoverage(summary: ExportedChannelSummary): boolean {
  return REPRESENTATIVE_CHANNEL_NAMES.every((normalizedName) =>
    summary.representative_channels.some((channel) => channel.normalized_name === normalizedName)
  );
}

function exportedChannelSummaryMatchesPlaybackSamples(summary: ExportedChannelSummary): boolean {
  if (summary.playback_sample_count === null) {
    return false;
  }

  return summary.representative_channels.every((channel) => channel.sample_count === summary.playback_sample_count);
}

function exportedChannelSummaryShowsVariation(summary: ExportedChannelSummary): boolean {
  return summary.representative_channels.every((channel) => {
    if (channel.min_value === null || channel.max_value === null) {
      return false;
    }

    return channel.max_value !== channel.min_value;
  });
}

function isFiniteQuaternion(
  rotation: [number, number, number, number] | null | undefined
): rotation is [number, number, number, number] {
  return Array.isArray(rotation) && rotation.length === 4 && rotation.every((value) => typeof value === "number" && Number.isFinite(value));
}

function isFiniteEulerXYZ(
  eulerXYZ: [number, number, number] | null | undefined
): eulerXYZ is [number, number, number] {
  return Array.isArray(eulerXYZ) && eulerXYZ.length === 3 && eulerXYZ.every((value) => typeof value === "number" && Number.isFinite(value));
}

function resolveEulerXYZFromQuaternion(
  rotation: [number, number, number, number] | null | undefined
): [number, number, number] | null {
  if (!isFiniteQuaternion(rotation)) {
    return null;
  }

  const quaternion = new THREE.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]).normalize();
  const euler = new THREE.Euler(0, 0, 0, "XYZ").setFromQuaternion(quaternion, "XYZ");

  return [euler.x, euler.y, euler.z];
}

function resolveQuaternionAngularDistanceRadians(
  left: [number, number, number, number] | null | undefined,
  right: [number, number, number, number] | null | undefined
): number | null {
  if (!isFiniteQuaternion(left) || !isFiniteQuaternion(right)) {
    return null;
  }

  const leftQuaternion = new THREE.Quaternion(left[0], left[1], left[2], left[3]).normalize();
  const rightQuaternion = new THREE.Quaternion(right[0], right[1], right[2], right[3]).normalize();

  return leftQuaternion.angleTo(rightQuaternion);
}

function resolveRawRestOffsetQuaternion(
  boneName: string
): [number, number, number, number] {
  return OFFICIAL_IDLE_FAKE_RAW_REST_OFFSETS[boneName as OfficialIdleRenderedProofBoneName] ?? NEUTRAL_QUATERNION;
}

function axisValueExceedsNoiseFloor(value: number, threshold = OFFICIAL_IDLE_RENDERED_PITCH_ROLL_NOISE_FLOOR_RADIANS): boolean {
  return Number.isFinite(value) && Math.abs(value) > threshold;
}

function renderedAxisMatchesAuthoredSign(
  renderedValue: number,
  authoredValue: number,
  threshold = OFFICIAL_IDLE_RENDERED_PITCH_ROLL_NOISE_FLOOR_RADIANS
): boolean {
  if (!Number.isFinite(renderedValue) || !Number.isFinite(authoredValue)) {
    return false;
  }

  if (Math.abs(authoredValue) <= threshold) {
    return true;
  }

  return axisValueExceedsNoiseFloor(renderedValue, threshold) && Math.sign(renderedValue) === Math.sign(authoredValue);
}

function resolveDominantEulerAxis(
  eulerXYZ: [number, number, number] | null | undefined,
  threshold = OFFICIAL_IDLE_RENDERED_PITCH_ROLL_NOISE_FLOOR_RADIANS
): { index: 0 | 1 | 2; value: number } | null {
  if (!isFiniteEulerXYZ(eulerXYZ)) {
    return null;
  }

  const absoluteValues = eulerXYZ.map((value) => Math.abs(value)) as [number, number, number];
  let dominantIndex: 0 | 1 | 2 = 0;

  if (absoluteValues[1] > absoluteValues[dominantIndex]) {
    dominantIndex = 1;
  }

  if (absoluteValues[2] > absoluteValues[dominantIndex]) {
    dominantIndex = 2;
  }

  return absoluteValues[dominantIndex] > threshold
    ? { index: dominantIndex, value: eulerXYZ[dominantIndex] }
    : null;
}

function quaternionsApproximatelyEqual(
  left: [number, number, number, number] | null | undefined,
  right: [number, number, number, number] | null | undefined,
  epsilon = 1e-5
): boolean {
  if (!isFiniteQuaternion(left) || !isFiniteQuaternion(right)) {
    return false;
  }

  return left.every((value, index) => Math.abs(value - right[index]) <= epsilon);
}

function resolveQuaternionSampleAtIndex(
  localRotationSamples: SemanticAnimationRuntimeQuaternionSampleSeries | undefined,
  sampleIndex: number
): [number, number, number, number] | null {
  if (!localRotationSamples) {
    return null;
  }

  const sampledRotation = [
    localRotationSamples.x[sampleIndex],
    localRotationSamples.y[sampleIndex],
    localRotationSamples.z[sampleIndex],
    localRotationSamples.w[sampleIndex]
  ];

  if (sampledRotation.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return null;
  }

  return sampledRotation as [number, number, number, number];
}

function resolveMaxQuaternionSeriesExcursionRadians(
  localRotationSamples: SemanticAnimationRuntimeQuaternionSampleSeries | undefined
): number | null {
  const baselineRotation = resolveQuaternionSampleAtIndex(localRotationSamples, 0);

  if (!baselineRotation) {
    return null;
  }

  const sampleCount = Math.min(
    localRotationSamples?.x.length ?? 0,
    localRotationSamples?.y.length ?? 0,
    localRotationSamples?.z.length ?? 0,
    localRotationSamples?.w.length ?? 0
  );
  let maxExcursionRadians = 0;

  for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
    const sampledRotation = resolveQuaternionSampleAtIndex(localRotationSamples, sampleIndex);
    const excursionRadians = resolveQuaternionAngularDistanceRadians(sampledRotation, baselineRotation);

    if (excursionRadians === null) {
      return null;
    }

    maxExcursionRadians = Math.max(maxExcursionRadians, excursionRadians);
  }

  return maxExcursionRadians;
}

function resolveQuaternionFromEulerXYZ(
  eulerXYZ: [number, number, number] | null | undefined
): [number, number, number, number] | null {
  if (!isFiniteEulerXYZ(eulerXYZ)) {
    return null;
  }

  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(eulerXYZ[0], eulerXYZ[1], eulerXYZ[2], "XYZ")).normalize();
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function resolveFingerChannelBindingDefinition(
  boneName: OfficialIdleFingerProofBoneName
): OfficialIdleFingerChannelBindingDefinition | null {
  return OFFICIAL_IDLE_FINGER_CHANNEL_BINDINGS.find((binding) => binding.boneName === boneName) ?? null;
}

function resolveFingerAuthoredChannelSignal(
  channelMap: ReadonlyMap<string, SemanticAnimationRuntimeChannel>,
  boneName: OfficialIdleFingerProofBoneName,
  timesS: number[],
  sampleTimeSeconds: number
): {
  eulerXYZ: [number, number, number];
  maxExcursionRadians: number;
} | null {
  const binding = resolveFingerChannelBindingDefinition(boneName);

  if (!binding || timesS.length === 0) {
    return null;
  }

  const stretchChannel = channelMap.get(binding.stretchNormalizedName) ?? null;
  const spreadChannel = channelMap.get(binding.spreadNormalizedName) ?? null;

  if (!stretchChannel && !spreadChannel) {
    return null;
  }

  const sampledStretch = stretchChannel ? sampleNumericSeries(stretchChannel.samples, timesS, sampleTimeSeconds) : 0;
  const sampledSpread = spreadChannel ? sampleNumericSeries(spreadChannel.samples, timesS, sampleTimeSeconds) : 0;

  if ((stretchChannel && sampledStretch === null) || (spreadChannel && sampledSpread === null)) {
    return null;
  }

  const sampledEulerXYZ: [number, number, number] = [
    (sampledStretch ?? 0) * 0.2,
    0,
    (sampledSpread ?? 0) * binding.spreadScale
  ];
  const baselineQuaternion = resolveQuaternionFromEulerXYZ([
    ((stretchChannel?.samples[0] ?? 0) as number) * 0.2,
    0,
    ((spreadChannel?.samples[0] ?? 0) as number) * binding.spreadScale
  ]);

  if (!baselineQuaternion) {
    return null;
  }

  let maxExcursionRadians = 0;

  for (let sampleIndex = 1; sampleIndex < timesS.length; sampleIndex += 1) {
    const indexedStretch = stretchChannel ? stretchChannel.samples[sampleIndex] : 0;
    const indexedSpread = spreadChannel ? spreadChannel.samples[sampleIndex] : 0;

    if ((stretchChannel && !Number.isFinite(indexedStretch)) || (spreadChannel && !Number.isFinite(indexedSpread))) {
      return null;
    }

    const indexedQuaternion = resolveQuaternionFromEulerXYZ([
      (indexedStretch ?? 0) * 0.2,
      0,
      (indexedSpread ?? 0) * binding.spreadScale
    ]);
    const excursionRadians = resolveQuaternionAngularDistanceRadians(indexedQuaternion, baselineQuaternion);

    if (excursionRadians === null) {
      return null;
    }

    maxExcursionRadians = Math.max(maxExcursionRadians, excursionRadians);
  }

  return {
    eulerXYZ: sampledEulerXYZ,
    maxExcursionRadians
  };
}

function isFiniteVectorXYZ(
  vectorXYZ: [number, number, number] | null | undefined
): vectorXYZ is [number, number, number] {
  return Array.isArray(vectorXYZ) && vectorXYZ.length === 3 && vectorXYZ.every((value) => typeof value === "number" && Number.isFinite(value));
}

function resolveVectorAngleRadians(
  left: [number, number, number] | null | undefined,
  right: [number, number, number] | null | undefined
): number | null {
  if (!isFiniteVectorXYZ(left) || !isFiniteVectorXYZ(right)) {
    return null;
  }

  const leftVector = new THREE.Vector3(left[0], left[1], left[2]);
  const rightVector = new THREE.Vector3(right[0], right[1], right[2]);

  if (leftVector.lengthSq() === 0 || rightVector.lengthSq() === 0) {
    return null;
  }

  return leftVector.normalize().angleTo(rightVector.normalize());
}

function resolveComparisonBoneByHumanBodyBone(
  payload: SemanticAnimationRuntimePayload,
  humanBodyBone: string
): SemanticAnimationRuntimeBoneTransformComparisonBone | null {
  return (
    payload.exportAudit?.boneTransformComparison?.bones.find((bone) => bone.humanBodyBone === humanBodyBone) ?? null
  );
}

function humanoidPlaybackAcceptsRuntimePayload(payload: SemanticAnimationRuntimePayload): boolean {
  const fakeVrm = createFakeOfficialIdleVrm({});
  const playback = createHumanoidChannelPlayback(fakeVrm as never, payload);

  if (!playback) {
    return false;
  }

  const debugSnapshot = playback.getDebugSnapshot();
  return debugSnapshot.boundChannels.length > 0 || debugSnapshot.quaternionBoundChannels.length > 0;
}

function createFakeOfficialIdleVrm(
  baselineRotations: Partial<Record<string, [number, number, number, number]>>
): {
  scene: THREE.Scene;
  humanoid: {
    getNormalizedPose: () => FakePose;
    getNormalizedBoneNode: (boneName: string) => THREE.Object3D | null;
    getRawBoneNode: (boneName: string) => THREE.Object3D | null;
    setNormalizedPose: (pose: FakePose) => void;
    update: () => void;
  };
  getRenderedBoneNode: (boneName: string) => THREE.Object3D | null;
  getRenderedFingerTipMarkerNode: (boneName: string) => THREE.Object3D | null;
} {
  const scene = new THREE.Scene();
  let lastPose: FakePose = {};
  const normalizedBoneNodes = new Map<string, THREE.Object3D>();
  const renderedBoneNodes = new Map<string, THREE.Object3D>();
  const renderedFingerTipMarkerNodes = new Map<string, THREE.Object3D>();
  const renderedRawRestOffsets = new Map<string, THREE.Quaternion>();

  const boneParentNames: Record<string, string | null> = {
    hips: null,
    spine: "hips",
    chest: "spine",
    upperChest: "chest",
    neck: "upperChest",
    head: "neck",
    leftShoulder: "upperChest",
    rightShoulder: "upperChest",
    leftUpperArm: "leftShoulder",
    leftLowerArm: "leftUpperArm",
    leftHand: "leftLowerArm",
    leftThumbMetacarpal: "leftHand",
    leftIndexProximal: "leftHand",
    leftMiddleProximal: "leftHand",
    leftRingProximal: "leftHand",
    leftLittleProximal: "leftHand",
    leftUpperLeg: "hips",
    leftLowerLeg: "leftUpperLeg",
    leftFoot: "leftLowerLeg",
    leftToes: "leftFoot",
    rightUpperArm: "rightShoulder",
    rightLowerArm: "rightUpperArm",
    rightHand: "rightLowerArm",
    rightThumbMetacarpal: "rightHand",
    rightIndexProximal: "rightHand",
    rightMiddleProximal: "rightHand",
    rightRingProximal: "rightHand",
    rightLittleProximal: "rightHand",
    rightUpperLeg: "hips",
    rightLowerLeg: "rightUpperLeg",
    rightFoot: "rightLowerLeg",
    rightToes: "rightFoot"
  };

  function resolveBoneNode(
    boneNodes: Map<string, THREE.Object3D>,
    boneName: string,
    nodeKind: "normalized" | "rendered"
  ): THREE.Object3D {
    const existingBoneNode = boneNodes.get(boneName);

    if (existingBoneNode) {
      return existingBoneNode;
    }

    const nextBoneNode = new THREE.Object3D();
    nextBoneNode.name = nodeKind === "normalized" ? boneName : `rendered_${boneName}`;

    const baselineRotation =
      nodeKind === "normalized"
        ? baselineRotations[boneName] ?? NEUTRAL_QUATERNION
        : resolveRawRestOffsetQuaternion(boneName);
    nextBoneNode.quaternion.set(
      baselineRotation[0],
      baselineRotation[1],
      baselineRotation[2],
      baselineRotation[3]
    );

    if (nodeKind === "rendered") {
      renderedRawRestOffsets.set(
        boneName,
        new THREE.Quaternion(
          baselineRotation[0],
          baselineRotation[1],
          baselineRotation[2],
          baselineRotation[3]
        ).normalize()
      );
    }

    const localPosition = OFFICIAL_IDLE_FAKE_BONE_POSITIONS[boneName];
    if (localPosition) {
      nextBoneNode.position.set(localPosition[0], localPosition[1], localPosition[2]);
    }

    if (nodeKind === "rendered") {
      const fingerTipMarkerOffset = OFFICIAL_IDLE_FAKE_FINGER_TIP_MARKER_OFFSETS[boneName];

      if (fingerTipMarkerOffset) {
        const tipMarkerNode = new THREE.Object3D();
        tipMarkerNode.name = `rendered_${boneName}_tip_marker`;
        tipMarkerNode.position.set(fingerTipMarkerOffset[0], fingerTipMarkerOffset[1], fingerTipMarkerOffset[2]);
        nextBoneNode.add(tipMarkerNode);
        renderedFingerTipMarkerNodes.set(boneName, tipMarkerNode);
      }
    }

    boneNodes.set(boneName, nextBoneNode);

    const parentBoneName = boneParentNames[boneName] ?? null;
    if (parentBoneName) {
      resolveBoneNode(boneNodes, parentBoneName, nodeKind).add(nextBoneNode);
    } else {
      scene.add(nextBoneNode);
    }

    return nextBoneNode;
  }

  function syncRenderedBones(): void {
    Object.keys(boneParentNames).forEach((boneName) => {
      const normalizedBoneNode = resolveBoneNode(normalizedBoneNodes, boneName, "normalized");
      const renderedBoneNode = resolveBoneNode(renderedBoneNodes, boneName, "rendered");
      const rawRestOffset = renderedRawRestOffsets.get(boneName);

      if (rawRestOffset) {
        renderedBoneNode.quaternion.copy(rawRestOffset).multiply(normalizedBoneNode.quaternion).normalize();
      } else {
        renderedBoneNode.quaternion.copy(normalizedBoneNode.quaternion).normalize();
      }
    });

    scene.updateMatrixWorld(true);
  }

  Object.keys(boneParentNames).forEach((boneName) => {
    resolveBoneNode(normalizedBoneNodes, boneName, "normalized");
    resolveBoneNode(renderedBoneNodes, boneName, "rendered");
  });

  syncRenderedBones();

  return {
    scene,
    humanoid: {
      getNormalizedPose: () => lastPose,
      getNormalizedBoneNode: (boneName) => normalizedBoneNodes.get(boneName) ?? null,
      getRawBoneNode: (boneName) => renderedBoneNodes.get(boneName) ?? null,
      setNormalizedPose: (pose) => {
        lastPose = pose;

        Object.entries(pose).forEach(([boneName, transform]) => {
          if (!transform?.rotation) {
            return;
          }

          resolveBoneNode(normalizedBoneNodes, boneName, "normalized").quaternion.set(
            transform.rotation[0],
            transform.rotation[1],
            transform.rotation[2],
            transform.rotation[3]
          );
        });

        syncRenderedBones();
      },
      update: () => {
        syncRenderedBones();
      }
    },
    getRenderedBoneNode: (boneName) => renderedBoneNodes.get(boneName) ?? null,
    getRenderedFingerTipMarkerNode: (boneName) => renderedFingerTipMarkerNodes.get(boneName) ?? null
  };
}

function resolveFakeOfficialIdleBoneNode(
  fakeVrm: {
    humanoid: {
      getNormalizedBoneNode: (boneName: string) => THREE.Object3D | null;
      getRawBoneNode: (boneName: string) => THREE.Object3D | null;
    };
  },
  boneName: string
): THREE.Object3D | null {
  return fakeVrm.humanoid.getRawBoneNode(boneName) ?? fakeVrm.humanoid.getNormalizedBoneNode(boneName);
}

function resolveFingerHandBoneName(
  boneName: OfficialIdleFingerProofBoneName
): OfficialIdleHandProofBoneName {
  return boneName.startsWith("left") ? "leftHand" : "rightHand";
}

function resolveRenderedFingerArticulationDirectionInHandSpace(
  fakeVrm: ReturnType<typeof createFakeOfficialIdleVrm>,
  boneName: OfficialIdleFingerProofBoneName
): [number, number, number] | null {
  const fingerBoneNode = fakeVrm.getRenderedBoneNode(boneName);
  const fingerTipMarkerNode = fakeVrm.getRenderedFingerTipMarkerNode(boneName);
  const handBoneNode = fakeVrm.getRenderedBoneNode(resolveFingerHandBoneName(boneName));

  if (!fingerBoneNode || !fingerTipMarkerNode || !handBoneNode) {
    return null;
  }

  const fingerRootInHandSpace = handBoneNode.worldToLocal(fingerBoneNode.getWorldPosition(new THREE.Vector3()));
  const fingerTipInHandSpace = handBoneNode.worldToLocal(fingerTipMarkerNode.getWorldPosition(new THREE.Vector3()));
  const fingerDirectionInHandSpace = fingerTipInHandSpace.sub(fingerRootInHandSpace);

  if (fingerDirectionInHandSpace.lengthSq() === 0) {
    return null;
  }

  fingerDirectionInHandSpace.normalize();

  return [fingerDirectionInHandSpace.x, fingerDirectionInHandSpace.y, fingerDirectionInHandSpace.z];
}

function roundGroundContactWorldY(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function resolveGroundedContactWorldYByBone(
  fakeVrm: {
    humanoid: {
      getNormalizedBoneNode: (boneName: string) => THREE.Object3D | null;
      getRawBoneNode: (boneName: string) => THREE.Object3D | null;
    };
  },
  boneNames: readonly string[]
): Record<string, number | null> {
  return Object.fromEntries(
    boneNames.map((boneName) => {
      const boneNode = resolveFakeOfficialIdleBoneNode(fakeVrm, boneName);
      const worldY = boneNode ? boneNode.getWorldPosition(new THREE.Vector3()).y : null;
      return [boneName, roundGroundContactWorldY(worldY)] as const;
    })
  );
}

function groundFakeOfficialIdleRootToFloor(
  root: THREE.Object3D,
  fakeVrm: {
    humanoid: {
      getNormalizedBoneNode: (boneName: string) => THREE.Object3D | null;
      getRawBoneNode: (boneName: string) => THREE.Object3D | null;
    };
  }
): void {
  root.updateWorldMatrix(true, true);

  const groundedBoneHeights = OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES
    .map((boneName) => resolveFakeOfficialIdleBoneNode(fakeVrm, boneName))
    .filter((boneNode): boneNode is THREE.Object3D => boneNode !== null)
    .map((boneNode) => boneNode.getWorldPosition(new THREE.Vector3()).y)
    .filter((height) => Number.isFinite(height));
  const groundedFootHeights = OFFICIAL_IDLE_RUNTIME_GROUNDING_FOOT_BONE_NAMES
    .map((boneName) => resolveFakeOfficialIdleBoneNode(fakeVrm, boneName))
    .filter((boneNode): boneNode is THREE.Object3D => boneNode !== null)
    .map((boneNode) => boneNode.getWorldPosition(new THREE.Vector3()).y)
    .filter((height) => Number.isFinite(height));

  const floorHeight = groundedFootHeights.length > 0
    ? Math.min(...groundedFootHeights)
    : groundedBoneHeights.length > 0
    ? Math.min(...groundedBoneHeights)
    : new THREE.Box3().setFromObject(root).min.y;

  if (!Number.isFinite(floorHeight) || Math.abs(floorHeight) <= 1e-4) {
    return;
  }

  root.position.y -= floorHeight;
  root.updateWorldMatrix(true, true);
}

function resolveMinGroundedContactWorldY(contactWorldYByBone: Record<string, number | null>): number | null {
  const groundedContactWorldY = Object.values(contactWorldYByBone).filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );

  if (groundedContactWorldY.length === 0) {
    return null;
  }

  return roundGroundContactWorldY(Math.min(...groundedContactWorldY));
}

function sampleGroundedOfficialIdleContactSurface(
  playback: NonNullable<ReturnType<typeof createOfficialBoneLocalClipPlayback>>,
  fakeVrm: ReturnType<typeof createFakeOfficialIdleVrm>,
  elapsedSeconds: number
): {
  poseSnapshot: HumanoidChannelPlaybackDebugPoseSnapshot;
  groundedContactWorldYByBone: Record<string, number | null>;
  minGroundedContactWorldY: number | null;
  renderedFingerArticulationDirectionByBone: Record<string, [number, number, number] | null>;
} {
  fakeVrm.scene.position.set(0, 0, 0);
  fakeVrm.scene.updateMatrixWorld(true);

  const poseSnapshot = playback.getRenderedPoseSnapshot(elapsedSeconds);
  groundFakeOfficialIdleRootToFloor(fakeVrm.scene, fakeVrm);

  const groundedContactWorldYByBone = resolveGroundedContactWorldYByBone(
    fakeVrm,
    OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES
  );
  const renderedFingerArticulationDirectionByBone = Object.fromEntries(
    OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.map((boneName) => [
      boneName,
      resolveRenderedFingerArticulationDirectionInHandSpace(fakeVrm, boneName)
    ])
  );

  return {
    poseSnapshot,
    groundedContactWorldYByBone,
    minGroundedContactWorldY: resolveMinGroundedContactWorldY(groundedContactWorldYByBone),
    renderedFingerArticulationDirectionByBone
  };
}

function buildOfficialIdleRenderedPoseSurface(
  payload: SemanticAnimationRuntimePayload,
  runtimeDefaultPlaybackPath: AvatarRuntimePlaybackPath
) {
  const samplingTimes = payload.sampling?.timesS ?? [];
  const proofSampleIndex = samplingTimes.length > 0
    ? Math.min(OFFICIAL_IDLE_RENDERED_PROOF_SAMPLE_INDEX, Math.max(1, samplingTimes.length - 1))
    : 0;
  const loopStartTimeSeconds = samplingTimes[0] ?? 0;
  const proofSampleTimeSeconds = samplingTimes[proofSampleIndex] ?? payload.durationMs / 2000;
  const finalFrameTimeSeconds = samplingTimes[samplingTimes.length - 1] ?? proofSampleTimeSeconds;
  let officialIdleFallbackRequested = false;
  const fakeVrm = createFakeOfficialIdleVrm({});
  const baselineRenderedQuaternionByBone = new Map(
    OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.map((boneName) => {
      const renderedBoneNode = fakeVrm.humanoid.getRawBoneNode(boneName);

      return [
        boneName,
        renderedBoneNode
          ? ([
              renderedBoneNode.quaternion.x,
              renderedBoneNode.quaternion.y,
              renderedBoneNode.quaternion.z,
              renderedBoneNode.quaternion.w
            ] as [number, number, number, number])
          : null
      ] as const;
    })
  );
  const resolvedPlayback = resolveAvatarRuntimePlayback(fakeVrm as never, payload, {
    animationPlaybackPath: runtimeDefaultPlaybackPath,
    onOfficialIdleFallback: () => {
      officialIdleFallbackRequested = true;
    }
  });
  const playback = resolvedPlayback.playback;

  if (!playback) {
    throw new Error("Expected idle.default playback to resolve for the avatar runtime default path.");
  }

  const loopStartGroundedContactSurface = sampleGroundedOfficialIdleContactSurface(
    playback,
    fakeVrm,
    loopStartTimeSeconds
  );
  const renderedGroundedContactSurface = sampleGroundedOfficialIdleContactSurface(
    playback,
    fakeVrm,
    proofSampleTimeSeconds
  );
  const loopStartRenderedPoseSnapshot = loopStartGroundedContactSurface.poseSnapshot;
  const renderedPoseSnapshot = renderedGroundedContactSurface.poseSnapshot;
  fakeVrm.scene.position.set(0, 0, 0);
  fakeVrm.scene.updateMatrixWorld(true);
  const finalFrameRenderedPoseSnapshot = playback.getRenderedPoseSnapshot(finalFrameTimeSeconds);
  const finalFrameFingerArticulationDirectionByBone = Object.fromEntries(
    OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.map((boneName) => [
      boneName,
      resolveRenderedFingerArticulationDirectionInHandSpace(fakeVrm, boneName)
    ])
  );
  const renderedTargetedBoneNames = renderedPoseSnapshot.targetedBones.map((boneName: string) => String(boneName));
  const loopStartRenderedPoseByBone = new Map(
    loopStartRenderedPoseSnapshot.bonePoses.map((bonePose) => [bonePose.boneName, bonePose])
  );
  const renderedPoseByBone = new Map(renderedPoseSnapshot.bonePoses.map((bonePose) => [bonePose.boneName, bonePose]));
  const finalFrameRenderedPoseByBone = new Map(
    finalFrameRenderedPoseSnapshot.bonePoses.map((bonePose) => [bonePose.boneName, bonePose])
  );
  const exportBoneByHumanBodyBone = new Map(
    (payload.exportAudit?.boneTransformComparison?.bones ?? [])
      .filter((bone) => typeof bone.humanBodyBone === "string" && bone.humanBodyBone.length > 0)
      .map((bone) => [bone.humanBodyBone as string, bone])
  );
  const runtimeChannelByNormalizedName = new Map(
    (payload.channels ?? []).map((channel) => [channel.normalizedName, channel])
  );

  const proofBones = OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.map((boneName) => {
    const humanBodyBone = boneName[0].toUpperCase() + boneName.slice(1);
    const exportBone = exportBoneByHumanBodyBone.get(humanBodyBone) ?? null;
    const fingerAuthoredSignal = OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(boneName as OfficialIdleFingerProofBoneName)
      ? resolveFingerAuthoredChannelSignal(
          runtimeChannelByNormalizedName,
          boneName as OfficialIdleFingerProofBoneName,
          samplingTimes,
          proofSampleTimeSeconds
        )
      : null;
    const loopStartBonePose = loopStartRenderedPoseByBone.get(boneName) ?? null;
    const browserBonePose = renderedPoseByBone.get(boneName) ?? null;
    const finalFrameBonePose = finalFrameRenderedPoseByBone.get(boneName) ?? null;
    const comparisonQuaternion = resolveQuaternionSampleAtIndex(exportBone?.localRotationSamples, proofSampleIndex);
    const exportQuaternion = comparisonQuaternion ?? resolveQuaternionFromEulerXYZ(fingerAuthoredSignal?.eulerXYZ ?? null);
    const baselineBrowserQuaternion = baselineRenderedQuaternionByBone.get(boneName) ?? null;
    const proofSlice = OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(boneName as OfficialIdleFingerProofBoneName)
      ? ("finger_root_follow_through" as OfficialIdleProofSlice)
      : OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES.includes(
          boneName as OfficialIdleLowerArmHandProofBoneName
        )
        ? ("lower_arm_hand_follow_through" as OfficialIdleProofSlice)
        : ("previously_accepted" as OfficialIdleProofSlice);
    const finalFrameSettleTarget = proofSlice === "previously_accepted"
      ? "baseline_browser_quaternion"
      : "loop_start_browser_quaternion";
    const finalFrameSettleTargetQuaternion = finalFrameSettleTarget === "loop_start_browser_quaternion"
      ? loopStartBonePose?.rotation ?? null
      : baselineBrowserQuaternion;
    const sampledRenderedExcursionRadians = resolveQuaternionAngularDistanceRadians(
      browserBonePose?.rotation ?? null,
      baselineBrowserQuaternion
    );
    const authoredMaxExcursionRadians =
      resolveMaxQuaternionSeriesExcursionRadians(exportBone?.localRotationSamples) ??
      fingerAuthoredSignal?.maxExcursionRadians ??
      null;
    const loopStartRenderedFingerArticulationDirection = OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(
      boneName as OfficialIdleFingerProofBoneName
    )
      ? loopStartGroundedContactSurface.renderedFingerArticulationDirectionByBone[boneName] ?? null
      : null;
    const sampledRenderedFingerArticulationDirection = OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(
      boneName as OfficialIdleFingerProofBoneName
    )
      ? renderedGroundedContactSurface.renderedFingerArticulationDirectionByBone[boneName] ?? null
      : null;
    const finalFrameRenderedFingerArticulationDirection = OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(
      boneName as OfficialIdleFingerProofBoneName
    )
      ? finalFrameFingerArticulationDirectionByBone[boneName] ?? null
      : null;
    const normalizedBoneNode = fakeVrm.humanoid.getNormalizedBoneNode(boneName);
    const normalizedQuaternion = normalizedBoneNode
      ? ([
          normalizedBoneNode.quaternion.x,
          normalizedBoneNode.quaternion.y,
          normalizedBoneNode.quaternion.z,
          normalizedBoneNode.quaternion.w
        ] as [number, number, number, number])
      : null;

    return {
      bone_name: boneName,
      proof_slice: proofSlice,
      human_body_bone: humanBodyBone,
      browser_source: browserBonePose ? "rendered_pose_snapshot" : "missing",
      loop_start_browser_quaternion: loopStartBonePose?.rotation ?? null,
      loop_start_browser_euler_xyz: loopStartBonePose?.eulerXYZ ?? null,
      browser_quaternion: browserBonePose?.rotation ?? null,
      browser_euler_xyz: browserBonePose?.eulerXYZ ?? null,
      sampled_rendered_excursion_radians: sampledRenderedExcursionRadians,
      normalized_quaternion: normalizedQuaternion,
      rendered_to_normalized_angular_distance_radians: resolveQuaternionAngularDistanceRadians(
        browserBonePose?.rotation ?? null,
        normalizedQuaternion
      ),
      authored_signal_source: comparisonQuaternion
        ? "comparison_quaternion"
        : fingerAuthoredSignal
          ? "runtime_channels"
          : "missing",
      export_quaternion: exportQuaternion,
      export_euler_xyz: resolveEulerXYZFromQuaternion(exportQuaternion),
      authored_max_excursion_radians: authoredMaxExcursionRadians,
      loop_start_rendered_finger_articulation_direction_in_hand_space: loopStartRenderedFingerArticulationDirection,
      rendered_finger_articulation_direction_in_hand_space: sampledRenderedFingerArticulationDirection,
      final_frame_rendered_finger_articulation_direction_in_hand_space: finalFrameRenderedFingerArticulationDirection,
      rendered_finger_articulation_excursion_radians: resolveVectorAngleRadians(
        sampledRenderedFingerArticulationDirection,
        loopStartRenderedFingerArticulationDirection
      ),
      final_frame_rendered_finger_articulation_angular_distance_to_loop_start_radians: resolveVectorAngleRadians(
        finalFrameRenderedFingerArticulationDirection,
        loopStartRenderedFingerArticulationDirection
      ),
      baseline_browser_quaternion: baselineBrowserQuaternion,
      final_frame_browser_quaternion: finalFrameBonePose?.rotation ?? null,
      final_frame_browser_euler_xyz: finalFrameBonePose?.eulerXYZ ?? null,
      final_frame_settle_target: finalFrameSettleTarget,
      final_frame_settle_target_quaternion: finalFrameSettleTargetQuaternion,
      final_frame_angular_distance_to_settle_target_radians: resolveQuaternionAngularDistanceRadians(
        finalFrameBonePose?.rotation ?? null,
        finalFrameSettleTargetQuaternion
      ),
      final_frame_angular_distance_to_loop_start_radians: resolveQuaternionAngularDistanceRadians(
        finalFrameBonePose?.rotation ?? null,
        loopStartBonePose?.rotation ?? null
      ),
      final_frame_angular_distance_to_baseline_radians:
        proofSlice === "previously_accepted"
          ? resolveQuaternionAngularDistanceRadians(finalFrameBonePose?.rotation ?? null, baselineBrowserQuaternion)
          : null
    };
  });
  const rawAndNormalizedBonesAreDistinctObjects = OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.every((boneName) => {
    const normalizedBoneNode = fakeVrm.humanoid.getNormalizedBoneNode(boneName);
    const renderedBoneNode = fakeVrm.humanoid.getRawBoneNode(boneName);

    return normalizedBoneNode !== null && renderedBoneNode !== null && normalizedBoneNode !== renderedBoneNode;
  });
  const fallbackPayload: SemanticAnimationRuntimePayload = {
    ...payload,
    exportAudit: undefined
  };
  let fallbackOfficialRouteRequested = false;
  const fallbackResolvedPlayback = resolveAvatarRuntimePlayback(createFakeOfficialIdleVrm({}) as never, fallbackPayload, {
    animationPlaybackPath: runtimeDefaultPlaybackPath,
    onOfficialIdleFallback: () => {
      fallbackOfficialRouteRequested = true;
    }
  });
  const fallbackDebugSnapshot = fallbackResolvedPlayback.playback?.getDebugSnapshot() ?? null;
  const fallbackQuaternionBindingPrefixes = fallbackDebugSnapshot?.quaternionBoundChannels.map(
    (binding) => binding.normalizedNamePrefix
  ) ?? [];
  const pitchRollProofBones = proofBones.filter((bone): bone is typeof proofBones[number] & {
    bone_name: OfficialIdleRenderedPitchRollProofBoneName;
  } => OFFICIAL_IDLE_RENDERED_PITCH_ROLL_PROOF_BONE_NAMES.includes(
    bone.bone_name as OfficialIdleRenderedPitchRollProofBoneName
  ));
  const handProofBones = proofBones.filter((bone): bone is typeof proofBones[number] & {
    bone_name: OfficialIdleHandProofBoneName;
  } => bone.bone_name === "leftHand" || bone.bone_name === "rightHand");
  const fingerProofBones = proofBones.filter((bone): bone is typeof proofBones[number] & {
    bone_name: OfficialIdleFingerProofBoneName;
  } => OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(bone.bone_name as OfficialIdleFingerProofBoneName));
  const sampledGroundedContactWorldYDriftByBone = Object.fromEntries(
    OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES.map((boneName) => {
      const loopStartWorldY = loopStartGroundedContactSurface.groundedContactWorldYByBone[boneName] ?? null;
      const sampledWorldY = renderedGroundedContactSurface.groundedContactWorldYByBone[boneName] ?? null;
      const upwardDriftWorldY =
        typeof loopStartWorldY === "number" && typeof sampledWorldY === "number"
          ? roundGroundContactWorldY(sampledWorldY - loopStartWorldY)
          : null;

      return [boneName, upwardDriftWorldY] as const;
    })
  );

  return {
    runtime_default_playback_path: runtimeDefaultPlaybackPath,
    playback_path: resolvedPlayback.playbackPath,
    sample_time_seconds: proofSampleTimeSeconds,
    sample_index: proofSampleIndex,
    final_frame_time_seconds: finalFrameTimeSeconds,
    rotation_space: renderedPoseSnapshot.rotationSpace,
    targeted_bones: renderedTargetedBoneNames,
    proof_boundary: {
      cumulative_bone_names: OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES,
      previously_accepted_bone_names: OFFICIAL_IDLE_ACCEPTED_PROOF_BONE_NAMES,
      new_lower_arm_hand_bone_names: OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES,
      new_root_finger_bone_names: OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES
    },
    bones: proofBones,
    fallback_surface: {
      official_idle_fallback_requested: fallbackOfficialRouteRequested,
      playback_path: fallbackResolvedPlayback.playbackPath,
      bound_channel_count: fallbackDebugSnapshot?.boundChannels.length ?? 0,
      quaternion_binding_prefixes: fallbackQuaternionBindingPrefixes
    },
    grounded_contact_surface: {
      grounding_contact_bone_names: OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES,
      world_y_epsilon: OFFICIAL_IDLE_GROUND_CONTACT_WORLD_Y_EPSILON,
      loop_start_grounded_contact_world_y_by_bone: loopStartGroundedContactSurface.groundedContactWorldYByBone,
      sampled_grounded_contact_world_y_by_bone: renderedGroundedContactSurface.groundedContactWorldYByBone,
      sampled_grounded_contact_world_y_drift_from_loop_start_by_bone: sampledGroundedContactWorldYDriftByBone,
      loop_start_min_grounded_contact_world_y: loopStartGroundedContactSurface.minGroundedContactWorldY,
      sampled_min_grounded_contact_world_y: renderedGroundedContactSurface.minGroundedContactWorldY
    },
    validation: {
      avatar_runtime_idle_route_returns_official_playback:
        runtimeDefaultPlaybackPath === "official_idle_stability" &&
        resolvedPlayback.playbackPath === "official_idle_stability" &&
        playback !== null,
      playback_path_is_runtime_default: resolvedPlayback.playbackPath === runtimeDefaultPlaybackPath,
      runtime_default_path_is_official_idle_stability: runtimeDefaultPlaybackPath === "official_idle_stability",
      rotation_space_is_rendered_raw_local_rotation:
        renderedPoseSnapshot.rotationSpace === "vrm_rendered_raw_bone_local_rotation",
      targeted_bones_match_official_idle_slice:
        renderedTargetedBoneNames.length === OFFICIAL_IDLE_TARGET_BONE_NAMES.length &&
        OFFICIAL_IDLE_TARGET_BONE_NAMES.every((boneName) => renderedTargetedBoneNames.includes(boneName)),
      targeted_bones_include_root_finger_slice:
        OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.every((boneName) => renderedTargetedBoneNames.includes(boneName)),
      targeted_bones_include_ground_contact_chain:
        OFFICIAL_IDLE_GROUND_CONTACT_BONE_NAMES.every((boneName) =>
          renderedTargetedBoneNames.includes(boneName)
        ),
      cumulative_proof_bones_match_rendered_silhouette_slice:
        JSON.stringify(proofBones.map((bone) => bone.bone_name)) ===
        JSON.stringify(OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES),
      proof_boundary_explicitly_separates_accepted_and_new_follow_through_slices:
        OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.length ===
          OFFICIAL_IDLE_ACCEPTED_PROOF_BONE_NAMES.length +
            OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES.length +
            OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.length &&
        OFFICIAL_IDLE_ACCEPTED_PROOF_BONE_NAMES.every((boneName) =>
          OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.includes(boneName as OfficialIdleRenderedProofBoneName)
        ) &&
        OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES.every((boneName) =>
          OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.includes(boneName as OfficialIdleRenderedProofBoneName)
        ) &&
        OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.every((boneName) =>
          OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.includes(boneName as OfficialIdleRenderedProofBoneName)
        ) &&
        OFFICIAL_IDLE_ACCEPTED_PROOF_BONE_NAMES.every(
          (boneName) => !OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES.includes(
            boneName as OfficialIdleLowerArmHandProofBoneName
          )
        ) &&
        OFFICIAL_IDLE_ACCEPTED_PROOF_BONE_NAMES.every(
          (boneName) => !OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(
            boneName as OfficialIdleFingerProofBoneName
          )
        ) &&
        OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES.every(
          (boneName) => !OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.includes(
            boneName as OfficialIdleFingerProofBoneName
          )
        ) &&
        OFFICIAL_IDLE_RENDERED_PROOF_BONE_NAMES.every(
          (boneName) =>
            OFFICIAL_IDLE_ACCEPTED_PROOF_BONE_NAMES.some((acceptedBoneName) => acceptedBoneName === boneName) ||
            OFFICIAL_IDLE_LOWER_ARM_HAND_PROOF_BONE_NAMES.some((lowerArmHandBoneName) => lowerArmHandBoneName === boneName) ||
            OFFICIAL_IDLE_FINGER_PROOF_BONE_NAMES.some((fingerBoneName) => fingerBoneName === boneName)
        ),
      proof_boundary_is_subset_of_targeted_bones:
        proofBones.every((bone) => OFFICIAL_IDLE_TARGET_BONE_NAMES.includes(bone.bone_name)),
      proof_uses_rendered_pose_snapshot_for_all_targeted_bones:
        proofBones.every((bone) => bone.browser_source === "rendered_pose_snapshot"),
      raw_and_normalized_bones_are_distinct_objects: rawAndNormalizedBonesAreDistinctObjects,
      all_proof_bones_expose_finite_browser_export_and_final_frame_quaternions:
        proofBones.every(
          (bone) =>
            isFiniteQuaternion(bone.browser_quaternion) &&
            isFiniteQuaternion(bone.export_quaternion) &&
            isFiniteQuaternion(bone.baseline_browser_quaternion) &&
            isFiniteQuaternion(bone.final_frame_browser_quaternion)
        ),
      all_proof_bones_expose_finite_rendered_and_authored_pitch_roll:
        proofBones.every(
          (bone) => isFiniteEulerXYZ(bone.browser_euler_xyz) && isFiniteEulerXYZ(bone.export_euler_xyz)
        ),
      pitch_roll_proof_bone_rendered_pitch_roll_above_noise:
        pitchRollProofBones.every(
          (bone) =>
            isFiniteEulerXYZ(bone.browser_euler_xyz) &&
            (axisValueExceedsNoiseFloor(bone.browser_euler_xyz[0]) || axisValueExceedsNoiseFloor(bone.browser_euler_xyz[2]))
        ),
      pitch_roll_proof_bone_rendered_pitch_roll_sign_matches_authored_axes:
        pitchRollProofBones.every(
          (bone) =>
            isFiniteEulerXYZ(bone.browser_euler_xyz) &&
            isFiniteEulerXYZ(bone.export_euler_xyz) &&
            renderedAxisMatchesAuthoredSign(bone.browser_euler_xyz[0], bone.export_euler_xyz[0]) &&
            renderedAxisMatchesAuthoredSign(bone.browser_euler_xyz[2], bone.export_euler_xyz[2])
        ),
      lower_arm_hand_slice_has_explicit_hand_axis_sign_proof:
        handProofBones.every(
          (bone) =>
            isFiniteEulerXYZ(bone.browser_euler_xyz) &&
            isFiniteEulerXYZ(bone.export_euler_xyz) &&
            axisValueExceedsNoiseFloor(bone.export_euler_xyz[0]) &&
            Math.abs(bone.export_euler_xyz[0]) > Math.abs(bone.export_euler_xyz[1]) &&
            Math.abs(bone.export_euler_xyz[0]) > Math.abs(bone.export_euler_xyz[2]) &&
            axisValueExceedsNoiseFloor(bone.browser_euler_xyz[0]) &&
            Math.abs(bone.browser_euler_xyz[0]) > Math.abs(bone.browser_euler_xyz[1]) &&
            Math.abs(bone.browser_euler_xyz[0]) > Math.abs(bone.browser_euler_xyz[2]) &&
            renderedAxisMatchesAuthoredSign(bone.browser_euler_xyz[0], bone.export_euler_xyz[0])
        ),
      finger_root_slice_has_explicit_dominant_axis_sign_proof:
        fingerProofBones.every((bone) => {
          const dominantAuthoredAxis = resolveDominantEulerAxis(bone.export_euler_xyz);

          return (
            dominantAuthoredAxis !== null &&
            isFiniteEulerXYZ(bone.browser_euler_xyz) &&
            axisValueExceedsNoiseFloor(bone.browser_euler_xyz[dominantAuthoredAxis.index]) &&
            renderedAxisMatchesAuthoredSign(
              bone.browser_euler_xyz[dominantAuthoredAxis.index],
              dominantAuthoredAxis.value
            )
          );
        }),
      finger_root_slice_has_explicit_rendered_articulation_surface:
        fingerProofBones.every(
          (bone) =>
            isFiniteVectorXYZ(bone.loop_start_rendered_finger_articulation_direction_in_hand_space) &&
            isFiniteVectorXYZ(bone.rendered_finger_articulation_direction_in_hand_space) &&
            isFiniteVectorXYZ(bone.final_frame_rendered_finger_articulation_direction_in_hand_space)
        ),
      finger_root_slice_rendered_articulation_excursion_above_threshold:
        fingerProofBones.every(
          (bone) =>
            typeof bone.rendered_finger_articulation_excursion_radians === "number" &&
            Number.isFinite(bone.rendered_finger_articulation_excursion_radians) &&
            bone.rendered_finger_articulation_excursion_radians > OFFICIAL_IDLE_FINGER_RENDERED_ARTICULATION_EPSILON_RADIANS
        ),
      proof_bone_authored_excursion_above_threshold:
        proofBones.every(
          (bone) =>
            typeof bone.authored_max_excursion_radians === "number" &&
            Number.isFinite(bone.authored_max_excursion_radians) &&
            bone.authored_max_excursion_radians > OFFICIAL_IDLE_RENDERED_EXCURSION_EPSILON_RADIANS
        ),
      proof_bone_sampled_rendered_excursion_above_threshold:
        proofBones.every(
          (bone) =>
            typeof bone.sampled_rendered_excursion_radians === "number" &&
            Number.isFinite(bone.sampled_rendered_excursion_radians) &&
            bone.sampled_rendered_excursion_radians > OFFICIAL_IDLE_RENDERED_EXCURSION_EPSILON_RADIANS
        ),
      lower_arm_hand_slice_returns_near_loop_start:
        proofBones.filter((bone) => bone.proof_slice === "lower_arm_hand_follow_through").every(
          (bone) =>
            bone.final_frame_settle_target === "loop_start_browser_quaternion" &&
            typeof bone.final_frame_angular_distance_to_settle_target_radians === "number" &&
            Number.isFinite(bone.final_frame_angular_distance_to_settle_target_radians) &&
            bone.final_frame_angular_distance_to_settle_target_radians <= OFFICIAL_IDLE_FINAL_FRAME_BASELINE_EPSILON_RADIANS
        ),
      finger_root_slice_returns_near_loop_start:
        proofBones.filter((bone) => bone.proof_slice === "finger_root_follow_through").every(
          (bone) =>
            bone.final_frame_settle_target === "loop_start_browser_quaternion" &&
            typeof bone.final_frame_angular_distance_to_settle_target_radians === "number" &&
            Number.isFinite(bone.final_frame_angular_distance_to_settle_target_radians) &&
            bone.final_frame_angular_distance_to_settle_target_radians <= OFFICIAL_IDLE_FINAL_FRAME_BASELINE_EPSILON_RADIANS
        ),
      finger_root_slice_rendered_articulation_returns_near_loop_start:
        fingerProofBones.every(
          (bone) =>
            typeof bone.final_frame_rendered_finger_articulation_angular_distance_to_loop_start_radians === "number" &&
            Number.isFinite(bone.final_frame_rendered_finger_articulation_angular_distance_to_loop_start_radians) &&
            bone.final_frame_rendered_finger_articulation_angular_distance_to_loop_start_radians <=
              OFFICIAL_IDLE_FINAL_FRAME_BASELINE_EPSILON_RADIANS
        ),
      proof_bone_rendered_pose_differs_from_neutral_seed:
        proofBones.every(
          (bone) => isFiniteQuaternion(bone.browser_quaternion) && !quaternionsApproximatelyEqual(bone.browser_quaternion, NEUTRAL_QUATERNION)
        ),
      proof_bone_rendered_pose_stays_distinct_from_normalized_pose:
        proofBones.every(
          (bone) =>
            typeof bone.rendered_to_normalized_angular_distance_radians === "number" &&
            Number.isFinite(bone.rendered_to_normalized_angular_distance_radians) &&
            bone.rendered_to_normalized_angular_distance_radians >
              OFFICIAL_IDLE_RENDERED_RAW_NORMALIZED_SEPARATION_EPSILON_RADIANS
        ),
      official_idle_payload_did_not_trigger_fallback: !officialIdleFallbackRequested,
      fallback_route_returns_idle_fallback_humanoid:
        fallbackOfficialRouteRequested &&
        fallbackResolvedPlayback.playbackPath === "idle_fallback_humanoid" &&
        fallbackResolvedPlayback.playback !== null,
      fallback_has_no_official_idle_binding_prefixes:
        fallbackQuaternionBindingPrefixes.every((prefix) => !prefix.includes("official_mixer_rotation")),
      fallback_avoids_punch_only_comparison_binding_prefixes:
        fallbackQuaternionBindingPrefixes.every((prefix) => !prefix.includes("comparison_rotation")),
      runtime_floor_grounding_contact_set_matches_expected_feet_and_toes:
        JSON.stringify(OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES) ===
        JSON.stringify(["leftFoot", "rightFoot", "leftToes", "rightToes"]),
      grounded_loop_start_contact_points_touch_floor:
        OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES.every((boneName) => {
          const groundedWorldY = loopStartGroundedContactSurface.groundedContactWorldYByBone[boneName];
          return typeof groundedWorldY === "number" && Math.abs(groundedWorldY) <= OFFICIAL_IDLE_GROUND_CONTACT_WORLD_Y_EPSILON;
        }),
      sampled_grounded_contact_minimum_touches_floor:
        typeof renderedGroundedContactSurface.minGroundedContactWorldY === "number" &&
        renderedGroundedContactSurface.minGroundedContactWorldY <= OFFICIAL_IDLE_GROUND_CONTACT_WORLD_Y_EPSILON,
      sampled_grounded_contact_points_do_not_float_above_loop_start:
        OFFICIAL_IDLE_RUNTIME_GROUNDING_CONTACT_BONE_NAMES.every((boneName) => {
          const upwardDriftWorldY = sampledGroundedContactWorldYDriftByBone[boneName];
          return typeof upwardDriftWorldY === "number" && upwardDriftWorldY <= OFFICIAL_IDLE_GROUND_CONTACT_WORLD_Y_EPSILON;
        })
    }
  };
}

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];

  if (!snapshotPath) {
    throw new Error("Expected a frontend avatar idle.default snapshot path argument.");
  }

  const seamSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as FrontendAvatarIdleDefaultRuntimeSnapshot;
  const backendSnapshot = seamSnapshot.backend_session_animation_surface.snapshot_document;
  const updatedBackendSnapshot = seamSnapshot.backend_session_animation_surface.updated_snapshot_document;
  const backendDefaultIdleCommand = backendSnapshot.command;
  const backendPlaybackMode = resolveFrontendPlaybackMode(
    backendDefaultIdleCommand.playback.mode,
    backendDefaultIdleCommand.playback.loop
  );
  const backendExpectedDurationMs =
    backendDefaultIdleCommand.playback.expected_duration_ms ?? seamSnapshot.promoted_idle_asset.derived_duration_ms ?? null;
  const generatedIdleRuntimeDocument = seamSnapshot.generated_runtime_payload_surface.idle_default.runtime_document;
  const generatedSpeakRuntimeDocument = seamSnapshot.generated_runtime_payload_surface.speak_loop.runtime_document;
  const baseAnimation = cloneDefaultBaseAnimationCommand();
  const runtimePayload = resolveRuntimePayloadFromDocument(baseAnimation, generatedIdleRuntimeDocument);
  const idleRuntimeMotionProfile = runtimePayload ? resolveBaseAnimationMotionProfile(runtimePayload) : null;
  const updatedRuntimeCommand = buildRuntimeCommand(updatedBackendSnapshot.command);
  const speakRuntimePayload = resolveRuntimePayloadFromDocument(updatedRuntimeCommand, generatedSpeakRuntimeDocument);
  const generatedIdlePayload = resolveRuntimePayloadFromDocument(baseAnimation, generatedIdleRuntimeDocument);
  const generatedSpeakPayload = resolveRuntimePayloadFromDocument(updatedRuntimeCommand, generatedSpeakRuntimeDocument);
  const generatedSpeakMotionProfile = generatedSpeakPayload ? resolveBaseAnimationMotionProfile(generatedSpeakPayload) : null;
  const runtimeDefaultPlaybackPath = seamSnapshot.frontend_source_surface.avatar_runtime_default_playback_path;
  const officialIdleRenderedPoseSurface =
    runtimePayload && runtimeDefaultPlaybackPath
      ? buildOfficialIdleRenderedPoseSurface(runtimePayload, runtimeDefaultPlaybackPath)
      : null;
  const idleHumanoidPlaybackAcceptsRuntimePayload = runtimePayload
    ? humanoidPlaybackAcceptsRuntimePayload(runtimePayload)
    : false;
  const speakHumanoidPlaybackAcceptsRuntimePayload = speakRuntimePayload
    ? humanoidPlaybackAcceptsRuntimePayload(speakRuntimePayload)
    : false;
  const requestedUrls: string[] = [];
  const observedSnapshots: Array<{ deliveryMode: string; snapshot: ConsumedSessionAnimationSnapshot }> = [];
  const observedDeliveryModes: string[] = [];
  let resolveLiveSnapshot: ((snapshot: ConsumedSessionAnimationSnapshot) => void) | null = null;
  const liveSnapshotPromise = new Promise<ConsumedSessionAnimationSnapshot>((resolve) => {
    resolveLiveSnapshot = resolve;
  });
  const snapshotFallbackRequestedUrls: string[] = [];
  const snapshotFallbackObservedSnapshots: Array<{ deliveryMode: string; snapshot: ConsumedSessionAnimationSnapshot }> = [];
  const snapshotFallbackObservedDeliveryModes: string[] = [];
  let resolveSnapshotFallbackSnapshot: ((snapshot: ConsumedSessionAnimationSnapshot) => void) | null = null;
  const snapshotFallbackSnapshotPromise = new Promise<ConsumedSessionAnimationSnapshot>((resolve) => {
    resolveSnapshotFallbackSnapshot = resolve;
  });
  let snapshotFallbackRefreshEnabled = false;

  Object.assign(globalThis, {
    window: {
      EventSource: FakeEventSource,
      location: {
        origin: "http://localhost:4173"
      }
    }
  });

  const liveSubscription = await startSessionAnimationLiveConsumption({
    fetcher: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const payload = requestedUrls.length === 1 ? backendSnapshot : updatedBackendSnapshot;

      return {
        ok: true,
        status: 200,
        json: async () => payload
      } as Response;
    },
    onSnapshot: (snapshot, deliveryMode) => {
      observedSnapshots.push({ deliveryMode, snapshot });
      if (deliveryMode === "live") {
        resolveLiveSnapshot?.(snapshot);
      }
    },
    onDeliveryModeChange: (deliveryMode) => {
      observedDeliveryModes.push(deliveryMode);
    }
  });

  const liveEventSource = FakeEventSource.instances[0];
  if (!liveEventSource) {
    throw new Error("Session animation live consumption did not create an EventSource instance.");
  }

  liveEventSource.emit("open");
  liveEventSource.emit("session.animation", JSON.stringify(updatedBackendSnapshot));

  const liveSnapshot = await liveSnapshotPromise;
  liveSubscription.close();

  const snapshotFallbackInstanceIndex = FakeEventSource.instances.length;
  const snapshotFallbackSubscription = await startSessionAnimationLiveConsumption({
    fetcher: async (input) => {
      const url = String(input);
      snapshotFallbackRequestedUrls.push(url);

      const payload =
        snapshotFallbackRequestedUrls.length === 1 || !snapshotFallbackRefreshEnabled
          ? backendSnapshot
          : updatedBackendSnapshot;

      return {
        ok: true,
        status: 200,
        json: async () => payload
      } as Response;
    },
    snapshotRefreshIntervalMs: 20,
    onSnapshot: (snapshot, deliveryMode) => {
      snapshotFallbackObservedSnapshots.push({ deliveryMode, snapshot });

      if (deliveryMode === "snapshot" && snapshot.semanticCommand.id === updatedBackendSnapshot.command.semantic_id) {
        resolveSnapshotFallbackSnapshot?.(snapshot);
      }
    },
    onDeliveryModeChange: (deliveryMode) => {
      snapshotFallbackObservedDeliveryModes.push(deliveryMode);
    }
  });

  const snapshotFallbackEventSource = FakeEventSource.instances[snapshotFallbackInstanceIndex];
  if (!snapshotFallbackEventSource) {
    throw new Error("Session animation snapshot fallback did not create an EventSource instance.");
  }

  snapshotFallbackRefreshEnabled = true;
  snapshotFallbackEventSource.onerror?.();

  const snapshotFallbackSnapshot = await Promise.race([
    snapshotFallbackSnapshotPromise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Session animation snapshot fallback did not refresh from the backend."));
      }, 500);
    })
  ]);
  snapshotFallbackSubscription.close();

  const result = {
    runtime_default_idle: {
      backend_default_idle_command: {
        character_id: backendDefaultIdleCommand.character_id,
        semantic_id: backendDefaultIdleCommand.semantic_id,
        selected_source: backendDefaultIdleCommand.resolution.selected_source,
        playback_mode: backendPlaybackMode,
        expected_duration_ms: backendExpectedDurationMs
      },
      base_animation: baseAnimation,
      runtime_payload: runtimePayload,
      backend_surface_targets_active_character:
        backendDefaultIdleCommand.character_id === seamSnapshot.backend_session_animation_surface.active_character_id,
      backend_default_idle_is_shared_library: backendDefaultIdleCommand.resolution.selected_source === "shared_library",
      backend_default_idle_avoids_fallback: backendDefaultIdleCommand.resolution.fallback_applied === false,
      base_animation_matches_backend_semantic_id: baseAnimation.id === backendDefaultIdleCommand.semantic_id,
      base_animation_uses_shared_source: baseAnimation.source === "shared",
      base_animation_matches_backend_playback: baseAnimation.playback === backendPlaybackMode,
      runtime_payload_resolves: runtimePayload !== null,
      runtime_payload_matches_backend_semantic_id: runtimePayload?.semanticId === backendDefaultIdleCommand.semantic_id,
      runtime_payload_matches_backend_playback: runtimePayload?.playback === backendPlaybackMode,
      runtime_payload_matches_backend_duration:
        backendExpectedDurationMs === null ? runtimePayload !== null : runtimePayload?.durationMs === backendExpectedDurationMs
    },
    live_loader_runtime: {
      snapshot_fetch_urls: requestedUrls,
      live_event_source_url: liveEventSource.url,
      live_mode_observed: observedDeliveryModes.includes("live"),
      initial_snapshot_delivery_mode: observedSnapshots[0]?.deliveryMode ?? null,
      initial_snapshot_semantic_id: observedSnapshots[0]?.snapshot.semanticCommand.id ?? null,
      live_snapshot_semantic_id: liveSnapshot.semanticCommand.id,
      live_snapshot_lifecycle_state: liveSnapshot.lifecycleState,
      live_snapshot_matches_backend_updated_character:
        liveSnapshot.characterId === updatedBackendSnapshot.active_character_id,
      snapshot_fetch_stays_on_snapshot_route: requestedUrls.every((url) => /\/session\/animation$/.test(url)),
      live_event_source_reuses_animation_route: /\/session\/animation$/.test(liveEventSource.url),
      live_event_consumed_direct_payload: requestedUrls.length === 1,
      live_event_promoted_updated_snapshot: liveSnapshot.semanticCommand.id === updatedBackendSnapshot.command.semantic_id,
      live_event_source_closed_on_cleanup: liveEventSource.closed
    },
    snapshot_fallback_runtime: {
      snapshot_fetch_urls: snapshotFallbackRequestedUrls,
      event_source_url: snapshotFallbackEventSource.url,
      fallback_mode_observed: snapshotFallbackObservedDeliveryModes.includes("snapshot"),
      live_mode_observed: snapshotFallbackObservedDeliveryModes.includes("live"),
      initial_snapshot_delivery_mode: snapshotFallbackObservedSnapshots[0]?.deliveryMode ?? null,
      initial_snapshot_semantic_id: snapshotFallbackObservedSnapshots[0]?.snapshot.semanticCommand.id ?? null,
      refreshed_snapshot_semantic_id: snapshotFallbackSnapshot.semanticCommand.id,
      refreshed_snapshot_lifecycle_state: snapshotFallbackSnapshot.lifecycleState,
      refreshed_snapshot_matches_backend_updated_character:
        snapshotFallbackSnapshot.characterId === updatedBackendSnapshot.active_character_id,
      snapshot_refresh_stays_on_snapshot_route: snapshotFallbackRequestedUrls.every((url) => /\/session\/animation$/.test(url)),
      snapshot_refresh_refetched_backend_snapshot: snapshotFallbackRequestedUrls.length >= 2,
      snapshot_fallback_promoted_updated_snapshot:
        snapshotFallbackSnapshot.semanticCommand.id === updatedBackendSnapshot.command.semantic_id,
      event_source_closed_on_disconnect: snapshotFallbackEventSource.closed
    },
    source_path_independence: {
      runtime_load_path_seeds_default_idle: seamSnapshot.frontend_source_surface.runtime_load_path_seeds_default_idle,
      avatar_runtime_default_playback_path: seamSnapshot.frontend_source_surface.avatar_runtime_default_playback_path,
      app_uses_idle_asset_path_hack:
        seamSnapshot.frontend_source_surface.app_mentions_idle_default_sidecar_path ||
        seamSnapshot.frontend_source_surface.app_mentions_animation_asset_root,
      runtime_uses_idle_asset_path_hack:
        seamSnapshot.frontend_source_surface.runtime_mentions_idle_default_sidecar_path ||
        seamSnapshot.frontend_source_surface.runtime_mentions_animation_asset_root,
      avatar_runtime_distinguishes_official_idle_from_fallback:
        seamSnapshot.frontend_source_surface.avatar_runtime_distinguishes_official_idle_from_fallback,
      loader_fetches_session_animation_snapshot:
        seamSnapshot.frontend_source_surface.loader_fetches_session_animation_snapshot,
      loader_live_url_reuses_animation_route:
        seamSnapshot.frontend_source_surface.loader_live_url_reuses_animation_route
    },
    official_idle_route_surface: {
      official_idle_playback_factory_present:
        seamSnapshot.frontend_source_surface.official_idle_playback_factory_present,
      official_idle_playback_requires_unity_humanoid_channel_space:
        seamSnapshot.frontend_source_surface.official_idle_playback_requires_unity_humanoid_channel_space,
      official_idle_playback_targets_follow_through_bones:
        seamSnapshot.frontend_source_surface.official_idle_playback_targets_follow_through_bones,
      official_idle_playback_targets_ground_contact_bones:
        officialIdleRenderedPoseSurface?.validation.targeted_bones_include_ground_contact_chain ?? false,
      official_idle_grounding_keeps_contact_points_on_floor:
        (officialIdleRenderedPoseSurface?.validation.sampled_grounded_contact_minimum_touches_floor ?? false) &&
        (officialIdleRenderedPoseSurface?.validation.sampled_grounded_contact_points_do_not_float_above_loop_start ?? false)
    },
    official_idle_rendered_pose_surface: officialIdleRenderedPoseSurface,
    humanoid_channel_playback_surface: {
      avatar_runtime_wires_humanoid_channel_playback:
        seamSnapshot.frontend_source_surface.avatar_runtime_wires_humanoid_channel_playback,
      humanoid_playback_factory_present:
        seamSnapshot.frontend_source_surface.humanoid_playback_factory_present,
      humanoid_playback_requires_unity_humanoid_channel_space:
        seamSnapshot.frontend_source_surface.humanoid_playback_requires_unity_humanoid_channel_space,
      humanoid_idle_fallback_uses_punch_only_comparison_bindings:
        seamSnapshot.frontend_source_surface.humanoid_idle_fallback_uses_punch_only_comparison_bindings,
      humanoid_playback_binds_representative_channels:
        seamSnapshot.frontend_source_surface.humanoid_playback_binds_representative_channels,
      idle_runtime_channel_space_matches_humanoid_playback: idleHumanoidPlaybackAcceptsRuntimePayload,
      speak_runtime_channel_space_matches_humanoid_playback: speakHumanoidPlaybackAcceptsRuntimePayload
    },
    generated_runtime_channel_proof: {
      idle_runtime_document_semantic_id: generatedIdleRuntimeDocument.semantic_id ?? null,
      idle_runtime_document_matches_idle_default: generatedIdleRuntimeDocument.semantic_id === baseAnimation.id,
      idle_runtime_document_exports_channels:
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary.channel_count > 0,
      idle_runtime_document_has_representative_channel_coverage: exportedChannelSummaryHasRepresentativeCoverage(
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary
      ),
      idle_runtime_document_channel_samples_match_playback: exportedChannelSummaryMatchesPlaybackSamples(
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary
      ),
      idle_runtime_document_channel_values_vary: exportedChannelSummaryShowsVariation(
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary
      ),
      generated_idle_payload_resolves: generatedIdlePayload !== null,
      generated_idle_payload_matches_backend_semantic_id: generatedIdlePayload?.semanticId === backendDefaultIdleCommand.semantic_id,
      generated_idle_payload_matches_backend_duration:
        backendExpectedDurationMs === null ? generatedIdlePayload !== null : generatedIdlePayload?.durationMs === backendExpectedDurationMs,
      speak_runtime_document_semantic_id: generatedSpeakRuntimeDocument.semantic_id ?? null,
      speak_runtime_document_exports_channels:
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary.channel_count > 0,
      speak_runtime_document_has_representative_channel_coverage: exportedChannelSummaryHasRepresentativeCoverage(
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary
      ),
      speak_runtime_document_channel_samples_match_playback: exportedChannelSummaryMatchesPlaybackSamples(
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary
      ),
      speak_runtime_document_channel_values_vary: exportedChannelSummaryShowsVariation(
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary
      ),
      generated_speak_payload_resolves: generatedSpeakPayload !== null,
      generated_speak_payload_matches_live_semantic_id:
        generatedSpeakPayload?.semanticId === updatedBackendSnapshot.command.semantic_id,
      generated_speak_payload_matches_live_playback:
        generatedSpeakPayload?.playback === updatedRuntimeCommand.playback,
      generated_speak_payload_matches_live_duration:
        updatedBackendSnapshot.command.playback.expected_duration_ms === null ||
        updatedBackendSnapshot.command.playback.expected_duration_ms === undefined
          ? generatedSpeakPayload !== null
          : generatedSpeakPayload?.durationMs === updatedBackendSnapshot.command.playback.expected_duration_ms,
      generated_speak_payload_avoids_idle_alias:
        generatedSpeakPayload?.semanticId === "speak.loop" && generatedSpeakPayload?.semanticId !== baseAnimation.id,
      generated_speak_motion_profile_differs_from_idle:
        generatedSpeakPayload?.semanticId === "speak.loop" &&
        !areMotionProfilesEqual(generatedSpeakMotionProfile, idleRuntimeMotionProfile)
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();