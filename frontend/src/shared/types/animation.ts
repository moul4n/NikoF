export const semanticAnimationIds = [
  "idle.default",
  "idle.focused",
  "listen.loop",
  "speak.loop",
  "emote.acknowledge"
] as const;

export type SemanticAnimationId = (typeof semanticAnimationIds)[number] | (string & {});

export type SemanticAnimationPlaybackMode = "loop" | "once";

export interface SemanticAnimationCommand {
  id: SemanticAnimationId;
  source: "shared" | "override";
  playback: SemanticAnimationPlaybackMode;
  intensity?: number;
  durationMs?: number;
}

export interface BackendAnimationCommandDocument {
  animation_id: string;
  character_id: string;
  state: string;
  intensity: number;
  parameters: Record<string, string>;
}