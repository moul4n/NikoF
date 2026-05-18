"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BASE_ANIMATION_MOTION_PROFILE = void 0;
exports.resolveBaseAnimationMotionProfile = resolveBaseAnimationMotionProfile;
exports.DEFAULT_BASE_ANIMATION_MOTION_PROFILE = {
    speedMultiplier: 1,
    bobAmplitude: 0.018,
    secondaryBobAmplitude: 0.004,
    leanAmplitude: 0.018,
    nodAmplitude: 0.012,
    yawAmplitude: 0.03
};
function isFiniteAmplitude(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function resolveBaseAnimationMotionProfile(payload) {
    const motionProfile = payload.motionProfile;
    if (motionProfile &&
        typeof motionProfile.speedMultiplier === "number" &&
        Number.isFinite(motionProfile.speedMultiplier) &&
        motionProfile.speedMultiplier >= 0 &&
        isFiniteAmplitude(motionProfile.bobAmplitude) &&
        isFiniteAmplitude(motionProfile.secondaryBobAmplitude) &&
        isFiniteAmplitude(motionProfile.leanAmplitude) &&
        isFiniteAmplitude(motionProfile.nodAmplitude) &&
        isFiniteAmplitude(motionProfile.yawAmplitude)) {
        return motionProfile;
    }
    return exports.DEFAULT_BASE_ANIMATION_MOTION_PROFILE;
}
