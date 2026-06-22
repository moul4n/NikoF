import type {
  SemanticAnimationCommand,
  SemanticAnimationRuntimeBoneTransformComparison,
  SemanticAnimationRuntimeBoneTransformComparisonBone,
  SemanticAnimationMotionProfile,
  SemanticAnimationPlaybackMode,
  SemanticAnimationRuntimeChannel,
  SemanticAnimationRuntimeExportAudit,
  SemanticAnimationRuntimePayload,
  SemanticAnimationRuntimeQuaternion,
  SemanticAnimationRuntimeQuaternionSampleSeries,
  SemanticAnimationRuntimeSourceAsset,
  SemanticAnimationRuntimeSampling
} from "../../shared/types/animation";
import sharedAnimationRegistry from "../../../../assets/animations/dsl/shared/animations.json";

export interface SharedAnimationRuntimeSidecarDocument {
  semantic_id?: string;
  channel_space?: string;
  source?: {
    kind?: string;
    path?: string;
    source_asset_path?: string;
  };
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
      anchor?: {
        type?: string;
        bones?: string[];
      };
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
        local_position_samples?: {
          x?: number[];
          y?: number[];
          z?: number[];
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
}

type SharedAnimationRuntimeSidecarModule = {
  default: SharedAnimationRuntimeSidecarDocument;
};

type SharedAnimationRegistryDocument = {
  sidecars?: Record<
    string,
    {
      path?: string;
      stage?: string;
      approved_for_shared_library?: boolean;
    }
  >;
};

/**
 * Semantic ids whose generated runtime source is a Unity .anim (not playable
 * by the official VRMA/Mixamo playback core). They resolve to another
 * semantic's playable source until dedicated .vrma assets are exported.
 */
export const SHARED_SEMANTIC_ANIMATION_SOURCE_FALLBACKS: Readonly<Record<string, string>> = {
  "idle.default": "idle.neutral",
  "listen.loop": "idle.neutral",
  "speak.loop": "idle.neutral"
};

export function isIdleSemanticAnimationPayload(payload: SemanticAnimationRuntimePayload): boolean {
  return payload.semanticId.startsWith("idle.");
}

const legacySharedSemanticAnimationAliases: Readonly<Record<string, string>> = {
  idle1v3: "idle.neutral"
};

const sharedAnimationRegistryDocument = sharedAnimationRegistry as SharedAnimationRegistryDocument;

const registeredSharedSemanticAnimationIds = Object.keys(sharedAnimationRegistryDocument.sidecars ?? {});

const sharedAnimationRuntimeSidecarModules = Object.values(
  import.meta.glob<SharedAnimationRuntimeSidecarModule>(
    "../../../../assets/animations/generated/shared/*/*.runtime.json",
    { eager: true }
  )
).reduce<Record<string, SharedAnimationRuntimeSidecarModule>>((modules, runtimeModule) => {
  const semanticId = runtimeModule.default.semantic_id?.trim();

  if (semanticId) {
    modules[semanticId] = runtimeModule;
  }

  return modules;
}, {});

function resolveRuntimeSourceAsset(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument
): SemanticAnimationRuntimeSourceAsset | undefined {
  const path = runtimeDocument.source?.path?.trim();

  if (!path) {
    return undefined;
  }

  return {
    kind: runtimeDocument.source?.kind?.trim() || undefined,
    path,
    sourceAssetPath: runtimeDocument.source?.source_asset_path?.trim() || undefined
  };
}

export const DEFAULT_BASE_ANIMATION_COMMAND: SemanticAnimationCommand = {
  id: "idle.neutral",
  playback: "loop"
};

const sharedSemanticAnimationPayloadCatalog = buildSharedSemanticAnimationPayloadCatalog();

function createDefaultSharedSemanticAnimationPayloadCatalog(): Map<string, SemanticAnimationRuntimePayload> {
  return new Map<string, SemanticAnimationRuntimePayload>([
    [
      "idle.default",
      {
        semanticId: "idle.default",
        playback: "loop",
        durationMs: 8333,
        motionProfile: {
          speedMultiplier: 1,
          bobAmplitude: 0.018,
          secondaryBobAmplitude: 0.004,
          leanAmplitude: 0.018,
          nodAmplitude: 0.012,
          yawAmplitude: 0.03
        }
      }
    ]
  ]);
}

function resolveRuntimePlaybackMode(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument
): SemanticAnimationPlaybackMode | null {
  const playbackMode = runtimeDocument.playback?.mode;

  if (playbackMode === "loop" || playbackMode === "once") {
    return playbackMode;
  }

  if (typeof runtimeDocument.playback?.loop === "boolean") {
    return runtimeDocument.playback.loop ? "loop" : "once";
  }

  return null;
}

function resolveRuntimeMotionProfile(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument
): SemanticAnimationMotionProfile | null {
  const motionProfile = runtimeDocument.motion_profile;

  if (
    !motionProfile ||
    typeof motionProfile.speed_multiplier !== "number" ||
    !Number.isFinite(motionProfile.speed_multiplier) ||
    motionProfile.speed_multiplier < 0 ||
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
    return null;
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

function resolveRuntimeSampling(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument
): SemanticAnimationRuntimeSampling | null {
  const timesS = runtimeDocument.sampling?.times_s?.filter((value) => typeof value === "number" && Number.isFinite(value));

  if (!timesS || timesS.length === 0) {
    return null;
  }

  return {
    timesS,
    sampleRate:
      typeof runtimeDocument.playback?.sample_rate === "number" && Number.isFinite(runtimeDocument.playback.sample_rate)
        ? runtimeDocument.playback.sample_rate
        : undefined,
    sampleCount:
      typeof runtimeDocument.playback?.sample_count === "number" && Number.isFinite(runtimeDocument.playback.sample_count)
        ? runtimeDocument.playback.sample_count
        : undefined
  };
}

function resolveRuntimeChannels(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument,
  sampling: SemanticAnimationRuntimeSampling | null
): SemanticAnimationRuntimeChannel[] | undefined {
  const expectedSampleCount = sampling?.timesS.length ?? null;
  const channels = runtimeDocument.channels
    ?.map((channel): SemanticAnimationRuntimeChannel | null => {
      const name = channel.name?.trim();
      const normalizedName = channel.normalized_name?.trim();
      const samples = channel.samples?.filter((value) => typeof value === "number" && Number.isFinite(value));

      if (!name || !normalizedName || !samples || samples.length === 0) {
        return null;
      }

      if (expectedSampleCount !== null && samples.length !== expectedSampleCount) {
        return null;
      }

      return {
        name,
        normalizedName,
        group: channel.group?.trim() || undefined,
        valueKind: channel.value_kind?.trim() || undefined,
        samples
      };
    })
    .filter((channel): channel is SemanticAnimationRuntimeChannel => channel !== null);

  return channels && channels.length > 0 ? channels : undefined;
}

function resolveRuntimeQuaternion(
  quaternionDocument: {
    x?: number;
    y?: number;
    z?: number;
    w?: number;
  } | null | undefined
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

function resolveRuntimeQuaternionSampleComponent(
  samples: number[] | null | undefined,
  expectedSampleCount: number | null
): number[] | null {
  const resolvedSamples = samples?.filter((value) => typeof value === "number" && Number.isFinite(value));

  if (!resolvedSamples || resolvedSamples.length === 0) {
    return null;
  }

  if (expectedSampleCount !== null && resolvedSamples.length !== expectedSampleCount) {
    return null;
  }

  return resolvedSamples;
}

function resolveRuntimeQuaternionSampleSeries(
  sampleSeriesDocument:
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
  if (!sampleSeriesDocument) {
    return undefined;
  }

  const x = resolveRuntimeQuaternionSampleComponent(sampleSeriesDocument.x, expectedSampleCount);
  const y = resolveRuntimeQuaternionSampleComponent(sampleSeriesDocument.y, expectedSampleCount);
  const z = resolveRuntimeQuaternionSampleComponent(sampleSeriesDocument.z, expectedSampleCount);
  const w = resolveRuntimeQuaternionSampleComponent(sampleSeriesDocument.w, expectedSampleCount);

  if (!x || !y || !z || !w) {
    return undefined;
  }

  const sampleCount = x.length;

  if (y.length !== sampleCount || z.length !== sampleCount || w.length !== sampleCount) {
    return undefined;
  }

  return {
    x,
    y,
    z,
    w
  };
}

function resolveRuntimePositionSampleSeries(
  sampleSeriesDocument: { x?: number[]; y?: number[]; z?: number[] } | null | undefined,
  expectedSampleCount: number | null
): { x: number[]; y: number[]; z: number[] } | undefined {
  if (!sampleSeriesDocument) {
    return undefined;
  }

  const x = resolveRuntimeQuaternionSampleComponent(sampleSeriesDocument.x, expectedSampleCount);
  const y = resolveRuntimeQuaternionSampleComponent(sampleSeriesDocument.y, expectedSampleCount);
  const z = resolveRuntimeQuaternionSampleComponent(sampleSeriesDocument.z, expectedSampleCount);

  if (!x || !y || !z) {
    return undefined;
  }

  const sampleCount = x.length;
  if (y.length !== sampleCount || z.length !== sampleCount) {
    return undefined;
  }

  return { x, y, z };
}

function resolveRuntimeBoneTransformComparisonBones(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument,
  sampling: SemanticAnimationRuntimeSampling | null
): SemanticAnimationRuntimeBoneTransformComparisonBone[] | undefined {
  const usesRuntimeSamplingTimes = runtimeDocument.export_audit?.bone_transform_comparison?.uses_runtime_sampling_times === true;
  const expectedSampleCount = usesRuntimeSamplingTimes ? sampling?.timesS.length ?? null : null;
  const resolvedBones = runtimeDocument.export_audit?.bone_transform_comparison?.bones
    ?.map((bone): SemanticAnimationRuntimeBoneTransformComparisonBone | null => {
      const name = bone.name?.trim();

      if (!name) {
        return null;
      }

      const localPositionSamples = bone.local_position_samples
        ? resolveRuntimePositionSampleSeries(bone.local_position_samples, expectedSampleCount)
        : undefined;

      return {
        name,
        humanBodyBone: bone.human_body_bone?.trim() || undefined,
        group: bone.group?.trim() || undefined,
        muscleChannels: bone.muscle_channels?.filter((channel): channel is string => typeof channel === "string" && channel.trim().length > 0),
        finalLocalRotation: resolveRuntimeQuaternion(bone.final_local_rotation),
        localRotationSamples: resolveRuntimeQuaternionSampleSeries(bone.local_rotation_samples, expectedSampleCount),
        localPositionSamples
      };
    })
    .filter((bone): bone is SemanticAnimationRuntimeBoneTransformComparisonBone => bone !== null);

  return resolvedBones && resolvedBones.length > 0 ? resolvedBones : undefined;
}

function resolveRuntimeExportAudit(
  runtimeDocument: SharedAnimationRuntimeSidecarDocument,
  sampling: SemanticAnimationRuntimeSampling | null
): SemanticAnimationRuntimeExportAudit | undefined {
  const resolvedBones = resolveRuntimeBoneTransformComparisonBones(runtimeDocument, sampling);
  const boneTransformComparisonDocument = runtimeDocument.export_audit?.bone_transform_comparison;
  const boneTransformComparison: SemanticAnimationRuntimeBoneTransformComparison | undefined =
    resolvedBones && boneTransformComparisonDocument
      ? {
          clipGateSemanticId: boneTransformComparisonDocument.clip_gate_semantic_id?.trim() || undefined,
          comparisonKind: boneTransformComparisonDocument.comparison_kind?.trim() || undefined,
          samplingMode: boneTransformComparisonDocument.sampling_mode?.trim() || undefined,
          avatarSource: boneTransformComparisonDocument.avatar_source?.trim() || undefined,
          usesRuntimeSamplingTimes:
            typeof boneTransformComparisonDocument.uses_runtime_sampling_times === "boolean"
              ? boneTransformComparisonDocument.uses_runtime_sampling_times
              : undefined,
          boneCount:
            typeof boneTransformComparisonDocument.bone_count === "number" &&
            Number.isFinite(boneTransformComparisonDocument.bone_count)
              ? boneTransformComparisonDocument.bone_count
              : undefined,
          anchor: boneTransformComparisonDocument.anchor?.type
            ? {
                type: boneTransformComparisonDocument.anchor.type,
                bones: boneTransformComparisonDocument.anchor.bones?.filter(
                  (b): b is string => typeof b === "string" && b.length > 0
                )
              }
            : undefined,
          bones: resolvedBones
        }
      : undefined;

  if (!boneTransformComparison && !runtimeDocument.export_audit?.limb_rotation_space) {
    return undefined;
  }

  return {
    limbRotationSpace: runtimeDocument.export_audit?.limb_rotation_space?.trim() || undefined,
    lowerArmRotationHintSource: runtimeDocument.export_audit?.lower_arm_rotation_hint_source?.trim() || undefined,
    boneTransformComparison
  };
}

export function buildSharedSemanticAnimationPayloadCatalogFromRuntimeDocuments(
  runtimeDocuments: SharedAnimationRuntimeSidecarDocument[]
): Map<string, SemanticAnimationRuntimePayload> {
  const catalog = createDefaultSharedSemanticAnimationPayloadCatalog();

  runtimeDocuments.forEach((runtimeDocument) => {
    const semanticId = runtimeDocument.semantic_id;
    const playback = resolveRuntimePlaybackMode(runtimeDocument);
    const durationMs = runtimeDocument.playback?.duration_ms;
    const motionProfile = resolveRuntimeMotionProfile(runtimeDocument);
    const sampling = resolveRuntimeSampling(runtimeDocument);
    const channels = resolveRuntimeChannels(runtimeDocument, sampling);
    const exportAudit = resolveRuntimeExportAudit(runtimeDocument, sampling);
    const sourceAsset = resolveRuntimeSourceAsset(runtimeDocument);
    const existingPayload = semanticId ? catalog.get(semanticId) : null;

    if (!semanticId || !playback || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }

    catalog.set(semanticId, {
      semanticId,
      playback,
      durationMs,
      motionProfile: motionProfile ?? existingPayload?.motionProfile,
      channelSpace: runtimeDocument.channel_space ?? existingPayload?.channelSpace,
      sampling: sampling ?? existingPayload?.sampling,
      channels: channels ?? existingPayload?.channels,
      exportAudit: exportAudit ?? existingPayload?.exportAudit,
      sourceAsset: sourceAsset ?? existingPayload?.sourceAsset
    });
  });

  return catalog;
}

function buildSharedSemanticAnimationPayloadCatalog(): Map<string, SemanticAnimationRuntimePayload> {
  return buildSharedSemanticAnimationPayloadCatalogFromRuntimeDocuments(
    Object.values(sharedAnimationRuntimeSidecarModules).map((runtimeModule) => runtimeModule.default)
  );
}

function inferSemanticAnimationPlaybackMode(semanticId: string): SemanticAnimationPlaybackMode {
  return semanticId.endsWith(".once") ? "once" : "loop";
}

function createRegisteredSharedSemanticAnimationFallbackPayload(semanticId: string): SemanticAnimationRuntimePayload {
  return {
    semanticId,
    playback: inferSemanticAnimationPlaybackMode(semanticId),
    durationMs: 1
  };
}

function compareSharedSemanticAnimationPayloads(
  left: SemanticAnimationRuntimePayload,
  right: SemanticAnimationRuntimePayload
): number {
  const defaultSemanticId = DEFAULT_BASE_ANIMATION_COMMAND.id;

  if (left.semanticId === defaultSemanticId && right.semanticId !== defaultSemanticId) {
    return -1;
  }

  if (right.semanticId === defaultSemanticId && left.semanticId !== defaultSemanticId) {
    return 1;
  }

  return left.semanticId.localeCompare(right.semanticId);
}

function resolveSharedSemanticAnimationPayloadFromCatalog(
  command: SemanticAnimationCommand,
  catalog: Map<string, SemanticAnimationRuntimePayload>
): SemanticAnimationRuntimePayload | null {
  const resolvedPayload = catalog.get(command.id) ?? catalog.get(legacySharedSemanticAnimationAliases[command.id] ?? "");

  if (!resolvedPayload) {
    return null;
  }

  return {
    ...resolvedPayload,
    playback: command.playback,
    durationMs: command.durationMs ?? resolvedPayload.durationMs,
    motionProfile: resolvedPayload.motionProfile,
    channelSpace: resolvedPayload.channelSpace,
    sampling: resolvedPayload.sampling,
    channels: resolvedPayload.channels,
    exportAudit: resolvedPayload.exportAudit,
    sourceAsset: resolvedPayload.sourceAsset
  };
}

export function cloneDefaultBaseAnimationCommand(): SemanticAnimationCommand {
  return {
    ...DEFAULT_BASE_ANIMATION_COMMAND
  };
}

export function resolveCanonicalSharedSemanticAnimationId(semanticId: string): string {
  return legacySharedSemanticAnimationAliases[semanticId] ?? semanticId;
}

export function listSharedSemanticAnimationPayloads(): SemanticAnimationRuntimePayload[] {
  const catalogEntries = new Map(sharedSemanticAnimationPayloadCatalog);

  registeredSharedSemanticAnimationIds.forEach((semanticId) => {
    if (!catalogEntries.has(semanticId)) {
      catalogEntries.set(semanticId, createRegisteredSharedSemanticAnimationFallbackPayload(semanticId));
    }
  });

  return [...catalogEntries.values()].sort(compareSharedSemanticAnimationPayloads);
}

export function resolveSharedSemanticAnimationPayload(
  command: SemanticAnimationCommand
): SemanticAnimationRuntimePayload | null {
  return resolveSharedSemanticAnimationPayloadFromCatalog(command, sharedSemanticAnimationPayloadCatalog);
}

export function resolveSharedSemanticAnimationPayloadFromRuntimeDocuments(
  command: SemanticAnimationCommand,
  runtimeDocuments: SharedAnimationRuntimeSidecarDocument[]
): SemanticAnimationRuntimePayload | null {
  return resolveSharedSemanticAnimationPayloadFromCatalog(
    command,
    buildSharedSemanticAnimationPayloadCatalogFromRuntimeDocuments(runtimeDocuments)
  );
}