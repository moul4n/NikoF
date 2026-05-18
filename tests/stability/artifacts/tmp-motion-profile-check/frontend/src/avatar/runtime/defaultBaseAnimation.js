import idleDefaultRuntime from "../../../../assets/animations/generated/shared/idle.default/idle.default.runtime.json";
import gesturePunchOnceRuntime from "../../../../assets/animations/generated/shared/gesture.punch.once/gesture.punch.once.runtime.json";
import listenLoopRuntime from "../../../../assets/animations/generated/shared/listen.loop/listen.loop.runtime.json";
import speakLoopRuntime from "../../../../assets/animations/generated/shared/speak.loop/speak.loop.runtime.json";
const sharedAnimationRuntimeSidecarModules = {
    "idle.default": {
        default: idleDefaultRuntime
    },
    "gesture.punch.once": {
        default: gesturePunchOnceRuntime
    },
    "listen.loop": {
        default: listenLoopRuntime
    },
    "speak.loop": {
        default: speakLoopRuntime
    }
};
export const DEFAULT_BASE_ANIMATION_COMMAND = {
    id: "idle.default",
    source: "shared",
    playback: "loop"
};
const sharedSemanticAnimationPayloadCatalog = buildSharedSemanticAnimationPayloadCatalog();
function createDefaultSharedSemanticAnimationPayloadCatalog() {
    return new Map([
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
function resolveRuntimePlaybackMode(runtimeDocument) {
    const playbackMode = runtimeDocument.playback?.mode;
    if (playbackMode === "loop" || playbackMode === "once") {
        return playbackMode;
    }
    if (typeof runtimeDocument.playback?.loop === "boolean") {
        return runtimeDocument.playback.loop ? "loop" : "once";
    }
    return null;
}
function resolveRuntimeMotionProfile(runtimeDocument) {
    const motionProfile = runtimeDocument.motion_profile;
    if (!motionProfile ||
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
        !Number.isFinite(motionProfile.yaw_amplitude)) {
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
function resolveRuntimeSampling(runtimeDocument) {
    const timesS = runtimeDocument.sampling?.times_s?.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (!timesS || timesS.length === 0) {
        return null;
    }
    return {
        timesS,
        sampleRate: typeof runtimeDocument.playback?.sample_rate === "number" && Number.isFinite(runtimeDocument.playback.sample_rate)
            ? runtimeDocument.playback.sample_rate
            : undefined,
        sampleCount: typeof runtimeDocument.playback?.sample_count === "number" && Number.isFinite(runtimeDocument.playback.sample_count)
            ? runtimeDocument.playback.sample_count
            : undefined
    };
}
function resolveRuntimeChannels(runtimeDocument, sampling) {
    const expectedSampleCount = sampling?.timesS.length ?? null;
    const channels = runtimeDocument.channels
        ?.map((channel) => {
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
        .filter((channel) => channel !== null);
    return channels && channels.length > 0 ? channels : undefined;
}
function resolveRuntimeQuaternion(quaternionDocument) {
    if (!quaternionDocument) {
        return undefined;
    }
    const { x, y, z, w } = quaternionDocument;
    if (![x, y, z, w].every((value) => typeof value === "number" && Number.isFinite(value))) {
        return undefined;
    }
    return {
        x: x,
        y: y,
        z: z,
        w: w
    };
}
function resolveRuntimeQuaternionSampleComponent(samples, expectedSampleCount) {
    const resolvedSamples = samples?.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (!resolvedSamples || resolvedSamples.length === 0) {
        return null;
    }
    if (expectedSampleCount !== null && resolvedSamples.length !== expectedSampleCount) {
        return null;
    }
    return resolvedSamples;
}
function resolveRuntimeQuaternionSampleSeries(sampleSeriesDocument, expectedSampleCount) {
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
function resolveRuntimeBoneTransformComparisonBones(runtimeDocument, sampling) {
    const usesRuntimeSamplingTimes = runtimeDocument.export_audit?.bone_transform_comparison?.uses_runtime_sampling_times === true;
    const expectedSampleCount = usesRuntimeSamplingTimes ? sampling?.timesS.length ?? null : null;
    const resolvedBones = runtimeDocument.export_audit?.bone_transform_comparison?.bones
        ?.map((bone) => {
        const name = bone.name?.trim();
        if (!name) {
            return null;
        }
        return {
            name,
            humanBodyBone: bone.human_body_bone?.trim() || undefined,
            group: bone.group?.trim() || undefined,
            muscleChannels: bone.muscle_channels?.filter((channel) => typeof channel === "string" && channel.trim().length > 0),
            finalLocalRotation: resolveRuntimeQuaternion(bone.final_local_rotation),
            localRotationSamples: resolveRuntimeQuaternionSampleSeries(bone.local_rotation_samples, expectedSampleCount)
        };
    })
        .filter((bone) => bone !== null);
    return resolvedBones && resolvedBones.length > 0 ? resolvedBones : undefined;
}
function resolveRuntimeExportAudit(runtimeDocument, sampling) {
    const resolvedBones = resolveRuntimeBoneTransformComparisonBones(runtimeDocument, sampling);
    const boneTransformComparisonDocument = runtimeDocument.export_audit?.bone_transform_comparison;
    const boneTransformComparison = resolvedBones && boneTransformComparisonDocument
        ? {
            clipGateSemanticId: boneTransformComparisonDocument.clip_gate_semantic_id?.trim() || undefined,
            comparisonKind: boneTransformComparisonDocument.comparison_kind?.trim() || undefined,
            samplingMode: boneTransformComparisonDocument.sampling_mode?.trim() || undefined,
            avatarSource: boneTransformComparisonDocument.avatar_source?.trim() || undefined,
            usesRuntimeSamplingTimes: typeof boneTransformComparisonDocument.uses_runtime_sampling_times === "boolean"
                ? boneTransformComparisonDocument.uses_runtime_sampling_times
                : undefined,
            boneCount: typeof boneTransformComparisonDocument.bone_count === "number" &&
                Number.isFinite(boneTransformComparisonDocument.bone_count)
                ? boneTransformComparisonDocument.bone_count
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
export function buildSharedSemanticAnimationPayloadCatalogFromRuntimeDocuments(runtimeDocuments) {
    const catalog = createDefaultSharedSemanticAnimationPayloadCatalog();
    runtimeDocuments.forEach((runtimeDocument) => {
        const semanticId = runtimeDocument.semantic_id;
        const playback = resolveRuntimePlaybackMode(runtimeDocument);
        const durationMs = runtimeDocument.playback?.duration_ms;
        const motionProfile = resolveRuntimeMotionProfile(runtimeDocument);
        const sampling = resolveRuntimeSampling(runtimeDocument);
        const channels = resolveRuntimeChannels(runtimeDocument, sampling);
        const exportAudit = resolveRuntimeExportAudit(runtimeDocument, sampling);
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
            exportAudit: exportAudit ?? existingPayload?.exportAudit
        });
    });
    return catalog;
}
function buildSharedSemanticAnimationPayloadCatalog() {
    return buildSharedSemanticAnimationPayloadCatalogFromRuntimeDocuments(Object.values(sharedAnimationRuntimeSidecarModules).map((runtimeModule) => runtimeModule.default));
}
function resolveSharedSemanticAnimationPayloadFromCatalog(command, catalog) {
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
        channels: resolvedPayload.channels,
        exportAudit: resolvedPayload.exportAudit
    };
}
export function cloneDefaultBaseAnimationCommand() {
    return {
        ...DEFAULT_BASE_ANIMATION_COMMAND
    };
}
export function resolveSharedSemanticAnimationPayload(command) {
    return resolveSharedSemanticAnimationPayloadFromCatalog(command, sharedSemanticAnimationPayloadCatalog);
}
export function resolveSharedSemanticAnimationPayloadFromRuntimeDocuments(command, runtimeDocuments) {
    return resolveSharedSemanticAnimationPayloadFromCatalog(command, buildSharedSemanticAnimationPayloadCatalogFromRuntimeDocuments(runtimeDocuments));
}
