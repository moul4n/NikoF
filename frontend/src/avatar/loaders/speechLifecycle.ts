import type {
  BackendSessionEventDocument,
  BackendSpeechLifecycleEventEnvelopeDocument,
  BackendSpeechLifecycleTransportSnapshotDocument
} from "../../shared/types/character.js";

export type SpeechLifecycleDeliveryMode = "live" | "snapshot";

export interface SpeechLifecycleLiveConsumptionOptions {
  onSnapshot: (snapshot: ConsumedSpeechLifecycleSnapshot, deliveryMode: SpeechLifecycleDeliveryMode) => void;
  onDeliveryModeChange: (deliveryMode: SpeechLifecycleDeliveryMode, error?: Error) => void;
  fetcher?: typeof fetch;
}

export interface SpeechLifecycleLiveConsumptionSubscription {
  close: () => void;
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

export interface ConsumedSpeechLifecycleSnapshot {
  stream: string;
  delivery: string;
  sessionId: string;
  nextCursor: string;
  eventCount: number;
  eventTypes: string[];
  cursors: string[];
  orderedEnvelopePreserved: boolean;
  nextCursorAdvancesPastLastEvent: boolean;
  canonicalTranscriptionEvent: BackendSessionEventDocument | null;
  canonicalSpeechSynthesisEvent: BackendSessionEventDocument | null;
}

export function consumeSpeechLifecycleSnapshot(
  snapshot: BackendSpeechLifecycleTransportSnapshotDocument
): ConsumedSpeechLifecycleSnapshot {
  const events = snapshot.events.map((envelope) => ({
    ...envelope,
    event: cloneSessionEvent(envelope.event)
  }));
  const lastEvent = events.at(-1) ?? null;
  const expectedNextCursor = lastEvent
    ? `speech.lifecycle:${snapshot.session_id}:${lastEvent.sequence + 1}`
    : `speech.lifecycle:${snapshot.session_id}:1`;

  return {
    stream: snapshot.stream,
    delivery: snapshot.delivery,
    sessionId: snapshot.session_id,
    nextCursor: snapshot.next_cursor,
    eventCount: events.length,
    eventTypes: events.map((envelope) => envelope.event.event_type),
    cursors: events.map((envelope) => envelope.cursor),
    orderedEnvelopePreserved: events.every(
      (envelope, index) =>
        envelope.sequence === index + 1 &&
        envelope.cursor === `speech.lifecycle:${snapshot.session_id}:${envelope.sequence}` &&
        envelope.event.session_id === snapshot.session_id
    ),
    nextCursorAdvancesPastLastEvent: snapshot.next_cursor === expectedNextCursor,
    canonicalTranscriptionEvent:
      events.find((envelope) => envelope.event.event_type === "transcription.status")?.event ?? null,
    canonicalSpeechSynthesisEvent:
      events.find((envelope) => envelope.event.event_type === "speech.synthesis")?.event ?? null
  };
}

export async function startSpeechLifecycleLiveConsumption(
  options: SpeechLifecycleLiveConsumptionOptions
): Promise<SpeechLifecycleLiveConsumptionSubscription> {
  const fetcher = options.fetcher ?? fetch;
  let closed = false;
  let eventSource: EventSource | null = null;
  let currentSnapshot = await fetchSpeechLifecycleSnapshot(fetcher);

  if (closed) {
    return {
      close: () => {
        closed = true;
      }
    };
  }

  options.onSnapshot(consumeSpeechLifecycleSnapshot(currentSnapshot), "snapshot");

  if (typeof window !== "undefined" && typeof window.EventSource === "function") {
    const liveUrl = buildSpeechLifecycleLiveUrl(currentSnapshot.next_cursor);
    eventSource = new window.EventSource(liveUrl);

    eventSource.addEventListener("open", () => {
      if (closed) {
        return;
      }

      options.onDeliveryModeChange("live");
    });

    eventSource.addEventListener("speech.lifecycle", () => {
      void refreshSnapshotFromLiveSignal();
    });

    eventSource.onmessage = () => {
      void refreshSnapshotFromLiveSignal();
    };

    eventSource.onerror = () => {
      if (closed) {
        return;
      }

      eventSource?.close();
      eventSource = null;
      options.onDeliveryModeChange("snapshot", new Error("Live speech lifecycle delivery disconnected."));
    };
  }

  return {
    close: () => {
      closed = true;
      eventSource?.close();
      eventSource = null;
    }
  };

  async function refreshSnapshotFromLiveSignal(): Promise<void> {
    const latestSnapshot = await fetchSpeechLifecycleSnapshot(fetcher);

    if (closed) {
      return;
    }

    currentSnapshot = mergeSpeechLifecycleSnapshot(currentSnapshot, latestSnapshot);
    options.onSnapshot(consumeSpeechLifecycleSnapshot(currentSnapshot), "live");
  }
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSessionEvent(event: BackendSessionEventDocument): BackendSessionEventDocument {
  return stripNullFields(cloneJsonValue(event)) as BackendSessionEventDocument;
}

function stripNullFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripNullFields(item));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).reduce<Record<string, unknown>>((result, [key, entry]) => {
      if (entry !== null) {
        result[key] = stripNullFields(entry);
      }

      return result;
    }, {});
  }

  return value;
}

async function fetchSpeechLifecycleSnapshot(fetcher: typeof fetch): Promise<BackendSpeechLifecycleTransportSnapshotDocument> {
  const response = await fetcher(buildBackendApiUrl("/session/speech-lifecycle"));

  if (!response.ok) {
    throw new Error(`Backend speech lifecycle request failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendSpeechLifecycleTransportSnapshotDocument;
}

function mergeSpeechLifecycleSnapshot(
  currentSnapshot: BackendSpeechLifecycleTransportSnapshotDocument,
  latestSnapshot: BackendSpeechLifecycleTransportSnapshotDocument
): BackendSpeechLifecycleTransportSnapshotDocument {
  const orderedEvents = new Map<string, BackendSpeechLifecycleEventEnvelopeDocument>();

  [...currentSnapshot.events, ...latestSnapshot.events].forEach((envelope) => {
    orderedEvents.set(envelope.cursor, envelope);
  });

  return {
    ...latestSnapshot,
    events: [...orderedEvents.values()].sort((left, right) => left.sequence - right.sequence)
  };
}

function resolveBackendApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_BACKEND_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return "/api";
  }

  return configuredBaseUrl.replace(/\/+$/, "");
}

function buildBackendApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${backendApiBaseUrl}${normalizedPath}`;
}

function buildSpeechLifecycleLiveUrl(cursor: string): string {
  const liveUrl = new URL(buildBackendApiUrl("/session/speech-lifecycle"), window.location.origin);
  liveUrl.searchParams.set("cursor", cursor);
  return liveUrl.toString();
}