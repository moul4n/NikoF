import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { VRMHumanBoneName, type VRM } from "@pixiv/three-vrm";

type VRMHumanBoneNameValue = (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName];

export interface OfficialMixamoClipHandle {
  clipId: string;
  clip: THREE.AnimationClip;
  action: THREE.AnimationAction;
}

export interface OfficialMixamoPlaybackDebugSnapshot {
  mixerTimeSeconds: number;
  activeClipCount: number;
  clips: Array<{
    clipId: string;
    clipDurationSeconds: number;
    actionTimeSeconds: number;
    effectiveWeight: number;
    effectiveTimeScale: number;
    enabled: boolean;
    paused: boolean;
    running: boolean;
    loopMode: "once" | "repeat" | "pingpong" | "unknown";
    repetitions: number;
  }>;
}

export interface OfficialMixamoPlaybackBridge {
  loadClip(url: string, clipId: string): Promise<OfficialMixamoClipHandle>;
  play(clipId: string, options?: { loop?: boolean }): void;
  stop(clipId: string): void;
  stopAll(): void;
  update(deltaSeconds: number): void;
  getDebugSnapshot(): OfficialMixamoPlaybackDebugSnapshot;
  dispose(): void;
}

const MIXAMO_VRM_RIG_MAP: Record<string, VRMHumanBoneNameValue> = {
  mixamorigHips: VRMHumanBoneName.Hips,
  mixamorigSpine: VRMHumanBoneName.Spine,
  mixamorigSpine1: VRMHumanBoneName.Chest,
  mixamorigSpine2: VRMHumanBoneName.UpperChest,
  mixamorigNeck: VRMHumanBoneName.Neck,
  mixamorigHead: VRMHumanBoneName.Head,
  mixamorigLeftShoulder: VRMHumanBoneName.LeftShoulder,
  mixamorigLeftArm: VRMHumanBoneName.LeftUpperArm,
  mixamorigLeftForeArm: VRMHumanBoneName.LeftLowerArm,
  mixamorigLeftHand: VRMHumanBoneName.LeftHand,
  mixamorigLeftHandThumb1: VRMHumanBoneName.LeftThumbMetacarpal,
  mixamorigLeftHandThumb2: VRMHumanBoneName.LeftThumbProximal,
  mixamorigLeftHandThumb3: VRMHumanBoneName.LeftThumbDistal,
  mixamorigLeftHandIndex1: VRMHumanBoneName.LeftIndexProximal,
  mixamorigLeftHandIndex2: VRMHumanBoneName.LeftIndexIntermediate,
  mixamorigLeftHandIndex3: VRMHumanBoneName.LeftIndexDistal,
  mixamorigLeftHandMiddle1: VRMHumanBoneName.LeftMiddleProximal,
  mixamorigLeftHandMiddle2: VRMHumanBoneName.LeftMiddleIntermediate,
  mixamorigLeftHandMiddle3: VRMHumanBoneName.LeftMiddleDistal,
  mixamorigLeftHandRing1: VRMHumanBoneName.LeftRingProximal,
  mixamorigLeftHandRing2: VRMHumanBoneName.LeftRingIntermediate,
  mixamorigLeftHandRing3: VRMHumanBoneName.LeftRingDistal,
  mixamorigLeftHandPinky1: VRMHumanBoneName.LeftLittleProximal,
  mixamorigLeftHandPinky2: VRMHumanBoneName.LeftLittleIntermediate,
  mixamorigLeftHandPinky3: VRMHumanBoneName.LeftLittleDistal,
  mixamorigRightShoulder: VRMHumanBoneName.RightShoulder,
  mixamorigRightArm: VRMHumanBoneName.RightUpperArm,
  mixamorigRightForeArm: VRMHumanBoneName.RightLowerArm,
  mixamorigRightHand: VRMHumanBoneName.RightHand,
  mixamorigRightHandPinky1: VRMHumanBoneName.RightLittleProximal,
  mixamorigRightHandPinky2: VRMHumanBoneName.RightLittleIntermediate,
  mixamorigRightHandPinky3: VRMHumanBoneName.RightLittleDistal,
  mixamorigRightHandRing1: VRMHumanBoneName.RightRingProximal,
  mixamorigRightHandRing2: VRMHumanBoneName.RightRingIntermediate,
  mixamorigRightHandRing3: VRMHumanBoneName.RightRingDistal,
  mixamorigRightHandMiddle1: VRMHumanBoneName.RightMiddleProximal,
  mixamorigRightHandMiddle2: VRMHumanBoneName.RightMiddleIntermediate,
  mixamorigRightHandMiddle3: VRMHumanBoneName.RightMiddleDistal,
  mixamorigRightHandIndex1: VRMHumanBoneName.RightIndexProximal,
  mixamorigRightHandIndex2: VRMHumanBoneName.RightIndexIntermediate,
  mixamorigRightHandIndex3: VRMHumanBoneName.RightIndexDistal,
  mixamorigRightHandThumb1: VRMHumanBoneName.RightThumbMetacarpal,
  mixamorigRightHandThumb2: VRMHumanBoneName.RightThumbProximal,
  mixamorigRightHandThumb3: VRMHumanBoneName.RightThumbDistal,
  mixamorigLeftUpLeg: VRMHumanBoneName.LeftUpperLeg,
  mixamorigLeftLeg: VRMHumanBoneName.LeftLowerLeg,
  mixamorigLeftFoot: VRMHumanBoneName.LeftFoot,
  mixamorigLeftToeBase: VRMHumanBoneName.LeftToes,
  mixamorigRightUpLeg: VRMHumanBoneName.RightUpperLeg,
  mixamorigRightLeg: VRMHumanBoneName.RightLowerLeg,
  mixamorigRightFoot: VRMHumanBoneName.RightFoot,
  mixamorigRightToeBase: VRMHumanBoneName.RightToes,
};

