import type {
  BackendSessionEventDocument,
  BackendSpeechLifecycleTransportSnapshotDocument
} from "../../shared/types/character.js";

const backendApiBaseUrl = resolveBackendApiBaseUrl();

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

export async function fetchSpeechLifecycleSnapshot(
  fetcher: typeof fetch = fetch
): Promise<ConsumedSpeechLifecycleSnapshot> {
  const response = await fetcher(buildBackendApiUrl("/session/speech-lifecycle"));

  if (!response.ok) {
    throw new Error(`Backend speech lifecycle request failed with status ${response.status}.`);
  }

  return consumeSpeechLifecycleSnapshot((await response.json()) as BackendSpeechLifecycleTransportSnapshotDocument);
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

function buildBackendApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${backendApiBaseUrl}${normalizedPath}`;
}