import React, { useEffect, useRef, useState } from "react";
import { describeSttStateLine, useSttState } from "./useSttState";
import {
  PUSH_TO_TALK_STORAGE_KEY,
  formatPushToTalkBindingLabel,
  isEditableKeyboardTarget,
  matchesPushToTalkBinding,
  readPersistedPushToTalkBinding
} from "./pushToTalkBinding";

/**
 * Hold-to-talk control for the display (avatar) surface, so the whole voice
 * loop can run from a single tab — press and hold the button (or hold the
 * configured push-to-talk key) to listen, release to send. Uses the SAME
 * persisted key binding as the control settings panel, and the shared
 * useSttState seam for start/stop semantics.
 */
export function DisplayPushToTalkControl(): JSX.Element {
  const { state: sttState, setListening } = useSttState();
  const [active, setActive] = useState(false);
  const [binding, setBinding] = useState(() => readPersistedPushToTalkBinding());
  const heldRef = useRef(false);
  const startedListeningRef = useRef(false);

  const snapshot = sttState.snapshot;
  const disabled = sttState.action === "device" || sttState.status === "loading" || !snapshot?.available;
  const statusLine = describeSttStateLine(sttState);
  const keyLabel = formatPushToTalkBindingLabel(binding);

  // Keep in sync if the binding is changed on the control settings page
  // (localStorage 'storage' events fire in other tabs/surfaces).
  useEffect(() => {
    function handleStorage(event: StorageEvent): void {
      if (event.key === PUSH_TO_TALK_STORAGE_KEY) {
        setBinding(readPersistedPushToTalkBinding());
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  type PointerLikeEvent = {
    preventDefault(): void;
    pointerId?: number;
    currentTarget?: {
      setPointerCapture?(pointerId: number): void;
      releasePointerCapture?(pointerId: number): void;
    };
  };

  function engage(): void {
    if (heldRef.current || disabled) {
      return;
    }
    heldRef.current = true;
    setActive(true);
    startedListeningRef.current = !(snapshot?.listening ?? false);
    if (startedListeningRef.current) {
      void setListening(true);
    }
  }

  function release(): void {
    if (!heldRef.current) {
      return;
    }
    heldRef.current = false;
    setActive(false);
    const shouldStopListening = startedListeningRef.current;
    startedListeningRef.current = false;
    if (shouldStopListening) {
      void setListening(false);
    }
  }

  // Push-to-talk key hold (the configured binding), ignoring keypresses while
  // typing in a field.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (
        event.repeat
        || heldRef.current
        || disabled
        || isEditableKeyboardTarget(event.target)
        || !matchesPushToTalkBinding(event, binding)
      ) {
        return;
      }
      event.preventDefault();
      engage();
    }

    function handleKeyUp(event: KeyboardEvent): void {
      if (matchesPushToTalkBinding(event, binding)) {
        release();
      }
    }

    function handleRelease(): void {
      release();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleRelease);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleRelease);
    };
    // Re-bind when the binding/availability/listening change so the handlers see
    // current values (they close over `binding`, `disabled`, snapshot.listening).
  }, [binding, disabled, snapshot?.listening, setListening]);

  return (
    <section className="surface-panel surface-panel--ptt" aria-labelledby="display-ptt-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Voice input</p>
          <h2 id="display-ptt-title">Push to talk</h2>
        </div>
      </div>
      <button
        type="button"
        className={active ? "ptt-button ptt-button--active" : "ptt-button"}
        disabled={disabled}
        aria-pressed={active}
        data-testid="display-push-to-talk"
        onPointerDown={(event: PointerLikeEvent) => {
          event.preventDefault();
          // Capture the pointer so release fires even if the button resizes
          // (its label changes while active) and the pointer drifts off it.
          if (typeof event.pointerId === "number") {
            event.currentTarget?.setPointerCapture?.(event.pointerId);
          }
          engage();
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        {active ? "Listening… release to send" : `Hold to talk (or hold ${keyLabel})`}
      </button>
      <p className="ptt-status">{statusLine}</p>
    </section>
  );
}
