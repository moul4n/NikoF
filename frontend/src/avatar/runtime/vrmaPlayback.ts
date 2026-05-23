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

export interface VrmaPlaybackDebugSnapshot {
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
    positionTrackStats: {
      trackName: string | null;
      x: { min: number; max: number; range: number } | null;
      y: { min: number; max: number; range: number } | null;
      z: { min: number; max: number; range: number } | null;
    } | null;
  }>;
}

export interface VrmaPlaybackBridge {
  loadVrma(url: string, clipId: string): Promise<VrmaClipHandle>;
  play(clipId: string, options?: { loop?: boolean; transitionMs?: number; restart?: boolean }): void;
  stop(clipId: string, options?: { fadeOutMs?: number }): void;
  crossfade(fromClipId: string, toClipId: string, durationMs: number): void;
  stopAll(fadeOutMs?: number): void;
  update(deltaSeconds: number): void;
  getDebugSnapshot(): VrmaPlaybackDebugSnapshot;
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

  function play(clipId: string, options?: { loop?: boolean; transitionMs?: number; restart?: boolean }): void {
    const handle = activeClips.get(clipId);
    if (!handle) return;

    const loop = options?.loop ?? true;
    const transitionMs = options?.transitionMs ?? 0;
    const restart = options?.restart ?? true;

    handle.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    handle.action.clampWhenFinished = !loop;
    handle.action.stopFading();
    if (restart) {
      handle.action.reset();
    }
    handle.action.enabled = true;

    if (transitionMs > 0) {
      handle.action.fadeIn(transitionMs / 1000);
    } else {
      handle.action.setEffectiveWeight(1);
    }

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

  function getDebugSnapshot(): VrmaPlaybackDebugSnapshot {
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

    const buildPositionTrackStats = (clip: THREE.AnimationClip): VrmaPlaybackDebugSnapshot["clips"][number]["positionTrackStats"] => {
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
    loadedAnimations.clear();
  }

  return {
    loadVrma,
    play,
    stop,
    crossfade,
    stopAll,
    update,
    getDebugSnapshot,
    dispose
  };
}
