import * as THREE from "three";
import { VRMHumanBoneName, type VRM } from "@pixiv/three-vrm";
import type { SemanticAnimationRuntimeChannel, SemanticAnimationRuntimePayload } from "../../shared/types/animation";

type HumanoidAxis = "x" | "y" | "z";
type VRMHumanBoneNameValue = (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName];

interface HumanoidChannelBindingDefinition {
  normalizedName: string;
  boneName: VRMHumanBoneNameValue;
  axis: HumanoidAxis;
  scale: number;
  inputOffset?: number;
}

interface HumanoidPoseTransform {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
}

type HumanoidPose = Partial<Record<VRMHumanBoneNameValue, HumanoidPoseTransform>>;

interface HumanoidBoneBindingState {
  boneName: VRMHumanBoneNameValue;
  deltaRotation: THREE.Vector3;
}

interface HumanoidQuaternionBindingDefinition {
  normalizedNamePrefix: string;
  boneName: VRMHumanBoneNameValue;
}

type HumanoidClipBindingScaleOverrides = Readonly<Record<string, Readonly<Record<string, number>>>>;

function createFingerStretchBindings(
  channelPrefix: string,
  boneNames: readonly [VRMHumanBoneNameValue, VRMHumanBoneNameValue, VRMHumanBoneNameValue],
  scale = 0.2
): HumanoidChannelBindingDefinition[] {
  return boneNames.map((boneName, index) => ({
    normalizedName: `${channelPrefix}_${index + 1}.stretched`,
    boneName,
    axis: "x",
    scale
  }));
}

function createFingerSpreadBindings(
  channelPrefix: string,
  boneName: VRMHumanBoneNameValue,
  scale: number
): HumanoidChannelBindingDefinition[] {
  return [
    {
      normalizedName: `${channelPrefix}_spread`,
      boneName,
      axis: "z",
      scale
    }
  ];
}

interface BoundHumanoidQuaternionChannel {
  boneName: VRMHumanBoneNameValue;
  xChannel: SemanticAnimationRuntimeChannel;
  yChannel: SemanticAnimationRuntimeChannel;
  zChannel: SemanticAnimationRuntimeChannel;
  wChannel: SemanticAnimationRuntimeChannel;
  sampledRotation: [number, number, number, number] | null;
}

interface BoundHumanoidChannel {
  channel: SemanticAnimationRuntimeChannel;
  boneState: HumanoidBoneBindingState;
  axis: HumanoidAxis;
  scale: number;
  inputOffset: number;
  sampledDelta: number | null;
}

export interface HumanoidChannelPlaybackDebugBinding {
  channelName: string;
  normalizedName: string;
  boneName: VRMHumanBoneNameValue;
  axis: HumanoidAxis;
  scale: number;
  sampledDelta: number | null;
}

export interface HumanoidChannelPlaybackDebugQuaternionBinding {
  normalizedNamePrefix: string;
  boneName: VRMHumanBoneNameValue;
  sampledRotation: [number, number, number, number] | null;
}

export interface HumanoidChannelPlaybackDebugSnapshot {
  boundChannels: HumanoidChannelPlaybackDebugBinding[];
  quaternionBoundChannels: HumanoidChannelPlaybackDebugQuaternionBinding[];
  targetedBones: VRMHumanBoneNameValue[];
}

export interface HumanoidChannelPlayback {
  apply: (elapsedSeconds: number) => void;
  getDebugSnapshot: () => HumanoidChannelPlaybackDebugSnapshot;
  reset: () => void;
}

const HUMANOID_CLIP_BINDING_SCALE_OVERRIDES: HumanoidClipBindingScaleOverrides = {
  "gesture.punch.once": {
    "left.shoulder.front_back": 1,
    "right.shoulder.front_back": 1,
    "left.arm.down_up": 1.08,
    "right.arm.down_up": 0.68,
    "left.arm.front_back": 2,
    "right.arm.front_back": 2,
    "left.hand.down_up": 1.15,
    "right.hand.down_up": 1.15,
    "left.hand.in_out": 1.1,
    "right.hand.in_out": 1.1
  }
};

