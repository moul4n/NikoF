import React, { useEffect, useState } from "react";
import { usePushToTalk } from "./usePushToTalk";
import { useAutoRevealOnPointer } from "./useAutoRevealOnPointer";
import {
  isAudioOutputMuted,
  setAudioOutputMuted,
  subscribeAudioOutputMuted
} from "./audioOutputControl";

type PointerLikeEvent = {
  preventDefault(): void;
  pointerId?: number;
  currentTarget?: { setPointerCapture?(pointerId: number): void };
};

function MicIcon({ muted }: { muted: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
      {muted ? <line x1="3" y1="3" x2="21" y2="21" /> : null}
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      {muted ? (
        <>
          <line x1="16" y1="9" x2="21" y2="14" />
          <line x1="21" y1="9" x2="16" y2="14" />
        </>
      ) : (
        <>
          <path d="M16 9a4 4 0 0 1 0 6" />
          <path d="M18.5 6.5a8 8 0 0 1 0 11" />
        </>
      )}
    </svg>
  );
}

function EyeIcon({ on }: { on: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {on ? (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="M4 5l16 14" />
          <path d="M9.5 5.4A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.7" />
          <path d="M6 7.2A18 18 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 3.6-.6" />
        </>
      )}
    </svg>
  );
}

/**
 * Floating, auto-hiding controls in the bottom-right of the wrapperless stage
 * window: hold-to-talk plus camera-tracking, mic-mute and audio-out-mute toggles.
 * They fade in on mouse movement and fade out after a short idle, so the avatar
 * window stays clean. Mic mute force-disables push-to-talk; audio-out mute
 * silences the avatar's reply playback for this window; the eye toggles camera
 * attention tracking (state owned by the stage shell and passed in here).
 */
export interface StageControlsProps {
  cameraTrackingOn: boolean;
  cameraTrackingAvailable: boolean;
  onToggleCameraTracking: () => void;
}

export function StageControls({
  cameraTrackingOn,
  cameraTrackingAvailable,
  onToggleCameraTracking
}: StageControlsProps): JSX.Element {
  const [micMuted, setMicMuted] = useState(false);
  const [audioMuted, setAudioMuted] = useState(() => isAudioOutputMuted());

  const ptt = usePushToTalk({ disabledExternally: micMuted });
  // Reveal on mouse movement, hide after idle — but stay visible while listening.
  const revealed = useAutoRevealOnPointer();
  const visible = revealed || ptt.active;

  // Keep the audio-mute button in sync if the mute is toggled elsewhere.
  useEffect(() => subscribeAudioOutputMuted(setAudioMuted), []);

  function toggleAudioMuted(): void {
    setAudioOutputMuted(!audioMuted);
  }

  return (
    <div className="stage-controls" data-visible={visible ? "true" : "false"}>
      {ptt.noDeviceSelected && !micMuted ? (
        <p className="stage-controls__hint">Pick a microphone on the control page to enable voice.</p>
      ) : null}
      <div className="stage-controls__row">
        <button
          type="button"
          className={cameraTrackingOn ? "stage-controls__icon stage-controls__icon--on" : "stage-controls__icon"}
          disabled={!cameraTrackingAvailable}
          aria-pressed={cameraTrackingOn}
          aria-label={cameraTrackingOn ? "Turn off camera tracking" : "Turn on camera tracking"}
          title={cameraTrackingOn ? "Camera tracking on" : "Camera tracking off"}
          onClick={onToggleCameraTracking}
        >
          <EyeIcon on={cameraTrackingOn} />
        </button>
        <button
          type="button"
          className={micMuted ? "stage-controls__icon stage-controls__icon--muted" : "stage-controls__icon"}
          aria-pressed={micMuted}
          aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
          title={micMuted ? "Microphone muted" : "Mute microphone"}
          onClick={() => setMicMuted((value) => !value)}
        >
          <MicIcon muted={micMuted} />
        </button>
        <button
          type="button"
          className={audioMuted ? "stage-controls__icon stage-controls__icon--muted" : "stage-controls__icon"}
          aria-pressed={audioMuted}
          aria-label={audioMuted ? "Unmute avatar audio" : "Mute avatar audio"}
          title={audioMuted ? "Avatar audio muted" : "Mute avatar audio"}
          onClick={toggleAudioMuted}
        >
          <SpeakerIcon muted={audioMuted} />
        </button>
        <button
          type="button"
          className={ptt.active ? "stage-ptt__button stage-ptt__button--active" : "stage-ptt__button"}
          disabled={ptt.disabled}
          aria-pressed={ptt.active}
          title={micMuted ? "Microphone muted" : ptt.statusLine}
          data-testid="stage-push-to-talk"
          onPointerDown={(event: PointerLikeEvent) => {
            event.preventDefault();
            if (typeof event.pointerId === "number") {
              event.currentTarget?.setPointerCapture?.(event.pointerId);
            }
            ptt.engage();
          }}
          onPointerUp={ptt.release}
          onPointerCancel={ptt.release}
        >
          <span className="stage-ptt__dot" aria-hidden="true" />
          {ptt.active ? "Listening… release to send" : `Hold to talk · ${ptt.keyLabel}`}
        </button>
      </div>
    </div>
  );
}
