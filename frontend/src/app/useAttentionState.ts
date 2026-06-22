import { useEffect, useRef, useState } from "react";
import type { BackendAttentionInputDeviceDocument, BackendAttentionStateDocument } from "../shared/types/character";

export const ATTENTION_STATE_ROUTE_PATH = "/session/attention";
export const ATTENTION_LIVE_ROUTE_PATH = "/session/attention/live";
export const ATTENTION_DEVICE_ROUTE_PATH = "/session/attention/device";
export const ATTENTION_DEVICES_ROUTE_PATH = "/session/attention/devices";
export const ATTENTION_ENABLED_ROUTE_PATH = "/session/attention/enabled";
export const ATTENTION_TRACKING_ROUTE_PATH = "/session/attention/tracking";
export const ATTENTION_DEBUG_MARKER_ROUTE_PATH = "/session/attention/debug-marker";
const ATTENTION_DEBUG_MARKER_STORAGE_KEY = "nikof.attention.showTrackingDebugMarker";
// Persist the operator's camera-attention intent (chosen on the control page) so
// it survives reloads AND backend restarts, and is re-applied on every surface
// — including the display window — rather than resetting to off.
const ATTENTION_ENABLED_STORAGE_KEY = "nikof.attention.enabled";
const ATTENTION_TRACKING_STORAGE_KEY = "nikof.attention.tracking";
const ATTENTION_DEVICE_STORAGE_KEY = "nikof.attention.selectedDevice";
const ATTENTION_DEVICE_LABEL_STORAGE_KEY = "nikof.attention.selectedDeviceLabel";

const attentionPollIntervalMs = 1250;

function readPersistedAttentionDebugMarkerEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(ATTENTION_DEBUG_MARKER_STORAGE_KEY) === "true";
}

function readPersistedBoolean(key: string): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem(key);
  return value === null ? null : value === "true";
}

function writePersistedBoolean(key: string, value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(key, value ? "true" : "false");
}

function writePersistedString(key: string, value: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  if (value) {
    window.localStorage.setItem(key, value);
  } else {
    window.localStorage.removeItem(key);
  }
}

function writePersistedAttentionDebugMarkerEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!enabled) {
    window.localStorage.removeItem(ATTENTION_DEBUG_MARKER_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(ATTENTION_DEBUG_MARKER_STORAGE_KEY, "true");
}

function resolveApiBaseUrl(): string {
  const configuredBaseUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_BACKEND_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return "/api";
  }

  return configuredBaseUrl.replace(/\/+$/, "");
}

function buildBackendApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${resolveApiBaseUrl()}${normalizedPath}`;
}

export type AttentionLoadState = {
  status: "loading" | "ready" | "offline";
  snapshot: BackendAttentionStateDocument | null;
  devices: BackendAttentionInputDeviceDocument[];
  action: "idle" | "device" | "enabled" | "tracking";
  message: string | null;
  showTrackingDebugMarker: boolean;
};

export interface AttentionDeviceSelectionInput {
  deviceId: string | null;
  deviceLabel?: string | null;
}

function pickNewerSnapshot(
  currentSnapshot: BackendAttentionStateDocument | null,
  incomingSnapshot: BackendAttentionStateDocument,
): BackendAttentionStateDocument {
  if (!currentSnapshot) {
    return incomingSnapshot;
  }

  return incomingSnapshot.next_sequence >= currentSnapshot.next_sequence ? incomingSnapshot : currentSnapshot;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildBackendApiUrl(path), {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    let detail: string | null = null;
    try {
      const payload = (await response.json()) as { detail?: string };
      detail = typeof payload.detail === "string" ? payload.detail : null;
    } catch {
      detail = null;
    }

    throw new Error(detail ?? `Backend attention request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export function describeAttentionStateLine(state: AttentionLoadState): string {
  if (state.status === "loading") {
    return "Loading camera attention status.";
  }

  if (state.status === "offline") {
    return state.message ?? "Camera attention is offline.";
  }

  const snapshot = state.snapshot;
  if (!snapshot) {
    return "Awaiting camera attention status.";
  }

  if (!snapshot.available) {
    return snapshot.last_error ?? "Camera attention is unavailable.";
  }

  if (!snapshot.enabled) {
    return "Camera attention is disabled.";
  }

  const deviceLabel = snapshot.selected_device_label ?? "default camera";
  if (snapshot.state === "tracking") {
    return `Tracking attention from ${deviceLabel}.`;
  }
  if (snapshot.state === "degraded") {
    return snapshot.last_error ?? `Camera attention is degraded on ${deviceLabel}.`;
  }
  return `${snapshot.state} on ${deviceLabel}.`;
}