function resolveBindingScale(
  semanticId: string | undefined,
  normalizedName: string,
  defaultScale: number
): number {
  if (!semanticId) {
    return defaultScale;
  }

  const clipScaleOverrides = HUMANOID_CLIP_BINDING_SCALE_OVERRIDES[semanticId];

  if (!clipScaleOverrides) {
    return defaultScale;
  }

  return defaultScale * (clipScaleOverrides[normalizedName] ?? 1);
}

const HUMANOID_CHANNEL_BINDINGS: readonly HumanoidChannelBindingDefinition[] = [
  { normalizedName: "spine.front_back", boneName: VRMHumanBoneName.Spine, axis: "x", scale: 1 },
  { normalizedName: "spine.left_right", boneName: VRMHumanBoneName.Spine, axis: "z", scale: -1 },
  { normalizedName: "spine.twist.left_right", boneName: VRMHumanBoneName.Spine, axis: "y", scale: 1 },
  { normalizedName: "chest.front_back", boneName: VRMHumanBoneName.Chest, axis: "x", scale: 1 },
  { normalizedName: "chest.left_right", boneName: VRMHumanBoneName.Chest, axis: "z", scale: -1 },
  { normalizedName: "chest.twist.left_right", boneName: VRMHumanBoneName.Chest, axis: "y", scale: 1 },
  { normalizedName: "upperchest.front_back", boneName: VRMHumanBoneName.UpperChest, axis: "x", scale: 1 },
  { normalizedName: "upperchest.left_right", boneName: VRMHumanBoneName.UpperChest, axis: "z", scale: -1 },
  { normalizedName: "upperchest.twist.left_right", boneName: VRMHumanBoneName.UpperChest, axis: "y", scale: 1 },
  { normalizedName: "neck.nod.down_up", boneName: VRMHumanBoneName.Neck, axis: "x", scale: 1.35 },
  { normalizedName: "neck.tilt.left_right", boneName: VRMHumanBoneName.Neck, axis: "z", scale: -1.2 },
  { normalizedName: "neck.turn.left_right", boneName: VRMHumanBoneName.Neck, axis: "y", scale: 1.2 },
  { normalizedName: "head.nod.down_up", boneName: VRMHumanBoneName.Head, axis: "x", scale: 1.4 },
  { normalizedName: "head.tilt.left_right", boneName: VRMHumanBoneName.Head, axis: "z", scale: -1.25 },
  { normalizedName: "head.turn.left_right", boneName: VRMHumanBoneName.Head, axis: "y", scale: 1.2 },
  { normalizedName: "left.shoulder.down_up", boneName: VRMHumanBoneName.LeftShoulder, axis: "z", scale: 0.3 },
  { normalizedName: "left.shoulder.front_back", boneName: VRMHumanBoneName.LeftShoulder, axis: "x", scale: 0.18 },
  { normalizedName: "left.upper.leg.front_back", boneName: VRMHumanBoneName.LeftUpperLeg, axis: "x", scale: 1 },
  { normalizedName: "left.upper.leg.in_out", boneName: VRMHumanBoneName.LeftUpperLeg, axis: "z", scale: -1 },
  { normalizedName: "left.upper.leg.twist.in_out", boneName: VRMHumanBoneName.LeftUpperLeg, axis: "y", scale: 0.8 },
  { normalizedName: "left.lower.leg.twist.in_out", boneName: VRMHumanBoneName.LeftLowerLeg, axis: "y", scale: 0.4 },
  { normalizedName: "left.foot.up_down", boneName: VRMHumanBoneName.LeftFoot, axis: "x", scale: 1 },
  { normalizedName: "left.foot.twist.in_out", boneName: VRMHumanBoneName.LeftFoot, axis: "y", scale: 0.75 },
  { normalizedName: "left.toes.up_down", boneName: VRMHumanBoneName.LeftToes, axis: "x", scale: 25 },
  { normalizedName: "left.arm.twist.in_out", boneName: VRMHumanBoneName.LeftUpperArm, axis: "y", scale: 0.75 },
  { normalizedName: "left.elbow.flex", boneName: VRMHumanBoneName.LeftLowerArm, axis: "x", scale: 0.9 },
  { normalizedName: "left.forearm.twist.in_out", boneName: VRMHumanBoneName.LeftLowerArm, axis: "y", scale: 0.2 },
  { normalizedName: "left.hand.down_up", boneName: VRMHumanBoneName.LeftHand, axis: "x", scale: 1 },
  { normalizedName: "left.hand.in_out", boneName: VRMHumanBoneName.LeftHand, axis: "z", scale: -1 },
  ...createFingerStretchBindings("lefthand_thumb", [
    VRMHumanBoneName.LeftThumbMetacarpal,
    VRMHumanBoneName.LeftThumbProximal,
    VRMHumanBoneName.LeftThumbDistal
  ]),
  ...createFingerStretchBindings("lefthand_index", [
    VRMHumanBoneName.LeftIndexProximal,
    VRMHumanBoneName.LeftIndexIntermediate,
    VRMHumanBoneName.LeftIndexDistal
  ]),
  ...createFingerStretchBindings("lefthand_middle", [
    VRMHumanBoneName.LeftMiddleProximal,
    VRMHumanBoneName.LeftMiddleIntermediate,
    VRMHumanBoneName.LeftMiddleDistal
  ]),
  ...createFingerStretchBindings("lefthand_ring", [
    VRMHumanBoneName.LeftRingProximal,
    VRMHumanBoneName.LeftRingIntermediate,
    VRMHumanBoneName.LeftRingDistal
  ]),
  ...createFingerStretchBindings("lefthand_little", [
    VRMHumanBoneName.LeftLittleProximal,
    VRMHumanBoneName.LeftLittleIntermediate,
    VRMHumanBoneName.LeftLittleDistal
  ]),
  ...createFingerSpreadBindings("lefthand_thumb", VRMHumanBoneName.LeftThumbMetacarpal, -0.15),
  ...createFingerSpreadBindings("lefthand_index", VRMHumanBoneName.LeftIndexProximal, -0.15),
  ...createFingerSpreadBindings("lefthand_middle", VRMHumanBoneName.LeftMiddleProximal, -0.15),
  ...createFingerSpreadBindings("lefthand_ring", VRMHumanBoneName.LeftRingProximal, -0.15),
  ...createFingerSpreadBindings("lefthand_little", VRMHumanBoneName.LeftLittleProximal, -0.15),
  { normalizedName: "right.shoulder.down_up", boneName: VRMHumanBoneName.RightShoulder, axis: "z", scale: -0.3 },
  { normalizedName: "right.shoulder.front_back", boneName: VRMHumanBoneName.RightShoulder, axis: "x", scale: 0.18 },
  { normalizedName: "right.upper.leg.front_back", boneName: VRMHumanBoneName.RightUpperLeg, axis: "x", scale: 1 },
  { normalizedName: "right.upper.leg.in_out", boneName: VRMHumanBoneName.RightUpperLeg, axis: "z", scale: 1 },
  { normalizedName: "right.upper.leg.twist.in_out", boneName: VRMHumanBoneName.RightUpperLeg, axis: "y", scale: -0.8 },
  { normalizedName: "right.lower.leg.twist.in_out", boneName: VRMHumanBoneName.RightLowerLeg, axis: "y", scale: -0.4 },
  { normalizedName: "right.foot.up_down", boneName: VRMHumanBoneName.RightFoot, axis: "x", scale: 1 },
  { normalizedName: "right.foot.twist.in_out", boneName: VRMHumanBoneName.RightFoot, axis: "y", scale: -0.75 },
  { normalizedName: "right.toes.up_down", boneName: VRMHumanBoneName.RightToes, axis: "x", scale: 25 },
  { normalizedName: "right.arm.twist.in_out", boneName: VRMHumanBoneName.RightUpperArm, axis: "y", scale: -0.75 },
  { normalizedName: "right.elbow.flex", boneName: VRMHumanBoneName.RightLowerArm, axis: "x", scale: 0.9 },
  { normalizedName: "right.forearm.twist.in_out", boneName: VRMHumanBoneName.RightLowerArm, axis: "y", scale: -0.2 },
  { normalizedName: "right.hand.down_up", boneName: VRMHumanBoneName.RightHand, axis: "x", scale: 1 },
  { normalizedName: "right.hand.in_out", boneName: VRMHumanBoneName.RightHand, axis: "z", scale: 1 },
  ...createFingerStretchBindings("righthand_thumb", [
    VRMHumanBoneName.RightThumbMetacarpal,
    VRMHumanBoneName.RightThumbProximal,
    VRMHumanBoneName.RightThumbDistal
  ]),
  ...createFingerStretchBindings("righthand_index", [
    VRMHumanBoneName.RightIndexProximal,
    VRMHumanBoneName.RightIndexIntermediate,
    VRMHumanBoneName.RightIndexDistal
  ]),
  ...createFingerStretchBindings("righthand_middle", [
    VRMHumanBoneName.RightMiddleProximal,
    VRMHumanBoneName.RightMiddleIntermediate,
    VRMHumanBoneName.RightMiddleDistal
  ]),
  ...createFingerStretchBindings("righthand_ring", [
    VRMHumanBoneName.RightRingProximal,
    VRMHumanBoneName.RightRingIntermediate,
    VRMHumanBoneName.RightRingDistal
  ]),
  ...createFingerStretchBindings("righthand_little", [
    VRMHumanBoneName.RightLittleProximal,
    VRMHumanBoneName.RightLittleIntermediate,
    VRMHumanBoneName.RightLittleDistal
  ]),
  ...createFingerSpreadBindings("righthand_thumb", VRMHumanBoneName.RightThumbMetacarpal, 0.15),
  ...createFingerSpreadBindings("righthand_index", VRMHumanBoneName.RightIndexProximal, 0.15),
  ...createFingerSpreadBindings("righthand_middle", VRMHumanBoneName.RightMiddleProximal, 0.15),
  ...createFingerSpreadBindings("righthand_ring", VRMHumanBoneName.RightRingProximal, 0.15),
  ...createFingerSpreadBindings("righthand_little", VRMHumanBoneName.RightLittleProximal, 0.15),
  { normalizedName: "left.arm.down_up", boneName: VRMHumanBoneName.LeftUpperArm, axis: "z", scale: -1.35 },
  { normalizedName: "left.arm.front_back", boneName: VRMHumanBoneName.LeftUpperArm, axis: "x", scale: 1 },
  { normalizedName: "right.arm.down_up", boneName: VRMHumanBoneName.RightUpperArm, axis: "z", scale: 1.35 },
  { normalizedName: "right.arm.front_back", boneName: VRMHumanBoneName.RightUpperArm, axis: "x", scale: 1 }
];

