import React, { useEffect, useRef, useState } from "react";
import { describeSttStateLine, useSttState } from "./useSttState";

/**
 * Hold-to-talk control for the display (avatar) surface, so the whole voice
 * loop can run from a single tab — press and hold the button (or hold Space) to
 * listen, release to send. Mirrors the control surface's push-to-talk semantics
 * (start listening on engage if not already listening; stop on release only if
 * this control started it) via the shared useSttState seam.
 */
export function DisplayPushToTalkControl(): JSX.Element {
  const { state: sttState, setListening } = useSttState();
  const [active, setActive] = useState(false);
  const heldRef = useRef(false);
  const startedListeningRef = useRef(false);

  const snapshot = sttState.snapshot;
  const disabled = sttState.action === "device" || sttState.status === "loading" || !snapshot?.available;
  const statusLine = describeSttStateLine(sttState);

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

  // Space-bar hold mirrors the button, ignoring keypresses while typing.
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      const element = target as HTMLElement | null;
      if (!element || typeof element.tagName !== "string") {
        return false;
      }
      return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable === true;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.code !== "Space" || event.repeat || heldRef.current || disabled || isTypingTarget(event.target)) {
        return;
      }
      event.preventDefault();
      engage();
    }

    function handleKeyUp(event: KeyboardEvent): void {
      if (event.code === "Space") {
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
    // Re-bind when availability or listening state changes so engage/release see
    // current values (they close over `disabled` and `snapshot.listening`).
  }, [disabled, snapshot?.listening, setListening]);

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
        {active ? "Listening… release to send" : "Hold to talk (or hold Space)"}
      </button>
      <p className="ptt-status">{statusLine}</p>
    </section>
  );
}
