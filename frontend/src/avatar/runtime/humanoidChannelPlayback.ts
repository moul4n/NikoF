import { VRMHumanBoneName } from "@pixiv/three-vrm";

type HumanoidAxis = "x" | "y" | "z";
type VRMHumanBoneNameValue = (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName];

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

export interface HumanoidChannelPlaybackDebugBonePose {
  boneName: VRMHumanBoneNameValue;
  source: "channel_delta" | "quaternion";
  contributingChannels: string[];
  rotation: [number, number, number, number];
  eulerXYZ: [number, number, number];
}

export interface HumanoidChannelPlaybackDebugPoseSnapshot {
  elapsedSeconds: number;
  sampleTimeSeconds: number;
  sampleIndex: number;
  rotationSpace:
    | "vrm_normalized_pose_delta"
    | "vrm_normalized_bone_mixer_local_rotation"
    | "vrm_rendered_normalized_bone_local_rotation"
    | "vrm_rendered_raw_bone_local_rotation";
  boundChannels: HumanoidChannelPlaybackDebugBinding[];
  quaternionBoundChannels: HumanoidChannelPlaybackDebugQuaternionBinding[];
  targetedBones: VRMHumanBoneNameValue[];
  bonePoses: HumanoidChannelPlaybackDebugBonePose[];
  keyBonePoses: HumanoidChannelPlaybackDebugBonePose[];
}

export interface HumanoidChannelPlaybackDebugSnapshot {
  boundChannels: HumanoidChannelPlaybackDebugBinding[];
  quaternionBoundChannels: HumanoidChannelPlaybackDebugQuaternionBinding[];
  targetedBones: VRMHumanBoneNameValue[];
}

export interface HumanoidChannelPlayback {
  apply: (elapsedSeconds: number) => void;
  getDebugSnapshot: () => HumanoidChannelPlaybackDebugSnapshot;
  getPoseSnapshot: (elapsedSeconds: number) => HumanoidChannelPlaybackDebugPoseSnapshot;
  getRenderedPoseSnapshot: (elapsedSeconds: number) => HumanoidChannelPlaybackDebugPoseSnapshot;
  reset: () => void;
}
