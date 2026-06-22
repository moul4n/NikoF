import type { SemanticAnimationPlaybackMode } from "./types/animation";

// The trailing token of a semantic id encodes playback (e.g. greet.bow.once,
// idle.bored.loop). It's noise in a button label, so we drop it for display.
const PLAYBACK_SUFFIX_TOKENS = new Set(["once", "loop"]);

/**
 * Human-readable label for a semantic animation id, with the trailing
 * playback token (once/loop) removed: "greet.bow.once" -> "Greet Bow",
 * "idle.bored.loop" -> "Idle Bored".
 */
export function formatSemanticAnimationLabel(semanticId: string): string {
  const segments = semanticId.split(/[._-]+/).filter((segment) => segment.length > 0);
  while (segments.length > 1 && PLAYBACK_SUFFIX_TOKENS.has(segments[segments.length - 1].toLowerCase())) {
    segments.pop();
  }
  return segments.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join(" ");
}

/**
 * Short playback badge for a clip button. Loops show "Loop"; one-shots show
 * their length to the nearest whole second ("1s", "5s"). Returns "" when the
 * length is unknown for a one-shot.
 */
export function formatAnimationDurationBadge(
  playback: SemanticAnimationPlaybackMode,
  durationMs: number | undefined
): string {
  if (playback === "loop") {
    return "Loop";
  }
  if (typeof durationMs === "number" && durationMs > 0) {
    return `${Math.max(1, Math.round(durationMs / 1000))}s`;
  }
  return "";
}
