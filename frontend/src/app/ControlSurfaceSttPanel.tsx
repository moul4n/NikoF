import React, { useEffect, useRef, useState } from "react";
import type { BackendSttTranscriptChunkDocument } from "../shared/types/character";
import { describeSttStateLine, useSttState } from "./useSttState.js";
import {
  formatPushToTalkBindingLabel,
  isEditableKeyboardTarget,
  isModifierOnlyKey,
  matchesPushToTalkBinding,
  normalizePushToTalkBinding,
  readPersistedPushToTalkBinding,
  writePersistedPushToTalkBinding,
  type PushToTalkBinding
} from "./pushToTalkBinding.js";

function formatSttChunkTimestamp(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "time unavailable";
  }

  return new Date(value * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function describeSttChunkDispatchState(chunk: BackendSttTranscriptChunkDocument): string {
  if (chunk.dispatch_state === "submitted") {
    return `sent to ${chunk.dispatch_target ?? "llm"}`;
  }

  if (chunk.dispatch_state === "stub-recorded") {
    return "stored for stub dispatch";
  }

  if (chunk.dispatch_state === "queued") {
    return `queued for ${chunk.dispatch_target ?? "llm"}`;
  }

  if (chunk.dispatch_state === "filtered") {
    return "kept as debug-only";
  }

  if (chunk.dispatch_state === "error") {
    return "dispatch error";
  }

  return chunk.dispatch_state;
}

/**
 * Speech-to-text controls + push-to-talk binding. Extracted from the operator
 * command monolith so the "STT" tab owns it directly. Input selection updates
 * the sidecar through the backend; confirmed chunks are stored in the backend
 * STT buffer and surfaced here for debugging.
 */
export function ControlSurfaceSttPanel(): JSX.Element {
  const { state: sttState, setSelectedDevice, setListening } = useSttState();
  const [pushToTalkBinding, setPushToTalkBinding] = useState<PushToTalkBinding>(() => readPersistedPushToTalkBinding());
  const [isCapturingPushToTalkKey, setIsCapturingPushToTalkKey] = useState(false);
  const [isPushToTalkActive, setIsPushToTalkActive] = useState(false);
  const pushToTalkHeldRef = useRef(false);
  const pushToTalkStartedListeningRef = useRef(false);

  const sttSnapshot = sttState.snapshot;
  const sttStatusLine = describeSttStateLine(sttState);
  const sttTranscriptChunks = sttSnapshot?.transcript_chunks ?? [];
  const sttLatestTranscript =
    sttTranscriptChunks[0]?.transcript ?? sttSnapshot?.latest_confirmed_text ?? "Awaiting a queued transcript from the STT sidecar.";
  const sttListeningButtonLabel = sttSnapshot?.listening ? "Stop listening" : "Start listening";
  const sttControlsDisabled = sttState.action !== "idle" || sttState.status === "loading";
  const sttPushToTalkDisabled = sttState.action === "device" || sttState.status === "loading" || !sttSnapshot?.available;
  const pushToTalkKeyLabel = formatPushToTalkBindingLabel(pushToTalkBinding);
  const pushToTalkButtonLabel = isCapturingPushToTalkKey ? "Press a key..." : `Push-to-talk key: ${pushToTalkKeyLabel}`;
  const pushToTalkStatusLine = isCapturingPushToTalkKey
    ? "Press any non-modifier key to bind push-to-talk. Press Escape to cancel."
    : isPushToTalkActive
      ? `Holding ${pushToTalkKeyLabel} keeps STT capture open until release.`
      : `Hold ${pushToTalkKeyLabel} anywhere on the control surface to talk. Focused text fields are ignored.`;

  useEffect(() => {
    writePersistedPushToTalkBinding(pushToTalkBinding);
  }, [pushToTalkBinding]);

  useEffect(() => {
    function releasePushToTalk(): void {
      if (!pushToTalkHeldRef.current) {
        return;
      }

      pushToTalkHeldRef.current = false;
      setIsPushToTalkActive(false);

      const shouldStopListening = pushToTalkStartedListeningRef.current;
      pushToTalkStartedListeningRef.current = false;
      if (shouldStopListening) {
        void setListening(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (isCapturingPushToTalkKey) {
        if (event.repeat) {
          return;
        }

        event.preventDefault();
        if (event.key === "Escape") {
          setIsCapturingPushToTalkKey(false);
          return;
        }

        if (isModifierOnlyKey(event.key)) {
          return;
        }

        setPushToTalkBinding(
          normalizePushToTalkBinding({
            code: event.code || null,
            key: event.key || null
          })
        );
        setIsCapturingPushToTalkKey(false);
        return;
      }

      if (!matchesPushToTalkBinding(event, pushToTalkBinding) || isEditableKeyboardTarget(event.target)) {
        return;
      }

      event.preventDefault();
      if (event.repeat || pushToTalkHeldRef.current || sttPushToTalkDisabled) {
        return;
      }

      pushToTalkHeldRef.current = true;
      setIsPushToTalkActive(true);
      pushToTalkStartedListeningRef.current = !(sttSnapshot?.listening ?? false);
      if (pushToTalkStartedListeningRef.current) {
        void setListening(true);
      }
    }

    function handleKeyUp(event: KeyboardEvent): void {
      if (isCapturingPushToTalkKey || !matchesPushToTalkBinding(event, pushToTalkBinding)) {
        return;
      }

      event.preventDefault();
      releasePushToTalk();
    }

    function handleWindowBlur(): void {
      setIsCapturingPushToTalkKey(false);
      releasePushToTalk();
    }

    function handleVisibilityChange(): void {
      if (!document.hidden) {
        return;
      }

      setIsCapturingPushToTalkKey(false);
      releasePushToTalk();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isCapturingPushToTalkKey, pushToTalkBinding, setListening, sttPushToTalkDisabled, sttSnapshot?.listening]);

  function handleSelectedDeviceChange(event: { target: { value: string } }): void {
    const nextDeviceId = event.target.value.trim() || null;
    void setSelectedDevice(nextDeviceId);
  }

  function handleListeningToggle(): void {
    void setListening(!(sttSnapshot?.listening ?? false));
  }

  return (
    <section className="surface-panel operator-panel" aria-labelledby="control-stt-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Speech-to-text</p>
          <h2 id="control-stt-title">Hot mic sidecar</h2>
        </div>
        <p className="operator-panel__stt-status">{sttStatusLine}</p>
      </div>

      <label className="operator-panel__field" htmlFor="operator-stt-device">
        <span className="operator-panel__field-label">Audio input</span>
        <select
          id="operator-stt-device"
          className="operator-panel__input"
          value={sttSnapshot?.selected_device_id ?? ""}
          onChange={handleSelectedDeviceChange}
          disabled={sttControlsDisabled}
        >
          {sttState.devices.length === 0 ? <option value="">No backend input devices detected</option> : null}
          {sttState.devices.map((device) => (
            <option key={device.device_id} value={device.device_id}>
              {device.label}
              {device.default ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="operator-panel__actions">
        <button
          className="operator-panel__button"
          type="button"
          onClick={handleListeningToggle}
          disabled={sttControlsDisabled || !sttSnapshot?.available}
        >
          {sttState.action === "listening" ? "Updating microphone state..." : sttListeningButtonLabel}
        </button>
        <button
          className={isCapturingPushToTalkKey || isPushToTalkActive ? "operator-panel__button operator-panel__button--active" : "operator-panel__button"}
          type="button"
          onClick={() => {
            setIsCapturingPushToTalkKey((currentValue) => !currentValue);
          }}
          aria-pressed={isCapturingPushToTalkKey}
        >
          {pushToTalkButtonLabel}
        </button>
      </div>

      <p className="operator-panel__hint">{pushToTalkStatusLine}</p>

      <div className="operator-panel__stt-transcript" aria-live="polite">
        <div className="operator-panel__stt-transcript-header">
          <p className="operator-panel__stt-transcript-label">STT output window</p>
          <p className="operator-panel__stt-transcript-meta">{sttTranscriptChunks.length} stored chunks</p>
        </div>
        <p className="operator-panel__stt-transcript-text">{sttLatestTranscript}</p>
        <div className="operator-panel__stt-log" role="list" aria-label="Recent STT transcript chunks">
          {sttTranscriptChunks.length === 0 ? (
            <p className="operator-panel__stt-log-empty">Waiting for confirmed speech chunks from the hot-mic sidecar.</p>
          ) : (
            sttTranscriptChunks.map((chunk) => (
              <article key={chunk.chunk_id} className="operator-panel__stt-log-entry" role="listitem">
                <div className="operator-panel__stt-log-entry-header">
                  <p className="operator-panel__stt-log-entry-title">{describeSttChunkDispatchState(chunk)}</p>
                  <p className="operator-panel__stt-log-entry-meta">
                    {formatSttChunkTimestamp(chunk.captured_at)} · {(chunk.duration_ms / 1000).toFixed(2)}s
                    {typeof chunk.confidence === "number" ? ` · ${(chunk.confidence * 100).toFixed(0)}% conf` : ""}
                  </p>
                </div>
                <p className="operator-panel__stt-log-entry-text">{chunk.transcript}</p>
                {chunk.dispatch_detail ? (
                  <p className="operator-panel__stt-log-entry-detail">{chunk.dispatch_detail}</p>
                ) : null}
              </article>
            ))
          )}
        </div>
      </div>

      <p className="operator-panel__hint">
        Browser controls stay backend-owned here: input selection updates the sidecar through the backend, confirmed chunks are stored in the backend STT buffer for debugging, and accepted chunks are marked for stub or live downstream dispatch.
      </p>
      {sttState.message ? <p className="surface-panel__summary">{sttState.message}</p> : null}
    </section>
  );
}
