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

/**
 * Feet-anchored playback: builds the animation with feet as the immovable base.
 *
 * Upper body (hips, spine, chest, arms, head): uses exported rotation data directly.
 * Legs: rotation tracks are PRE-SOLVED at clip-build time using 2-bone IK so that
 * both feet stay planted at Y=0 regardless of the VRM's proportions.
 *
 * The result is a clip that inherently keeps feet grounded — no per-frame runtime
 * corrections needed. The model is built from the feet up.
 */
export function createFeetAnchoredMixerPlayback(
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
  const frameCount = timesS.length;

  // Collect exported bone data by name for IK solving
  const boneDataMap = new Map<string, SemanticAnimationRuntimeQuaternionSampleSeries>();
  for (const bone of comparison.bones) {
    if (bone.humanBodyBone && bone.localRotationSamples) {
      boneDataMap.set(bone.humanBodyBone, bone.localRotationSamples);
    }
  }

  // Get VRM bone nodes and rest-pose info for IK
  const hipsNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
  const leftUpperLegNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperLeg);
  const leftLowerLegNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerLeg);
  const leftFootNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftFoot);
  const rightUpperLegNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperLeg);
  const rightLowerLegNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerLeg);
  const rightFootNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightFoot);

  if (!hipsNode || !leftUpperLegNode || !leftLowerLegNode || !leftFootNode ||
      !rightUpperLegNode || !rightLowerLegNode || !rightFootNode) {
    return null;
  }

  // Rest-pose local positions (offsets from parent)
  const leftUpperLegLocalPos = leftUpperLegNode.position.clone();
  const rightUpperLegLocalPos = rightUpperLegNode.position.clone();

  // Get hips rotation samples for computing hip joint world positions per frame
  const hipsRotSamples = boneDataMap.get("Hips");

  // Get exported leg rotation samples for FK chain computation
  const leftUpperLegSamples = boneDataMap.get("LeftUpperLeg");
  const leftLowerLegSamples = boneDataMap.get("LeftLowerLeg");
  const leftFootSamples = boneDataMap.get("LeftFoot");
  const rightUpperLegSamples = boneDataMap.get("RightUpperLeg");
  const rightLowerLegSamples = boneDataMap.get("RightLowerLeg");
  const rightFootSamples = boneDataMap.get("RightFoot");

  // CENTRAL AXIS APPROACH:
  // The world vertical axis (Y=0 = floor) is the fixed reference.
  // All exported rotations are applied AS-IS (preserving natural animation).
  // We compute hips Y per-frame via forward kinematics so that the lowest
  // foot in the chain lands exactly at Y=0.
  //
  // For each frame:
  //   1. Apply all exported rotations (hips, upper leg, lower leg, foot)
  //   2. Compute foot world Y relative to hips (FK down the chain)
  //   3. Set hips Y = -footRelativeY (so foot world Y = 0)

  const hipsPositions = new Float32Array(frameCount * 3);

  const _hipsQuat = new THREE.Quaternion();
  const _upperLegQuat = new THREE.Quaternion();
  const _lowerLegQuat = new THREE.Quaternion();
  const _footQuat = new THREE.Quaternion();
  const _chainWorldQuat = new THREE.Quaternion();
  const _vec = new THREE.Vector3();

  // Local positions of child bones (offsets from parent in rest pose)
  const leftLowerLegLocalPos = leftLowerLegNode.position.clone(); // upper leg → lower leg
  const leftFootLocalPos = leftFootNode.position.clone();         // lower leg → foot
  const rightLowerLegLocalPos = rightLowerLegNode.position.clone();
  const rightFootLocalPos = rightFootNode.position.clone();

  for (let i = 0; i < frameCount; i++) {
    // Hips rotation for this frame (Unity→THREE.js conversion)
    if (hipsRotSamples) {
      _hipsQuat.set(
        -hipsRotSamples.x[i], -hipsRotSamples.y[i],
        hipsRotSamples.z[i], hipsRotSamples.w[i]
      );
    } else {
      _hipsQuat.identity();
    }

    // --- LEFT leg FK: compute foot Y relative to hips position ---
    if (leftUpperLegSamples) {
      _upperLegQuat.set(
        -leftUpperLegSamples.x[i], -leftUpperLegSamples.y[i],
        leftUpperLegSamples.z[i], leftUpperLegSamples.w[i]
      );
    } else {
      _upperLegQuat.identity();
    }
    if (leftLowerLegSamples) {
      _lowerLegQuat.set(
        -leftLowerLegSamples.x[i], -leftLowerLegSamples.y[i],
        leftLowerLegSamples.z[i], leftLowerLegSamples.w[i]
      );
    } else {
      _lowerLegQuat.identity();
    }

    // FK chain: hips → upperLeg → lowerLeg → foot
    // upperLeg world pos = hipsPos + hipsQuat * upperLegLocalPos
    // lowerLeg world pos = upperLeg world pos + (hipsQuat * upperLegQuat) * lowerLegLocalPos
    // foot world pos = lowerLeg world pos + (hipsQuat * upperLegQuat * lowerLegQuat) * footLocalPos
    // We only need the Y component relative to hips (set hipsY = 0 for computation)

    let leftFootY = 0;
    // Step 1: hips → upper leg joint
    _vec.copy(leftUpperLegLocalPos).applyQuaternion(_hipsQuat);
    leftFootY += _vec.y;
    // Step 2: upper leg → lower leg (knee)
    _chainWorldQuat.copy(_hipsQuat).multiply(_upperLegQuat);
    _vec.copy(leftLowerLegLocalPos).applyQuaternion(_chainWorldQuat);
    leftFootY += _vec.y;
    // Step 3: lower leg → foot
    _chainWorldQuat.multiply(_lowerLegQuat);
    _vec.copy(leftFootLocalPos).applyQuaternion(_chainWorldQuat);
    leftFootY += _vec.y;

    // --- RIGHT leg FK: compute foot Y relative to hips position ---
    if (rightUpperLegSamples) {
      _upperLegQuat.set(
        -rightUpperLegSamples.x[i], -rightUpperLegSamples.y[i],
        rightUpperLegSamples.z[i], rightUpperLegSamples.w[i]
      );
    } else {
      _upperLegQuat.identity();
    }
    if (rightLowerLegSamples) {
      _lowerLegQuat.set(
        -rightLowerLegSamples.x[i], -rightLowerLegSamples.y[i],
        rightLowerLegSamples.z[i], rightLowerLegSamples.w[i]
      );
    } else {
      _lowerLegQuat.identity();
    }

    let rightFootY = 0;
    _vec.copy(rightUpperLegLocalPos).applyQuaternion(_hipsQuat);
    rightFootY += _vec.y;
    _chainWorldQuat.copy(_hipsQuat).multiply(_upperLegQuat);
    _vec.copy(rightLowerLegLocalPos).applyQuaternion(_chainWorldQuat);
    rightFootY += _vec.y;
    _chainWorldQuat.multiply(_lowerLegQuat);
    _vec.copy(rightFootLocalPos).applyQuaternion(_chainWorldQuat);
    rightFootY += _vec.y;

    // The lowest foot determines hips height.
    // footWorldY = hipsY + footRelativeY = 0  →  hipsY = -footRelativeY
    const lowestFootY = Math.min(leftFootY, rightFootY);
    const requiredHipsY = -lowestFootY;

    // Store hips position (rest XZ, computed Y)
    hipsPositions[i * 3] = hipsNode.position.x;
    hipsPositions[i * 3 + 1] = requiredHipsY;
    hipsPositions[i * 3 + 2] = hipsNode.position.z;
  }

  // Build tracks: ALL bones use exported rotation data (no IK replacement)
  for (const bone of comparison.bones) {
    const humanBodyBone = bone.humanBodyBone ?? null;
    const vrmBoneName = humanBodyBone ? BONE_NAME_MAP[humanBodyBone] : undefined;
    const samples = bone.localRotationSamples;

    if (!vrmBoneName || !samples) continue;
    if (
      samples.x.length !== frameCount ||
      samples.y.length !== frameCount ||
      samples.z.length !== frameCount ||
      samples.w.length !== frameCount
    ) continue;

    const boneNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
    if (!boneNode) continue;

    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${boneNode.name}.quaternion`,
        timesS,
        interleaveQuaternionSamples(samples)
      )
    );
  }

  // Add hips position track (derived from FK so lowest foot sits at Y=0)
  if (hipsNode) {
    tracks.push(new THREE.VectorKeyframeTrack(
      `${hipsNode.name}.position`, timesS, Array.from(hipsPositions)
    ));
  }

  console.log(`[feetAnchoredPlayback] ${tracks.length} tracks (central axis: FK rotations + derived hips Y)`);

  if (tracks.length === 0) {
    return null;
  }

  const duration = timesS[timesS.length - 1] ?? payload.durationMs / 1000;
  const clip = new THREE.AnimationClip(`feetAnchored:${payload.semanticId}`, duration, tracks);
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const action = mixer.clipAction(clip);

  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  // Procedural overlay nodes
  const motionProfile = payload.motionProfile;
  const spineNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine);
  const chestNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Chest);
  const upperChestNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
  const headNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
  const overlayQuat = new THREE.Quaternion();

  const LEAN_PERIOD = 11.0;
  const YAW_PERIOD = 13.7;
  const NOD_PERIOD = 8.333;

  let lastAppliedTime = 0;

  return {
    apply(elapsedSeconds: number): void {
      const delta = elapsedSeconds - lastAppliedTime;
      lastAppliedTime = elapsedSeconds;

      if (delta > 0 && delta < 1) {
        mixer.update(delta);
      } else {
        mixer.setTime(elapsedSeconds % duration);
      }

      // Procedural lean/yaw/nod overlay (upper body only — does not affect legs)
      if (motionProfile) {
        const leanAngle = Math.sin(elapsedSeconds * (2 * Math.PI / LEAN_PERIOD)) * motionProfile.leanAmplitude;
        const yawAngle = Math.sin(elapsedSeconds * (2 * Math.PI / YAW_PERIOD)) * motionProfile.yawAmplitude;
        const nodAngle = Math.sin(elapsedSeconds * (2 * Math.PI / NOD_PERIOD) + 0.5) * motionProfile.nodAmplitude;

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


