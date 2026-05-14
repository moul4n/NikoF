import type {
  BackendSessionEventDocument,
  BackendSpeechLifecycleTransportSnapshotDocument
} from "../../shared/types/character.js";

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