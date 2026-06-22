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
  channel: "base" | "overlay";
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
  // Upper-body additive overlay channel: gesture clips that layer ON TOP of the
  // maintained base animation (e.g. a wave while idling) instead of replacing
  // it. Overlay actions share the base mixer (additive blending only composes
  // within one mixer) but are tracked separately, so base stop/crossfade never
  // disturbs them and vice versa.
  loadOverlayClip(url: string, clipId: string): Promise<AnimationClipHandle>;
  playOverlay(
    clipId: string,
    options?: { loop?: boolean; transitionMs?: number; intensity?: number; restart?: boolean }
  ): void;
  stopOverlay(clipId: string, options?: { fadeOutMs?: number }): void;
  stopAllOverlay(fadeOutMs?: number): void;
  hasActiveOverlay(clipId: string): boolean;
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
  // The gesture overlay runs on its OWN mixer that updates AFTER the base mixer
  // each frame. A masked gesture clip (upper-body bone tracks only) plays as a
  // normal-blend action: at full weight it OVERRIDES the base on those bones
  // (so the arm reaches the gesture's absolute pose — a wave actually raises),
  // and while its weight fades in/out it blends against whatever the base mixer
  // just wrote (a smooth raise/lower). Bones with no track in the masked clip —
  // hips, legs, head — are never written by this mixer, so the base keeps them.
  // (Additive blending was wrong here: gesture clips are absolute poses, not
  // deltas, so an additive layer only reproduced the wiggle, not the raise.)
  const overlayMixer = new THREE.AnimationMixer(root);
  const activeClips = new Map<string, AnimationClipHandle>();
  const overlayClips = new Map<string, AnimationClipHandle>();
  const loadedVrmAnimations = new Map<string, VRMAnimation>();

  // Humanoid bones excluded from upper-body overlays: the root/hips (anchors the
  // avatar), the legs/feet (locomotion stays owned by the base clip), and the
  // head/neck/eyes/jaw (owned by look-at and the passive facial layers).
  // Everything else — spine, chest, shoulders, arms, hands, fingers — is driven
  // by the gesture while it plays.
  const NON_OVERLAY_BONES: ReadonlySet<VRMHumanBoneNameValue> = new Set([
    VRMHumanBoneName.Hips,
    VRMHumanBoneName.Neck,
    VRMHumanBoneName.Head,
    VRMHumanBoneName.LeftEye,
    VRMHumanBoneName.RightEye,
    VRMHumanBoneName.Jaw,
    VRMHumanBoneName.LeftUpperLeg,
    VRMHumanBoneName.LeftLowerLeg,
    VRMHumanBoneName.LeftFoot,
    VRMHumanBoneName.LeftToes,
    VRMHumanBoneName.RightUpperLeg,
    VRMHumanBoneName.RightLowerLeg,
    VRMHumanBoneName.RightFoot,
    VRMHumanBoneName.RightToes,
  ]);

  let cachedOverlayNodeNames: Set<string> | null = null;
  function overlayBoneNodeNames(): Set<string> {
    if (cachedOverlayNodeNames) {
      return cachedOverlayNodeNames;
    }
    const names = new Set<string>();
    for (const boneName of Object.values(VRMHumanBoneName) as VRMHumanBoneNameValue[]) {
      if (NON_OVERLAY_BONES.has(boneName)) {
        continue;
      }
      const node = vrm.humanoid.getNormalizedBoneNode(boneName);
      if (node?.name) {
        names.add(node.name);
      }
    }
    cachedOverlayNodeNames = names;
    return names;
  }

  // Restrict a clip to upper-body bone-rotation tracks so the overlay action
  // only writes arms/torso. Kept as ABSOLUTE poses (no additive conversion):
  // played at full weight on the overlay mixer it overrides the base on these
  // bones, so the gesture reaches its intended pose; legs/hips/head have no
  // track here and stay owned by the base clip and the gaze/facial layers.
  function makeUpperBodyOverlayClip(clip: THREE.AnimationClip): THREE.AnimationClip {
    const allowed = overlayBoneNodeNames();
    const tracks = clip.tracks.filter(
      (track) => track.name.endsWith(".quaternion") && allowed.has(track.name.split(".")[0])
    );
    return new THREE.AnimationClip(`${clip.name}__upperOverlay`, clip.duration, tracks);
  }

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

    const handle: AnimationClipHandle = { clipId, sourceKind, clip, action, channel: "base" };
    activeClips.set(clipId, handle);
    return handle;
  }

  async function loadOverlayClip(url: string, clipId: string): Promise<AnimationClipHandle> {
    const existing = overlayClips.get(clipId);
    if (existing) {
      return existing;
    }

    const sourceKind = resolveAnimationClipSourceKind(url);

    if (!sourceKind) {
      throw new Error(`Unsupported animation source (expected .vrma or .fbx): ${url}`);
    }

    const baseClip = sourceKind === "vrma" ? await loadVrmaClip(url, clipId) : await loadMixamoFbxClip(url, clipId);
    const overlayClip = makeUpperBodyOverlayClip(baseClip);

    // Normal blend on the dedicated overlay mixer (updated after the base): at
    // weight 1 it overrides the base on the masked bones; at partial weight it
    // blends against the base's current pose.
    const action = overlayMixer.clipAction(overlayClip, root);
    action.setEffectiveWeight(0);
    action.enabled = true;

    const handle: AnimationClipHandle = { clipId, sourceKind, clip: overlayClip, action, channel: "overlay" };
    overlayClips.set(clipId, handle);
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

  function playOverlay(
    clipId: string,
    options?: { loop?: boolean; transitionMs?: number; intensity?: number; restart?: boolean }
  ): void {
    const handle = overlayClips.get(clipId);
    if (!handle) {
      return;
    }

    const loop = options?.loop ?? false;
    const transitionMs = options?.transitionMs ?? 0;
    const intensity = Math.max(0, Math.min(1, options?.intensity ?? 1));
    const restart = options?.restart ?? true;

    handle.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    // Hold the final frame for one-shots: the caller fades the overlay weight
    // out just before the clip ends, so the arm eases back to the base pose
    // instead of snapping when a LoopOnce action stops.
    handle.action.clampWhenFinished = !loop;
    if (restart) {
      handle.action.reset();
    }
    handle.action.enabled = true;
    handle.action.setEffectiveWeight(intensity);

    if (transitionMs > 0) {
      handle.action.fadeIn(transitionMs / 1000);
    }

    handle.action.play();
  }

  function stopOverlay(clipId: string, options?: { fadeOutMs?: number }): void {
    const handle = overlayClips.get(clipId);
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

  function stopAllOverlay(fadeOutMs?: number): void {
    for (const clipId of overlayClips.keys()) {
      stopOverlay(clipId, { fadeOutMs: fadeOutMs ?? 0 });
    }
  }

  function hasActiveOverlay(clipId: string): boolean {
    const handle = overlayClips.get(clipId);
    return Boolean(
      handle && handle.action.enabled && (handle.action.isRunning() || handle.action.getEffectiveWeight() > 0.001)
    );
  }

  function update(deltaSeconds: number): void {
    // Base first, then the overlay: the overlay's normal-blend override reads
    // the base's just-applied pose to blend against while fading in/out.
    mixer.update(deltaSeconds);
    overlayMixer.update(deltaSeconds);
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
    overlayMixer.stopAllAction();
    for (const handle of activeClips.values()) {
      mixer.uncacheClip(handle.clip);
      mixer.uncacheAction(handle.clip);
    }
    for (const handle of overlayClips.values()) {
      overlayMixer.uncacheClip(handle.clip);
      overlayMixer.uncacheAction(handle.clip);
    }
    activeClips.clear();
    overlayClips.clear();
    loadedVrmAnimations.clear();
  }

  return {
    loadClip,
    play,
    stop,
    crossfade,
    stopAll,
    stopAllExcept,
    loadOverlayClip,
    playOverlay,
    stopOverlay,
    stopAllOverlay,
    hasActiveOverlay,
    update,
    hasActiveClip,
    getDebugSnapshot,
    dispose
  };
}
