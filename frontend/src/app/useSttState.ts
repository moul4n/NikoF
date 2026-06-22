import { useEffect, useRef, useState } from "react";
import type { BackendSttInputDeviceDocument, BackendSttStateDocument } from "../shared/types/character";

export const STT_STATE_ROUTE_PATH = "/session/stt";
export const STT_DEVICE_ROUTE_PATH = "/session/stt/device";
export const STT_DEVICES_ROUTE_PATH = "/session/stt/devices";
export const STT_LISTENING_ROUTE_PATH = "/session/stt/listening";
// The chosen microphone is persisted here so it is saved globally: the control
// page picks it, and every surface (incl. the display hold-to-talk) re-applies
// it automatically after a reload or backend restart.
export const STT_DEVICE_STORAGE_KEY = "nikof.stt.selectedDevice";

const sttPollIntervalMs = 1250;

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

export type SttLoadState = {
  status: "loading" | "ready" | "offline";
  snapshot: BackendSttStateDocument | null;
  devices: BackendSttInputDeviceDocument[];
  action: "idle" | "device" | "listening";
  message: string | null;
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildBackendApiUrl(path), {
    ...init,
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

    throw new Error(detail ?? `Backend STT request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export function describeSttStateLine(state: SttLoadState): string {
  if (state.status === "loading") {
    return "Loading STT sidecar status.";
  }

  if (state.status === "offline") {
    return state.message ?? "STT sidecar is offline.";
  }

  const snapshot = state.snapshot;
  if (!snapshot) {
    return "Awaiting STT sidecar status.";
  }

  if (!snapshot.available) {
    return snapshot.last_error ?? "STT sidecar is unavailable.";
  }

  const deviceLabel = snapshot.selected_device_label ?? "default input";
  if (snapshot.state === "detected") {
    return `Detected speech on ${deviceLabel}.`;
  }
  if (snapshot.state === "processing") {
    return `Processing confirmed speech from ${deviceLabel}.`;
  }
  if (snapshot.listening) {
    return `Listening on ${deviceLabel}.`;
  }
  if (snapshot.state === "ready") {
    return `STT sidecar ready on ${deviceLabel}.`;
  }

  return `${snapshot.state} on ${deviceLabel}.`;
}

export function useSttState(): {
  state: SttLoadState;
  setSelectedDevice: (deviceId: string | null) => Promise<void>;
  setListening: (enabled: boolean) => Promise<void>;
} {
  const [state, setState] = useState<SttLoadState>({
    status: "loading",
    snapshot: null,
    devices: [],
    action: "idle",
    message: null
  });
  const latestSnapshotRef = useRef<BackendSttStateDocument | null>(null);
  const listeningRequestRef = useRef<Promise<void> | null>(null);
  const desiredListeningStateRef = useRef<boolean | null>(null);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    latestSnapshotRef.current = state.snapshot;
  }, [state.snapshot]);

  useEffect(() => {
    let cancelled = false;

    async function refreshState(): Promise<void> {
      if (refreshInFlightRef.current) {
        return;
      }

      refreshInFlightRef.current = true;

      try {
        const [snapshot, devicesPayload] = await Promise.all([
          fetchJson<BackendSttStateDocument>(STT_STATE_ROUTE_PATH),
          fetchJson<{ devices: BackendSttInputDeviceDocument[] }>(STT_DEVICES_ROUTE_PATH)
        ]);

        if (cancelled) {
          return;
        }

        latestSnapshotRef.current = snapshot;

        setState((currentState) => ({
          status: "ready",
          snapshot,
          devices: Array.isArray(devicesPayload.devices) ? devicesPayload.devices : [],
          action: currentState.action === "idle" ? "idle" : currentState.action,
          message: null
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
          message: error instanceof Error ? error.message : "Backend STT route unavailable."
        }));
      } finally {
        refreshInFlightRef.current = false;
      }
    }

    void refreshState();
    const intervalId = window.setInterval(() => {
      void refreshState();
    }, sttPollIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  // Re-apply the globally-saved microphone after a reload or backend restart
  // (the sidecar resets its selection to none), so any surface — including the
  // display hold-to-talk — just works without re-picking the device.
  const reappliedDeviceRef = useRef(false);
  useEffect(() => {
    if (
      reappliedDeviceRef.current ||
      state.status !== "ready" ||
      !state.snapshot?.available ||
      state.snapshot?.selected_device_id ||
      state.devices.length === 0
    ) {
      return;
    }
    const persisted = typeof window !== "undefined" ? window.localStorage.getItem(STT_DEVICE_STORAGE_KEY) : null;
    if (persisted && state.devices.some((device) => device.device_id === persisted)) {
      reappliedDeviceRef.current = true;
      void setSelectedDevice(persisted);
    }
  }, [state.status, state.snapshot?.available, state.snapshot?.selected_device_id, state.devices]);

  async function setSelectedDevice(deviceId: string | null): Promise<void> {
    setState((currentState) => ({ ...currentState, action: "device", message: null }));
    try {
      const snapshot = await fetchJson<BackendSttStateDocument>(STT_DEVICE_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify({ device_id: deviceId })
      });
      latestSnapshotRef.current = snapshot;
      if (typeof window !== "undefined") {
        if (deviceId) {
          window.localStorage.setItem(STT_DEVICE_STORAGE_KEY, deviceId);
        } else {
          window.localStorage.removeItem(STT_DEVICE_STORAGE_KEY);
        }
      }
      setState((currentState) => ({
        status: "ready",
        snapshot,
        devices: currentState.devices,
        action: "idle",
        message: null
      }));
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.snapshot ? "ready" : "offline",
        action: "idle",
        message: error instanceof Error ? error.message : "Backend STT device update failed."
      }));
    }
  }

  async function flushListeningState(): Promise<void> {
    while (typeof desiredListeningStateRef.current === "boolean") {
      const nextEnabled = desiredListeningStateRef.current;
      desiredListeningStateRef.current = null;

      if ((latestSnapshotRef.current?.listening ?? false) === nextEnabled) {
        continue;
      }

      setState((currentState) => ({ ...currentState, action: "listening", message: null }));
      try {
        const snapshot = await fetchJson<BackendSttStateDocument>(STT_LISTENING_ROUTE_PATH, {
          method: "PUT",
          body: JSON.stringify({ enabled: nextEnabled })
        });
        latestSnapshotRef.current = snapshot;
        setState((currentState) => ({
          status: "ready",
          snapshot,
          devices: currentState.devices,
          action: "idle",
          message: null
        }));
      } catch (error: unknown) {
        setState((currentState) => ({
          ...currentState,
          status: currentState.snapshot ? "ready" : "offline",
          action: "idle",
          message: error instanceof Error ? error.message : "Backend STT listening update failed."
        }));
        break;
      }
    }
  }

  async function setListening(enabled: boolean): Promise<void> {
    desiredListeningStateRef.current = enabled;

    while (true) {
      if (!listeningRequestRef.current) {
        listeningRequestRef.current = flushListeningState().finally(() => {
          listeningRequestRef.current = null;
        });
      }

      await listeningRequestRef.current;

      const desiredListeningState = desiredListeningStateRef.current;
      const currentListeningState = latestSnapshotRef.current?.listening ?? false;
      if (typeof desiredListeningState !== "boolean" || desiredListeningState === currentListeningState) {
        return;
      }
    }
  }

  return {
    state,
    setSelectedDevice,
    setListening
  };
}