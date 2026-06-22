import React, { useEffect, useState } from "react";
import type { CharacterCatalogEntry } from "../../shared/types/character";
import { listSharedSemanticAnimationPayloads } from "../runtime/defaultBaseAnimation";
import type { AvatarRuntimeBridge } from "../runtime/avatarRuntime";
import { getAvatarRuntimeMountPoints } from "../runtime/mountPoints";

const DISPLAY_EMOTION_OPTIONS = [
  { value: null, label: "Neutral" },
  { value: "happy", label: "Happy" },
  { value: "sad", label: "Sad" },
  { value: "angry", label: "Angry" },
  { value: "relaxed", label: "Relaxed" },
  { value: "surprised", label: "Surprised" }
] as const;

const DISPLAY_ANIMATION_BUTTON_EXCLUDED_IDS = new Set(["idle.default", "listen.loop", "speak.loop"]);
const DISPLAY_IDLE_SELECTOR_IDS = ["idle.neutral", "idle.happy", "idle.sad"] as const;
const DISPLAY_IDLE_SELECTOR_ID_SET = new Set<string>(DISPLAY_IDLE_SELECTOR_IDS);

const DISPLAY_ANIMATION_OPTIONS = listSharedSemanticAnimationPayloads()
  .filter((payload) => !DISPLAY_ANIMATION_BUTTON_EXCLUDED_IDS.has(payload.semanticId))
  .map((payload) => ({
    id: payload.semanticId,
    label: formatSemanticAnimationLabel(payload.semanticId),
    playbackLabel: payload.playback === "loop" ? "Loop" : "Once",
    command: {
      id: payload.semanticId,
      source: "shared",
      playback: payload.playback
    } as const
  }));

const DISPLAY_IDLE_OPTIONS = DISPLAY_IDLE_SELECTOR_IDS.flatMap((semanticId) =>
  DISPLAY_ANIMATION_OPTIONS.filter((option) => option.id === semanticId)
);

const DISPLAY_ONE_SHOT_OPTIONS = DISPLAY_ANIMATION_OPTIONS.filter((option) => option.command.playback === "once");

const DISPLAY_LOOP_MOTION_OPTIONS = DISPLAY_ANIMATION_OPTIONS.filter(
  (option) => option.command.playback === "loop" && !DISPLAY_IDLE_SELECTOR_ID_SET.has(option.id)
);

interface AvatarStageProps {
  runtime: AvatarRuntimeBridge;
  selectedCharacter: CharacterCatalogEntry | null;
  variant?: "embedded" | "display";
  onSelectDisplayAnimationOverride?: (optionId: string) => void;
  // Optional overlay (voice captions) rendered over the bottom of the avatar
  // viewport on the display surface, in place of the static "ready" message.
  captionsSlot?: JSX.Element | null;
}

