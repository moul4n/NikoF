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
const snapshotFallbackPollIntervalMs = 500;

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
  latestEvent: BackendSessionEventDocument | null;
  canonicalAssistantMessageEvent: BackendSessionEventDocument | null;
  canonicalTranscriptionEvent: BackendSessionEventDocument | null;
  canonicalSpeechSynthesisEvent: BackendSessionEventDocument | null;
  // Ordered segments of the latest utterance (Phase 1a). For a non-segmented
  // reply this is the single canonical synthesis event; for a segmented reply
  // it is every speech.synthesis event sharing the latest utterance_id, ordered
  // by segment_index.
  canonicalSpeechSynthesisSegments: BackendSessionEventDocument[];
}

/**
 * Select the ordered segments belonging to the most recent utterance.
 *
 * Pure so it can be reasoned about (and unit-tested) in isolation. When the
 * latest synthesis event has no utterance_id (non-segmented reply), the result
 * is just that single event. Otherwise it is every synthesis event sharing that
 * utterance_id, de-duplicated by segment_index (latest wins) and ordered.
 */
export function selectCurrentUtteranceSegments(
  speechSynthesisEvents: BackendSessionEventDocument[]
): BackendSessionEventDocument[] {
  if (speechSynthesisEvents.length === 0) {
    return [];
  }

  const latest = speechSynthesisEvents[speechSynthesisEvents.length - 1];
  const utteranceId = latest.synthesis?.utterance_id ?? null;
  if (!utteranceId) {
    return [latest];
  }

  const byIndex = new Map<number, BackendSessionEventDocument>();
  for (const event of speechSynthesisEvents) {
    if ((event.synthesis?.utterance_id ?? null) !== utteranceId) {
      continue;
    }
    const index = event.synthesis?.segment_index ?? 0;
    byIndex.set(index, event);
  }

  return [...byIndex.entries()].sort(([left], [right]) => left - right).map(([, event]) => event);
}

export function consumeSpeechLifecycleSnapshot(
  snapshot: BackendSpeechLifecycleTransportSnapshotDocument
): ConsumedSpeechLifecycleSnapshot {
  const events = snapshot.events.map((envelope) => ({
    ...envelope,
    event: cloneSessionEvent(envelope.event)
  }));
  const latestEvents = [...events].reverse();
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
    latestEvent: lastEvent?.event ?? null,
    canonicalAssistantMessageEvent:
      latestEvents.find((envelope) => envelope.event.event_type === "assistant.message")?.event ?? null,
    canonicalTranscriptionEvent:
      latestEvents.find((envelope) => envelope.event.event_type === "transcription.status")?.event ?? null,
    canonicalSpeechSynthesisEvent:
      latestEvents.find((envelope) => envelope.event.event_type === "speech.synthesis")?.event ?? null,
    canonicalSpeechSynthesisSegments: selectCurrentUtteranceSegments(
      events
        .filter((envelope) => envelope.event.event_type === "speech.synthesis")
        .map((envelope) => envelope.event)
    )
  };
}

export async function startSpeechLifecycleLiveConsumption(
  options: SpeechLifecycleLiveConsumptionOptions
): Promise<SpeechLifecycleLiveConsumptionSubscription> {
  const fetcher = options.fetcher ?? fetch;
  let closed = false;
  let eventSource: EventSource | null = null;
  let snapshotFallbackTimeoutId: number | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let currentSnapshot = await fetchSpeechLifecycleSnapshot(fetcher);

  if (closed) {
    return {
      close: () => {
        closed = true;
      }
    };
  }

  options.onSnapshot(consumeSpeechLifecycleSnapshot(currentSnapshot), "snapshot");

  connectLiveDelivery(currentSnapshot.next_cursor);
  ensureSnapshotFallbackPolling();

  return {
    close: () => {
      closed = true;
      eventSource?.close();
      eventSource = null;
      clearSnapshotFallbackPolling();
    }
  };

  function connectLiveDelivery(cursor: string): void {
    if (closed || typeof window === "undefined" || typeof window.EventSource !== "function" || eventSource) {
      return;
    }

    const liveUrl = buildSpeechLifecycleLiveUrl(cursor);
    eventSource = new window.EventSource(liveUrl);

    eventSource.addEventListener("open", () => {
      if (closed) {
        return;
      }

      options.onDeliveryModeChange("live");
    });

    eventSource.addEventListener("speech.lifecycle", () => {
      void refreshSnapshot("live");
    });

    eventSource.onmessage = () => {
      void refreshSnapshot("live");
    };

    eventSource.onerror = () => {
      if (closed) {
        return;
      }

      eventSource?.close();
      eventSource = null;
      options.onDeliveryModeChange("snapshot", new Error("Live speech lifecycle delivery disconnected."));
      ensureSnapshotFallbackPolling();
      void refreshSnapshot("snapshot");
    };
  }

  function clearSnapshotFallbackPolling(): void {
    if (snapshotFallbackTimeoutId !== null) {
      window.clearTimeout(snapshotFallbackTimeoutId);
      snapshotFallbackTimeoutId = null;
    }
  }

  function ensureSnapshotFallbackPolling(): void {
    if (closed || snapshotFallbackTimeoutId !== null) {
      return;
    }

    snapshotFallbackTimeoutId = window.setTimeout(() => {
      snapshotFallbackTimeoutId = null;
      void refreshSnapshot(eventSource ? "live" : "snapshot");
    }, snapshotFallbackPollIntervalMs);
  }

  async function refreshSnapshot(deliveryMode: SpeechLifecycleDeliveryMode): Promise<void> {
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }

    refreshInFlight = (async () => {
      try {
        const latestSnapshot = await fetchSpeechLifecycleSnapshot(fetcher, currentSnapshot.next_cursor);

        if (closed) {
          return;
        }

        currentSnapshot = mergeSpeechLifecycleSnapshot(currentSnapshot, latestSnapshot);
        options.onSnapshot(consumeSpeechLifecycleSnapshot(currentSnapshot), deliveryMode);

        if (!eventSource) {
          connectLiveDelivery(currentSnapshot.next_cursor);
        }
      } catch (error) {
        if (closed) {
          return;
        }

        if (deliveryMode === "live") {
          options.onDeliveryModeChange(
            "snapshot",
            error instanceof Error ? error : new Error("Speech lifecycle refresh failed.")
          );
          eventSource?.close();
          eventSource = null;
        }
      } finally {
        refreshInFlight = null;
        ensureSnapshotFallbackPolling();
      }
    })();

    await refreshInFlight;
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

async function fetchSpeechLifecycleSnapshot(
  fetcher: typeof fetch,
  cursor?: string
): Promise<BackendSpeechLifecycleTransportSnapshotDocument> {
  const snapshotUrl = new URL(buildBackendApiUrl("/session/speech-lifecycle"), window.location.origin);
  if (cursor) {
    snapshotUrl.searchParams.set("cursor", cursor);
  }

  const response = await fetcher(snapshotUrl.toString());

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

function buildSpeechLifecycleLiveUrl(cursor: string): string {
  const liveUrl = new URL(buildBackendApiUrl("/session/speech-lifecycle"), window.location.origin);
  liveUrl.searchParams.set("cursor", cursor);
  return liveUrl.toString();
}