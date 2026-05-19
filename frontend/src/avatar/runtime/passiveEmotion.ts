import type { VRM } from "@pixiv/three-vrm";

export const PASSIVE_EMOTION_NAMES = ["happy", "sad", "angry", "relaxed", "surprised"] as const;

export type PassiveEmotionName = (typeof PASSIVE_EMOTION_NAMES)[number];

export interface PassiveEmotionController {
  setEmotion(nextEmotion: PassiveEmotionName | null): void;
  update(deltaSeconds: number): void;
  dispose(): void;
}

interface EmotionLayerState {
  currentWeight: number;
  startWeight: number;
  targetWeight: number;
}

interface PassiveEmotionConfig {
  defaultTransitionSeconds: number;
  idleBlendSpeed: number;
  idleRelaxedBase: number;
  idleRelaxedPrimaryAmplitude: number;
  idleRelaxedSecondaryAmplitude: number;
  idleHappyBase: number;
  idleHappyAmplitude: number;
  targetWeights: Record<PassiveEmotionName, number>;
}

const DEFAULT_CONFIG: PassiveEmotionConfig = {
  defaultTransitionSeconds: 0.9,
  idleBlendSpeed: 1.4,
  idleRelaxedBase: 0.028,
  idleRelaxedPrimaryAmplitude: 0.014,
  idleRelaxedSecondaryAmplitude: 0.008,
  idleHappyBase: 0.004,
  idleHappyAmplitude: 0.007,
  targetWeights: {
    happy: 0.78,
    sad: 0.72,
    angry: 0.76,
    relaxed: 0.64,
    surprised: 0.58
  }
};

export function isPassiveEmotionName(value: string): value is PassiveEmotionName {
  return PASSIVE_EMOTION_NAMES.includes(value as PassiveEmotionName);
}

export function createPassiveEmotionController(
  vrm: VRM,
  config: Partial<PassiveEmotionConfig> = {}
): PassiveEmotionController {
  const cfg: PassiveEmotionConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    targetWeights: {
      ...DEFAULT_CONFIG.targetWeights,
      ...config.targetWeights
    }
  };

  const layerStates = new Map<PassiveEmotionName, EmotionLayerState>(
    PASSIVE_EMOTION_NAMES.map((emotionName) => [
      emotionName,
      {
        currentWeight: 0,
        startWeight: 0,
        targetWeight: 0
      }
    ])
  );

  let activeEmotion: PassiveEmotionName | null = null;
  let transitionElapsedSeconds = cfg.defaultTransitionSeconds;
  let transitionDurationSeconds = cfg.defaultTransitionSeconds;
  let idleElapsedSeconds = Math.random() * 32;
  let idleRelaxedWeight = 0;
  let idleHappyWeight = 0;

  function setExpressionWeight(emotionName: PassiveEmotionName, weight: number): void {
    const expressionManager = vrm.expressionManager;
    if (!expressionManager?.getExpression(emotionName)) {
      return;
    }

    expressionManager.setValue(emotionName, weight);
  }

  function easeInOutSine(t: number): number {
    return -(Math.cos(Math.PI * t) - 1) / 2;
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  function setEmotion(nextEmotion: PassiveEmotionName | null): void {
    activeEmotion = nextEmotion;
    transitionElapsedSeconds = 0;
    transitionDurationSeconds = cfg.defaultTransitionSeconds;

    PASSIVE_EMOTION_NAMES.forEach((emotionName) => {
      const state = layerStates.get(emotionName);
      if (!state) {
        return;
      }

      state.startWeight = state.currentWeight;
      state.targetWeight = nextEmotion === emotionName ? cfg.targetWeights[emotionName] : 0;
    });
  }

  function update(deltaSeconds: number): void {
    const expressionManager = vrm.expressionManager;

    if (!expressionManager) {
      return;
    }

    transitionElapsedSeconds = Math.min(
      transitionElapsedSeconds + deltaSeconds,
      transitionDurationSeconds
    );
    const normalizedTransition = transitionDurationSeconds <= 0
      ? 1
      : transitionElapsedSeconds / transitionDurationSeconds;
    const easedTransition = easeInOutSine(Math.min(Math.max(normalizedTransition, 0), 1));
    const idleBlendFactor = 1 - Math.exp(-cfg.idleBlendSpeed * deltaSeconds);

    idleElapsedSeconds += deltaSeconds;

    const idleRelaxedTarget = activeEmotion === null
      ? clamp(
        cfg.idleRelaxedBase
          + Math.sin(idleElapsedSeconds * 0.37) * cfg.idleRelaxedPrimaryAmplitude
          + Math.sin(idleElapsedSeconds * 0.16 + 1.4) * cfg.idleRelaxedSecondaryAmplitude,
        0,
        0.075
      )
      : 0;
    const idleHappyTarget = activeEmotion === null
      ? clamp(
        cfg.idleHappyBase + Math.sin(idleElapsedSeconds * 0.23 + 0.85) * cfg.idleHappyAmplitude,
        0,
        0.022
      )
      : 0;

    idleRelaxedWeight += (idleRelaxedTarget - idleRelaxedWeight) * idleBlendFactor;
    idleHappyWeight += (idleHappyTarget - idleHappyWeight) * idleBlendFactor;

    PASSIVE_EMOTION_NAMES.forEach((emotionName) => {
      const state = layerStates.get(emotionName);
      if (!state) {
        return;
      }

      state.currentWeight = state.startWeight + (state.targetWeight - state.startWeight) * easedTransition;

      const idleWeight = emotionName === "relaxed"
        ? idleRelaxedWeight
        : emotionName === "happy"
          ? idleHappyWeight
          : 0;

      setExpressionWeight(emotionName, clamp(state.currentWeight + idleWeight, 0, 1));
    });
  }

  function dispose(): void {
    PASSIVE_EMOTION_NAMES.forEach((emotionName) => {
      setExpressionWeight(emotionName, 0);
    });
  }

  return {
    setEmotion,
    update,
    dispose
  };
}
