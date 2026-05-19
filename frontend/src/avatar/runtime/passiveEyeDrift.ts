import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

/**
 * Passive eye-drift controller.
 * Eyes look straight forward with subtle micro-saccades for liveliness.
 * Supports a gaze-lock override for camera tracking (look at person).
 *
 * Uses vrm.lookAt.target positioning so three-vrm handles the actual
 * eye bone rotation and expression blend automatically.
 */

export interface PassiveEyeDriftController {
  /** Call every frame with the frame delta in seconds. */
  update(deltaSeconds: number): void;
  /** Override gaze — eyes lock to the given world-space point (camera tracking). */
  lockGaze(worldPoint: THREE.Vector3): void;
  /** Release gaze lock — returns to forward + micro-saccades. */
  releaseGaze(): void;
  /** Whether gaze is currently locked (camera override active). */
  readonly isGazeLocked: boolean;
  /** Clean up. */
  dispose(): void;
}

interface EyeDriftConfig {
  /** Distance in front of the head where the virtual gaze target sits. */
  gazeDepth: number;
  /** Maximum horizontal fixation drift around forward (meters at gazeDepth). */
  maxFixationDriftX: number;
  /** Maximum vertical fixation drift around forward (meters at gazeDepth). */
  maxFixationDriftY: number;
  /** Minimum time to hold a fixation point (seconds). */
  minFixationDuration: number;
  /** Maximum time to hold a fixation point (seconds). */
  maxFixationDuration: number;
  /** Speed of smooth interpolation toward the fixation point. */
  fixationBlendSpeed: number;
  /** Micro-saccade amplitude (meters at gazeDepth). */
  saccadeAmplitude: number;
  /** Interval range for micro-saccades (seconds). */
  minSaccadeInterval: number;
  maxSaccadeInterval: number;
  /** Duration of a saccade movement (seconds). */
  saccadeDuration: number;
  /** Speed of smooth transition when locking/releasing gaze. */
  lockTransitionSpeed: number;
}

const DEFAULT_CONFIG: EyeDriftConfig = {
  gazeDepth: 1.5,
  maxFixationDriftX: 0.012,
  maxFixationDriftY: 0.008,
  minFixationDuration: 1.6,
  maxFixationDuration: 4.2,
  fixationBlendSpeed: 1.4,
  saccadeAmplitude: 0.015,
  minSaccadeInterval: 0.3,
  maxSaccadeInterval: 1.2,
  saccadeDuration: 0.04,
  lockTransitionSpeed: 4.0
};