const HUMANOID_QUATERNION_BINDINGS: readonly HumanoidQuaternionBindingDefinition[] = [
  { normalizedNamePrefix: "left.lower_arm.rotation", boneName: VRMHumanBoneName.LeftLowerArm },
  { normalizedNamePrefix: "right.lower_arm.rotation", boneName: VRMHumanBoneName.RightLowerArm }
];

function cloneHumanoidPose(pose: HumanoidPose): HumanoidPose {
  const clonedPose: HumanoidPose = {};

  for (const [boneName, transform] of Object.entries(pose) as Array<[VRMHumanBoneNameValue, HumanoidPoseTransform]>) {
    clonedPose[boneName] = {
      position: transform.position ? [...transform.position] as [number, number, number] : undefined,
      rotation: transform.rotation ? [...transform.rotation] as [number, number, number, number] : undefined
    };
  }

  return clonedPose;
}

function sampleChannelValue(channel: SemanticAnimationRuntimeChannel, timesS: number[], elapsedSeconds: number): number | null {
  const sampleCount = Math.min(channel.samples.length, timesS.length);

  if (sampleCount === 0) {
    return null;
  }

  if (sampleCount === 1 || elapsedSeconds <= timesS[0]) {
    return channel.samples[0] ?? null;
  }

  const lastIndex = sampleCount - 1;

  if (elapsedSeconds >= timesS[lastIndex]) {
    return channel.samples[lastIndex] ?? null;
  }

  for (let upperIndex = 1; upperIndex < sampleCount; upperIndex += 1) {
    const upperTime = timesS[upperIndex];

    if (upperTime < elapsedSeconds) {
      continue;
    }

    const lowerIndex = upperIndex - 1;
    const lowerTime = timesS[lowerIndex];
    const lowerSample = channel.samples[lowerIndex];
    const upperSample = channel.samples[upperIndex];

    if (!Number.isFinite(lowerSample) || !Number.isFinite(upperSample)) {
      return null;
    }

    if (upperTime <= lowerTime) {
      return upperSample;
    }

    const progress = (elapsedSeconds - lowerTime) / (upperTime - lowerTime);
    return THREE.MathUtils.lerp(lowerSample, upperSample, progress);
  }

  return channel.samples[lastIndex] ?? null;
}

