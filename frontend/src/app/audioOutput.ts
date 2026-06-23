// Read/write seam for the "last used audio output device" choice. Playback runs
// in the browser, but the *selection* is held by the backend so it survives a
// restart and every surface (control + the separate display window) gets it on
// load — mirrors the stage-background seam. The browser enumerates the actual
// devices and applies the choice via HTMLAudioElement.setSinkId.

export const AUDIO_OUTPUT_ROUTE_PATH = "/session/audio-output";

export interface AudioOutputSelection {
  deviceId: string | null;
  deviceLabel: string | null;
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

export async function getAudioOutputSelection(fetcher: typeof fetch = fetch): Promise<AudioOutputSelection | null> {
  try {
    const response = await fetcher(buildBackendApiUrl(AUDIO_OUTPUT_ROUTE_PATH), { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    return normalizeSelection(await response.json());
  } catch {
    return null;
  }
}

export async function setAudioOutputSelection(
  selection: AudioOutputSelection,
  fetcher: typeof fetch = fetch
): Promise<AudioOutputSelection | null> {
  const response = await fetcher(buildBackendApiUrl(AUDIO_OUTPUT_ROUTE_PATH), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: selection.deviceId, device_label: selection.deviceLabel })
  });
  if (!response.ok) {
    return null;
  }
  return normalizeSelection(await response.json());
}

function normalizeSelection(payload: unknown): AudioOutputSelection {
  const document = (payload ?? {}) as { device_id?: unknown; device_label?: unknown };
  return {
    deviceId: typeof document.device_id === "string" && document.device_id ? document.device_id : null,
    deviceLabel: typeof document.device_label === "string" && document.device_label ? document.device_label : null
  };
}

function resolveBackendApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env?.VITE_BACKEND_API_BASE_URL?.trim();
  if (!configuredBaseUrl) {
    return "/api";
  }
  return configuredBaseUrl.replace(/\/+$/, "");
}

function buildBackendApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${backendApiBaseUrl}${normalizedPath}`;
}
