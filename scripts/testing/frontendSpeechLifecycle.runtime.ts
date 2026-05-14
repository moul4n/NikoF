import { readFile } from "fs/promises";
import {
  appendSpeechLifecycleEnvelope,
  consumeSpeechLifecycleSnapshot
} from "../../frontend/src/avatar/loaders/speechLifecycle.js";
import type {
  BackendSpeechLifecycleEventEnvelopeDocument,
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
  const loaderSourcePath = process.argv[3];
  const appSourcePath = process.argv[4];

  if (!snapshotPath) {
    throw new Error("Expected a backend speech snapshot path argument.");
  }

  if (!loaderSourcePath) {
    throw new Error("Expected a speech lifecycle loader source path argument.");
  }

  if (!appSourcePath) {
    throw new Error("Expected an App source path argument.");
  }

  const [snapshotText, loaderSourceText, appSourceText] = await Promise.all([
    readFile(snapshotPath, "utf8"),
    readFile(loaderSourcePath, "utf8"),
    readFile(appSourcePath, "utf8")
  ]);

  const snapshot = JSON.parse(snapshotText) as BackendSpeechContractsSnapshot;
  const transportSnapshot = snapshot.contracts.speech_lifecycle_transport_snapshot;
  const consumed = consumeSpeechLifecycleSnapshot(transportSnapshot);
  const liveEnvelope = buildLiveSpeechLifecycleEnvelope(transportSnapshot);
  const liveConsumed = consumeSpeechLifecycleSnapshot(appendSpeechLifecycleEnvelope(transportSnapshot, liveEnvelope));
  const liveTransportMarkers = collectLiveTransportMarkers(loaderSourceText);
  const liveSeamPresent = liveTransportMarkers.length > 0;

  assertFirstVisemeSliceSurvived(snapshot, consumed);
  assertCanonicalSynthesisRuntimeHandoff(appSourceText);

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
    },
    speech_lifecycle_live_runtime: {
      appended_cursor: liveEnvelope.cursor,
      appended_sequence: liveEnvelope.sequence,
      event_count: liveConsumed.eventCount,
      next_cursor: liveConsumed.nextCursor,
      next_cursor_advances_past_last_event: liveConsumed.nextCursorAdvancesPastLastEvent,
      canonical_speech_synthesis_event_updates:
        liveConsumed.canonicalSpeechSynthesisEvent?.synthesis?.text === liveEnvelope.event.synthesis?.text,
      final_cursor_matches_appended_event: liveConsumed.cursors.at(-1) === liveEnvelope.cursor
    },
    live_transport_readiness: {
      seam_status: liveSeamPresent ? "ready" : "blocked",
      live_seam_present: liveSeamPresent,
      snapshot_fetch_present: /\bfetchSpeechLifecycleSnapshot\b/.test(loaderSourceText),
      live_consumption_present: /\bstartSpeechLifecycleLiveConsumption\b/.test(loaderSourceText),
      live_transport_markers: liveTransportMarkers,
      canonical_stream_reference_present: /speech\.lifecycle/.test(loaderSourceText),
      backend_event_envelope_type_present: /\bBackendSpeechLifecycleEventEnvelopeDocument\b/.test(loaderSourceText),
      cursor_reference_present: /\bcursor\b/.test(loaderSourceText),
      app_live_message_present: /Live SSE is connected on the backend-owned speech\.lifecycle envelope\./.test(appSourceText),
      dependency: liveSeamPresent
        ? null
        : "Switch's frontend SSE seam is still absent from speechLifecycle.ts, so transport-backed runtime coverage remains blocked until the loader consumes text/event-stream frames on the existing speech.lifecycle cursor and event envelope."
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function buildLiveSpeechLifecycleEnvelope(
  snapshot: BackendSpeechLifecycleTransportSnapshotDocument
): BackendSpeechLifecycleEventEnvelopeDocument {
  const lastEnvelope = snapshot.events.at(-1);

  if (!lastEnvelope) {
    throw new Error("Expected at least one speech lifecycle envelope in the backend snapshot.");
  }

  const nextSequence = lastEnvelope.sequence + 1;

  return {
    event_id: `${lastEnvelope.event_id}-live`,
    sequence: nextSequence,
    cursor: `speech.lifecycle:${snapshot.session_id}:${nextSequence}`,
    event: {
      ...lastEnvelope.event,
      event_type: "speech.synthesis",
      status: "completed",
      timestamp: "2026-05-14T09:47:00Z",
      synthesis: {
        profile_id: lastEnvelope.event.synthesis?.profile_id ?? "tts.gpt-sovits.2026-stable",
        status: "completed",
        text: "Live delivery continued the canonical speech lifecycle.",
        locale: lastEnvelope.event.synthesis?.locale ?? "en-US",
        timing: lastEnvelope.event.synthesis?.timing ?? null
      }
    }
  };
}

function collectLiveTransportMarkers(sourceText: string): string[] {
  const markers = [
    {
      name: "EventSource",
      pattern: /\bEventSource\b/
    },
    {
      name: "text/event-stream",
      pattern: /text\/event-stream/
    },
    {
      name: "speech.lifecycle SSE listener",
      pattern: /addEventListener\s*\(\s*["']speech\.lifecycle["']/
    },
    {
      name: "live consumption seam",
      pattern: /\bstartSpeechLifecycleLiveConsumption\b/
    },
    {
      name: "lastEventId",
      pattern: /\blastEventId\b/
    }
  ];

  return markers.filter((marker) => marker.pattern.test(sourceText)).map((marker) => marker.name);
}

function assertFirstVisemeSliceSurvived(
  snapshot: BackendSpeechContractsSnapshot,
  consumed: ReturnType<typeof consumeSpeechLifecycleSnapshot>
): void {
  const contractVisemeSlot = snapshot.contracts.canonical_speech_synthesis_event.synthesis?.timing?.viseme_slots?.[0] ?? null;
  const consumedVisemeSlot = consumed.canonicalSpeechSynthesisEvent?.synthesis?.timing?.viseme_slots?.[0] ?? null;

  if (!contractVisemeSlot) {
    throw new Error("Backend speech contract fixture is missing the first synthesis viseme slice.");
  }

  if (!consumedVisemeSlot) {
    throw new Error("Frontend speech lifecycle consumption dropped the first backend-owned synthesis viseme slice.");
  }

  if (canonicalizeJsonValue(consumedVisemeSlot) !== canonicalizeJsonValue(contractVisemeSlot)) {
    throw new Error("Frontend speech lifecycle consumption changed the first backend-owned synthesis viseme slice.");
  }
}

function assertCanonicalSynthesisRuntimeHandoff(appSourceText: string): void {
  const appHandoffMarkers = [
    {
      name: "canonical synthesis selection",
      pattern: /const\s+canonicalSynthesisEvent\s*=\s*speechLifecycleState\.snapshot\?\.canonicalSpeechSynthesisEvent\s*\?\?\s*null\s*;/
    },
    {
      name: "canonical synthesis playback key",
      pattern: /buildSpeechSynthesisPlaybackKey\(canonicalSynthesisEvent\)/
    },
    {
      name: "speech reaction input resolution",
      pattern: /const\s+speechReactionInput\s*=\s*resolveSpeechReactionInput\(canonicalSynthesisEvent\.synthesis\)\s*;/
    },
    {
      name: "speech reaction duration handoff",
      pattern: /const\s+durationMs\s*=\s*speechReactionInput\.utteranceDurationMs\s*;/
    },
    {
      name: "audio reaction bridge",
      pattern: /beginAudioSpeechPlayback\(audioSource,\s*durationMs,\s*playbackKey,\s*speechReactionInput\)/
    },
    {
      name: "timing reaction bridge",
      pattern: /beginTimingSpeechWindow\(durationMs,\s*playbackKey,\s*speechReactionInput\)/
    }
  ];

  const missingMarkers = appHandoffMarkers.filter((marker) => !marker.pattern.test(appSourceText)).map((marker) => marker.name);

  if (missingMarkers.length > 0) {
    throw new Error(
      `App-to-runtime speech playback handoff no longer preserves the canonical synthesis speech-reaction seam: ${missingMarkers.join(", ")}.`
    );
  }
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