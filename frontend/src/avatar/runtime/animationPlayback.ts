import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMHumanBoneName, type VRM } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation
} from "@pixiv/three-vrm-animation";

type VRMHumanBoneNameValue = (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName];

export type AnimationClipSourceKind = "vrma" | "mixamo_fbx";

export interface AnimationClipHandle {
  clipId: string;
  sourceKind: AnimationClipSourceKind;
  clip: THREE.AnimationClip;
  action: THREE.AnimationAction;
}

export interface AnimationPlaybackDebugSnapshot {
  mixerTimeSeconds: number;
  activeClipCount: number;
  clips: Array<{
    clipId: string;
    sourceKind: AnimationClipSourceKind;
    clipDurationSeconds: number;
    actionTimeSeconds: number;
    effectiveWeight: number;
    effectiveTimeScale: number;
    enabled: boolean;
    paused: boolean;
    running: boolean;
    loopMode: "once" | "repeat" | "pingpong" | "unknown";
    repetitions: number;
    positionTrackStats: {
      trackName: string | null;
      x: { min: number; max: number; range: number } | null;
      y: { min: number; max: number; range: number } | null;
      z: { min: number; max: number; range: number } | null;
    } | null;
  }>;
}

export interface AnimationPlaybackBridge {
  loadClip(url: string, clipId: string): Promise<AnimationClipHandle>;
  play(clipId: string, options?: { loop?: boolean; transitionMs?: number; restart?: boolean }): void;
  stop(clipId: string, options?: { fadeOutMs?: number }): void;
  crossfade(fromClipId: string, toClipId: string, durationMs: number): void;
  stopAll(fadeOutMs?: number): void;
  stopAllExcept(keepClipId: string, options?: { fadeOutMs?: number }): void;
  update(deltaSeconds: number): void;
  hasActiveClip(clipId: string): boolean;
  getDebugSnapshot(): AnimationPlaybackDebugSnapshot;
  dispose(): void;
}

/**
 * Official Mixamo rig name → VRM humanoid bone mapping, mirroring the
 * three-vrm `loadMixamoAnimation` example.
 */
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

export function resolveAnimationClipSourceKind(url: string): AnimationClipSourceKind | null {
  const cleanPath = url.split("?")[0].toLowerCase();

  if (cleanPath.endsWith(".vrma")) {
    return "vrma";
  }

  if (cleanPath.endsWith(".fbx")) {
    return "mixamo_fbx";
  }

  return null;
}

/**
 * Single playback core for all base animations. Every clip — native .vrma via
 * @pixiv/three-vrm-animation, or Mixamo .fbx via the official three-vrm
 * retarget path — lands in the same THREE.AnimationMixer, so transitions
 * between any two clips crossfade correctly. The avatar root is never
 * animated by this bridge: only humanoid bone rotations plus the scaled hips
 * position track move, which keeps the character anchored in world space.
 */
