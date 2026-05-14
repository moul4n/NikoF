import type {
  BackendSessionEventDocument,
  BackendSpeechLifecycleEventEnvelopeDocument,
  BackendSpeechLifecycleTransportSnapshotDocument
} from "../../shared/types/character.js";

const backendApiBaseUrl = resolveBackendApiBaseUrl();
const speechLifecycleStreamEventName = "speech.lifecycle";

type ImportMetaWithOptionalEnv = ImportMeta & {
  env?: {
    VITE_BACKEND_API_BASE_URL?: string;
  };
};

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

export type SpeechLifecycleDeliveryMode = "snapshot" | "live";

export interface SpeechLifecycleEventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export type SpeechLifecycleEventSourceFactory = (url: string) => SpeechLifecycleEventSourceLike;

export interface SpeechLifecycleLiveConsumptionCallbacks {
  fetcher?: typeof fetch;
  eventSourceFactory?: SpeechLifecycleEventSourceFactory;
  onSnapshot: (snapshot: ConsumedSpeechLifecycleSnapshot, deliveryMode: SpeechLifecycleDeliveryMode) => void;
  onDeliveryModeChange?: (deliveryMode: SpeechLifecycleDeliveryMode, error: Error | null) => void;
}

export interface SpeechLifecycleLiveConsumptionSubscription {
  close(): void;
}

export async function fetchSpeechLifecycleSnapshot(
  fetcher: typeof fetch = fetch
): Promise<ConsumedSpeechLifecycleSnapshot> {
  return consumeSpeechLifecycleSnapshot(await fetchSpeechLifecycleTransportSnapshot(fetcher));
}

export async function startSpeechLifecycleLiveConsumption(
  callbacks: SpeechLifecycleLiveConsumptionCallbacks
): Promise<SpeechLifecycleLiveConsumptionSubscription> {
  const fetcher = callbacks.fetcher ?? fetch;
  let transportSnapshot = await fetchSpeechLifecycleTransportSnapshot(fetcher);
  let deliveryMode: SpeechLifecycleDeliveryMode = "snapshot";

  callbacks.onSnapshot(consumeSpeechLifecycleSnapshot(transportSnapshot), deliveryMode);

  const eventSourceFactory = resolveSpeechLifecycleEventSourceFactory(callbacks.eventSourceFactory);

  if (!eventSourceFactory) {
    callbacks.onDeliveryModeChange?.("snapshot", new Error("Live speech lifecycle delivery is unavailable in this environment."));
    return {
      close() {
        return undefined;
      }
    };
  }

  const eventSource = eventSourceFactory(buildSpeechLifecycleStreamUrl(transportSnapshot.next_cursor));
  let closed = false;

  const handleOpen = (): void => {
    if (closed || deliveryMode === "live") {
      return;
    }

    deliveryMode = "live";
    callbacks.onDeliveryModeChange?.("live", null);
  };

  const handleSpeechLifecycleEvent = (event: Event): void => {
    if (closed) {
      return;
    }

    try {
      const messageEvent = event as MessageEvent<string>;
      const envelope = JSON.parse(messageEvent.data) as BackendSpeechLifecycleEventEnvelopeDocument;

      transportSnapshot = appendSpeechLifecycleEnvelope(transportSnapshot, envelope);
      callbacks.onSnapshot(consumeSpeechLifecycleSnapshot(transportSnapshot), deliveryMode);
    } catch (error: unknown) {
      const parseError = error instanceof Error ? error : new Error("Live speech lifecycle event payload could not be parsed.");
      callbacks.onDeliveryModeChange?.("snapshot", parseError);
      close();
    }
  };

  const handleError = (): void => {
    if (closed) {
      return;
    }

    deliveryMode = "snapshot";
    callbacks.onDeliveryModeChange?.("snapshot", new Error("Live speech lifecycle stream unavailable."));
    close();
  };

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    eventSource.removeEventListener("open", handleOpen);
    eventSource.removeEventListener(speechLifecycleStreamEventName, handleSpeechLifecycleEvent);
    eventSource.removeEventListener("error", handleError);
    eventSource.close();
  };

  eventSource.addEventListener("open", handleOpen);
  eventSource.addEventListener(speechLifecycleStreamEventName, handleSpeechLifecycleEvent);
  eventSource.addEventListener("error", handleError);

  return {
    close
  };
}