export function createOfficialMixamoPlayback(vrm: VRM): OfficialMixamoPlaybackBridge {
  const loader = new FBXLoader();
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const activeClips = new Map<string, OfficialMixamoClipHandle>();
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const workingQuaternion = new THREE.Quaternion();

  async function loadClip(url: string, clipId: string): Promise<OfficialMixamoClipHandle> {
    const existing = activeClips.get(clipId);
    if (existing) {
      return existing;
    }

    const asset = await loader.loadAsync(url);
    const sourceClip = THREE.AnimationClip.findByName(asset.animations, "mixamo.com") ?? asset.animations[0];

    if (!sourceClip) {
      throw new Error(`No Mixamo animation clip found in: ${url}`);
    }

    const tracks: THREE.KeyframeTrack[] = [];
    const sourceHipsNode = asset.getObjectByName("mixamorigHips");
    const sourceHipsHeight = sourceHipsNode?.position.y ?? 0;
    const vrmHipsHeight = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? 0;
    const hipsPositionScale = sourceHipsHeight > 0 ? vrmHipsHeight / sourceHipsHeight : 1;

    sourceClip.tracks.forEach((sourceTrack) => {
      const [mixamoRigName, propertyName] = sourceTrack.name.split(".");
      const vrmBoneName = MIXAMO_VRM_RIG_MAP[mixamoRigName];
      const vrmNodeName = vrmBoneName ? vrm.humanoid.getNormalizedBoneNode(vrmBoneName)?.name : null;
      const mixamoRigNode = asset.getObjectByName(mixamoRigName);

      if (!vrmNodeName || !mixamoRigNode) {
        return;
      }

      if (sourceTrack instanceof THREE.QuaternionKeyframeTrack) {
        mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
        mixamoRigNode.parent?.getWorldQuaternion(parentRestWorldRotation);

        const values = Array.from(sourceTrack.values);

        for (let index = 0; index < values.length; index += 4) {
          const flatQuaternion = values.slice(index, index + 4);
          workingQuaternion.fromArray(flatQuaternion);
          workingQuaternion.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
          workingQuaternion.toArray(flatQuaternion);

          for (let componentIndex = 0; componentIndex < 4; componentIndex += 1) {
            values[index + componentIndex] = flatQuaternion[componentIndex];
          }
        }

        const finalValues = values.map((value, index) =>
          vrm.meta?.metaVersion === "0" && index % 2 === 0 ? -value : value
        );

        tracks.push(new THREE.QuaternionKeyframeTrack(`${vrmNodeName}.${propertyName}`, sourceTrack.times, finalValues));
        return;
      }

      if (sourceTrack instanceof THREE.VectorKeyframeTrack && vrmBoneName === "hips") {
        const finalValues = Array.from(sourceTrack.values).map((value, index) => {
          const signedValue = vrm.meta?.metaVersion === "0" && index % 3 !== 1 ? -value : value;
          return signedValue * hipsPositionScale;
        });

        tracks.push(new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, sourceTrack.times, finalValues));
      }
    });

    const clip = new THREE.AnimationClip(`official:${clipId}`, sourceClip.duration, tracks);
    const action = mixer.clipAction(clip);
    action.setEffectiveWeight(0);
    action.enabled = true;

    const handle: OfficialMixamoClipHandle = { clipId, clip, action };
    activeClips.set(clipId, handle);
    return handle;
  }

  function play(clipId: string, options?: { loop?: boolean }): void {
    const handle = activeClips.get(clipId);
    if (!handle) {
      return;
    }

    const loop = options?.loop ?? true;
    handle.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    handle.action.clampWhenFinished = !loop;
    handle.action.reset();
    handle.action.setEffectiveWeight(1);
    handle.action.play();
  }

  function stop(clipId: string): void {
    const handle = activeClips.get(clipId);
    if (!handle) {
      return;
    }

    handle.action.stop();
    handle.action.setEffectiveWeight(0);
  }

  function stopAll(): void {
    for (const clipId of activeClips.keys()) {
      stop(clipId);
    }
  }

  function update(deltaSeconds: number): void {
    mixer.update(deltaSeconds);
  }

  function resolveLoopMode(loop: THREE.AnimationActionLoopStyles): "once" | "repeat" | "pingpong" | "unknown" {
    switch (loop) {
      case THREE.LoopOnce:
        return "once";
      case THREE.LoopRepeat:
        return "repeat";
      case THREE.LoopPingPong:
        return "pingpong";
      default:
        return "unknown";
    }
  }

  function getDebugSnapshot(): OfficialMixamoPlaybackDebugSnapshot {
    return {
      mixerTimeSeconds: mixer.time,
      activeClipCount: activeClips.size,
      clips: Array.from(activeClips.values()).map(({ clipId, clip, action }) => ({
        clipId,
        clipDurationSeconds: clip.duration,
        actionTimeSeconds: action.time,
        effectiveWeight: action.getEffectiveWeight(),
        effectiveTimeScale: action.getEffectiveTimeScale(),
        enabled: action.enabled,
        paused: action.paused,
        running: action.isRunning(),
        loopMode: resolveLoopMode(action.loop),
        repetitions: action.repetitions
      }))
    };
  }

  function dispose(): void {
    stopAll();
    mixer.stopAllAction();
    activeClips.clear();
  }

  return {
    loadClip,
    play,
    stop,
    stopAll,
    update,
    getDebugSnapshot,
    dispose
  };
}