export function createPassiveEyeDriftController(
  vrm: VRM,
  config: Partial<EyeDriftConfig> = {}
): PassiveEyeDriftController {
  const cfg: EyeDriftConfig = { ...DEFAULT_CONFIG, ...config };

  // The lookAt target object that three-vrm will track
  let gazeTarget: THREE.Object3D | null = null;
  let gazeLocked = false;
  const lockPoint = new THREE.Vector3(0, 0, cfg.gazeDepth);

  // Fixation drift state
  const fixationOffset = new THREE.Vector2(0, 0);
  const fixationTarget = new THREE.Vector2(0, 0);
  let fixationElapsed = 0;
  let fixationDuration = randomInRange(cfg.minFixationDuration, cfg.maxFixationDuration);

  // Saccade state
  let saccadeTimer = 0;
  let nextSaccadeIn = randomInRange(cfg.minSaccadeInterval, cfg.maxSaccadeInterval);
  const saccadeOffset = new THREE.Vector2(0, 0);
  let saccadeElapsed = 0;
  let saccadeActive = false;

  // Working vectors
  const worldGazePoint = new THREE.Vector3();
  const headWorldPos = new THREE.Vector3();

  function randomInRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  function pickFixationTarget(): void {
    // Bias toward center so the avatar reads as looking forward.
    const horizontalBias = (Math.random() + Math.random() + Math.random()) / 3;
    const verticalBias = (Math.random() + Math.random() + Math.random()) / 3;

    fixationTarget.set(
      (horizontalBias * 2 - 1) * cfg.maxFixationDriftX,
      (verticalBias * 2 - 1) * cfg.maxFixationDriftY
    );

    fixationElapsed = 0;
    fixationDuration = randomInRange(cfg.minFixationDuration, cfg.maxFixationDuration);
  }

  function ensureGazeTarget(): THREE.Object3D | null {
    if (!vrm.lookAt) return null;

    if (!gazeTarget) {
      gazeTarget = new THREE.Object3D();
      gazeTarget.name = "passiveEyeDrift_gazeTarget";
      vrm.scene.add(gazeTarget);
      vrm.lookAt.target = gazeTarget;
    }
    return gazeTarget;
  }

  function getHeadPosition(): THREE.Vector3 {
    const headNode = vrm.humanoid?.getNormalizedBoneNode("head");
    if (headNode) {
      headNode.getWorldPosition(headWorldPos);
    } else {
      vrm.scene.getWorldPosition(headWorldPos);
      headWorldPos.y += 1.5;
    }
    return headWorldPos;
  }

  function update(deltaSeconds: number): void {
    const target = ensureGazeTarget();
    if (!target) return;

    const headPos = getHeadPosition();

    if (gazeLocked) {
      // Smoothly move toward locked gaze point
      worldGazePoint.copy(lockPoint);
      target.position.lerp(worldGazePoint, 1 - Math.exp(-cfg.lockTransitionSpeed * deltaSeconds));
      return;
    }

    // --- Forward-biased fixation drift + micro-saccades ---

    fixationElapsed += deltaSeconds;
    if (fixationElapsed >= fixationDuration) {
      pickFixationTarget();
    }

    fixationOffset.lerp(
      fixationTarget,
      1 - Math.exp(-cfg.fixationBlendSpeed * deltaSeconds)
    );

    saccadeTimer += deltaSeconds;
    if (!saccadeActive && saccadeTimer >= nextSaccadeIn) {
      saccadeActive = true;
      saccadeElapsed = 0;
      const angle = Math.random() * Math.PI * 2;
      const amp = Math.random() * cfg.saccadeAmplitude;
      saccadeOffset.set(Math.cos(angle) * amp, Math.sin(angle) * amp);
    }

    let saccadeX = 0;
    let saccadeY = 0;
    if (saccadeActive) {
      saccadeElapsed += deltaSeconds;
      if (saccadeElapsed >= cfg.saccadeDuration) {
        saccadeActive = false;
        saccadeTimer = 0;
        nextSaccadeIn = randomInRange(cfg.minSaccadeInterval, cfg.maxSaccadeInterval);
      } else {
        const t = saccadeElapsed / cfg.saccadeDuration;
        const intensity = t < 0.3 ? t / 0.3 : 1 - ((t - 0.3) / 0.7);
        saccadeX = saccadeOffset.x * intensity;
        saccadeY = saccadeOffset.y * intensity;
      }
    }

    // Gaze target: mostly straight forward from head (toward camera, -Z)
    // with tiny fixation drift and micro-saccade offsets layered on top.
    worldGazePoint.set(
      headPos.x + fixationOffset.x + saccadeX,
      headPos.y + fixationOffset.y + saccadeY,
      headPos.z - cfg.gazeDepth
    );

    target.position.lerp(worldGazePoint, 1 - Math.exp(-cfg.lockTransitionSpeed * deltaSeconds));
  }

  function lockGaze(worldPoint: THREE.Vector3): void {
    gazeLocked = true;
    lockPoint.copy(worldPoint);
  }

  function releaseGaze(): void {
    gazeLocked = false;
    pickFixationTarget();
  }

  function dispose(): void {
    if (gazeTarget) {
      gazeTarget.removeFromParent();
      gazeTarget = null;
    }
    if (vrm.lookAt) {
      vrm.lookAt.target = undefined as unknown as THREE.Object3D;
    }
  }

  return {
    update,
    lockGaze,
    releaseGaze,
    get isGazeLocked() { return gazeLocked; },
    dispose
  };
}
