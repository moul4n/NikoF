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
const STT_DEVICE_STORAGE_KEY = "nikof.stt.selectedDevice";

export function DisplayPushToTalkControl(): JSX.Element {
  const { state: sttState, setListening, setSelectedDevice } = useSttState();
  const [active, setActive] = useState(false);
  const [binding, setBinding] = useState(() => readPersistedPushToTalkBinding());
  const heldRef = useRef(false);
  const startedListeningRef = useRef(false);
  const reappliedDeviceRef = useRef(false);

  const snapshot = sttState.snapshot;
  const devices = sttState.devices;
  const selectedDeviceId = snapshot?.selected_device_id ?? "";
  // No input device picked yet (this box reports no OS "default" input), so the
  // mic captures nothing until one is chosen — surface that as a clear blocker.
  const noDeviceSelected = sttState.status === "ready" && !!snapshot?.available && !selectedDeviceId;
  const disabled =
    sttState.action === "device" || sttState.status === "loading" || !snapshot?.available || noDeviceSelected;
  const statusLine = describeSttStateLine(sttState);
  const keyLabel = formatPushToTalkBindingLabel(binding);

  // Re-apply the previously chosen device after a reload/backend restart (which
  // resets the sidecar's selection to none), so single-tab use just works.
  useEffect(() => {
    if (reappliedDeviceRef.current || sttState.status !== "ready" || selectedDeviceId || devices.length === 0) {
      return;
    }
    const persisted = typeof window !== "undefined" ? window.localStorage.getItem(STT_DEVICE_STORAGE_KEY) : null;
    if (persisted && devices.some((device) => device.device_id === persisted)) {
      reappliedDeviceRef.current = true;
      void setSelectedDevice(persisted);
    }
  }, [devices, selectedDeviceId, sttState.status, setSelectedDevice]);

  function handleSelectDevice(deviceId: string): void {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STT_DEVICE_STORAGE_KEY, deviceId);
    }
    void setSelectedDevice(deviceId || null);
  }

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
      <label className="ptt-device">
        <span className="ptt-device__label">Microphone</span>
        <select
          className="ptt-device__select"
          value={selectedDeviceId}
          disabled={sttState.action === "device" || devices.length === 0}
          onChange={(event: { currentTarget: { value: string } }) => handleSelectDevice(event.currentTarget.value)}
        >
          <option value="">Select a microphone…</option>
          {devices.map((device) => (
            <option key={device.device_id} value={device.device_id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      {noDeviceSelected ? (
        <p className="ptt-status ptt-status--warn">Pick your microphone above to enable voice.</p>
      ) : null}
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
