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
    values[i * 3 + 2] = -samples.z[i];
  }

  return values;
}



/**
 * Scale exported hips position samples proportionally to match the VRM skeleton,
 * using the same approach as three-vrm's loadMixamoAnimation / createVRMAnimationClip:
 *   output = source_position * (vrmHipsY / sourceHipsY)
 *
 * This uniform scaling preserves the relationship between hips bob and leg rotations,
 * ensuring feet naturally stay grounded without any IK or FK corrections.
 */
function rebasePositionToVrmRest(
  samples: SemanticAnimationRuntimePositionSampleSeries,
  vrmRestPos: THREE.Vector3
): SemanticAnimationRuntimePositionSampleSeries {
  const count = samples.x.length;
  // Source hips rest Y (first frame as reference)
  const sourceHipsY = samples.y[0];
  // Uniform scale factor: VRM hips height / source hips height
  const scale = sourceHipsY !== 0 ? vrmRestPos.y / sourceHipsY : 1;

  const rebasedX = new Array<number>(count);
  const rebasedY = new Array<number>(count);
  const rebasedZ = new Array<number>(count);

  for (let i = 0; i < count; i++) {
    rebasedX[i] = samples.x[i] * scale;
    rebasedY[i] = samples.y[i] * scale;
    rebasedZ[i] = samples.z[i] * scale;
  }

  return { x: rebasedX, y: rebasedY, z: rebasedZ };
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

  for (const bone of comparison.bones) {
    const humanBodyBone = bone.humanBodyBone ?? null;
    const vrmBoneName = humanBodyBone ? BONE_NAME_MAP[humanBodyBone] : undefined;
    const samples = bone.localRotationSamples;

    if (!vrmBoneName || !samples) {
      continue;
    }

    if (
      samples.x.length !== timesS.length ||
      samples.y.length !== timesS.length ||
      samples.z.length !== timesS.length ||
      samples.w.length !== timesS.length
    ) {
      continue;
    }

    const boneNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);

    if (!boneNode) {
      continue;
    }

    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${boneNode.name}.quaternion`,
        timesS,
        interleaveQuaternionSamples(samples)
      )
    );
  }

  // Add Hips position track if available (root translation for proper grounded animation)
  for (const bone of comparison.bones) {
    const humanBodyBone = bone.humanBodyBone ?? null;
    if (humanBodyBone !== "Hips") continue;

    const posSamples = bone.localPositionSamples;
    if (!posSamples || posSamples.x.length !== timesS.length) break;

    const hipsNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
    if (!hipsNode) break;

    const vrmRestPos = hipsNode.position.clone();
    const normalizedRestHipsPos = vrm.humanoid.normalizedRestPose.hips?.position;
    const rebasedSamples = rebasePositionToVrmRest(posSamples, vrmRestPos);

    // Diagnostic: expose on window for debugging
    (window as any).__mixerDiag = {
      vrmRestPos: [vrmRestPos.x, vrmRestPos.y, vrmRestPos.z],
      normalizedRestHipsPos,
      sourceFirst: [posSamples.x[0], posSamples.y[0], posSamples.z[0]],
      scale: posSamples.y[0] !== 0 ? vrmRestPos.y / posSamples.y[0] : 1,
      outputFirst: [rebasedSamples.x[0], rebasedSamples.y[0], rebasedSamples.z[0]],
      sourceXRange: [Math.min(...posSamples.x), Math.max(...posSamples.x)],
      sourceZRange: [Math.min(...posSamples.z), Math.max(...posSamples.z)],
    };

    tracks.push(
      new THREE.VectorKeyframeTrack(
        `${hipsNode.name}.position`,
        timesS,
        interleavePositionSamples(rebasedSamples)
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