export function createHumanoidChannelPlayback(
  vrm: VRM | null,
  payload: SemanticAnimationRuntimePayload
): HumanoidChannelPlayback | null {
  const timesS = payload.sampling?.timesS;
  const channels = payload.channels;

  if (!vrm?.humanoid || !timesS || timesS.length === 0 || !channels || channels.length === 0) {
    return null;
  }

  if (payload.channelSpace !== "unity_humanoid_muscle") {
    return null;
  }

  const channelMap = new Map(channels.map((channel) => [channel.normalizedName, channel]));
  const baselinePose = cloneHumanoidPose(vrm.humanoid.getNormalizedPose());
  const appliedPose = cloneHumanoidPose(baselinePose);
  const boneStates = new Map<VRMHumanBoneNameValue, HumanoidBoneBindingState>();
  const boundChannels: BoundHumanoidChannel[] = [];
  const boundQuaternionChannels: BoundHumanoidQuaternionChannel[] = [];
  const quaternionBoundBones = new Set<VRMHumanBoneNameValue>();

  for (const binding of HUMANOID_QUATERNION_BINDINGS) {
    const xChannel = channelMap.get(`${binding.normalizedNamePrefix}.x`);
    const yChannel = channelMap.get(`${binding.normalizedNamePrefix}.y`);
    const zChannel = channelMap.get(`${binding.normalizedNamePrefix}.z`);
    const wChannel = channelMap.get(`${binding.normalizedNamePrefix}.w`);

    if (!xChannel || !yChannel || !zChannel || !wChannel) {
      continue;
    }

    const boneNode = vrm.humanoid.getNormalizedBoneNode(binding.boneName);

    if (!boneNode) {
      continue;
    }

    boundQuaternionChannels.push({
      boneName: binding.boneName,
      xChannel,
      yChannel,
      zChannel,
      wChannel,
      sampledRotation: null
    });
    quaternionBoundBones.add(binding.boneName);
  }

  for (const binding of HUMANOID_CHANNEL_BINDINGS) {
    if (quaternionBoundBones.has(binding.boneName)) {
      continue;
    }

    const channel = channelMap.get(binding.normalizedName);

    if (!channel) {
      continue;
    }

    let boneState = boneStates.get(binding.boneName);

    if (!boneState) {
      const boneNode = vrm.humanoid.getNormalizedBoneNode(binding.boneName);

      if (!boneNode) {
        continue;
      }

      boneState = {
        boneName: binding.boneName,
        deltaRotation: new THREE.Vector3()
      };
      boneStates.set(binding.boneName, boneState);
    }

    boundChannels.push({
      channel,
      boneState,
      axis: binding.axis,
      scale: resolveBindingScale(payload.semanticId, binding.normalizedName, binding.scale),
      inputOffset: binding.inputOffset ?? 0,
      sampledDelta: null
    });
  }

  if (boundChannels.length === 0 && boundQuaternionChannels.length === 0) {
    return null;
  }

  const deltaEuler = new THREE.Euler(0, 0, 0, "XYZ");
  const deltaQuaternion = new THREE.Quaternion();
  return {
    apply(elapsedSeconds: number): void {
      boneStates.forEach((boneState) => {
        boneState.deltaRotation.set(0, 0, 0);
      });

      boundChannels.forEach((binding) => {
        const sampledValue = sampleChannelValue(binding.channel, timesS, elapsedSeconds);
        binding.sampledDelta = sampledValue;

        if (sampledValue === null) {
          return;
        }

        binding.boneState.deltaRotation[binding.axis] += (sampledValue + binding.inputOffset) * binding.scale;
      });

      boneStates.forEach((boneState) => {
        deltaEuler.set(boneState.deltaRotation.x, boneState.deltaRotation.y, boneState.deltaRotation.z, "XYZ");
        deltaQuaternion.setFromEuler(deltaEuler);

        const poseTransform = appliedPose[boneState.boneName] ?? {};
        poseTransform.rotation = [deltaQuaternion.x, deltaQuaternion.y, deltaQuaternion.z, deltaQuaternion.w];
        appliedPose[boneState.boneName] = poseTransform;
      });

      boundQuaternionChannels.forEach((binding) => {
        const sampledX = sampleChannelValue(binding.xChannel, timesS, elapsedSeconds);
        const sampledY = sampleChannelValue(binding.yChannel, timesS, elapsedSeconds);
        const sampledZ = sampleChannelValue(binding.zChannel, timesS, elapsedSeconds);
        const sampledW = sampleChannelValue(binding.wChannel, timesS, elapsedSeconds);
        const poseTransform = appliedPose[binding.boneName] ?? {};

        if (
          sampledX === null ||
          sampledY === null ||
          sampledZ === null ||
          sampledW === null ||
          !Number.isFinite(sampledX) ||
          !Number.isFinite(sampledY) ||
          !Number.isFinite(sampledZ) ||
          !Number.isFinite(sampledW)
        ) {
          binding.sampledRotation = null;
          poseTransform.rotation = [0, 0, 0, 1];
          appliedPose[binding.boneName] = poseTransform;
          return;
        }

        deltaQuaternion.set(sampledX, sampledY, sampledZ, sampledW).normalize();
        binding.sampledRotation = [deltaQuaternion.x, deltaQuaternion.y, deltaQuaternion.z, deltaQuaternion.w];
        poseTransform.rotation = binding.sampledRotation;
        appliedPose[binding.boneName] = poseTransform;
      });

      vrm.humanoid.setNormalizedPose(appliedPose);
      vrm.humanoid.update();
    },

    getDebugSnapshot(): HumanoidChannelPlaybackDebugSnapshot {
      return {
        boundChannels: boundChannels.map((binding) => ({
          channelName: binding.channel.name,
          normalizedName: binding.channel.normalizedName,
          boneName: binding.boneState.boneName,
          axis: binding.axis,
          scale: binding.scale,
          sampledDelta: binding.sampledDelta
        })),
        quaternionBoundChannels: boundQuaternionChannels.map((binding) => ({
          normalizedNamePrefix: binding.xChannel.normalizedName.replace(/\.x$/, ""),
          boneName: binding.boneName,
          sampledRotation: binding.sampledRotation
        })),
        targetedBones: Array.from(new Set([...boneStates.keys(), ...boundQuaternionChannels.map((binding) => binding.boneName)]))
      };
    },

    reset(): void {
      boundChannels.forEach((binding) => {
        binding.sampledDelta = null;
      });

      boundQuaternionChannels.forEach((binding) => {
        binding.sampledRotation = null;
      });

      vrm.humanoid.setNormalizedPose(baselinePose);
      vrm.humanoid.update();
    }
  };
}