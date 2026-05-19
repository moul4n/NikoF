import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { VRM } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation
} from "@pixiv/three-vrm-animation";

export interface VrmaClipHandle {
  clipId: string;
  clip: THREE.AnimationClip;
  action: THREE.AnimationAction;
}

export interface VrmaPlaybackState {
  activeClips: Map<string, VrmaClipHandle>;
  mixer: THREE.AnimationMixer;
}

export interface VrmaPlaybackBridge {
  loadVrma(url: string, clipId: string): Promise<VrmaClipHandle>;
  play(clipId: string, options?: { loop?: boolean; transitionMs?: number }): void;
  stop(clipId: string, options?: { fadeOutMs?: number }): void;
  crossfade(fromClipId: string, toClipId: string, durationMs: number): void;
  stopAll(fadeOutMs?: number): void;
  update(deltaSeconds: number): void;
  dispose(): void;
}

export function createVrmaPlayback(vrm: VRM, root: THREE.Object3D): VrmaPlaybackBridge {
  const mixer = new THREE.AnimationMixer(root);
  const loadedAnimations = new Map<string, VRMAnimation>();
  const activeClips = new Map<string, VrmaClipHandle>();

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  async function loadVrma(url: string, clipId: string): Promise<VrmaClipHandle> {
    const existing = activeClips.get(clipId);
    if (existing) return existing;

    const gltf = await loader.loadAsync(url);
    const vrmAnimations: VRMAnimation[] = gltf.userData.vrmAnimations ?? [];

    if (vrmAnimations.length === 0) {
      throw new Error(`No VRM animation found in: ${url}`);
    }

    const vrmAnimation = vrmAnimations[0];
    loadedAnimations.set(clipId, vrmAnimation);

    // Cast needed: @pixiv/three-vrm-animation re-exports its own VRMCore types
    // which are structurally identical but nominally distinct from @pixiv/three-vrm.
    const clip = createVRMAnimationClip(vrmAnimation, vrm as unknown as Parameters<typeof createVRMAnimationClip>[1]);
    clip.name = clipId;

    const action = mixer.clipAction(clip);
    action.setEffectiveWeight(0);
    action.enabled = true;

    const handle: VrmaClipHandle = { clipId, clip, action };
    activeClips.set(clipId, handle);
    return handle;
  }

  function play(clipId: string, options?: { loop?: boolean; transitionMs?: number }): void {
    const handle = activeClips.get(clipId);
    if (!handle) return;

    const loop = options?.loop ?? true;

    handle.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    handle.action.clampWhenFinished = !loop;
    handle.action.reset();
    handle.action.setEffectiveWeight(1);
    handle.action.play();
  }

  function stop(clipId: string, options?: { fadeOutMs?: number }): void {
    const handle = activeClips.get(clipId);
    if (!handle) return;

    const fadeOutMs = options?.fadeOutMs ?? 0;

    if (fadeOutMs > 0) {
      handle.action.fadeOut(fadeOutMs / 1000);
    } else {
      handle.action.stop();
      handle.action.setEffectiveWeight(0);
    }
  }

  function crossfade(fromClipId: string, toClipId: string, durationMs: number): void {
    const fromHandle = activeClips.get(fromClipId);
    const toHandle = activeClips.get(toClipId);
    if (!fromHandle || !toHandle) return;

    toHandle.action.reset();
    toHandle.action.play();
    toHandle.action.setEffectiveWeight(1);
    fromHandle.action.crossFadeTo(toHandle.action, durationMs / 1000, true);
  }

  function stopAll(fadeOutMs?: number): void {
    for (const [clipId] of activeClips) {
      stop(clipId, { fadeOutMs: fadeOutMs ?? 0 });
    }
  }

  function update(deltaSeconds: number): void {
    mixer.update(deltaSeconds);
  }

  function dispose(): void {
    mixer.stopAllAction();
    for (const handle of activeClips.values()) {
      mixer.uncacheClip(handle.clip);
      mixer.uncacheAction(handle.clip);
    }
    activeClips.clear();
    loadedAnimations.clear();
  }

  return {
    loadVrma,
    play,
    stop,
    crossfade,
    stopAll,
    update,
    dispose
  };
}