export function appendSpeechLifecycleEnvelope(
  snapshot: BackendSpeechLifecycleTransportSnapshotDocument,
  envelope: BackendSpeechLifecycleEventEnvelopeDocument
): BackendSpeechLifecycleTransportSnapshotDocument {
  if (snapshot.events.some((existingEnvelope) => existingEnvelope.cursor === envelope.cursor)) {
    return snapshot;
  }

  const nextEvents = [...snapshot.events, cloneSpeechLifecycleEnvelope(envelope)].sort((left, right) => left.sequence - right.sequence);
  const lastEvent = nextEvents.at(-1) ?? null;

  return {
    ...snapshot,
    events: nextEvents,
    next_cursor: lastEvent ? buildSpeechLifecycleCursor(snapshot.session_id, lastEvent.sequence + 1) : snapshot.next_cursor
  };
}

export function consumeSpeechLifecycleSnapshot(
  snapshot: BackendSpeechLifecycleTransportSnapshotDocument
): ConsumedSpeechLifecycleSnapshot {
  const events = snapshot.events.map((envelope) => cloneSpeechLifecycleEnvelope(envelope));
  const lastEvent = events.at(-1) ?? null;
  const expectedNextCursor = lastEvent
    ? buildSpeechLifecycleCursor(snapshot.session_id, lastEvent.sequence + 1)
    : buildSpeechLifecycleCursor(snapshot.session_id, 1);

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
        envelope.cursor === buildSpeechLifecycleCursor(snapshot.session_id, envelope.sequence) &&
        envelope.event.session_id === snapshot.session_id
    ),
    nextCursorAdvancesPastLastEvent: snapshot.next_cursor === expectedNextCursor,
    canonicalTranscriptionEvent: findLastEventByType(events, "transcription.status"),
    canonicalSpeechSynthesisEvent: findLastEventByType(events, "speech.synthesis")
  };
}

async function fetchSpeechLifecycleTransportSnapshot(
  fetcher: typeof fetch = fetch
): Promise<BackendSpeechLifecycleTransportSnapshotDocument> {
  const response = await fetcher(buildBackendApiUrl("/session/speech-lifecycle"));

  if (!response.ok) {
    throw new Error(`Backend speech lifecycle request failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendSpeechLifecycleTransportSnapshotDocument;
}

function cloneSpeechLifecycleEnvelope(
  envelope: BackendSpeechLifecycleEventEnvelopeDocument
): BackendSpeechLifecycleEventEnvelopeDocument {
  return {
    ...envelope,
    event: cloneSessionEvent(envelope.event)
  };
}

function findLastEventByType(
  events: readonly BackendSpeechLifecycleEventEnvelopeDocument[],
  eventType: string
): BackendSessionEventDocument | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event.event.event_type === eventType) {
      return event.event;
    }
  }

  return null;
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

function resolveBackendApiBaseUrl(): string {
  const configuredBaseUrl = (import.meta as ImportMetaWithOptionalEnv).env?.VITE_BACKEND_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return "/api";
  }

  return configuredBaseUrl.replace(/\/+$/, "");
}

function resolveSpeechLifecycleEventSourceFactory(
  overrideFactory?: SpeechLifecycleEventSourceFactory
): SpeechLifecycleEventSourceFactory | null {
  if (overrideFactory) {
    return overrideFactory;
  }

  if (typeof EventSource === "undefined") {
    return null;
  }

  return (url: string) => new EventSource(url);
}

function buildSpeechLifecycleStreamUrl(cursor: string): string {
  return buildBackendApiUrl("/session/speech-lifecycle", new URLSearchParams({ cursor }));
}

function buildSpeechLifecycleCursor(sessionId: string, sequence: number): string {
  return `${speechLifecycleStreamEventName}:${sessionId}:${sequence}`;
}

function buildBackendApiUrl(pathname: string, query?: URLSearchParams): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const url = `${backendApiBaseUrl}${normalizedPath}`;
  const serializedQuery = query?.toString();

  if (!serializedQuery) {
    return url;
  }

  return `${url}?${serializedQuery}`;
}