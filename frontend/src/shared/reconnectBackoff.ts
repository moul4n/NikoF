/**
 * Exponential reconnect backoff with jitter.
 *
 * Clients that retry a disconnected backend on a fixed interval hammer it in
 * lockstep while it is recovering (thundering herd). This grows the delay
 * exponentially per consecutive failed attempt up to a cap, and adds random
 * jitter so multiple surfaces (control / display / stage) don't retry in sync.
 * Reset the attempt counter to 0 on a successful reconnect.
 */

export interface ReconnectBackoffOptions {
  /** Delay for attempt 0, before exponential growth. */
  baseMs?: number;
  /** Upper bound on the (pre-jitter) delay. */
  capMs?: number;
  /** Extra jitter as a fraction of the delay (0.25 = up to +25%). */
  jitterRatio?: number;
  /** Injectable randomness for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_CAP_MS = 30000;
const DEFAULT_JITTER_RATIO = 0.25;

export function computeReconnectDelayMs(attempt: number, options: ReconnectBackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const capMs = options.capMs ?? DEFAULT_CAP_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;

  const safeAttempt = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  // 2 ** safeAttempt can overflow to Infinity for large attempts; min() with the
  // cap first keeps it bounded and finite.
  const exponential = Math.min(capMs, baseMs * 2 ** Math.min(safeAttempt, 53));
  const jitter = exponential * Math.max(0, jitterRatio) * Math.max(0, Math.min(1, random()));
  return Math.round(exponential + jitter);
}
