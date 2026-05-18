import type { VRM } from "@pixiv/three-vrm";
import type { SemanticAnimationRuntimePayload } from "../../shared/types/animation.js";
import type { HumanoidChannelPlayback } from "./humanoidChannelPlayback.js";
import { createMixerPlayback } from "./mixerPlayback.js";

export type AvatarRuntimePlaybackPath = "mixer";

export interface AvatarRuntimeResolvedPlayback {
  playback: HumanoidChannelPlayback | null;
  playbackPath: AvatarRuntimePlaybackPath;
}

export function isIdleSemanticAnimationPayload(payload: SemanticAnimationRuntimePayload): boolean {
  return payload.semanticId.startsWith("idle.");
}

export function resolveAvatarRuntimePlayback(
  vrm: VRM | null,
  payload: SemanticAnimationRuntimePayload
): AvatarRuntimeResolvedPlayback {
  return {
    playback: createMixerPlayback(vrm, payload),
    playbackPath: "mixer"
  };
}