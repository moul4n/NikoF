import type {
  BackendAnimationCommandDocument,
  BackendSessionAnimationSnapshotDocument,
  BackendSessionLifecycleUpdateRequestDocument,
  SemanticAnimationCommand,
  SemanticAnimationPlaybackMode
} from "../../shared/types/animation";

const backendApiBaseUrl = resolveBackendApiBaseUrl();

export type SessionAnimationDeliveryMode = "live" | "snapshot";

export interface SessionAnimationLiveConsumptionOptions {
  onSnapshot: (snapshot: ConsumedSessionAnimationSnapshot, deliveryMode: SessionAnimationDeliveryMode) => void;
  onDeliveryModeChange: (deliveryMode: SessionAnimationDeliveryMode, error?: Error) => void;
  fetcher?: typeof fetch;
}

export interface SessionAnimationLiveConsumptionSubscription {
  close: () => void;
}

export interface ConsumedSessionAnimationSnapshot {
  sessionId: string;
  lifecycleState: string;
  characterId: string;
  commandId: string;
  semanticCommand: SemanticAnimationCommand;
  rawCommand: BackendAnimationCommandDocument;
}

export async function fetchSessionAnimationSnapshot(
  fetcher: typeof fetch = fetch
): Promise<ConsumedSessionAnimationSnapshot> {
  return consumeSessionAnimationSnapshot(await fetchSessionAnimationSnapshotDocument(fetcher));
}

export async function updateSessionAnimationLifecycleState(
  lifecycleState: string,
  reason: string,
  fetcher: typeof fetch = fetch
): Promise<ConsumedSessionAnimationSnapshot> {
  const response = await fetcher(buildBackendApiUrl("/session/lifecycle-state"), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      lifecycle_state: lifecycleState,
      reason
    } satisfies BackendSessionLifecycleUpdateRequestDocument)
  });

  if (!response.ok) {
    throw new Error(`Backend session lifecycle update failed with status ${response.status}.`);
  }

  const rawSnapshot = (await response.json()) as BackendSessionAnimationSnapshotDocument;
  return consumeSessionAnimationSnapshot(rawSnapshot);
}

export async function startSessionAnimationLiveConsumption(
  options: SessionAnimationLiveConsumptionOptions
): Promise<SessionAnimationLiveConsumptionSubscription> {
  const fetcher = options.fetcher ?? fetch;
  let closed = false;
  let eventSource: EventSource | null = null;
  let currentSnapshot = await fetchSessionAnimationSnapshot(fetcher);

  if (closed) {
    return {
      close: () => {
        closed = true;
      }
    };
  }

  options.onSnapshot(currentSnapshot, "snapshot");

  if (typeof window !== "undefined" && typeof window.EventSource === "function") {
    eventSource = new window.EventSource(buildSessionAnimationLiveUrl());

    eventSource.addEventListener("open", () => {
      if (closed) {
        return;
      }

      options.onDeliveryModeChange("live");
    });

    eventSource.addEventListener("animation.command", (event) => {
      consumeLiveSnapshotFromEvent(event);
    });

    eventSource.addEventListener("session.animation", (event) => {
      consumeLiveSnapshotFromEvent(event);
    });

    eventSource.onmessage = (event) => {
      consumeLiveSnapshotFromEvent(event);
    };

    eventSource.onerror = () => {
      if (closed) {
        return;
      }

      eventSource?.close();
      eventSource = null;
      options.onDeliveryModeChange("snapshot", new Error("Live session animation delivery disconnected."));
    };
  }

  return {
    close: () => {
      closed = true;
      eventSource?.close();
      eventSource = null;
    }
  };

  function consumeLiveSnapshotFromEvent(event: Event): void {
    try {
      const latestSnapshot = consumeSessionAnimationSnapshot(
        JSON.parse((event as MessageEvent<string>).data) as BackendSessionAnimationSnapshotDocument
      );

      if (closed) {
        return;
      }

      currentSnapshot = latestSnapshot;
      options.onSnapshot(currentSnapshot, "live");
    } catch (error: unknown) {
      if (closed) {
        return;
      }

      eventSource?.close();
      eventSource = null;
      options.onDeliveryModeChange(
        "snapshot",
        error instanceof Error
          ? error
          : new Error("Live session animation event payload could not be parsed.")
      );
    }
  }
}

export function consumeSessionAnimationSnapshot(
  rawSnapshot: BackendSessionAnimationSnapshotDocument
): ConsumedSessionAnimationSnapshot {
  const rawCommand = rawSnapshot.command;

  return {
    sessionId: rawSnapshot.session_id,
    lifecycleState: rawSnapshot.lifecycle_state,
    characterId: rawSnapshot.active_character_id,
    commandId: rawCommand.command_id,
    semanticCommand: {
      id: rawCommand.semantic_id,
      source: rawCommand.resolution.selected_source === "character_override" ? "override" : "shared",
      playback: resolvePlaybackMode(rawCommand.playback.mode),
      intensity: rawCommand.intensity,
      durationMs: rawCommand.playback.expected_duration_ms ?? undefined
    },
    rawCommand
  };
}

function resolvePlaybackMode(mode: string): SemanticAnimationPlaybackMode {
  return mode === "loop" ? "loop" : "once";
}

async function fetchSessionAnimationSnapshotDocument(
  fetcher: typeof fetch
): Promise<BackendSessionAnimationSnapshotDocument> {
  const response = await fetcher(buildBackendApiUrl("/session/animation"));

  if (!response.ok) {
    throw new Error(`Backend session animation request failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendSessionAnimationSnapshotDocument;
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

function buildSessionAnimationLiveUrl(): string {
  return new URL(buildBackendApiUrl("/session/animation"), window.location.origin).toString();
}