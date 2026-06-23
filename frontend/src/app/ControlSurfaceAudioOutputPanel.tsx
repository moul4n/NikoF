import React from "react";
import { useAudioOutputState } from "./useAudioOutputState.js";

/**
 * Audio output (speaker / headphones) device picker for avatar speech playback.
 * Playback runs in the browser via HTMLAudioElement.setSinkId, but the chosen
 * device is saved in the backend so it survives a restart and every surface gets
 * it on load — same backend-owned pattern as the STT input device and the stage
 * background.
 */
export function ControlSurfaceAudioOutputPanel(): JSX.Element {
  const { state, setSelectedDevice } = useAudioOutputState();

  function handleSelectedDeviceChange(event: { target: { value: string } }): void {
    const nextDeviceId = event.target.value.trim() || null;
    const nextLabel = nextDeviceId
      ? state.devices.find((device) => device.deviceId === nextDeviceId)?.label ?? null
      : null;
    void setSelectedDevice({ deviceId: nextDeviceId, deviceLabel: nextLabel });
  }

  const statusLine = !state.supported
    ? "This browser can't route audio to a specific output device; the system default is used."
    : state.status === "loading"
      ? "Loading audio output devices."
      : state.devices.length === 0
        ? "No selectable output devices detected; using the system default."
        : `Playing avatar speech on ${state.selectedDeviceLabel ?? "the system default output"}.`;

  return (
    <section className="surface-panel operator-panel" aria-labelledby="control-audio-output-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Audio output</p>
          <h2 id="control-audio-output-title">Speech playback device</h2>
        </div>
        <p className="operator-panel__stt-status">{statusLine}</p>
      </div>

      <label className="operator-panel__field" htmlFor="operator-audio-output-device">
        <span className="operator-panel__field-label">Output device</span>
        <select
          id="operator-audio-output-device"
          className="operator-panel__input"
          value={state.selectedDeviceId ?? ""}
          onChange={handleSelectedDeviceChange}
          disabled={!state.supported || state.action !== "idle" || state.status === "loading"}
        >
          <option value="">System default output</option>
          {state.devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>

      <p className="operator-panel__hint">
        The chosen output device is stored in the backend, so the display window and any reloaded surface route avatar speech to the same speakers automatically.
      </p>
      {state.message ? <p className="surface-panel__summary">{state.message}</p> : null}
    </section>
  );
}
