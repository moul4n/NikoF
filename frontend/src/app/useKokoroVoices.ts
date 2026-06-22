import { useEffect, useState } from "react";

export const KOKORO_VOICES_ROUTE_PATH = "/session/tts/kokoro-voices";
export const KOKORO_VOICE_ROUTE_PATH = "/session/tts/kokoro-voice";

export interface KokoroVoiceOption {
  voice_id: string;
  label: string;
  language: string;
  english: boolean;
}

export interface KokoroVoicesDocument {
  schema_version: number;
  engine_active: boolean;
  available: boolean;
  selected_voice: string;
  lang: string;
  voices: KokoroVoiceOption[];
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

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildBackendApiUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });

  if (!response.ok) {
    let detail: string | null = null;
    try {
      const payload = (await response.json()) as { detail?: string };
      detail = typeof payload.detail === "string" ? payload.detail : null;
    } catch {
      detail = null;
    }
    throw new Error(detail ?? `Backend Kokoro voices request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export type KokoroVoicesState = {
  status: "loading" | "ready" | "offline";
  snapshot: KokoroVoicesDocument | null;
  action: "idle" | "saving";
  message: string | null;
  messageTone: "neutral" | "error" | "success";
};

export function useKokoroVoices(): {
  state: KokoroVoicesState;
  setVoice: (voiceId: string) => Promise<void>;
} {
  const [state, setState] = useState<KokoroVoicesState>({
    status: "loading",
    snapshot: null,
    action: "idle",
    message: null,
    messageTone: "neutral"
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await fetchJson<KokoroVoicesDocument>(KOKORO_VOICES_ROUTE_PATH);
        if (cancelled) {
          return;
        }
        setState({ status: "ready", snapshot, action: "idle", message: null, messageTone: "neutral" });
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        setState({
          status: "offline",
          snapshot: null,
          action: "idle",
          message: error instanceof Error ? error.message : "Backend Kokoro voices route unavailable.",
          messageTone: "error"
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function setVoice(voiceId: string): Promise<void> {
    setState((currentState) => ({ ...currentState, action: "saving", message: "Updating voice…", messageTone: "neutral" }));
    try {
      const snapshot = await fetchJson<KokoroVoicesDocument>(KOKORO_VOICE_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify({ voice: voiceId })
      });
      const label = snapshot.voices.find((voice) => voice.voice_id === snapshot.selected_voice)?.label ?? snapshot.selected_voice;
      setState({
        status: "ready",
        snapshot,
        action: "idle",
        message: `Voice set to ${label}. New replies use it immediately.`,
        messageTone: "success"
      });
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.snapshot ? "ready" : "offline",
        action: "idle",
        message: error instanceof Error ? error.message : "Updating the Kokoro voice failed.",
        messageTone: "error"
      }));
    }
  }

  return { state, setVoice };
}
