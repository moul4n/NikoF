import React from "react";
import {
  DEFAULT_BASE_ANIMATION_COMMAND,
  listSharedSemanticAnimationPayloads
} from "../avatar/runtime/defaultBaseAnimation";
import type { AvatarAnimationPlaybackPath, AvatarDebugProfileView } from "../avatar/runtime/avatarRuntime";
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

function describeRuntimeAdapter(payload: SemanticAnimationRuntimePayload): string {
  if (payload.playbackAdapter === "official_mixamo_fbx") {
    return "Uses the official Mixamo FBX runtime path.";
  }

  if (payload.playbackAdapter === "vrma") {
    return "Uses the VRMA runtime path.";
  }

  if (payload.playbackAdapter === "mixer") {
    return "Uses the mixer keyframe runtime path.";
  }

  return "Uses the generated runtime payload path.";
}

function buildSharedAnimationOption(payload: SemanticAnimationRuntimePayload): DevDisplayAnimationOption {
  const label = payload.semanticId === DEFAULT_BASE_ANIMATION_COMMAND.id ? "Idle Neutral" : formatSemanticAnimationLabel(payload.semanticId);
  const playbackVerb = payload.playback === "once" ? "Play" : "Loop";

  return {
    id: payload.semanticId,
    label,
    description: `${playbackVerb} ${label} on the local display surface. ${describeRuntimeAdapter(payload)}`,
    behavior: "command",
    semanticCommand: {
      id: payload.semanticId,
      source: "shared",
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

const DEV_DISPLAY_PLAYBACK_PATH_OPTIONS = [
  {
    id: "official",
    label: "Official Mixamo adapter",
    description: "Loads raw FBX animation sources and applies the official ThreeVRM Mixamo retarget path in the display runtime. Non-FBX semantics fall back to the legacy mixer."
  },
  {
    id: "mixer",
    label: "Mixer (quaternion keyframes)",
    description: "Feeds bone quaternion keyframes directly to THREE.AnimationMixer. No manual scaling or Euler decomposition."
  },
  {
    id: "vrma",
    label: "VRMA (three-vrm-animation)",
    description: "Loads .vrma files and uses @pixiv/three-vrm-animation for native retargeting with rest-pose preservation."
  }
] as const satisfies ReadonlyArray<{
  id: AvatarAnimationPlaybackPath;
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
  const selectedSharedAnimationOption = DEV_DISPLAY_SHARED_ANIMATION_OPTIONS.find((option) => option.id === selectedOptionId) ?? null;

  return (
    <section className="surface-panel surface-panel--display dev-animation-panel" aria-labelledby="dev-animation-switcher-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Dev-only animation override</p>
          <h2 id="dev-animation-switcher-title">Local display switcher</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        This panel is dev-only and only affects the local display window. Switch back to the backend default, hold a neutral T-pose, or pick any generated shared animation from the dropdown.
      </p>
      <p className="surface-panel__message">
        Backend snapshot: {backendAnimationId ?? "Unavailable, so the local idle fallback will be used when override is off."}
      </p>
      {!controlsEnabled ? (
        <p className="surface-panel__message">Display runtime is still mounting the avatar. Local animation overrides unlock once the first model load is ready.</p>
      ) : null}

      <div className="dev-animation-panel__field">
        <label className="dev-animation-panel__label" htmlFor="dev-display-animation-select">
          Generated animation
        </label>
        <select
          id="dev-display-animation-select"
          className="dev-animation-panel__select"
          value={selectedSharedAnimationOption?.id ?? ""}
          disabled={!controlsEnabled || DEV_DISPLAY_SHARED_ANIMATION_OPTIONS.length === 0}
          onChange={(event: { currentTarget: HTMLSelectElement }) => {
            const optionId = event.currentTarget.value.trim();

            if (optionId) {
              onSelectOption(optionId);
            }
          }}
        >
          <option value="">Select a generated animation...</option>
          {DEV_DISPLAY_SHARED_ANIMATION_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <p className="dev-animation-panel__selected-summary">
        {selectedSharedAnimationOption?.description ??
          "Choose a generated animation from the dropdown to preview it locally in the display surface."}
      </p>

      <div className="dev-animation-panel__list" role="group" aria-label="Display animation override">
        {DEV_DISPLAY_ACTION_OPTIONS.map((option) => {
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
