import { useEffect, useState } from "react";

export const CHARACTER_PROFILE_ROUTE_PATH = "/session/character-profile";

export interface CharacterProfileDocument {
  schema_version: number;
  personality: string;
  directives_do: string;
  directives_dont: string;
  response_formatting: string;
  updated_at: string | null;
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

    throw new Error(detail ?? `Backend character profile request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export interface CharacterProfileDraft {
  personality: string;
  directives_do: string;
  directives_dont: string;
  response_formatting: string;
}

export type CharacterProfileState = {
  status: "loading" | "ready" | "offline";
  snapshot: CharacterProfileDocument | null;
  action: "idle" | "saving";
  message: string | null;
  messageTone: "neutral" | "error" | "success";
};

export function useCharacterProfile(): {
  state: CharacterProfileState;
  saveProfile: (draft: CharacterProfileDraft) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<CharacterProfileState>({
    status: "loading",
    snapshot: null,
    action: "idle",
    message: null,
    messageTone: "neutral"
  });

  async function refresh(): Promise<void> {
    try {
      const snapshot = await fetchJson<CharacterProfileDocument>(CHARACTER_PROFILE_ROUTE_PATH);
      setState({
        status: "ready",
        snapshot,
        action: "idle",
        message: null,
        messageTone: "neutral"
      });
    } catch (error: unknown) {
      setState((currentState) => ({
        status: "offline",
        snapshot: currentState.snapshot,
        action: "idle",
        message: error instanceof Error ? error.message : "Backend character profile route unavailable.",
        messageTone: "error"
      }));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveProfile(draft: CharacterProfileDraft): Promise<void> {
    setState((currentState) => ({
      ...currentState,
      action: "saving",
      message: "Saving character profile.",
      messageTone: "neutral"
    }));

    try {
      const snapshot = await fetchJson<CharacterProfileDocument>(CHARACTER_PROFILE_ROUTE_PATH, {
        method: "PUT",
        body: JSON.stringify({
          personality: draft.personality,
          directives_do: draft.directives_do,
          directives_dont: draft.directives_dont,
          response_formatting: draft.response_formatting
        })
      });

      setState({
        status: "ready",
        snapshot,
        action: "idle",
        message: "Character profile saved. It applies on the next turn.",
        messageTone: "success"
      });
    } catch (error: unknown) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.snapshot ? "ready" : "offline",
        action: "idle",
        message: error instanceof Error ? error.message : "Saving character profile failed.",
        messageTone: "error"
      }));
    }
  }

  return {
    state,
    saveProfile,
    refresh
  };
}
