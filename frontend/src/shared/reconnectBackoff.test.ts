import { describe, expect, it } from "vitest";
import { computeReconnectDelayMs } from "./reconnectBackoff";

describe("computeReconnectDelayMs", () => {
  const noJitter = { random: () => 0 };

  it("grows exponentially from the base on each attempt", () => {
    expect(computeReconnectDelayMs(0, { baseMs: 1000, ...noJitter })).toBe(1000);
    expect(computeReconnectDelayMs(1, { baseMs: 1000, ...noJitter })).toBe(2000);
    expect(computeReconnectDelayMs(2, { baseMs: 1000, ...noJitter })).toBe(4000);
    expect(computeReconnectDelayMs(3, { baseMs: 1000, ...noJitter })).toBe(8000);
  });

  it("never exceeds the cap (pre-jitter)", () => {
    expect(computeReconnectDelayMs(50, { baseMs: 1000, capMs: 30000, ...noJitter })).toBe(30000);
    expect(computeReconnectDelayMs(999, { baseMs: 1000, capMs: 30000, ...noJitter })).toBe(30000);
  });

  it("adds at most jitterRatio on top of the delay", () => {
    const base = computeReconnectDelayMs(2, { baseMs: 1000, jitterRatio: 0.25, random: () => 0 });
    const jittered = computeReconnectDelayMs(2, { baseMs: 1000, jitterRatio: 0.25, random: () => 1 });
    expect(base).toBe(4000);
    expect(jittered).toBe(5000); // 4000 + 25%
    // A mid-range random lands strictly between the two bounds.
    const mid = computeReconnectDelayMs(2, { baseMs: 1000, jitterRatio: 0.25, random: () => 0.5 });
    expect(mid).toBeGreaterThanOrEqual(base);
    expect(mid).toBeLessThanOrEqual(jittered);
  });

  it("is monotonic non-decreasing across attempts with fixed jitter", () => {
    let previous = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = computeReconnectDelayMs(attempt, { baseMs: 1000, capMs: 30000, random: () => 0 });
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it("treats negative/NaN attempts as attempt 0 and stays finite", () => {
    expect(computeReconnectDelayMs(-5, { baseMs: 1000, ...noJitter })).toBe(1000);
    expect(computeReconnectDelayMs(Number.NaN, { baseMs: 1000, ...noJitter })).toBe(1000);
    expect(Number.isFinite(computeReconnectDelayMs(1024, { baseMs: 1000, capMs: 30000 }))).toBe(true);
  });
});
