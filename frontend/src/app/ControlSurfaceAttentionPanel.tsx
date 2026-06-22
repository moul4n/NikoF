import React from "react";
import { describeAttentionStateLine, useAttentionState } from "./useAttentionState.js";
import { useAttentionCapture } from "../features/vision/useAttentionCapture.js";

function formatAttentionCoordinate(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return value.toFixed(2);
}

/**
 * Camera attention / focus tracking controls. Extracted from the operator
 * command monolith so the "Tracking & Audio" tab owns it directly. Device
 * selection, enabled/tracking state, and the canonical attention snapshot stay
 * backend-owned; the toggle for the display tracking dot is routed through the
 * backend so it reaches the standalone front-end window too.
 *
 * Webcam capture itself is owned exclusively by the standalone front-end (stage)
 * window, so capture is forced off here — the hook's device-enumeration effect
 * still runs to keep the camera picker populated.
 */
export function ControlSurfaceAttentionPanel(): JSX.Element {
  const {
    state: attentionState,
    setSelectedDevice: setSelectedAttentionDevice,
    setEnabled: setAttentionEnabled,
    setTracking: setAttentionTracking,
    setShowTrackingDebugMarker
  } = useAttentionState();

  const attentionSnapshot = attentionState.snapshot;
  const attentionStatusLine = describeAttentionStateLine(attentionState);
  const attentionControlsDisabled = attentionState.action !== "idle" || attentionState.status === "loading";
  const attentionSubject = attentionSnapshot?.subject ?? null;
  const attentionEnabledButtonLabel = attentionSnapshot?.enabled ? "Disable attention" : "Enable attention";
  const attentionTrackingButtonLabel = attentionSnapshot?.tracking ? "Stop tracking" : "Start tracking";

  const attentionCaptureState = useAttentionCapture({
    enabled: false,
    tracking: false,
    selectedDeviceId: attentionSnapshot?.selected_device_id ?? null,
    selectedDeviceLabel: attentionSnapshot?.selected_device_label ?? null
  });
  const attentionDevices = attentionCaptureState.devices.length > 0 ? attentionCaptureState.devices : attentionState.devices;

  function handleSelectedAttentionDeviceChange(event: { target: { value: string } }): void {
    const nextDeviceId = event.target.value.trim() || null;
    const nextDevice = attentionDevices.find((device) => {
      if ("device_id" in device) {
        return device.device_id === nextDeviceId;
      }

      return device.deviceId === nextDeviceId;
    });
    const nextDeviceLabel = nextDevice ? ("label" in nextDevice ? nextDevice.label : null) : null;
    void setSelectedAttentionDevice({ deviceId: nextDeviceId, deviceLabel: nextDeviceLabel });
  }

  function handleAttentionEnabledToggle(): void {
    void setAttentionEnabled(!(attentionSnapshot?.enabled ?? false));
  }

  function handleAttentionTrackingToggle(): void {
    void setAttentionTracking(!(attentionSnapshot?.tracking ?? false));
  }

  function handleAttentionDebugMarkerToggle(event: { target: { checked: boolean } }): void {
    void setShowTrackingDebugMarker(event.target.checked);
  }

  return (
    <section className="surface-panel operator-panel" aria-labelledby="control-attention-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Camera attention</p>
          <h2 id="control-attention-title">Focus &amp; tracking</h2>
        </div>
        <p className="operator-panel__stt-status">{attentionStatusLine}</p>
      </div>

      <p className="surface-panel__summary">
        The standalone front-end window owns the webcam and posts observations; this control sets the camera source,
        enabled/tracking state, and whether the gaze tracking dot is drawn on the display.
      </p>

      <label className="operator-panel__field" htmlFor="operator-attention-device">
        <span className="operator-panel__field-label">Camera source</span>
        <select
          id="operator-attention-device"
          className="operator-panel__input"
          value={attentionSnapshot?.selected_device_id ?? ""}
          onChange={handleSelectedAttentionDeviceChange}
          disabled={attentionControlsDisabled}
        >
          {attentionDevices.length === 0 ? <option value="">No browser camera sources detected</option> : null}
          {attentionDevices.map((device) => (
            <option key={("device_id" in device ? device.device_id : device.deviceId)} value={"device_id" in device ? device.device_id : device.deviceId}>
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
          onClick={handleAttentionEnabledToggle}
          disabled={attentionControlsDisabled || !attentionSnapshot?.available}
        >
          {attentionState.action === "enabled" ? "Updating attention state..." : attentionEnabledButtonLabel}
        </button>
        <button
          className="operator-panel__button"
          type="button"
          onClick={handleAttentionTrackingToggle}
          disabled={attentionControlsDisabled || !attentionSnapshot?.enabled}
        >
          {attentionState.action === "tracking" ? "Updating tracking state..." : attentionTrackingButtonLabel}
        </button>
      </div>

      <label className="operator-panel__checkbox" htmlFor="operator-attention-debug-marker">
        <input
          id="operator-attention-debug-marker"
          type="checkbox"
          checked={attentionState.showTrackingDebugMarker}
          onChange={handleAttentionDebugMarkerToggle}
        />
        <span>Show display tracking dot</span>
      </label>

      <div className="operator-panel__stt-transcript" aria-live="polite">
        <div className="operator-panel__stt-transcript-header">
          <p className="operator-panel__stt-transcript-label">Attention snapshot</p>
          <p className="operator-panel__stt-transcript-meta">
            {attentionSubject ? `${((attentionSnapshot?.confidence ?? 0) * 100).toFixed(0)}% confidence` : "No tracked subject"}
          </p>
        </div>
        <p className="operator-panel__stt-transcript-text">
          {attentionSubject
            ? `x ${formatAttentionCoordinate(attentionSubject.normalized_x)} · y ${formatAttentionCoordinate(attentionSubject.normalized_y)}`
            : "Waiting for normalized attention observations from the standalone front-end camera capture path."}
        </p>
        <div className="operator-panel__stt-log" role="list" aria-label="Current attention metrics">
          <article className="operator-panel__stt-log-entry" role="listitem">
            <div className="operator-panel__stt-log-entry-header">
              <p className="operator-panel__stt-log-entry-title">Backend attention state</p>
              <p className="operator-panel__stt-log-entry-meta">{attentionSnapshot?.fps_target ?? 8} fps target</p>
            </div>
            <p className="operator-panel__stt-log-entry-text">
              Enabled: {attentionSnapshot?.enabled ? "yes" : "no"} · Tracking: {attentionSnapshot?.tracking ? "yes" : "no"}
            </p>
            <p className="operator-panel__stt-log-entry-detail">
              Frame: {attentionSnapshot?.frame_width ?? 320} x {attentionSnapshot?.frame_height ?? 240}
            </p>
          </article>
        </div>
      </div>

      {attentionState.message ? <p className="surface-panel__summary">{attentionState.message}</p> : null}
    </section>
  );
}
