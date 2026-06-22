import React from "react";
import {
  DEFAULT_BASE_ANIMATION_COMMAND,
  listSharedSemanticAnimationPayloads
} from "../avatar/runtime/defaultBaseAnimation";
import type { AvatarDebugProfileView } from "../avatar/runtime/avatarRuntime";
import type { SemanticAnimationCommand, SemanticAnimationRuntimePayload } from "../shared/types/animation";

type DevDisplayAnimationOptionBehavior = "backend" | "neutral" | "command";

type DevDisplayAnimationOption = {
  id: string;
  label: string;
  description: string;
  behavior: DevDisplayAnimationOptionBehavior;
  semanticCommand?: SemanticAnimationCommand;
};

const DEV_DISPLAY_ACTION_OPTIONS: ReadonlyArray<DevDisplayAnimationOption> = [
  {
    id: "backend",
    label: "Switch to default backend",
    description: "Return the display surface to backend-driven animation selection, including the local fallback idle when delivery is offline.",
    behavior: "backend"
  },
  {
    id: "neutral.stance",
    label: "Hold neutral stance",
    description:
      "Clear all base animation playback and hold the VRM's normalized baseline standing pose with no authored or procedural root motion.",
    behavior: "neutral"
  },
];

function formatSemanticAnimationLabel(semanticId: string): string {
  return semanticId
    .split(/[._-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function buildSharedAnimationOption(payload: SemanticAnimationRuntimePayload): DevDisplayAnimationOption {
  const label = payload.semanticId === DEFAULT_BASE_ANIMATION_COMMAND.id ? "Idle Neutral" : formatSemanticAnimationLabel(payload.semanticId);
  const playbackVerb = payload.playback === "once" ? "Play" : "Loop";

  return {
    id: payload.semanticId,
    label,
    description: `${playbackVerb} ${label} on the local display surface.`,
    behavior: "command",
    semanticCommand: {
      id: payload.semanticId,
      playback: payload.playback
    }
  };
}

const DEV_DISPLAY_SHARED_ANIMATION_OPTIONS: ReadonlyArray<DevDisplayAnimationOption> = listSharedSemanticAnimationPayloads().map(
  buildSharedAnimationOption
);

export type DevDisplayAnimationOptionId = string;

export type DevDisplayAnimationOverrideState = {
  optionId: DevDisplayAnimationOptionId;
  activationKey: number;
};

const DEV_DISPLAY_PROFILE_OPTIONS = [
  {
    id: "front",
    label: "Front profile",
    description: "Keep the default forward-facing model orientation for the display surface."
  },
  {
    id: "side",
    label: "Side profile",
    description: "Rotate the whole avatar 90 degrees on the Y axis to compare silhouette and limb arcs."
  }
] as const satisfies ReadonlyArray<{
  id: AvatarDebugProfileView;
  label: string;
  description: string;
}>;

export function resolveDevDisplayAnimationOption(optionId: DevDisplayAnimationOptionId) {
  return (
    DEV_DISPLAY_ACTION_OPTIONS.find((option) => option.id === optionId) ??
    DEV_DISPLAY_SHARED_ANIMATION_OPTIONS.find((option) => option.id === optionId) ??
    DEV_DISPLAY_ACTION_OPTIONS[0]
  );
}

interface DevDisplayProfilePanelProps {
  selectedProfileView: AvatarDebugProfileView;
  onSelectProfileView: (profileView: AvatarDebugProfileView) => void;
}

interface DevDisplayRenderModePanelProps {
  rigOverlayEnabled: boolean;
  controlsEnabled: boolean;
  onSetRigOverlayEnabled: (enabled: boolean) => void;
}

export function DevDisplayProfilePanel({
  selectedProfileView,
  onSelectProfileView
}: DevDisplayProfilePanelProps): JSX.Element {
  return (
    <section className="surface-panel surface-panel--display dev-animation-panel" aria-labelledby="dev-display-profile-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Dev-only orientation</p>
          <h2 id="dev-display-profile-title">Display profile view</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        Switch the whole avatar between front and side profiles without changing camera framing or the active animation.
      </p>

      <div className="dev-animation-panel__list" role="group" aria-label="Display profile view">
        {DEV_DISPLAY_PROFILE_OPTIONS.map((option) => {
          const isActive = option.id === selectedProfileView;

          return (
            <button
              key={option.id}
              type="button"
              className={isActive ? "dev-animation-panel__button dev-animation-panel__button--active" : "dev-animation-panel__button"}
              aria-pressed={isActive}
              onClick={() => onSelectProfileView(option.id)}
            >
              <span className="dev-animation-panel__button-title">{option.label}</span>
              <span className="dev-animation-panel__button-summary">{option.description}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function DevDisplayRenderModePanel({
  rigOverlayEnabled,
  controlsEnabled,
  onSetRigOverlayEnabled
}: DevDisplayRenderModePanelProps): JSX.Element {
  return (
    <section className="surface-panel surface-panel--display dev-animation-panel" aria-labelledby="dev-display-render-mode-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Dev-only bone overlay</p>
          <h2 id="dev-display-render-mode-title">Display bone overlay</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        Toggle a skeleton-style bone overlay on the local display surface so shoulder, hip, spine, and limb alignment stay readable over the shaded avatar.
      </p>
      {!controlsEnabled ? (
        <p className="surface-panel__message">Display runtime is still mounting the avatar. Bone overlay controls unlock once the first model load is ready.</p>
      ) : null}

      <div className="dev-animation-panel__list" role="group" aria-label="Display bone overlay">
        <button
          type="button"
          className={!rigOverlayEnabled ? "dev-animation-panel__button dev-animation-panel__button--active" : "dev-animation-panel__button"}
          aria-pressed={!rigOverlayEnabled}
          disabled={!controlsEnabled}
          onClick={() => onSetRigOverlayEnabled(false)}
        >
          <span className="dev-animation-panel__button-title">Overlay off</span>
          <span className="dev-animation-panel__button-summary">Keep the normal shaded avatar with no debug rig lines.</span>
        </button>
        <button
          type="button"
          className={rigOverlayEnabled ? "dev-animation-panel__button dev-animation-panel__button--active" : "dev-animation-panel__button"}
          aria-pressed={rigOverlayEnabled}
          disabled={!controlsEnabled}
          onClick={() => onSetRigOverlayEnabled(true)}
        >
          <span className="dev-animation-panel__button-title">Bone overlay</span>
          <span className="dev-animation-panel__button-summary">Draw the avatar humanoid bones as an overlaid guide on the local display surface only.</span>
        </button>
      </div>
    </section>
  );
}


