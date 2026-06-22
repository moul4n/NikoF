import { useEffect, useRef, useState } from "react";
import { describeSttStateLine, useSttState } from "./useSttState";
import {
  PUSH_TO_TALK_STORAGE_KEY,
  formatPushToTalkBindingLabel,
  isEditableKeyboardTarget,
  matchesPushToTalkBinding,
  readPersistedPushToTalkBinding
} from "./pushToTalkBinding";

export interface PushToTalkController {
  /** True while the hold is engaged (button held or key held). */
  active: boolean;
  /** True when the control should be inert (sidecar loading/unavailable, or no mic chosen). */
  disabled: boolean;
  /** Backend reports a usable sidecar but no input device is selected yet. */
  noDeviceSelected: boolean;
  /** Human-readable STT sidecar status line. */
  statusLine: string;
  /** Display label for the configured push-to-talk key. */
  keyLabel: string;
  /** Begin listening (idempotent while held). */
  engage: () => void;
  /** Stop listening and send the captured utterance. */
  release: () => void;
}

/**
 * Shared hold-to-talk behaviour for any surface that wants a push-to-talk
 * button: the control STT panel, the browser display surface, and the standalone
 * front-end (stage) window. STT capture is backend-owned — the sidecar records
 * from the microphone chosen (once) on the control page; this just toggles the
 * backend ``listening`` state on press/release via the shared ``useSttState``
 * seam, and binds the same persisted push-to-talk key. So the whole voice loop
 * (talk -> transcribe -> reply audio) can run from whichever surface mounts it.
 */
export interface PushToTalkOptions {
  /** Force-disable the control (e.g. the window's mic-mute toggle). */
  disabledExternally?: boolean;
}

export function usePushToTalk(options: PushToTalkOptions = {}): PushToTalkController {
  const { disabledExternally = false } = options;
  const { state: sttState, setListening } = useSttState();
  const [active, setActive] = useState(false);
  const [binding, setBinding] = useState(() => readPersistedPushToTalkBinding());
  const heldRef = useRef(false);
  const startedListeningRef = useRef(false);

  const snapshot = sttState.snapshot;
  const selectedDeviceId = snapshot?.selected_device_id ?? "";
  // No input device picked yet (this box reports no OS "default" input), so the
  // mic captures nothing until one is chosen on the control page.
  const noDeviceSelected = sttState.status === "ready" && !!snapshot?.available && !selectedDeviceId;
  const disabled =
    disabledExternally
    || sttState.action === "device"
    || sttState.status === "loading"
    || !snapshot?.available
    || noDeviceSelected;
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

  // If the control becomes disabled mid-hold (mic muted, sidecar dropped), end
  // the utterance so we don't leave the backend listening.
  useEffect(() => {
    if (disabled) {
      release();
    }
  }, [disabled]);

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
    // current values (engage/release close over `binding`, `disabled`,
    // snapshot.listening).
  }, [binding, disabled, snapshot?.listening, setListening]);

  return { active, disabled, noDeviceSelected, statusLine, keyLabel, engage, release };
}
