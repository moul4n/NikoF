import { useEffect, useState } from "react";
import type { BackendTtsReferenceSettingsDocument } from "../shared/types/character";

export const TTS_SETTINGS_ROUTE_PATH = "/session/tts/settings";
const defaultMaxReferenceAudioBytes = 5 * 1024 * 1024;

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

function resolveErrorDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const detail = (payload as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim() ? detail : null;
}

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
      detail = resolveErrorDetail(await response.json());
    } catch {
      detail = null;
    }

    throw new Error(detail ?? `Backend TTS settings request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

export type TtsReferenceSettingsState = {
  status: "loading" | "ready" | "offline";
  snapshot: BackendTtsReferenceSettingsDocument | null;
  action: "idle" | "saving";
  message: string | null;
  messageTone: "neutral" | "error" | "success";
};

export function useTtsReferenceSettings(): {
  state: TtsReferenceSettingsState;
  saveSettings: (promptText: string, file: File | null) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<TtsReferenceSettingsState>({
    status: "loading",
    snapshot: null,
    action: "idle",
    message: null,
    messageTone: "neutral"
  });

  async function refresh(): Promise<void> {
    try {
      const snapshot = await fetchJson<BackendTtsReferenceSettingsDocument>(TTS_SETTINGS_ROUTE_PATH);
      setState((currentState) => ({
        status: "ready",
        snapshot,
        action: currentState.action === "saving" ? "saving" : "idle",
        message: currentState.action === "saving" ? currentState.message : null,
        messageTone: currentState.action === "saving" ? currentState.messageTone : "neutral"
      }));
    } catch (error: unknown) {
      setState((currentState) => ({
        status: "offline",
        snapshot: currentState.snapshot,
        action: "idle",
        message: error instanceof Error ? error.message : "Backend TTS settings route unavailable.",
        messageTone: "error"
      }));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveSettings(promptText: string, file: File | null): Promise<void> {
    const normalizedPromptText = promptText.trim();
    if (!normalizedPromptText) {
      setState((currentState) => ({
        ...currentState,
        message: "Reference prompt text is required.",
        messageTone: "error"
      }));
      return;
    }

    const maxBytes = state.snapshot?.max_reference_audio_bytes ?? defaultMaxReferenceAudioBytes;
    if (file !== null) {
      if (!file.name.toLowerCase().endsWith(".wav")) {
        setState((currentState) => ({
          ...currentState,
          message: "Reference audio must be a .wav file.",
          messageTone: "error"
        }));
        return;
      }

      if (file.size > maxBytes) {
        setState((currentState) => ({
          ...currentState,
          message: `Reference audio exceeds the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit.`,
          messageTone: "error"
        }));
        return;
      }
    }

    setState((currentState) => ({
      ...currentState,
      action: "saving",
      message: "Saving TTS reference settings.",
      messageTone: "neutral"
    }));

    try {
      const payload: {
        prompt_text: string;
        prompt_language?: string;
        text_language?: string;
        file_name?: string;
        file_base64?: string;
      } = {
        prompt_text: normalizedPromptText,
        prompt_language: state.snapshot?.prompt_language,
        text_language: state.snapshot?.text_language
      };

      if (file !== null) {
        payload.file_name = file.name;
        payload.file_base64 = arrayBufferToBase64(await file.arrayBuffer());
      }

      const snapshot = await fetchJson<BackendTtsReferenceSettingsDocument>(TTS_SETTINGS_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify(payload)
      });

      setState({
        status: "ready",
        snapshot,
        action: "idle",
        message: snapshot.configured
          ? "Saved TTS reference audio and prompt text."
          : "Saved prompt text. A reference WAV is still required before GPT-SoVITS can synthesize.",
        messageTone: "success"
      });
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.snapshot ? "ready" : "offline",
        action: "idle",
        message: error instanceof Error ? error.message : "Saving TTS settings failed.",
        messageTone: "error"
      }));
    }
  }

  return {
    state,
    saveSettings,
    refresh
  };
}