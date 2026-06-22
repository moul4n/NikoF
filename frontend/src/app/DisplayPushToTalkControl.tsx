import React from "react";
import { usePushToTalk } from "./usePushToTalk";

type PointerLikeEvent = {
  preventDefault(): void;
  pointerId?: number;
  currentTarget?: {
    setPointerCapture?(pointerId: number): void;
    releasePointerCapture?(pointerId: number): void;
  };
};

/**
 * Hold-to-talk control for the browser display (avatar) surface, so the whole
 * voice loop can run from a single tab. Behaviour lives in {@link usePushToTalk};
 * this is just its presentation. The microphone is chosen on the control page and
 * saved globally, so there is no device picker here.
 */
export function DisplayPushToTalkControl(): JSX.Element {
  const ptt = usePushToTalk();

  return (
    <section className="surface-panel surface-panel--ptt" aria-labelledby="display-ptt-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Voice input</p>
          <h2 id="display-ptt-title">Push to talk</h2>
        </div>
      </div>
      {ptt.noDeviceSelected ? (
        <p className="ptt-status ptt-status--warn">Select your microphone on the control page to enable voice.</p>
      ) : null}
      <button
        type="button"
        className={ptt.active ? "ptt-button ptt-button--active" : "ptt-button"}
        disabled={ptt.disabled}
        aria-pressed={ptt.active}
        data-testid="display-push-to-talk"
        onPointerDown={(event: PointerLikeEvent) => {
          event.preventDefault();
          // Capture the pointer so release fires even if the button resizes
          // (its label changes while active) and the pointer drifts off it.
          if (typeof event.pointerId === "number") {
            event.currentTarget?.setPointerCapture?.(event.pointerId);
          }
          ptt.engage();
        }}
        onPointerUp={ptt.release}
        onPointerCancel={ptt.release}
      >
        {ptt.active ? "Listening… release to send" : `Hold to talk (or hold ${ptt.keyLabel})`}
      </button>
      <p className="ptt-status">{ptt.statusLine}</p>
    </section>
  );
}