function formatSemanticAnimationLabel(semanticId: string): string {
  return semanticId
    .split(/[._-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function describeOverlayChannel(channel: ReturnType<AvatarRuntimeBridge["snapshot"]>["overlayChannels"][number]): string {
  if (!channel.active || channel.mode === "idle") {
    return `${channel.channelId} idle`;
  }

  if (channel.mode === "viseme") {
    return channel.label ? `${channel.channelId} ${channel.mode} ${channel.label}` : `${channel.channelId} ${channel.mode}`;
  }

  return `${channel.channelId} ${channel.mode}`;
}

export function AvatarStage({
  runtime,
  selectedCharacter,
  variant = "embedded",
  onSelectDisplayAnimationOverride,
  captionsSlot
}: AvatarStageProps): JSX.Element {
  const mountPoints = getAvatarRuntimeMountPoints(variant);
  const [snapshot, setSnapshot] = useState(() => runtime.snapshot());

  useEffect(() => {
    setSnapshot(runtime.snapshot());

    return runtime.subscribe(() => {
      setSnapshot(runtime.snapshot());
    });
  }, [runtime]);

  useEffect(() => {
    runtime.mount(mountPoints);

    return () => {
      runtime.unmount();
    };
  }, [mountPoints, runtime]);

  const runtimeStatusLabel =
    snapshot.loadState === "loading"
      ? "loading vrm"
      : snapshot.loadState === "ready"
        ? "vrm ready"
        : snapshot.loadState === "error"
          ? "load failed"
          : snapshot.mounted
            ? "mounted"
            : "pending mount";
  const baseLayerLabel = snapshot.baseAnimation?.id ?? snapshot.pendingAnimation?.id ?? "neutral";
  const activeOverlayChannels = snapshot.overlayChannels.filter((channel) => channel.active);
  const overlayActivityLabel =
    activeOverlayChannels.length > 0 ? activeOverlayChannels.map(describeOverlayChannel).join(" + ") : "overlay idle";
  const runtimeActivityLabel = `base ${baseLayerLabel} · ${overlayActivityLabel}`;
  const headerStatusLabel = `${runtimeStatusLabel} · ${runtimeActivityLabel}`;
  const selectedIdleLabel = formatSemanticAnimationLabel(snapshot.idleAnimation?.id ?? "idle.neutral");

  const shellTitle = variant === "display" ? "Dedicated avatar render window" : "Default character shell";
  const shellEyebrow = variant === "display" ? "Display surface" : "Avatar runtime";
  const emptySelectionMessage =
    variant === "display"
      ? "The display surface is ready to mount the backend-confirmed character once one is selected."
      : "Select the default character to mount the runtime.";
  const readyMessage =
    activeOverlayChannels.length > 0
      ? `The mounted avatar is holding ${baseLayerLabel} as the base layer while ${overlayActivityLabel} runs as a live overlay.`
      : variant === "display"
      ? "The display surface is rendering the manifest-resolved VRM."
      : "The default shell is now rendering the imported VRM.";
  const displayCharacterLabel = selectedCharacter?.summary.displayName ?? "Waiting for backend-confirmed selection";
  const emotionControlsEnabled = Boolean(selectedCharacter) && snapshot.loadState === "ready";
  const animationControlsEnabled = Boolean(selectedCharacter) && snapshot.loadState === "ready";

  function triggerDisplayAnimation(optionId: string, command: (typeof DISPLAY_ANIMATION_OPTIONS)[number]["command"]): void {
    if (variant === "display" && onSelectDisplayAnimationOverride) {
      onSelectDisplayAnimationOverride(optionId);
      return;
    }

    runtime.play(command);
  }

  return (
    <section className={variant === "display" ? "avatar-stage avatar-stage--display" : "avatar-stage"} aria-labelledby="avatar-stage-title">
      <div className={variant === "display" ? "avatar-stage__header avatar-stage__header--display" : "avatar-stage__header"}>
        <div>
          <p className="eyebrow">{shellEyebrow}</p>
          <h2 id="avatar-stage-title">{shellTitle}</h2>
        </div>
        <span className="avatar-stage__status">{headerStatusLabel}</span>
      </div>

      <div className={variant === "display" ? "avatar-stage__surface avatar-stage__surface--display" : "avatar-stage__surface"}>
        <div className={variant === "display" ? "avatar-stage__viewport-shell avatar-stage__viewport-shell--display" : "avatar-stage__viewport-shell"}>
          {variant === "display" ? (
            <div className="avatar-stage__display-banner" aria-label="Display runtime summary">
              <span className="avatar-stage__display-chip">{displayCharacterLabel}</span>
              <span className="avatar-stage__display-chip">{runtimeStatusLabel}</span>
              <span className="avatar-stage__display-chip">base {baseLayerLabel}</span>
              <span className="avatar-stage__display-chip">{overlayActivityLabel}</span>
              <span className="avatar-stage__display-chip">left drag rotate · right drag pan · wheel zoom</span>
            </div>
          ) : null}
          <div id={mountPoints.viewportElementId} className="avatar-stage__viewport" />
          {!selectedCharacter ? <p className="avatar-stage__viewport-message">{emptySelectionMessage}</p> : null}
          {snapshot.loadState === "loading" ? (
            <p className="avatar-stage__viewport-message avatar-stage__viewport-message--loading">Loading the bundled VRM from the manifest-resolved model URL...</p>
          ) : null}
          {snapshot.error ? <p className="avatar-stage__viewport-message avatar-stage__viewport-message--error">{snapshot.error}</p> : null}
          {snapshot.loadState === "ready"
            ? variant === "display"
              ? captionsSlot ?? null
              : <p className="avatar-stage__viewport-message">{readyMessage}</p>
            : null}
        </div>
        {variant === "display" ? (
          <>
            <div className="avatar-stage__emotion-controls" aria-label="Facial expression controls">
              {DISPLAY_EMOTION_OPTIONS.map((option) => {
                const isActive = snapshot.activeEmotion === option.value;

                return (
                  <button
                    key={option.label}
                    type="button"
                    className={isActive ? "avatar-stage__emotion-button avatar-stage__emotion-button--active" : "avatar-stage__emotion-button"}
                    aria-pressed={isActive}
                    disabled={!emotionControlsEnabled}
                    onClick={() => {
                      runtime.setEmotion(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <section className="avatar-stage__animation-controls" aria-label="Animation test controls">
              <div className="avatar-stage__animation-controls-header">
                <p className="eyebrow">Local motion tests</p>
                <p className="avatar-stage__animation-controls-summary">
                  Choose the current return idle, then fire one-shot shared motions and let them settle back to that selected idle.
                </p>
              </div>
              <div className="avatar-stage__animation-section">
                <div className="avatar-stage__animation-section-header">
                  <p className="avatar-stage__animation-section-title">Idle selector</p>
                  <p className="avatar-stage__animation-controls-summary">Current return idle: {selectedIdleLabel}</p>
                </div>
                <div className="avatar-stage__animation-grid avatar-stage__animation-grid--compact">
                  {DISPLAY_IDLE_OPTIONS.map((option) => {
                    const isActive = snapshot.idleAnimation?.id === option.id;

                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={isActive ? "avatar-stage__animation-button avatar-stage__animation-button--active" : "avatar-stage__animation-button"}
                        aria-pressed={isActive}
                        disabled={!animationControlsEnabled}
                        onClick={() => {
                          runtime.setIdleAnimation(option.command, { source: "manual" });
                        }}
                      >
                        <span className="avatar-stage__animation-button-title">{option.label}</span>
                        <span className="avatar-stage__animation-button-summary">Selected idle</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="avatar-stage__animation-section">
                <div className="avatar-stage__animation-section-header">
                  <p className="avatar-stage__animation-section-title">One-shot motions</p>
                  <p className="avatar-stage__animation-controls-summary">Trigger a single motion, then return to the selected idle.</p>
                </div>
                <div className="avatar-stage__animation-grid">
                  {DISPLAY_ONE_SHOT_OPTIONS.map((option) => {
                    const isActive = snapshot.baseAnimation?.id === option.id || snapshot.pendingAnimation?.id === option.id;

                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={isActive ? "avatar-stage__animation-button avatar-stage__animation-button--active" : "avatar-stage__animation-button"}
                        aria-pressed={isActive}
                        disabled={!animationControlsEnabled}
                        onClick={() => {
                          triggerDisplayAnimation(option.id, option.command);
                        }}
                      >
                        <span className="avatar-stage__animation-button-title">{option.label}</span>
                        <span className="avatar-stage__animation-button-summary">{option.playbackLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {DISPLAY_LOOP_MOTION_OPTIONS.length > 0 ? (
                <div className="avatar-stage__animation-section">
                  <div className="avatar-stage__animation-section-header">
                    <p className="avatar-stage__animation-section-title">Continuous motions</p>
                    <p className="avatar-stage__animation-controls-summary">Optional looped motions that can temporarily replace the current idle.</p>
                  </div>
                  <div className="avatar-stage__animation-grid">
                    {DISPLAY_LOOP_MOTION_OPTIONS.map((option) => {
                      const isActive = snapshot.baseAnimation?.id === option.id || snapshot.pendingAnimation?.id === option.id;

                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={isActive ? "avatar-stage__animation-button avatar-stage__animation-button--active" : "avatar-stage__animation-button"}
                          aria-pressed={isActive}
                          disabled={!animationControlsEnabled}
                          onClick={() => {
                            triggerDisplayAnimation(option.id, option.command);
                          }}
                        >
                          <span className="avatar-stage__animation-button-title">{option.label}</span>
                          <span className="avatar-stage__animation-button-summary">{option.playbackLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </section>
          </>
        ) : null}
        {variant === "display" ? null : (
          <aside id={mountPoints.overlayElementId} className="avatar-stage__overlay">
            <h3>Selected character</h3>
            {selectedCharacter ? (
              <dl>
                <div>
                  <dt>Display name</dt>
                  <dd>{selectedCharacter.summary.displayName}</dd>
                </div>
                <div>
                  <dt>Manifest</dt>
                  <dd>{selectedCharacter.manifestUrl}</dd>
                </div>
                <div>
                  <dt>Model URL</dt>
                  <dd>{snapshot.currentModelUrl ?? selectedCharacter.summary.assets.modelUrl}</dd>
                </div>
                <div>
                  <dt>Runtime status</dt>
                  <dd>{runtimeStatusLabel}</dd>
                </div>
                <div>
                  <dt>Activity</dt>
                  <dd>{runtimeActivityLabel}</dd>
                </div>
                <div>
                  <dt>Base layer</dt>
                  <dd>{baseLayerLabel}</dd>
                </div>
                <div>
                  <dt>Overlay channels</dt>
                  <dd>{snapshot.overlayChannels.map(describeOverlayChannel).join(", ")}</dd>
                </div>
                <div>
                  <dt>Shared animation set</dt>
                  <dd>{selectedCharacter.summary.sharedAnimationSet}</dd>
                </div>
              </dl>
            ) : (
              <p>Select a character package to inspect its resolved runtime inputs.</p>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}