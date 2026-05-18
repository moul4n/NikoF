import React from "react";
import type { AvatarAnimationPlaybackPath, AvatarDebugProfileView } from "../avatar/runtime/avatarRuntime";
import type { SemanticAnimationCommand } from "../shared/types/animation";

const DEV_DISPLAY_ANIMATION_OPTIONS = [
  {
    id: "backend",
    label: "Backend live",
    description: "Use the backend-selected session animation, or the local idle fallback when backend delivery is offline.",
    behavior: "backend"
  },
  {
    id: "neutral.stance",
    label: "Hold neutral stance",
    description:
      "Clear all base animation playback and hold the VRM's normalized baseline standing pose with no authored or procedural root motion.",
    behavior: "neutral"
  },
  {
    id: "idle.default",
    label: "Force idle.default",
    description: "Loop the refreshed shared idle clip directly in the display window.",
    behavior: "command",
    semanticCommand: {
      id: "idle.default",
      source: "shared",
      playback: "loop"
    }
  },

] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  behavior: "backend" | "neutral" | "command";
  semanticCommand?: SemanticAnimationCommand;
}>;

export type DevDisplayAnimationOptionId = (typeof DEV_DISPLAY_ANIMATION_OPTIONS)[number]["id"];

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

const DEV_DISPLAY_PLAYBACK_PATH_OPTIONS = [
  {
    id: "mixer",
    label: "Mixer (quaternion keyframes)",
    description: "Feeds bone quaternion keyframes directly to THREE.AnimationMixer. No manual scaling or Euler decomposition."
  }
] as const satisfies ReadonlyArray<{
  id: AvatarAnimationPlaybackPath;
  label: string;
  description: string;
}>;

export function resolveDevDisplayAnimationOption(optionId: DevDisplayAnimationOptionId) {
  return DEV_DISPLAY_ANIMATION_OPTIONS.find((option) => option.id === optionId) ?? DEV_DISPLAY_ANIMATION_OPTIONS[0];
}

interface DevAnimationSwitcherPanelProps {
  selectedOptionId: DevDisplayAnimationOptionId;
  backendAnimationId: string | null;
  controlsEnabled: boolean;
  onSelectOption: (optionId: DevDisplayAnimationOptionId) => void;
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

interface DevDisplayPlaybackPathPanelProps {
  selectedPlaybackPath: AvatarAnimationPlaybackPath;
  onSelectPlaybackPath: (playbackPath: AvatarAnimationPlaybackPath) => void;
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

export function DevAnimationSwitcherPanel({
  selectedOptionId,
  backendAnimationId,
  controlsEnabled,
  onSelectOption
}: DevAnimationSwitcherPanelProps): JSX.Element {
  return (
    <section className="surface-panel surface-panel--display dev-animation-panel" aria-labelledby="dev-animation-switcher-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Dev-only animation override</p>
          <h2 id="dev-animation-switcher-title">Local display switcher</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        This panel is dev-only and only affects the local display window. Neutral stance clears animation entirely; click the punch option again to replay the one-shot clip.
      </p>
      <p className="surface-panel__message">
        Backend snapshot: {backendAnimationId ?? "Unavailable, so the local idle fallback will be used when override is off."}
      </p>
      {!controlsEnabled ? (
        <p className="surface-panel__message">Display runtime is still mounting the avatar. Local animation overrides unlock once the first model load is ready.</p>
      ) : null}

      <div className="dev-animation-panel__list" role="group" aria-label="Display animation override">
        {DEV_DISPLAY_ANIMATION_OPTIONS.map((option) => {
          const isActive = option.id === selectedOptionId;

          return (
            <button
              key={option.id}
              type="button"
              className={isActive ? "dev-animation-panel__button dev-animation-panel__button--active" : "dev-animation-panel__button"}
              aria-pressed={isActive}
              disabled={!controlsEnabled}
              onClick={() => onSelectOption(option.id)}
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

export function DevDisplayPlaybackPathPanel({
  selectedPlaybackPath,
  onSelectPlaybackPath
}: DevDisplayPlaybackPathPanelProps): JSX.Element {
  return (
    <section className="surface-panel surface-panel--display dev-animation-panel" aria-labelledby="dev-display-playback-path-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Dev-only display routes</p>
          <h2 id="dev-display-playback-path-title">Playback route</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        Switch the local display window between the legacy channel remap, the canonical idle stability slice, and the mixer-backed three-vrm-style punch spike.
      </p>

      <div className="dev-animation-panel__list" role="group" aria-label="Display playback route">
        {DEV_DISPLAY_PLAYBACK_PATH_OPTIONS.map((option) => {
          const isActive = option.id === selectedPlaybackPath;

          return (
            <button
              key={option.id}
              type="button"
              className={isActive ? "dev-animation-panel__button dev-animation-panel__button--active" : "dev-animation-panel__button"}
              aria-pressed={isActive}
              onClick={() => onSelectPlaybackPath(option.id)}
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
