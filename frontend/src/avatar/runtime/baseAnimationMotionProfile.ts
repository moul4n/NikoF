import type { SemanticAnimationMotionProfile, SemanticAnimationRuntimePayload } from "../../shared/types/animation";

export const DEFAULT_BASE_ANIMATION_MOTION_PROFILE: SemanticAnimationMotionProfile = {
  speedMultiplier: 1,
  bobAmplitude: 0.018,
  secondaryBobAmplitude: 0.004,
  leanAmplitude: 0.018,
  nodAmplitude: 0.012,
  yawAmplitude: 0.03
};

function isFiniteAmplitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function resolveBaseAnimationMotionProfile(
  payload: SemanticAnimationRuntimePayload
): SemanticAnimationMotionProfile {
  const motionProfile = payload.motionProfile;

  if (
    motionProfile &&
    typeof motionProfile.speedMultiplier === "number" &&
    Number.isFinite(motionProfile.speedMultiplier) &&
    motionProfile.speedMultiplier > 0 &&
    isFiniteAmplitude(motionProfile.bobAmplitude) &&
    isFiniteAmplitude(motionProfile.secondaryBobAmplitude) &&
    isFiniteAmplitude(motionProfile.leanAmplitude) &&
    isFiniteAmplitude(motionProfile.nodAmplitude) &&
    isFiniteAmplitude(motionProfile.yawAmplitude)
  ) {
    return motionProfile;
  }

  return DEFAULT_BASE_ANIMATION_MOTION_PROFILE;
}