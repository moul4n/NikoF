import { readFile } from "fs/promises";
import { consumeSpeechLifecycleSnapshot } from "../../frontend/src/avatar/loaders/speechLifecycle.js";
import { resolveSpeechSynthesisAudioSource } from "../../frontend/src/app/speechPlaybackAudioSource.js";
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
  const avatarRuntimeSourcePath = process.argv[4];
  const appSourcePath = process.argv[5];
  const speechLifecycleHookSourcePath = process.argv[6];
  const speechPlaybackBridgeHookSourcePath = process.argv[7];

  if (!snapshotPath) {
    throw new Error("Expected a backend speech snapshot path argument.");
  }

  if (!loaderSourcePath) {
    throw new Error("Expected a speech lifecycle loader source path argument.");
  }

  if (!avatarRuntimeSourcePath) {
    throw new Error("Expected an avatar runtime source path argument.");
  }

  if (!appSourcePath) {
    throw new Error("Expected an App source path argument.");
  }

  if (!speechLifecycleHookSourcePath) {
    throw new Error("Expected a speech lifecycle hook source path argument.");
  }

  if (!speechPlaybackBridgeHookSourcePath) {
    throw new Error("Expected a speech playback bridge hook source path argument.");
  }

  const [
    snapshotText,
    loaderSourceText,
    avatarRuntimeSourceText,
    appSourceText,
    speechLifecycleHookSourceText,
    speechPlaybackBridgeHookSourceText
  ] = await Promise.all([
    readFile(snapshotPath, "utf8"),
    readFile(loaderSourcePath, "utf8"),
    readFile(avatarRuntimeSourcePath, "utf8"),
    readFile(appSourcePath, "utf8"),
    readFile(speechLifecycleHookSourcePath, "utf8"),
    readFile(speechPlaybackBridgeHookSourcePath, "utf8")
  ]);

  const snapshot = JSON.parse(snapshotText) as BackendSpeechContractsSnapshot;
  const transportSnapshot = snapshot.contracts.speech_lifecycle_transport_snapshot;
  const consumed = consumeSpeechLifecycleSnapshot(transportSnapshot);
  const liveEnvelope = buildLiveSpeechLifecycleEnvelope(transportSnapshot);
  const liveConsumed = consumeSpeechLifecycleSnapshot(appendSpeechLifecycleEnvelope(transportSnapshot, liveEnvelope));
  const liveTransportMarkers = collectLiveTransportMarkers(loaderSourceText);
  const liveSeamPresent = liveTransportMarkers.length > 0;
  const speechLifecycleHookMarkers = collectSpeechLifecycleHookMarkers(speechLifecycleHookSourceText);
  const expectedSpeechLifecycleHookMarkers = getExpectedSpeechLifecycleHookMarkers();
  const speechReactionRuntimeMarkers = collectSpeechReactionRuntimeMarkers(avatarRuntimeSourceText);
  const expectedSpeechReactionRuntimeMarkers = getExpectedSpeechReactionRuntimeMarkers();
  const speechPlaybackBridgeMarkers = collectSpeechPlaybackBridgeMarkers(speechPlaybackBridgeHookSourceText);
  const expectedSpeechPlaybackBridgeMarkers = getExpectedSpeechPlaybackBridgeMarkers();
  const backendArtifactAudioReference = buildCanonicalArtifactAudioReference(transportSnapshot);
  const backendArtifactAudioResolution = resolveSpeechSynthesisAudioSource(backendArtifactAudioReference);

  assertFirstVisemeSliceSurvived(snapshot, consumed);
  assertSpeechLifecycleHookSeam(speechLifecycleHookSourceText);
  assertSpeechReactionRuntimeSeam(avatarRuntimeSourceText);
  assertCanonicalSynthesisRuntimeHandoff(appSourceText, speechPlaybackBridgeHookSourceText);
  assertBackendArtifactAudioReferencePlayable(backendArtifactAudioReference, backendArtifactAudioResolution);

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
    speech_lifecycle_hook_state: {
      speech_lifecycle_hook_markers: speechLifecycleHookMarkers,
      speech_lifecycle_hook_ready: speechLifecycleHookMarkers.length === expectedSpeechLifecycleHookMarkers.length,
      hook_export_present: /export function useSpeechLifecycleState\s*\(/.test(speechLifecycleHookSourceText),
      hook_live_message_present: /Live SSE is connected on the backend-owned speech\.lifecycle envelope\./.test(
        speechLifecycleHookSourceText
      ),
      hook_character_resolution_present: /export function resolveSpeechLifecycleCharacterId\s*\(/.test(
        speechLifecycleHookSourceText
      )
    },
    speech_playback_bridge_state: {
      speech_playback_bridge_markers: speechPlaybackBridgeMarkers,
      speech_playback_bridge_ready: speechPlaybackBridgeMarkers.length === expectedSpeechPlaybackBridgeMarkers.length,
      hook_export_present: /export function useSpeechPlaybackBridge\s*\(/.test(speechPlaybackBridgeHookSourceText),
      playback_status_export_present: /export type SpeechPlaybackStatus\s*=\s*"idle"\s*\|\s*"audio"\s*\|\s*"timing"/.test(
        speechPlaybackBridgeHookSourceText
      ),
      backend_artifact_audio_reference: backendArtifactAudioReference,
      backend_artifact_audio_source: backendArtifactAudioResolution.audioSource,
      backend_artifact_audio_reason: backendArtifactAudioResolution.reason,
      backend_artifact_audio_browser_playable:
        backendArtifactAudioResolution.reason === "browser_safe" &&
        backendArtifactAudioResolution.audioSource === backendArtifactAudioReference
    },
    avatar_runtime_speech_reaction: {
      speech_reaction_runtime_markers: speechReactionRuntimeMarkers,
      speech_reaction_runtime_ready: speechReactionRuntimeMarkers.length === expectedSpeechReactionRuntimeMarkers.length,
      snapshot_mode_present: /speechReactionMode:\s*AvatarSpeechReactionMode;/.test(avatarRuntimeSourceText),
      snapshot_active_viseme_present: /activeViseme:\s*string\s*\|\s*null;/.test(avatarRuntimeSourceText)
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
      hook_transport_state_present: /export function useSpeechLifecycleState\s*\(/.test(speechLifecycleHookSourceText),
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

function appendSpeechLifecycleEnvelope(
  snapshot: BackendSpeechLifecycleTransportSnapshotDocument,
  envelope: BackendSpeechLifecycleEventEnvelopeDocument
): BackendSpeechLifecycleTransportSnapshotDocument {
  return {
    ...snapshot,
    next_cursor: `speech.lifecycle:${snapshot.session_id}:${envelope.sequence + 1}`,
    events: [...snapshot.events, envelope]
  };
}

function buildCanonicalArtifactAudioReference(snapshot: BackendSpeechLifecycleTransportSnapshotDocument): string {
  const synthesisEnvelope = snapshot.events.find(
    (envelope) => envelope.event.event_type === "speech.synthesis" && envelope.event.synthesis
  );

  if (!synthesisEnvelope) {
    throw new Error("Expected a canonical speech synthesis envelope to build the backend artifact audio reference.");
  }

  return `/api/session/speech-artifacts/${synthesisEnvelope.event_id}/audio`;
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

function collectSpeechLifecycleHookMarkers(sourceText: string): string[] {
  const markers = getExpectedSpeechLifecycleHookMarkers().map((marker) => ({
    ...marker,
    pattern: marker.pattern
  }));

  return markers.filter((marker) => marker.pattern.test(sourceText)).map((marker) => marker.name);
}

function getExpectedSpeechLifecycleHookMarkers(): Array<{ name: string; pattern: RegExp }> {
  return [
    {
      name: "hook export",
      pattern: /export function useSpeechLifecycleState\s*\(/
    },
    {
      name: "loader live consumption bridge",
      pattern: /\bstartSpeechLifecycleLiveConsumption\b/
    },
    {
      name: "external refresh dependency",
      pattern: /\bexternalRefreshKey\b/
    },
    {
      name: "offline fallback state",
      pattern: /status:\s*"offline"/
    },
    {
      name: "offline retry timer",
      pattern: /window\.setTimeout/
    },
    {
      name: "live delivery message helper",
      pattern: /Live SSE is connected on the backend-owned speech\.lifecycle envelope\./
    }
  ];
}

function collectSpeechReactionRuntimeMarkers(sourceText: string): string[] {
  const markers = getExpectedSpeechReactionRuntimeMarkers().map((marker) => ({
    ...marker,
    pattern: marker.pattern
  }));

  return markers.filter((marker) => marker.pattern.test(sourceText)).map((marker) => marker.name);
}

function getExpectedSpeechReactionRuntimeMarkers(): Array<{ name: string; pattern: RegExp }> {
  return [
    {
      name: "speech overlay channel snapshot",
      pattern: /export\s+interface\s+AvatarOverlayChannelSnapshot\s*\{/
    },
    {
      name: "speech overlay snapshot field",
      pattern: /overlayChannels:\s*AvatarOverlayChannelSnapshot\[\];/
    },
    {
      name: "speech overlay channel factory",
      pattern: /function\s+createSpeechOverlayChannel\s*\(/ 
    },
    {
      name: "speech overlay snapshot builder",
      pattern: /function\s+buildSpeechOverlaySnapshot\s*\(/ 
    },
    {
      name: "speech overlay lifecycle source",
      pattern: /source:\s*nextChannel\.source\s*\?\?\s*"backend\.speech\.lifecycle"/
    },
    {
      name: "speech reaction viseme builder",
      pattern: /function\s+buildSpeechReactionVisemes\s*\(input:\s*AvatarSpeechReactionInput\)/
    },
    {
      name: "speech reaction coarse overlay fallback",
      pattern: /buildSpeechOverlaySnapshot\s*\(\s*\{\s*mode:\s*"coarse"\s*\}\s*\)/
    },
    {
      name: "speech reaction viseme overlay activation",
      pattern: /buildSpeechOverlaySnapshot\s*\(\s*\{\s*mode:\s*"viseme",\s*label\s*\}\s*\)/
    },
    {
      name: "speech reaction idle overlay clear",
      pattern: /buildSpeechOverlaySnapshot\s*\(\s*\{\s*mode:\s*"idle"\s*\}\s*\)/
    },
    {
      name: "runtime begin speech reaction bridge",
      pattern: /beginSpeechReaction\(input\)\s*\{\s*beginSpeechReaction\(input\);\s*\}/
    },
    {
      name: "runtime clear speech reaction bridge",
      pattern: /clearSpeechReaction\(\)\s*\{\s*clearSpeechReaction\(\);\s*\}/
    }
  ];
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

function assertBackendArtifactAudioReferencePlayable(
  audioReference: string,
  resolution: ReturnType<typeof resolveSpeechSynthesisAudioSource>
): void {
  if (resolution.reason !== "browser_safe" || resolution.audioSource !== audioReference) {
    throw new Error(
      `Frontend speech playback no longer treats the backend artifact URL as browser-playable canonical audio: ${audioReference}.`
    );
  }
}

function collectSpeechPlaybackBridgeMarkers(sourceText: string): string[] {
  const markers = getExpectedSpeechPlaybackBridgeMarkers().map((marker) => ({
    ...marker,
    pattern: marker.pattern
  }));

  return markers.filter((marker) => marker.pattern.test(sourceText)).map((marker) => marker.name);
}

function getExpectedSpeechPlaybackBridgeMarkers(): Array<{ name: string; pattern: RegExp }> {
  return [
    {
      name: "hook export",
      pattern: /export function useSpeechPlaybackBridge\s*\(/
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
}

function assertCanonicalSynthesisRuntimeHandoff(appSourceText: string, speechPlaybackBridgeHookSourceText: string): void {
  const appHandoffMarkers = [
    {
      name: "canonical synthesis selection",
      pattern: /const\s+canonicalSynthesisEvent\s*=\s*speechLifecycleState\.snapshot\?\.canonicalSpeechSynthesisEvent\s*\?\?\s*null\s*;/
    },
    {
      name: "speech playback bridge hook usage",
      pattern: /const\s+speechPlaybackStatus\s*=\s*useSpeechPlaybackBridge\s*\(\s*\{/
    }
  ];

  const missingMarkers = appHandoffMarkers.filter((marker) => !marker.pattern.test(appSourceText)).map((marker) => marker.name);

  const speechPlaybackBridgeMarkers = collectSpeechPlaybackBridgeMarkers(speechPlaybackBridgeHookSourceText);
  const expectedSpeechPlaybackBridgeMarkerNames = getExpectedSpeechPlaybackBridgeMarkers().map((marker) => marker.name);
  const missingSpeechPlaybackBridgeMarkers = expectedSpeechPlaybackBridgeMarkerNames.filter(
    (marker) => !speechPlaybackBridgeMarkers.includes(marker)
  );

  if (missingMarkers.length > 0 || missingSpeechPlaybackBridgeMarkers.length > 0) {
    throw new Error(
      `App-to-runtime speech playback handoff no longer preserves the canonical synthesis speech-reaction seam: ${[
        ...missingMarkers,
        ...missingSpeechPlaybackBridgeMarkers
      ].join(", ")}.`
    );
  }
}

function assertSpeechLifecycleHookSeam(speechLifecycleHookSourceText: string): void {
  const hookMarkers = collectSpeechLifecycleHookMarkers(speechLifecycleHookSourceText);
  const expectedMarkers = getExpectedSpeechLifecycleHookMarkers().map((marker) => marker.name);

  if (hookMarkers.length === expectedMarkers.length) {
    return;
  }

  const missingMarkers = expectedMarkers.filter((marker) => !hookMarkers.includes(marker));

  throw new Error(
    `Speech lifecycle transport state no longer preserves the extracted App seam in useSpeechLifecycleState.ts: ${missingMarkers.join(", ")}.`
  );
}

function assertSpeechReactionRuntimeSeam(avatarRuntimeSourceText: string): void {
  const runtimeMarkers = collectSpeechReactionRuntimeMarkers(avatarRuntimeSourceText);
  const expectedMarkers = getExpectedSpeechReactionRuntimeMarkers().map((marker) => marker.name);

  if (runtimeMarkers.length === expectedMarkers.length) {
    return;
  }

  const missingMarkers = expectedMarkers.filter((marker) => !runtimeMarkers.includes(marker));

  throw new Error(
    `Avatar runtime no longer preserves the localized speech-reaction seam Switch is generalizing: ${missingMarkers.join(", ")}.`
  );
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