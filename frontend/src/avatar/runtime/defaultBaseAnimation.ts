import type {
  SemanticAnimationCommand,
  SemanticAnimationMotionProfile,
  SemanticAnimationPlaybackMode,
  SemanticAnimationRuntimeChannel,
  SemanticAnimationRuntimePayload,
  SemanticAnimationRuntimeSampling
} from "../../shared/types/animation";
import idleDefaultRuntime from "../../../../assets/animations/generated/shared/idle.default/idle.default.runtime.json";
import gesturePunchOnceRuntime from "../../../../assets/animations/generated/shared/gesture.punch.once/gesture.punch.once.runtime.json";
import listenLoopRuntime from "../../../../assets/animations/generated/shared/listen.loop/listen.loop.runtime.json";
import speakLoopRuntime from "../../../../assets/animations/generated/shared/speak.loop/speak.loop.runtime.json";

export interface SharedAnimationRuntimeSidecarDocument {
  semantic_id?: string;
  channel_space?: string;
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

const sharedAnimationRuntimeSidecarModules: Record<string, SharedAnimationRuntimeSidecarModule> = {
  "idle.default": {
    default: idleDefaultRuntime as SharedAnimationRuntimeSidecarDocument
  },
  "gesture.punch.once": {
    default: gesturePunchOnceRuntime as SharedAnimationRuntimeSidecarDocument
  },
  "listen.loop": {
    default: listenLoopRuntime as SharedAnimationRuntimeSidecarDocument
  },
  "speak.loop": {
    default: speakLoopRuntime as SharedAnimationRuntimeSidecarDocument
  }
};

export const DEFAULT_BASE_ANIMATION_COMMAND: SemanticAnimationCommand = {
  id: "idle.default",
  source: "shared",
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
    motionProfile.speed_multiplier <= 0 ||
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
      channels: channels ?? existingPayload?.channels
    });
  });

  return catalog;
}

function buildSharedSemanticAnimationPayloadCatalog(): Map<string, SemanticAnimationRuntimePayload> {
  return buildSharedSemanticAnimationPayloadCatalogFromRuntimeDocuments(
    Object.values(sharedAnimationRuntimeSidecarModules).map((runtimeModule) => runtimeModule.default)
  );
}

function resolveSharedSemanticAnimationPayloadFromCatalog(
  command: SemanticAnimationCommand,
  catalog: Map<string, SemanticAnimationRuntimePayload>
): SemanticAnimationRuntimePayload | null {
  if (command.source !== "shared") {
    return null;
  }

  const resolvedPayload = catalog.get(command.id);

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
    channels: resolvedPayload.channels
  };
}

export function cloneDefaultBaseAnimationCommand(): SemanticAnimationCommand {
  return {
    ...DEFAULT_BASE_ANIMATION_COMMAND
  };
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