import * as THREE from "three";
import { VRMHumanBoneName, type VRM } from "@pixiv/three-vrm";
import type {
  SemanticAnimationRuntimePayload,
  SemanticAnimationRuntimePositionSampleSeries,
  SemanticAnimationRuntimeQuaternionSampleSeries
} from "../../shared/types/animation";
import type { HumanoidChannelPlayback } from "./humanoidChannelPlayback";

type VRMHumanBoneNameValue = (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName];

const BONE_NAME_MAP: Readonly<Record<string, VRMHumanBoneNameValue>> = {
  Chest: VRMHumanBoneName.Chest,
  Head: VRMHumanBoneName.Head,
  Hips: VRMHumanBoneName.Hips,
  LeftFoot: VRMHumanBoneName.LeftFoot,
  LeftHand: VRMHumanBoneName.LeftHand,
  LeftLowerArm: VRMHumanBoneName.LeftLowerArm,
  LeftLowerLeg: VRMHumanBoneName.LeftLowerLeg,
  LeftShoulder: VRMHumanBoneName.LeftShoulder,
  LeftToes: VRMHumanBoneName.LeftToes,
  LeftUpperArm: VRMHumanBoneName.LeftUpperArm,
  LeftUpperLeg: VRMHumanBoneName.LeftUpperLeg,
  Neck: VRMHumanBoneName.Neck,
  RightFoot: VRMHumanBoneName.RightFoot,
  RightHand: VRMHumanBoneName.RightHand,
  RightLowerArm: VRMHumanBoneName.RightLowerArm,
  RightLowerLeg: VRMHumanBoneName.RightLowerLeg,
  RightShoulder: VRMHumanBoneName.RightShoulder,
  RightToes: VRMHumanBoneName.RightToes,
  RightUpperArm: VRMHumanBoneName.RightUpperArm,
  RightUpperLeg: VRMHumanBoneName.RightUpperLeg,
  Spine: VRMHumanBoneName.Spine,
  UpperChest: VRMHumanBoneName.UpperChest
};

function interleaveQuaternionSamples(samples: SemanticAnimationRuntimeQuaternionSampleSeries): number[] {
  const count = Math.min(samples.x.length, samples.y.length, samples.z.length, samples.w.length);
  const values: number[] = new Array(count * 4);

  // Convert from Unity left-handed to Three.js/VRM right-handed coordinate system:
  // negate X and Y quaternion components (Z-axis flip convention)
  for (let i = 0; i < count; i++) {
    values[i * 4] = -samples.x[i];
    values[i * 4 + 1] = -samples.y[i];
    values[i * 4 + 2] = samples.z[i];
    values[i * 4 + 3] = samples.w[i];
  }

  return values;
}

function interleavePositionSamples(samples: SemanticAnimationRuntimePositionSampleSeries): number[] {
  const count = Math.min(samples.x.length, samples.y.length, samples.z.length);
  const values: number[] = new Array(count * 3);

  for (let i = 0; i < count; i++) {
    values[i * 3] = samples.x[i];
    values[i * 3 + 1] = samples.y[i];
    values[i * 3 + 2] = samples.z[i];
  }

  return values;
}

/**
 * Creates a clean AnimationMixer-based playback using the bone local rotation
 * quaternion samples directly from the Unity export. No scale tables, no axis
 * decomposition, no per-bone weight overrides.
 */
