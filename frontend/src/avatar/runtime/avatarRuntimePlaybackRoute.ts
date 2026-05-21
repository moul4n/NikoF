import type { VRM } from "@pixiv/three-vrm";
import type { SemanticAnimationRuntimePayload } from "../../shared/types/animation.js";
import type { HumanoidChannelPlayback } from "./humanoidChannelPlayback.js";
import { createMixerPlayback } from "./mixerPlayback.js";

export type AvatarRuntimePlaybackPath = "mixer" | "vrma" | "official";

export interface AvatarRuntimeResolvedPlayback {
  playback: HumanoidChannelPlayback | null;
  playbackPath: AvatarRuntimePlaybackPath;
}

export function isIdleSemanticAnimationPayload(payload: SemanticAnimationRuntimePayload): boolean {
  return payload.semanticId.startsWith("idle.");
}

export function resolveAvatarRuntimePlayback(
  vrm: VRM | null,
  payload: SemanticAnimationRuntimePayload,
  preferredPath?: AvatarRuntimePlaybackPath
): AvatarRuntimeResolvedPlayback {
  const routeDeclaredAdapter = (): AvatarRuntimeResolvedPlayback | null => {
    if (payload.playbackAdapter === "official_mixamo_fbx") {
      return {
        playback: null,
        playbackPath: "official"
      };
    }

    if (payload.playbackAdapter === "vrma") {
      return {
        playback: null,
        playbackPath: "vrma"
      };
    }

    if (payload.playbackAdapter === "mixer") {
      return {
        playback: createMixerPlayback(vrm, payload),
        playbackPath: "mixer"
      };
    }

    return null;
  };

  if (preferredPath === "official") {
    if (payload.playbackAdapter === "official_mixamo_fbx") {
      return {
        playback: null,
        playbackPath: "official"
      };
    }

    const declaredAdapter = routeDeclaredAdapter();
    if (declaredAdapter) {
      return declaredAdapter;
    }

    const sourcePath = payload.sourceAsset?.path?.toLowerCase() ?? "";

    if (sourcePath.endsWith(".fbx")) {
      return {
        playback: null,
        playbackPath: "official"
      };
    }
  }

  // VRMA path is handled externally by the VrmaPlaybackBridge —
  // when preferred path is "vrma", return null playback so the caller
  // knows to delegate to the VRMA subsystem instead of the legacy mixer.
  if (preferredPath === "vrma") {
    return {
      playback: null,
      playbackPath: "vrma"
    };
  }

  const declaredAdapter = routeDeclaredAdapter();
  if (declaredAdapter) {
    return declaredAdapter;
  }

  return {
    playback: createMixerPlayback(vrm, payload),
    playbackPath: "mixer"
  };
}