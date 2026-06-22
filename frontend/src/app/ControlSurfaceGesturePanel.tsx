import React, { useState } from "react";
import { listSharedSemanticAnimationPayloads } from "../avatar/runtime/defaultBaseAnimation";
import { submitSessionGesture, SessionGestureSubmitError } from "../avatar/loaders/sessionGesture";
import { formatSemanticAnimationLabel, formatAnimationDurationBadge } from "../shared/animationLabels";
import type { SemanticAnimationRuntimePayload } from "../shared/types/animation";

interface AnimationOption {
  id: string;
  label: string;
  durationLabel: string;
}

function toOption(payload: SemanticAnimationRuntimePayload): AnimationOption {
  return {
    id: payload.semanticId,
    label: formatSemanticAnimationLabel(payload.semanticId),
    durationLabel: formatAnimationDurationBadge(payload.playback, payload.durationMs)
  };
}

const ALL_PAYLOADS = listSharedSemanticAnimationPayloads();

// Conversation-state loops (listen/speak/reply) are driven by the turn pipeline,
// not manual operator control, so they are excluded from the manual buttons.
const CONVERSATION_LOOP_PREFIX = /^(listen|speak|reply)\./;

// Persistent base-layer idles (replace the base, loop until changed).
const IDLE_OPTIONS = ALL_PAYLOADS.filter((payload) => payload.semanticId.startsWith("idle.")).map((payload) =>
  toOption(payload)
);

// One-shot gestures (play once, settle back to the current idle).
const GESTURE_OPTIONS = ALL_PAYLOADS.filter((payload) => payload.playback === "once").map((payload) =>
  toOption(payload)
);

// Continuous, non-idle motions (e.g. dance) that replace the base layer until changed.
const LOOP_OPTIONS = ALL_PAYLOADS.filter(
  (payload) =>
    payload.playback === "loop" &&
    !payload.semanticId.startsWith("idle.") &&
    !CONVERSATION_LOOP_PREFIX.test(payload.semanticId)
).map((payload) => toOption(payload));

export function ControlSurfaceGesturePanel(): JSX.Element {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  // The current persistent base-layer animation (idle or loop). Gestures are
  // one-shots and do not change it, so the chosen idle/loop stays highlighted.
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);

  async function handleTriggerAnimation(semanticId: string, isBaseLayer: boolean): Promise<void> {
    setPendingId(semanticId);
    setStatusMessage(null);
    setIsError(false);
    if (isBaseLayer) {
      setSelectedBaseId(semanticId);
    }
    try {
      await submitSessionGesture(semanticId);
      setStatusMessage(`Sent ${formatSemanticAnimationLabel(semanticId)} to the avatar display.`);
    } catch (error) {
      const detail =
        error instanceof SessionGestureSubmitError ? error.detail ?? error.message : "Animation request failed.";
      setStatusMessage(detail);
      setIsError(true);
    } finally {
      setPendingId(null);
    }
  }

  function renderGroup(
    title: string,
    summary: string,
    options: AnimationOption[],
    isBaseLayer: boolean
  ): JSX.Element | null {
    if (options.length === 0) {
      return null;
    }
    return (
      <div className="control-gesture-panel__group">
        <p className="control-gesture-panel__group-title">{title}</p>
        <p className="control-gesture-panel__group-summary">{summary}</p>
        <div className="control-gesture-panel__grid">
          {options.map((option) => {
            const isActive = isBaseLayer && selectedBaseId === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={
                  isActive
                    ? "control-gesture-panel__button control-gesture-panel__button--active"
                    : "control-gesture-panel__button"
                }
                aria-pressed={isBaseLayer ? isActive : undefined}
                disabled={pendingId !== null}
                aria-busy={pendingId === option.id}
                onClick={() => void handleTriggerAnimation(option.id, isBaseLayer)}
              >
                <span className="control-gesture-panel__button-label">{option.label}</span>
                {option.durationLabel ? (
                  <span className="control-gesture-panel__button-duration">{option.durationLabel}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section className="surface-panel control-gesture-panel" aria-labelledby="control-animation-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Avatar control</p>
          <h2 id="control-animation-title">Animation control</h2>
        </div>
      </div>
      <p className="surface-panel__summary">
        Drive the avatar display / stage window over the backend. Idles and loops replace the base motion (continuous until changed); gestures play once and settle back to the current idle.
      </p>
      {renderGroup("Idle states", "Continuous base idle — persists until another animation is sent.", IDLE_OPTIONS, true)}
      {renderGroup("Gestures", "One-shot motions — play once, then return to the current idle.", GESTURE_OPTIONS, false)}
      {renderGroup("Loops", "Continuous motions that replace the base until another animation is sent.", LOOP_OPTIONS, true)}
      {statusMessage ? (
        <p
          className={isError ? "surface-panel__message surface-panel__message--error" : "surface-panel__message"}
          role="status"
        >
          {statusMessage}
        </p>
      ) : null}
    </section>
  );
}