export function useAttentionState(): {
  state: AttentionLoadState;
  setSelectedDevice: (input: AttentionDeviceSelectionInput) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setTracking: (enabled: boolean) => Promise<void>;
  setShowTrackingDebugMarker: (enabled: boolean) => Promise<void>;
} {
  const [state, setState] = useState<AttentionLoadState>({
    status: "loading",
    snapshot: null,
    devices: [],
    action: "idle",
    message: null,
    showTrackingDebugMarker: readPersistedAttentionDebugMarkerEnabled()
  });

  useEffect(() => {
    function handleStorage(event: StorageEvent): void {
      if (event.key !== ATTENTION_DEBUG_MARKER_STORAGE_KEY) {
        return;
      }

      setState((currentState) => ({
        ...currentState,
        showTrackingDebugMarker: event.newValue === "true"
      }));
    }

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let eventSource: EventSource | null = null;
    let pollTimeoutId: number | null = null;
    let deliveryMode: "live" | "snapshot" = "snapshot";

    async function refreshState(): Promise<void> {
      try {
        const [snapshot, devicesPayload] = await Promise.all([
          fetchJson<BackendAttentionStateDocument>(ATTENTION_STATE_ROUTE_PATH),
          fetchJson<{ devices: BackendAttentionInputDeviceDocument[] }>(ATTENTION_DEVICES_ROUTE_PATH)
        ]);

        if (cancelled) {
          return;
        }

        setState((currentState) => ({
          status: "ready",
          snapshot: pickNewerSnapshot(currentState.snapshot, snapshot),
          devices: Array.isArray(devicesPayload.devices) ? devicesPayload.devices : [],
          action: currentState.action === "idle" ? "idle" : currentState.action,
          message: currentState.message,
          showTrackingDebugMarker: currentState.showTrackingDebugMarker
        }));
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setState((currentState) => ({
          status: "offline",
          snapshot: currentState.snapshot,
          devices: currentState.devices,
          action: "idle",
          message: error instanceof Error ? error.message : "Backend attention route unavailable.",
          showTrackingDebugMarker: currentState.showTrackingDebugMarker
        }));
      } finally {
        schedulePolling();
      }
    }

    function clearPolling(): void {
      if (pollTimeoutId !== null) {
        window.clearTimeout(pollTimeoutId);
        pollTimeoutId = null;
      }
    }

    function schedulePolling(): void {
      if (cancelled || pollTimeoutId !== null) {
        return;
      }

      pollTimeoutId = window.setTimeout(() => {
        pollTimeoutId = null;
        void refreshState();
      }, attentionPollIntervalMs);
    }

    function connectLive(): void {
      if (cancelled || typeof window === "undefined" || typeof window.EventSource !== "function" || eventSource) {
        return;
      }

      eventSource = new window.EventSource(buildBackendApiUrl(ATTENTION_LIVE_ROUTE_PATH));

      eventSource.addEventListener("open", () => {
        if (cancelled) {
          return;
        }

        deliveryMode = "live";
        setState((currentState) => ({
          ...currentState,
          message: null
        }));
        schedulePolling();
      });

      eventSource.addEventListener("session.attention", (event) => {
        consumeLiveSnapshot(event);
      });

      eventSource.onmessage = (event) => {
        consumeLiveSnapshot(event);
      };

      eventSource.onerror = () => {
        if (cancelled) {
          return;
        }

        eventSource?.close();
        eventSource = null;
        deliveryMode = "snapshot";
        setState((currentState) => ({
          ...currentState,
          message: "Live attention delivery disconnected; using snapshot polling."
        }));
        schedulePolling();
      };
    }

    function consumeLiveSnapshot(event: Event): void {
      try {
        const snapshot = JSON.parse((event as MessageEvent<string>).data) as BackendAttentionStateDocument;

        if (cancelled) {
          return;
        }

        deliveryMode = "live";
        setState((currentState) => ({
          status: "ready",
          snapshot: pickNewerSnapshot(currentState.snapshot, snapshot),
          devices: currentState.devices,
          action: currentState.action,
          message: null,
          showTrackingDebugMarker: currentState.showTrackingDebugMarker
        }));
        schedulePolling();
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        eventSource?.close();
        eventSource = null;
        deliveryMode = "snapshot";
        setState((currentState) => ({
          ...currentState,
          message: error instanceof Error ? error.message : "Live attention event payload could not be parsed."
        }));
        schedulePolling();
      }
    }

    void refreshState();
    connectLive();

    return () => {
      cancelled = true;
      clearPolling();
      eventSource?.close();
      eventSource = null;
    };
  }, []);

  // Once the backend reports a usable camera, re-apply the persisted operator
  // intent (device -> enabled -> tracking) so a reload or backend restart
  // restores the same on/off state on whichever surface mounts first. Runs at
  // most once; later user toggles update the persisted intent directly.
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (reconciledRef.current || state.status !== "ready" || !state.snapshot?.available) {
      return;
    }
    const persistedDevice = typeof window !== "undefined" ? window.localStorage.getItem(ATTENTION_DEVICE_STORAGE_KEY) : null;
    const persistedDeviceLabel = typeof window !== "undefined" ? window.localStorage.getItem(ATTENTION_DEVICE_LABEL_STORAGE_KEY) : null;
    const persistedEnabled = readPersistedBoolean(ATTENTION_ENABLED_STORAGE_KEY);
    const persistedTracking = readPersistedBoolean(ATTENTION_TRACKING_STORAGE_KEY);
    const persistedDebugMarker = readPersistedAttentionDebugMarkerEnabled();

    if (persistedDevice === null && persistedEnabled === null && persistedTracking === null && !persistedDebugMarker) {
      reconciledRef.current = true;
      return;
    }

    const snapshot = state.snapshot;
    reconciledRef.current = true;
    void (async () => {
      if (
        persistedDevice &&
        state.devices.some((device) => device.device_id === persistedDevice) &&
        snapshot.selected_device_id !== persistedDevice
      ) {
        await setSelectedDevice({ deviceId: persistedDevice, deviceLabel: persistedDeviceLabel });
      }
      if (persistedEnabled !== null && snapshot.enabled !== persistedEnabled) {
        await setEnabled(persistedEnabled);
      }
      if (persistedTracking !== null && persistedEnabled !== false && snapshot.tracking !== persistedTracking) {
        await setTracking(persistedTracking);
      }
      // Only restore an explicit "on" preference; the marker default is off and
      // the persisted key is absent when disabled, so there is nothing to push
      // when persistedDebugMarker is false.
      if (persistedDebugMarker && snapshot.show_tracking_debug_marker !== true) {
        await setShowTrackingDebugMarker(true);
      }
    })();
  }, [state.status, state.snapshot?.available, state.devices]);

  async function setSelectedDevice(input: AttentionDeviceSelectionInput): Promise<void> {
    setState((currentState) => ({ ...currentState, action: "device", message: null }));
    try {
      const snapshot = await fetchJson<BackendAttentionStateDocument>(ATTENTION_DEVICE_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify({ device_id: input.deviceId, device_label: input.deviceLabel ?? null })
      });
      writePersistedString(ATTENTION_DEVICE_STORAGE_KEY, input.deviceId);
      writePersistedString(ATTENTION_DEVICE_LABEL_STORAGE_KEY, input.deviceLabel ?? null);
      const devicesPayload = await fetchJson<{ devices: BackendAttentionInputDeviceDocument[] }>(ATTENTION_DEVICES_ROUTE_PATH);
      setState((currentState) => ({
        status: "ready",
        snapshot: pickNewerSnapshot(currentState.snapshot, snapshot),
        devices: Array.isArray(devicesPayload.devices) ? devicesPayload.devices : [],
        action: "idle",
        message: null,
        showTrackingDebugMarker: currentState.showTrackingDebugMarker
      }));
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.snapshot ? "ready" : "offline",
        action: "idle",
        message: error instanceof Error ? error.message : "Backend attention device update failed."
      }));
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    setState((currentState) => ({ ...currentState, action: "enabled", message: null }));
    try {
      const snapshot = await fetchJson<BackendAttentionStateDocument>(ATTENTION_ENABLED_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      writePersistedBoolean(ATTENTION_ENABLED_STORAGE_KEY, enabled);
      setState((currentState) => ({
        status: "ready",
        snapshot: pickNewerSnapshot(currentState.snapshot, snapshot),
        devices: currentState.devices,
        action: "idle",
        message: null,
        showTrackingDebugMarker: currentState.showTrackingDebugMarker
      }));
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.snapshot ? "ready" : "offline",
        action: "idle",
        message: error instanceof Error ? error.message : "Backend attention enabled update failed."
      }));
    }
  }

  async function setTracking(enabled: boolean): Promise<void> {
    setState((currentState) => ({ ...currentState, action: "tracking", message: null }));
    try {
      const snapshot = await fetchJson<BackendAttentionStateDocument>(ATTENTION_TRACKING_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      writePersistedBoolean(ATTENTION_TRACKING_STORAGE_KEY, enabled);
      setState((currentState) => ({
        status: "ready",
        snapshot: pickNewerSnapshot(currentState.snapshot, snapshot),
        devices: currentState.devices,
        action: "idle",
        message: null,
        showTrackingDebugMarker: currentState.showTrackingDebugMarker
      }));
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.snapshot ? "ready" : "offline",
        action: "idle",
        message: error instanceof Error ? error.message : "Backend attention tracking update failed."
      }));
    }
  }

  // The tracking dot is rendered on whichever surface draws the avatar — now
  // primarily the standalone front-end window, which is a separate webview and
  // never sees this page's localStorage. Route the toggle through the backend so
  // the shared attention snapshot carries it to every surface; persist locally
  // too so the operator intent is restored after a backend restart.
  async function setShowTrackingDebugMarker(enabled: boolean): Promise<void> {
    writePersistedAttentionDebugMarkerEnabled(enabled);
    setState((currentState) => ({ ...currentState, showTrackingDebugMarker: enabled }));
    try {
      const snapshot = await fetchJson<BackendAttentionStateDocument>(ATTENTION_DEBUG_MARKER_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      setState((currentState) => ({
        ...currentState,
        snapshot: pickNewerSnapshot(currentState.snapshot, snapshot)
      }));
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        message: error instanceof Error ? error.message : "Backend attention debug marker update failed."
      }));
    }
  }

  // Prefer the backend snapshot's marker flag (shared across surfaces) over the
  // page-local persisted value, so the standalone front-end window and the
  // control surface always agree on whether the dot is shown.
  const effectiveShowTrackingDebugMarker =
    typeof state.snapshot?.show_tracking_debug_marker === "boolean"
      ? state.snapshot.show_tracking_debug_marker
      : state.showTrackingDebugMarker;

  return {
    state: { ...state, showTrackingDebugMarker: effectiveShowTrackingDebugMarker },
    setSelectedDevice,
    setEnabled,
    setTracking,
    setShowTrackingDebugMarker
  };
}