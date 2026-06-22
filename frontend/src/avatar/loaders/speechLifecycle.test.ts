import { describe, expect, it } from "vitest";
import type { BackendSessionEventDocument } from "../../shared/types/character";
import { consumeSpeechLifecycleSnapshot, selectCurrentUtteranceSegments } from "./speechLifecycle";

function transcriptionEvent(
  eventType: "transcript.partial" | "transcription.status",
  transcript: string,
  isFinal: boolean | undefined,
  index: number
): BackendSessionEventDocument {
  return {
    schema_version: 2,
    event_type: eventType,
    session_id: "session-1",
    character_id: "niko",
    status: isFinal === false ? "partial" : "final",
    timestamp: `2026-06-21T00:00:0${index}Z`,
    transcription: {
      profile_id: "stt.parakeet-tdt.0.6b-v2-2026",
      status: isFinal === false ? "partial" : "final",
      locale: "en-US",
      transcript,
      ...(isFinal === undefined ? {} : { is_final: isFinal })
    }
  } as BackendSessionEventDocument;
}

function snapshotOf(events: BackendSessionEventDocument[]) {
  return {
    stream: "speech.lifecycle",
    delivery: "snapshot",
    session_id: "session-1",
    next_cursor: `speech.lifecycle:session-1:${events.length + 1}`,
    events: events.map((event, index) => ({
      cursor: `speech.lifecycle:session-1:${index + 1}`,
      sequence: index + 1,
      event
    }))
  } as Parameters<typeof consumeSpeechLifecycleSnapshot>[0];
}

function synthesisEvent(
  overrides: Partial<BackendSessionEventDocument["synthesis"]> & { text: string }
): BackendSessionEventDocument {
  return {
    schema_version: 2,
    event_type: "speech.synthesis",
    session_id: "session-1",
    character_id: "niko",
    status: "ready",
    timestamp: "2026-06-21T00:00:00Z",
    synthesis: {
      profile_id: "tts.gpt-sovits.2026-stable",
      status: "ready",
      locale: "en-US",
      ...overrides
    }
  } as BackendSessionEventDocument;
}

describe("selectCurrentUtteranceSegments", () => {
  it("returns an empty list when there are no synthesis events", () => {
    expect(selectCurrentUtteranceSegments([])).toEqual([]);
  });

  it("returns the single latest event when it has no utterance_id (legacy)", () => {
    const a = synthesisEvent({ text: "Older." });
    const b = synthesisEvent({ text: "Latest." });
    const result = selectCurrentUtteranceSegments([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].synthesis?.text).toBe("Latest.");
  });

  it("groups segments by the latest utterance_id and orders by segment_index", () => {
    const events = [
      synthesisEvent({ text: "Old utterance.", utterance_id: "u0", segment_index: 0, segment_count: 1, is_final: true }),
      synthesisEvent({ text: "Two.", utterance_id: "u1", segment_index: 1, segment_count: 3, is_final: false }),
      synthesisEvent({ text: "One.", utterance_id: "u1", segment_index: 0, segment_count: 3, is_final: false }),
      synthesisEvent({ text: "Three.", utterance_id: "u1", segment_index: 2, segment_count: 3, is_final: true })
    ];
    const result = selectCurrentUtteranceSegments(events);
    expect(result.map((event) => event.synthesis?.text)).toEqual(["One.", "Two.", "Three."]);
    expect(result.map((event) => event.synthesis?.is_final)).toEqual([false, false, true]);
  });

  it("ignores segments from other utterances", () => {
    const events = [
      synthesisEvent({ text: "Other one.", utterance_id: "uX", segment_index: 0, segment_count: 1, is_final: true }),
      synthesisEvent({ text: "Current one.", utterance_id: "uY", segment_index: 0, segment_count: 2, is_final: false }),
      synthesisEvent({ text: "Current two.", utterance_id: "uY", segment_index: 1, segment_count: 2, is_final: true })
    ];
    const result = selectCurrentUtteranceSegments(events);
    expect(result.map((event) => event.synthesis?.utterance_id)).toEqual(["uY", "uY"]);
    expect(result).toHaveLength(2);
  });

  it("de-duplicates by segment_index, keeping the latest occurrence", () => {
    const events = [
      synthesisEvent({ text: "First take.", utterance_id: "u1", segment_index: 0, segment_count: 1, is_final: true }),
      synthesisEvent({ text: "Re-emitted.", utterance_id: "u1", segment_index: 0, segment_count: 1, is_final: true })
    ];
    const result = selectCurrentUtteranceSegments(events);
    expect(result).toHaveLength(1);
    expect(result[0].synthesis?.text).toBe("Re-emitted.");
  });
});

describe("consumeSpeechLifecycleSnapshot live captions", () => {
  it("surfaces the most recent transcript.partial text", () => {
    const snapshot = consumeSpeechLifecycleSnapshot(
      snapshotOf([
        transcriptionEvent("transcript.partial", "hello", false, 1),
        transcriptionEvent("transcript.partial", "hello there", false, 2)
      ])
    );
    expect(snapshot.livePartialTranscript).toBe("hello there");
  });

  it("clears the caption once a confirmed final supersedes the partial", () => {
    const snapshot = consumeSpeechLifecycleSnapshot(
      snapshotOf([
        transcriptionEvent("transcript.partial", "hello the", false, 1),
        transcriptionEvent("transcription.status", "hello there friend", true, 2)
      ])
    );
    expect(snapshot.livePartialTranscript).toBeNull();
  });

  it("is null when there are no transcription events", () => {
    const snapshot = consumeSpeechLifecycleSnapshot(snapshotOf([synthesisEvent({ text: "Reply." })]));
    expect(snapshot.livePartialTranscript).toBeNull();
  });
});
