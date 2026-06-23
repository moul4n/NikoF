import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAudioOutputSelection,
  setAudioOutputSelection,
  type AudioOutputSelection
} from "./audioOutput.js";
import {
  isAudioOutputSinkSelectionSupported,
  setAudioOutputSinkId
} from "./audioOutputControl.js";

const audioOutputPollIntervalMs = 3000;

export interface AudioOutputDeviceOption {
  deviceId: string;
  label: string;
}

export type AudioOutputState = {
  status: "loading" | "ready" | "offline";
  supported: boolean;
  selectedDeviceId: string | null;
  selectedDeviceLabel: string | null;
  devices: AudioOutputDeviceOption[];
  action: "idle" | "device";
  message: string | null;
};

async function enumerateOutputDevices(): Promise<AudioOutputDeviceOption[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audiooutput" && device.deviceId)
      .map((device, index) => ({
        deviceId: device.deviceId,
        // Labels are blank until the page has been granted media permission;
        // fall back to a stable positional name so the picker is still usable.
        label: device.label?.trim() || (device.deviceId === "default" ? "System default" : `Output device ${index + 1}`)
      }));
  } catch {
    return [];
  }
}

/**
 * Apply-only hook for surfaces that just need to route avatar speech to the
 * backend-saved output device (e.g. the standalone display window). Loads the
 * saved selection on mount and re-applies it when it changes, so a control-surface
 * change reaches every surface. Does not enumerate devices or render a picker.
 */
export function useAudioOutputSink(): void {
  useEffect(() => {
    if (!isAudioOutputSinkSelectionSupported()) {
      return;
    }
    let cancelled = false;
    let lastApplied: string | null | undefined;

    async function syncSink(): Promise<void> {
      const selection = await getAudioOutputSelection();
      if (cancelled || selection === null) {
        return;
      }
      if (selection.deviceId !== lastApplied) {
        lastApplied = selection.deviceId;
        await setAudioOutputSinkId(selection.deviceId);
      }
    }

    void syncSink();
    const intervalId = window.setInterval(() => void syncSink(), audioOutputPollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);
}

/**
 * Full output-device picker state for the control surface: enumerates the
 * browser's output devices, reflects the backend-saved selection, applies the
 * chosen sink to playback, and persists the choice to the backend.
 */
export function useAudioOutputState(): {
  state: AudioOutputState;
  setSelectedDevice: (option: { deviceId: string | null; deviceLabel: string | null }) => Promise<void>;
  refreshDevices: () => Promise<void>;
} {
  const supported = isAudioOutputSinkSelectionSupported();
  const [state, setState] = useState<AudioOutputState>({
    status: "loading",
    supported,
    selectedDeviceId: null,
    selectedDeviceLabel: null,
    devices: [],
    action: "idle",
    message: null
  });
  const appliedRef = useRef<string | null | undefined>(undefined);

  const applySelection = useCallback((selection: AudioOutputSelection) => {
    if (supported && selection.deviceId !== appliedRef.current) {
      appliedRef.current = selection.deviceId;
      void setAudioOutputSinkId(selection.deviceId);
    }
  }, [supported]);

  const loadDevices = useCallback(async (): Promise<AudioOutputDeviceOption[]> => {
    const devices = await enumerateOutputDevices();
    setState((current) => ({ ...current, devices }));
    return devices;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initialise(): Promise<void> {
      const [selection, devices] = await Promise.all([getAudioOutputSelection(), enumerateOutputDevices()]);
      if (cancelled) {
        return;
      }
      if (selection) {
        applySelection(selection);
      }
      setState((current) => ({
        ...current,
        status: "ready",
        devices,
        selectedDeviceId: selection?.deviceId ?? null,
        selectedDeviceLabel: selection?.deviceLabel ?? null,
        message: null
      }));
    }

    void initialise();

    // Output devices can be plugged/unplugged at runtime; refresh the list when
    // the browser signals a device change.
    const handleDeviceChange = (): void => void loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);

    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
    };
  }, [applySelection, loadDevices]);

  const setSelectedDevice = useCallback(
    async (option: { deviceId: string | null; deviceLabel: string | null }): Promise<void> => {
      setState((current) => ({ ...current, action: "device", message: null }));
      // Apply locally first so playback re-routes immediately, then persist.
      applySelection({ deviceId: option.deviceId, deviceLabel: option.deviceLabel });
      const saved = await setAudioOutputSelection({ deviceId: option.deviceId, deviceLabel: option.deviceLabel });
      setState((current) => ({
        ...current,
        status: "ready",
        action: "idle",
        selectedDeviceId: saved?.deviceId ?? option.deviceId,
        selectedDeviceLabel: saved?.deviceLabel ?? option.deviceLabel,
        message: saved === null ? "Could not save the output device to the backend." : null
      }));
    },
    [applySelection]
  );

  return { state, setSelectedDevice, refreshDevices: async () => void (await loadDevices()) };
}
