import type { VRM } from "@pixiv/three-vrm";

/**
 * Passive randomised blink controller.
 * Drives the VRM "blink" expression (morph target) on a natural cadence
 * without interfering with bone/body animations.
 */

export interface PassiveBlinkController {
  /** Call every frame with the frame delta in seconds. */
  update(deltaSeconds: number): void;
  /** Pause blinking (e.g. during explicit expression overrides). */
  pause(): void;
  /** Resume blinking after a pause. */
  resume(): void;
  /** Clean up. */
  dispose(): void;
}

interface BlinkConfig {
  /** Minimum seconds between blinks. */
  minInterval: number;
  /** Maximum seconds between blinks. */
  maxInterval: number;
  /** Duration of the closing phase in seconds. */
  closeDuration: number;
  /** Duration of the opening phase in seconds. */
  openDuration: number;
  /** Probability of a double-blink (0..1). */
  doubleProbability: number;
  /** Delay between blinks in a double-blink pair. */
  doubleDelay: number;
}

const DEFAULT_CONFIG: BlinkConfig = {
  minInterval: 2.0,
  maxInterval: 6.0,
  closeDuration: 0.06,
  openDuration: 0.12,
  doubleProbability: 0.15,
  doubleDelay: 0.12
};

type BlinkPhase = "waiting" | "closing" | "opening" | "doubleWait";

export function createPassiveBlinkController(
  vrm: VRM,
  config: Partial<BlinkConfig> = {}
): PassiveBlinkController {
  const cfg: BlinkConfig = { ...DEFAULT_CONFIG, ...config };

  let phase: BlinkPhase = "waiting";
  let phaseElapsed = 0;
  let nextBlinkIn = randomInterval();
  let pendingDouble = false;
  let paused = false;

  function randomInterval(): number {
    return cfg.minInterval + Math.random() * (cfg.maxInterval - cfg.minInterval);
  }

  function setBlinkWeight(weight: number): void {
    // Try "blink" first, then individual left/right if the model uses split blinks
    const mgr = vrm.expressionManager;
    if (!mgr) return;

    if (mgr.getExpression("blink")) {
      mgr.setValue("blink", weight);
    } else {
      if (mgr.getExpression("blinkLeft")) mgr.setValue("blinkLeft", weight);
      if (mgr.getExpression("blinkRight")) mgr.setValue("blinkRight", weight);
    }
  }

  function update(deltaSeconds: number): void {
    if (paused || !vrm.expressionManager) return;

    phaseElapsed += deltaSeconds;

    switch (phase) {
      case "waiting":
        if (phaseElapsed >= nextBlinkIn) {
          phase = "closing";
          phaseElapsed = 0;
          pendingDouble = Math.random() < cfg.doubleProbability;
        }
        break;

      case "closing": {
        const t = Math.min(phaseElapsed / cfg.closeDuration, 1);
        setBlinkWeight(t);
        if (t >= 1) {
          phase = "opening";
          phaseElapsed = 0;
        }
        break;
      }

      case "opening": {
        const t = Math.min(phaseElapsed / cfg.openDuration, 1);
        setBlinkWeight(1 - t);
        if (t >= 1) {
          if (pendingDouble) {
            pendingDouble = false;
            phase = "doubleWait";
            phaseElapsed = 0;
          } else {
            phase = "waiting";
            phaseElapsed = 0;
            nextBlinkIn = randomInterval();
          }
        }
        break;
      }

      case "doubleWait":
        setBlinkWeight(0);
        if (phaseElapsed >= cfg.doubleDelay) {
          phase = "closing";
          phaseElapsed = 0;
        }
        break;
    }
  }

  function pause(): void {
    paused = true;
    setBlinkWeight(0);
  }

  function resume(): void {
    paused = false;
    phase = "waiting";
    phaseElapsed = 0;
    nextBlinkIn = randomInterval();
  }

  function dispose(): void {
    paused = true;
    setBlinkWeight(0);
  }

  return { update, pause, resume, dispose };
}
