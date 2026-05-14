import { readFile } from "fs/promises";
import { consumeSpeechLifecycleSnapshot } from "../../frontend/src/avatar/loaders/speechLifecycle.js";
import type {
  BackendSessionEventDocument,
  BackendSpeechLifecycleTransportSnapshotDocument
} from "../../frontend/src/shared/types/character.js";

type BackendSpeechContractsSnapshot = {
  contracts: {
    canonical_transcription_event: BackendSessionEventDocument;
    canonical_speech_synthesis_event: BackendSessionEventDocument;
    speech_lifecycle_transport_snapshot: BackendSpeechLifecycleTransportSnapshotDocument;
  };
};

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];

  if (!snapshotPath) {
    throw new Error("Expected a backend speech snapshot path argument.");
  }

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as BackendSpeechContractsSnapshot;
  const consumed = consumeSpeechLifecycleSnapshot(snapshot.contracts.speech_lifecycle_transport_snapshot);

  const result = {
    speech_lifecycle_runtime: {
      stream: consumed.stream,
      delivery: consumed.delivery,
      session_id: consumed.sessionId,
      event_count: consumed.eventCount,
      event_types: consumed.eventTypes,
      cursors: consumed.cursors,
      next_cursor: consumed.nextCursor,
      ordered_envelope_preserved: consumed.orderedEnvelopePreserved,
      next_cursor_advances_past_last_event: consumed.nextCursorAdvancesPastLastEvent,
      canonical_transcription_event_survived:
        canonicalizeJsonValue(consumed.canonicalTranscriptionEvent) ===
        canonicalizeJsonValue(snapshot.contracts.canonical_transcription_event),
      canonical_speech_synthesis_event_survived:
        canonicalizeJsonValue(consumed.canonicalSpeechSynthesisEvent) ===
        canonicalizeJsonValue(snapshot.contracts.canonical_speech_synthesis_event),
      transcription_event_type: consumed.canonicalTranscriptionEvent?.event_type ?? null,
      synthesis_event_type: consumed.canonicalSpeechSynthesisEvent?.event_type ?? null,
      transcription_profile_id: consumed.canonicalTranscriptionEvent?.transcription?.profile_id ?? null,
      synthesis_profile_id: consumed.canonicalSpeechSynthesisEvent?.synthesis?.profile_id ?? null
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function canonicalizeJsonValue(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortJsonValue((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }

  return value;
}

void main();