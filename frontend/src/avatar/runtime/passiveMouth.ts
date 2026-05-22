import type { VRM } from "@pixiv/three-vrm";

/**
 * Passive idle mouth movement controller.
 * Produces subtle, natural micro-movements on mouth expressions when the
 * character is not speaking. Automatically yields when lip-sync overrides.
 */

export interface PassiveMouthController {
  /** Call every frame with the frame delta in seconds. */
  update(deltaSeconds: number): void;
  /** Signal that lip-sync is taking over — suppresses idle mouth. */
  suppressForSpeech(): void;
  /** Signal that lip-sync has ended — resumes idle mouth after a brief settle. */
  releaseFromSpeech(): void;
  /** Clean up. */
  dispose(): void;
}

interface MouthConfig {
  /** Base cycle period range (seconds) for the slow drift. */
  minCyclePeriod: number;
  maxCyclePeriod: number;
  /** Maximum weight applied to any single expression during idle. */
  maxIdleWeight: number;
  /** How quickly to fade out when speech override begins (seconds). */
  fadeOutDuration: number;
  /** How quickly to fade back in after speech ends (seconds). */
  fadeInDuration: number;
  /** Interval between micro-twitch events (seconds). */
  minTwitchInterval: number;
  maxTwitchInterval: number;
  /** Duration of a micro-twitch (seconds). */
  twitchDuration: number;
  /** Max weight of a micro-twitch. */
  twitchMaxWeight: number;
  /** Interval between rare passive breath events (seconds). */
  minBreathInterval: number;
  maxBreathInterval: number;
  /** Duration of a passive breath event (seconds). */
  breathDuration: number;
  /** Peak mouth weight during a passive breath. */
  breathMaxWeight: number;
}

const DEFAULT_CONFIG: MouthConfig = {
  minCyclePeriod: 3.0,
  maxCyclePeriod: 7.0,
  maxIdleWeight: 0.06,
  fadeOutDuration: 0.1,
  fadeInDuration: 0.4,
  minTwitchInterval: 4.0,
  maxTwitchInterval: 10.0,
  twitchDuration: 0.15,
  twitchMaxWeight: 0.1,
  minBreathInterval: 18.0,
  maxBreathInterval: 42.0,
  breathDuration: 0.9,
  breathMaxWeight: 0.18
};

/** Expression names we subtly modulate for idle mouth life. */
const IDLE_MOUTH_EXPRESSIONS = ["aa", "ih", "ou"] as const;
const CONTROLLED_MOUTH_EXPRESSIONS = ["aa", "ih", "ou", "oh"] as const;

interface DriftOscillator {
  expressionName: string;
  period: number;
  phase: number;
  amplitude: number;
  elapsed: number;
}

interface MicroTwitch {
  expressionName: string;
  elapsed: number;
  duration: number;
  peakWeight: number;
}

interface PassiveBreath {
  elapsed: number;
  duration: number;
  peakWeight: number;
}

