import type { VRM } from "@pixiv/three-vrm";
import type { SemanticAnimationRuntimePayload } from "../../shared/types/animation.js";
import type { HumanoidChannelPlayback } from "./humanoidChannelPlayback.js";
import { createMixerPlayback, createFeetAnchoredMixerPlayback } from "./mixerPlayback.js";

export type AvatarRuntimePlaybackPath = "mixer" | "feetAnchored" | "vrma";

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
  // VRMA path is handled externally by the VrmaPlaybackBridge —
  // when preferred path is "vrma", return null playback so the caller
  // knows to delegate to the VRMA subsystem instead of the legacy mixer.
  if (preferredPath === "vrma") {
    return {
      playback: null,
      playbackPath: "vrma"
    };
  }

  // Feet-anchored path: temporarily disabled — routing to standard mixer
  // while researching three-vrm's stable grounding approach.
  const anchorType = payload.exportAudit?.boneTransformComparison?.anchor?.type;
  if (anchorType === "feet") {
    return {
      playback: createMixerPlayback(vrm, payload),
      playbackPath: "mixer"
    };
  }

  return {
    playback: createMixerPlayback(vrm, payload),
    playbackPath: "mixer"
  };
}