export function createAnimationPlayback(vrm: VRM, root: THREE.Object3D): AnimationPlaybackBridge {
  const mixer = new THREE.AnimationMixer(root);
  const activeClips = new Map<string, AnimationClipHandle>();
  const loadedVrmAnimations = new Map<string, VRMAnimation>();

  const vrmaLoader = new GLTFLoader();
  vrmaLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const fbxLoader = new FBXLoader();

  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const workingQuaternion = new THREE.Quaternion();

  async function loadVrmaClip(url: string, clipId: string): Promise<THREE.AnimationClip> {
    const gltf = await vrmaLoader.loadAsync(url);
    const vrmAnimations: VRMAnimation[] = gltf.userData.vrmAnimations ?? [];

    if (vrmAnimations.length === 0) {
      throw new Error(`No VRM animation found in: ${url}`);
    }

    const vrmAnimation = vrmAnimations[0];
    loadedVrmAnimations.set(clipId, vrmAnimation);

    // Cast needed: @pixiv/three-vrm-animation re-exports its own VRMCore types
    // which are structurally identical but nominally distinct from @pixiv/three-vrm.
    const clip = createVRMAnimationClip(vrmAnimation, vrm as unknown as Parameters<typeof createVRMAnimationClip>[1]);
    clip.name = clipId;
    return clip;
  }

  async function loadMixamoFbxClip(url: string, clipId: string): Promise<THREE.AnimationClip> {
    const asset = await fbxLoader.loadAsync(url);
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

    const clip = new THREE.AnimationClip(clipId, sourceClip.duration, tracks);
    return clip;
  }

  async function loadClip(url: string, clipId: string): Promise<AnimationClipHandle> {
    const existing = activeClips.get(clipId);
    if (existing) {
      return existing;
    }

    const sourceKind = resolveAnimationClipSourceKind(url);

    if (!sourceKind) {
      throw new Error(`Unsupported animation source (expected .vrma or .fbx): ${url}`);
    }

    const clip = sourceKind === "vrma" ? await loadVrmaClip(url, clipId) : await loadMixamoFbxClip(url, clipId);

    const action = mixer.clipAction(clip);
    action.setEffectiveWeight(0);
    action.enabled = true;

    const handle: AnimationClipHandle = { clipId, sourceKind, clip, action };
    activeClips.set(clipId, handle);
    return handle;
  }

  function play(clipId: string, options?: { loop?: boolean; transitionMs?: number; restart?: boolean }): void {
    const handle = activeClips.get(clipId);
    if (!handle) {
      return;
    }

    const loop = options?.loop ?? true;
    const transitionMs = options?.transitionMs ?? 0;
    const restart = options?.restart ?? true;

    handle.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    handle.action.clampWhenFinished = !loop;
    if (restart) {
      handle.action.reset();
    }
    handle.action.enabled = true;

    // fadeIn multiplies the action's BASE weight, which loadClip initializes
    // to 0 — restore it to 1 first or the fade stays at 0 forever.
    handle.action.setEffectiveWeight(1);

    if (transitionMs > 0) {
      handle.action.fadeIn(transitionMs / 1000);
    }

    handle.action.play();
  }

  function stop(clipId: string, options?: { fadeOutMs?: number }): void {
    const handle = activeClips.get(clipId);
    if (!handle) {
      return;
    }

    const fadeOutMs = options?.fadeOutMs ?? 0;

    if (fadeOutMs > 0) {
      handle.action.fadeOut(fadeOutMs / 1000);
      return;
    }

    handle.action.stop();
    handle.action.setEffectiveWeight(0);
  }

  function crossfade(fromClipId: string, toClipId: string, durationMs: number): void {
    const fromHandle = activeClips.get(fromClipId);
    const toHandle = activeClips.get(toClipId);
    if (!fromHandle || !toHandle) {
      return;
    }

    toHandle.action.reset();
    toHandle.action.play();
    toHandle.action.setEffectiveWeight(1);
    fromHandle.action.crossFadeTo(toHandle.action, durationMs / 1000, true);
  }

  function stopAll(fadeOutMs?: number): void {
    for (const clipId of activeClips.keys()) {
      stop(clipId, { fadeOutMs: fadeOutMs ?? 0 });
    }
  }

  function stopAllExcept(keepClipId: string, options?: { fadeOutMs?: number }): void {
    for (const clipId of activeClips.keys()) {
      if (clipId !== keepClipId) {
        stop(clipId, options);
      }
    }
  }

  function update(deltaSeconds: number): void {
    mixer.update(deltaSeconds);
  }

  function hasActiveClip(clipId: string): boolean {
    const handle = activeClips.get(clipId);
    return Boolean(
      handle && handle.action.enabled && (handle.action.isRunning() || handle.action.getEffectiveWeight() > 0.001)
    );
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

  function getDebugSnapshot(): AnimationPlaybackDebugSnapshot {
    const buildRange = (values: number[]): { min: number; max: number; range: number } | null => {
      if (values.length === 0) {
        return null;
      }

      let min = values[0];
      let max = values[0];

      for (let index = 1; index < values.length; index += 1) {
        const value = values[index];
        if (value < min) {
          min = value;
        }
        if (value > max) {
          max = value;
        }
      }

      return {
        min,
        max,
        range: max - min,
      };
    };

    const buildPositionTrackStats = (
      clip: THREE.AnimationClip
    ): AnimationPlaybackDebugSnapshot["clips"][number]["positionTrackStats"] => {
      const track = clip.tracks.find((candidate) => candidate.name.endsWith(".position"));

      if (!(track instanceof THREE.VectorKeyframeTrack)) {
        return null;
      }

      const xValues: number[] = [];
      const yValues: number[] = [];
      const zValues: number[] = [];

      for (let index = 0; index < track.values.length; index += 3) {
        xValues.push(track.values[index]);
        yValues.push(track.values[index + 1]);
        zValues.push(track.values[index + 2]);
      }

      return {
        trackName: track.name,
        x: buildRange(xValues),
        y: buildRange(yValues),
        z: buildRange(zValues),
      };
    };

    return {
      mixerTimeSeconds: mixer.time,
      activeClipCount: activeClips.size,
      clips: Array.from(activeClips.values()).map((handle) => ({
        clipId: handle.clipId,
        sourceKind: handle.sourceKind,
        clipDurationSeconds: handle.clip.duration,
        actionTimeSeconds: handle.action.time,
        effectiveWeight: handle.action.getEffectiveWeight(),
        effectiveTimeScale: handle.action.getEffectiveTimeScale(),
        enabled: handle.action.enabled,
        paused: handle.action.paused,
        running: handle.action.isRunning(),
        loopMode: resolveLoopMode(handle.action.loop),
        repetitions: handle.action.repetitions,
        positionTrackStats: buildPositionTrackStats(handle.clip),
      })),
    };
  }

  function dispose(): void {
    mixer.stopAllAction();
    for (const handle of activeClips.values()) {
      mixer.uncacheClip(handle.clip);
      mixer.uncacheAction(handle.clip);
    }
    activeClips.clear();
    loadedVrmAnimations.clear();
  }

  return {
    loadClip,
    play,
    stop,
    crossfade,
    stopAll,
    stopAllExcept,
    update,
    hasActiveClip,
    getDebugSnapshot,
    dispose
  };
}