export function createPassiveMouthController(
  vrm: VRM,
  config: Partial<MouthConfig> = {}
): PassiveMouthController {
  const cfg: MouthConfig = { ...DEFAULT_CONFIG, ...config };

  // Master gain (0..1) controlling overall intensity — fades during speech
  let masterGain = 1;
  let suppressed = false;
  let settling = false; // brief pause after speech ends before resuming

  // Slow oscillating drift per expression
  const oscillators: DriftOscillator[] = IDLE_MOUTH_EXPRESSIONS.map((name) => ({
    expressionName: name,
    period: randomInRange(cfg.minCyclePeriod, cfg.maxCyclePeriod),
    phase: Math.random() * Math.PI * 2,
    amplitude: Math.random() * cfg.maxIdleWeight,
    elapsed: 0
  }));

  // Micro-twitch state
  let nextTwitchIn = randomInRange(cfg.minTwitchInterval, cfg.maxTwitchInterval);
  let twitchTimer = 0;
  let activeTwitch: MicroTwitch | null = null;

  // Rare passive breath state
  let nextBreathIn = randomInRange(cfg.minBreathInterval, cfg.maxBreathInterval);
  let breathTimer = 0;
  let activeBreath: PassiveBreath | null = null;

  function randomInRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  function setMouthWeight(expressionName: string, weight: number): void {
    const mgr = vrm.expressionManager;
    if (!mgr) return;
    if (mgr.getExpression(expressionName)) {
      mgr.setValue(expressionName, weight);
    }
  }

  function clearAllMouth(): void {
    for (const expressionName of CONTROLLED_MOUTH_EXPRESSIONS) {
      setMouthWeight(expressionName, 0);
    }
  }

  function update(deltaSeconds: number): void {
    if (!vrm.expressionManager) return;

    // Handle fade-out when suppressed for speech
    if (suppressed) {
      masterGain = Math.max(0, masterGain - deltaSeconds / cfg.fadeOutDuration);
      if (masterGain <= 0) {
        clearAllMouth();
        return;
      }
    } else if (settling) {
      // Stay quiet briefly after speech ends, then fade in
      settling = false;
      masterGain = 0;
    } else if (masterGain < 1) {
      masterGain = Math.min(1, masterGain + deltaSeconds / cfg.fadeInDuration);
    }

    const expressionWeights = new Map<string, number>();
    for (const expressionName of CONTROLLED_MOUTH_EXPRESSIONS) {
      expressionWeights.set(expressionName, 0);
    }

    // Drift oscillators
    for (const osc of oscillators) {
      osc.elapsed += deltaSeconds;

      // Slowly shift amplitude and period for organic feel
      if (osc.elapsed > osc.period) {
        osc.elapsed -= osc.period;
        osc.period = randomInRange(cfg.minCyclePeriod, cfg.maxCyclePeriod);
        osc.amplitude = Math.random() * cfg.maxIdleWeight;
        osc.phase = Math.random() * Math.PI * 2;
      }

      const t = osc.elapsed / osc.period;
      const wave = (Math.sin(t * Math.PI * 2 + osc.phase) + 1) * 0.5; // 0..1
      let weight = wave * osc.amplitude * masterGain;

      // Add twitch contribution if active on this expression
      if (activeTwitch && activeTwitch.expressionName === osc.expressionName) {
        const twitchT = activeTwitch.elapsed / activeTwitch.duration;
        // Bell curve: fast rise, fast fall
        const twitchWeight = activeTwitch.peakWeight * Math.sin(twitchT * Math.PI);
        weight = Math.min(weight + twitchWeight * masterGain, 0.3);
      }

      expressionWeights.set(osc.expressionName, weight);
    }

    if (activeBreath) {
      const breathT = activeBreath.elapsed / activeBreath.duration;
      const breathWeight = activeBreath.peakWeight * Math.sin(breathT * Math.PI) * masterGain;
      expressionWeights.set("oh", Math.min((expressionWeights.get("oh") ?? 0) + breathWeight, 0.32));
      expressionWeights.set("aa", Math.min((expressionWeights.get("aa") ?? 0) + breathWeight * 0.35, 0.18));
    }

    for (const expressionName of CONTROLLED_MOUTH_EXPRESSIONS) {
      setMouthWeight(expressionName, expressionWeights.get(expressionName) ?? 0);
    }

    // Micro-twitch timer
    twitchTimer += deltaSeconds;
    if (!activeTwitch && twitchTimer >= nextTwitchIn) {
      const randomExpr = IDLE_MOUTH_EXPRESSIONS[Math.floor(Math.random() * IDLE_MOUTH_EXPRESSIONS.length)];
      activeTwitch = {
        expressionName: randomExpr,
        elapsed: 0,
        duration: cfg.twitchDuration,
        peakWeight: Math.random() * cfg.twitchMaxWeight
      };
      twitchTimer = 0;
      nextTwitchIn = randomInRange(cfg.minTwitchInterval, cfg.maxTwitchInterval);
    }

    if (activeTwitch) {
      activeTwitch.elapsed += deltaSeconds;
      if (activeTwitch.elapsed >= activeTwitch.duration) {
        activeTwitch = null;
      }
    }

    // Rare passive breath timer
    breathTimer += deltaSeconds;
    if (!activeBreath && breathTimer >= nextBreathIn) {
      activeBreath = {
        elapsed: 0,
        duration: cfg.breathDuration,
        peakWeight: cfg.breathMaxWeight
      };
      breathTimer = 0;
      nextBreathIn = randomInRange(cfg.minBreathInterval, cfg.maxBreathInterval);
    }

    if (activeBreath) {
      activeBreath.elapsed += deltaSeconds;
      if (activeBreath.elapsed >= activeBreath.duration) {
        activeBreath = null;
      }
    }
  }

  function suppressForSpeech(): void {
    suppressed = true;
    activeBreath = null;
  }

  function releaseFromSpeech(): void {
    suppressed = false;
    settling = true;
    activeBreath = null;
    clearAllMouth();
  }

  function dispose(): void {
    suppressed = true;
    masterGain = 0;
    clearAllMouth();
  }

  return { update, suppressForSpeech, releaseFromSpeech, dispose };
}