export function createMixerPlayback(
  vrm: VRM | null,
  payload: SemanticAnimationRuntimePayload
): HumanoidChannelPlayback | null {
  const timesS = payload.sampling?.timesS;
  const comparison = payload.exportAudit?.boneTransformComparison;

  if (
    !vrm?.humanoid ||
    !timesS ||
    timesS.length === 0 ||
    !comparison?.usesRuntimeSamplingTimes ||
    comparison.bones.length === 0
  ) {
    return null;
  }

  const tracks: THREE.KeyframeTrack[] = [];
  const trackReport: string[] = [];

  for (const bone of comparison.bones) {
    const humanBodyBone = bone.humanBodyBone ?? null;
    const vrmBoneName = humanBodyBone ? BONE_NAME_MAP[humanBodyBone] : undefined;
    const samples = bone.localRotationSamples;

    if (!vrmBoneName || !samples) {
      trackReport.push(`SKIP ${humanBodyBone ?? bone.name}: no mapping or no samples`);
      continue;
    }

    if (
      samples.x.length !== timesS.length ||
      samples.y.length !== timesS.length ||
      samples.z.length !== timesS.length ||
      samples.w.length !== timesS.length
    ) {
      trackReport.push(`SKIP ${humanBodyBone}: sample count mismatch`);
      continue;
    }

    const boneNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);

    if (!boneNode) {
      trackReport.push(`SKIP ${humanBodyBone}: getNormalizedBoneNode returned null`);
      continue;
    }

    trackReport.push(`OK ${humanBodyBone} → node="${boneNode.name}" q[0]=(${samples.x[0].toFixed(3)},${samples.y[0].toFixed(3)},${samples.z[0].toFixed(3)},${samples.w[0].toFixed(3)})`);
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${boneNode.name}.quaternion`,
        timesS,
        interleaveQuaternionSamples(samples)
      )
    );
  }

  console.log(`[mixerPlayback] ${tracks.length} rotation tracks created from ${comparison.bones.length} bones:\n` + trackReport.join("\n"));

  // Add Hips position track if available (root translation for proper grounded animation)
  for (const bone of comparison.bones) {
    const humanBodyBone = bone.humanBodyBone ?? null;
    if (humanBodyBone !== "Hips") continue;

    const posSamples = bone.localPositionSamples;
    if (!posSamples || posSamples.x.length !== timesS.length) break;

    const hipsNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
    if (!hipsNode) break;

    tracks.push(
      new THREE.VectorKeyframeTrack(
        `${hipsNode.name}.position`,
        timesS,
        interleavePositionSamples(posSamples)
      )
    );
    break;
  }

  if (tracks.length === 0) {
    return null;
  }

  const duration = timesS[timesS.length - 1] ?? payload.durationMs / 1000;
  const clip = new THREE.AnimationClip(`mixer:${payload.semanticId}`, duration, tracks);
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const action = mixer.clipAction(clip);

  if (payload.playback === "loop") {
    action.setLoop(THREE.LoopRepeat, Infinity);
  } else {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
  }

  action.play();

  // Resolve bone nodes for procedural overlay (lean, yaw, nod)
  const motionProfile = payload.motionProfile;
  const spineNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine);
  const chestNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Chest);
  const hipsNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
  const upperChestNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
  const headNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
  const overlayQuat = new THREE.Quaternion();

  // Procedural overlay periods (intentionally different from base animation cycle)
  const LEAN_PERIOD = 11.0;
  const YAW_PERIOD = 13.7;
  const NOD_PERIOD = 8.333; // sync with breathing

  let lastAppliedTime = 0;

  return {
    apply(elapsedSeconds: number): void {
      const delta = elapsedSeconds - lastAppliedTime;
      lastAppliedTime = elapsedSeconds;

      if (delta > 0 && delta < 1) {
        // Normal forward advancement — let mixer handle LoopRepeat internally
        mixer.update(delta);
      } else {
        // Seek or reset (first frame, large jump, or backward) — re-evaluate from scratch
        mixer.setTime(elapsedSeconds % duration);
      }

      // Apply procedural lean/yaw/nod overlay on normalized bones before humanoid.update()
      if (motionProfile) {
        const leanAngle = Math.sin(elapsedSeconds * (2 * Math.PI / LEAN_PERIOD)) * motionProfile.leanAmplitude;
        const yawAngle = Math.sin(elapsedSeconds * (2 * Math.PI / YAW_PERIOD)) * motionProfile.yawAmplitude;
        const nodAngle = Math.sin(elapsedSeconds * (2 * Math.PI / NOD_PERIOD) + 0.5) * motionProfile.nodAmplitude;

        // Distribute lean across hips and spine (z-axis rotation in VRM normalized space)
        if (hipsNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), leanAngle * 0.4);
          hipsNode.quaternion.multiply(overlayQuat);
        }
        if (spineNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), leanAngle * 0.3);
          spineNode.quaternion.multiply(overlayQuat);
        }
        if (chestNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), leanAngle * 0.2);
          chestNode.quaternion.multiply(overlayQuat);
        }
        if (upperChestNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), leanAngle * 0.1);
          upperChestNode.quaternion.multiply(overlayQuat);
        }

        // Yaw (y-axis rotation) distributed across spine and chest
        if (spineNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle * 0.4);
          spineNode.quaternion.multiply(overlayQuat);
        }
        if (chestNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle * 0.35);
          chestNode.quaternion.multiply(overlayQuat);
        }
        if (upperChestNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle * 0.25);
          upperChestNode.quaternion.multiply(overlayQuat);
        }

        // Nod (x-axis rotation) on head — subtle breathing sync
        if (headNode) {
          overlayQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), nodAngle);
          headNode.quaternion.multiply(overlayQuat);
        }
      }

      vrm.humanoid.update();
    },

    getDebugSnapshot() {
      return {
        boundChannels: [],
        quaternionBoundChannels: tracks.map((track) => ({
          normalizedNamePrefix: track.name,
          boneName: track.name.split(".")[0] as VRMHumanBoneNameValue,
          sampledRotation: null
        })),
        targetedBones: tracks.map((track) => track.name.split(".")[0] as VRMHumanBoneNameValue)
      };
    },

    getPoseSnapshot(elapsedSeconds: number) {
      return {
        elapsedSeconds,
        sampleTimeSeconds: elapsedSeconds,
        sampleIndex: 0,
        rotationSpace: "vrm_normalized_bone_mixer_local_rotation",
        boundChannels: [],
        quaternionBoundChannels: [],
        targetedBones: [],
        bonePoses: [],
        keyBonePoses: []
      };
    },

    getRenderedPoseSnapshot(elapsedSeconds: number) {
      return this.getPoseSnapshot(elapsedSeconds);
    },

    reset(): void {
      action.stop();
      mixer.setTime(0);
      vrm.humanoid.update();
    }
  };
}
