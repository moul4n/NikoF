import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvatarRuntimeBridge } from "../avatar/runtime/avatarRuntime";
import type { BackendSessionEventDocument } from "../shared/types/character";
import { useSpeechPlaybackBridge } from "./useSpeechPlaybackBridge";

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  volume = 1;
  muted = false;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  readyState = 0;
  networkState = 0;
  private listeners = new Map<string, Set<() => void>>();

  constructor(src?: string) {
    this.src = src ?? "";
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, cb: () => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.forEach((cb) => cb());
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }
}

function makeRuntime(): AvatarRuntimeBridge {
  return {
    beginSpeechReaction: vi.fn(),
    clearSpeechReaction: vi.fn()
  } as unknown as AvatarRuntimeBridge;
}

function segment(
  index: number,
  isFinal: boolean,
  text: string,
  utteranceId: string | null = "u1"
): BackendSessionEventDocument {
  return {
    schema_version: 2,
    event_type: "speech.synthesis",
    session_id: "session-1",
    character_id: "niko",
    status: "ready",
    timestamp: `2026-06-21T00:00:0${index}Z`,
    synthesis: {
      profile_id: "tts.gpt-sovits.2026-stable",
      status: "ready",
      locale: "en-US",
      text,
      audio_reference: `/api/session/speech-artifacts/seg${index}/audio`,
      ...(utteranceId ? { utterance_id: utteranceId } : {}),
      segment_index: index,
      segment_count: 3,
      is_final: isFinal
    }
  } as BackendSessionEventDocument;
}

interface BridgeProps {
  runtime: AvatarRuntimeBridge;
  canonicalSynthesisEvent: BackendSessionEventDocument | null;
  latestAvailableSynthesisEvent: BackendSessionEventDocument | null;
  canonicalSynthesisSegments: BackendSessionEventDocument[];
  playbackEnabled?: boolean;
  resolveSegmentAudioOverride?: (utteranceId: string | null, segmentIndex: number | null) => string | null;
  lifecycleReady?: boolean;
}

async function flush(): Promise<void> {
  // Flush the microtask queue so audio.play().then(...) resolves.
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useSpeechPlaybackBridge playlist sequencing", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("plays multi-segment utterances in order, advancing on completion", async () => {
    const runtime = makeRuntime();
    const { rerender } = renderHook((props: BridgeProps) => useSpeechPlaybackBridge(props), {
      initialProps: {
        runtime,
        canonicalSynthesisEvent: null,
        latestAvailableSynthesisEvent: null,
        canonicalSynthesisSegments: [segment(0, false, "One.")]
      }
    });

    await flush();
    expect(FakeAudio.instances.map((audio) => audio.src)).toEqual([
      "/api/session/speech-artifacts/seg0/audio"
    ]);
    expect((runtime.beginSpeechReaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    // Segment 0 ends: non-final -> advance; next segment not delivered yet, so wait.
    const clearsAfterStart = (runtime.clearSpeechReaction as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      FakeAudio.instances[0].dispatch("ended");
    });
    expect(FakeAudio.instances).toHaveLength(1); // still waiting for seg1
    expect((runtime.clearSpeechReaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(clearsAfterStart);

    // Segment 1 streams in -> plays.
    rerender({
      runtime,
      canonicalSynthesisEvent: null,
      latestAvailableSynthesisEvent: null,
      canonicalSynthesisSegments: [segment(0, false, "One."), segment(1, false, "Two.")]
    });
    await flush();
    expect(FakeAudio.instances.map((audio) => audio.src)).toEqual([
      "/api/session/speech-artifacts/seg0/audio",
      "/api/session/speech-artifacts/seg1/audio"
    ]);

    await act(async () => {
      FakeAudio.instances[1].dispatch("ended");
    });

    // Final segment streams in -> plays, and completes the utterance.
    rerender({
      runtime,
      canonicalSynthesisEvent: null,
      latestAvailableSynthesisEvent: null,
      canonicalSynthesisSegments: [
        segment(0, false, "One."),
        segment(1, false, "Two."),
        segment(2, true, "Three.")
      ]
    });
    await flush();
    expect(FakeAudio.instances.map((audio) => audio.src)).toEqual([
      "/api/session/speech-artifacts/seg0/audio",
      "/api/session/speech-artifacts/seg1/audio",
      "/api/session/speech-artifacts/seg2/audio"
    ]);
    expect((runtime.beginSpeechReaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);

    const clearsBeforeFinal = (runtime.clearSpeechReaction as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      FakeAudio.instances[2].dispatch("ended");
    });
    // Cleanup fires exactly once for the final segment.
    expect((runtime.clearSpeechReaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      clearsBeforeFinal + 1
    );
  });

  it("plays a legacy single event (no utterance_id) and cleans up on completion", async () => {
    const runtime = makeRuntime();
    const legacy = segment(0, true, "Just one line.", null);
    renderHook((props: BridgeProps) => useSpeechPlaybackBridge(props), {
      initialProps: {
        runtime,
        canonicalSynthesisEvent: legacy,
        latestAvailableSynthesisEvent: null,
        canonicalSynthesisSegments: []
      }
    });

    await flush();
    expect(FakeAudio.instances).toHaveLength(1);
    expect((runtime.beginSpeechReaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    const clearsBefore = (runtime.clearSpeechReaction as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      FakeAudio.instances[0].dispatch("ended");
    });
    expect((runtime.clearSpeechReaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(clearsBefore + 1);
  });

  it("does not voice replies when playbackEnabled is false (non-avatar surface)", async () => {
    const runtime = makeRuntime();
    renderHook((props: BridgeProps) => useSpeechPlaybackBridge(props), {
      initialProps: {
        runtime,
        canonicalSynthesisEvent: null,
        latestAvailableSynthesisEvent: null,
        canonicalSynthesisSegments: [segment(0, true, "Only here for the avatar window.")],
        playbackEnabled: false
      }
    });

    await flush();
    expect(FakeAudio.instances).toHaveLength(0);
    expect((runtime.beginSpeechReaction as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("prefers a streamed audio override (blob url) over the canonical audio_reference", async () => {
    const runtime = makeRuntime();
    renderHook((props: BridgeProps) => useSpeechPlaybackBridge(props), {
      initialProps: {
        runtime,
        canonicalSynthesisEvent: null,
        latestAvailableSynthesisEvent: null,
        canonicalSynthesisSegments: [segment(0, true, "Streamed.")],
        resolveSegmentAudioOverride: (utteranceId, segmentIndex) =>
          utteranceId === "u1" && segmentIndex === 0 ? "blob:streamed-seg0" : null
      }
    });

    await flush();
    expect(FakeAudio.instances.map((audio) => audio.src)).toEqual(["blob:streamed-seg0"]);
  });

  it("falls back to the artifact fetch when no streamed override is available", async () => {
    const runtime = makeRuntime();
    renderHook((props: BridgeProps) => useSpeechPlaybackBridge(props), {
      initialProps: {
        runtime,
        canonicalSynthesisEvent: null,
        latestAvailableSynthesisEvent: null,
        canonicalSynthesisSegments: [segment(0, true, "Fetched.")],
        resolveSegmentAudioOverride: () => null
      }
    });

    await flush();
    expect(FakeAudio.instances.map((audio) => audio.src)).toEqual([
      "/api/session/speech-artifacts/seg0/audio"
    ]);
  });

  it("suppresses auto-play on mount when the latest event is already resolved", async () => {
    const runtime = makeRuntime();
    const onlyEvent = segment(0, true, "Stale reply.", null);
    renderHook((props: BridgeProps) => useSpeechPlaybackBridge(props), {
      initialProps: {
        runtime,
        canonicalSynthesisEvent: onlyEvent,
        latestAvailableSynthesisEvent: onlyEvent,
        canonicalSynthesisSegments: []
      }
    });

    await flush();
    // The initial-bundle effect pre-marks this event as handled, so a page
    // (re)load must not replay it.
    expect(FakeAudio.instances).toHaveLength(0);
    expect((runtime.beginSpeechReaction as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("suppresses a segmented mount-time replay once the snapshot is ready, then voices the next reply", async () => {
    const runtime = makeRuntime();
    // A completed multi-segment reply already present in the snapshot when this
    // surface loads. The first segment's key differs from the latest/canonical
    // event, so the old single-key suppression missed it — this is the startup
    // "she plays the last TTS file" bug.
    const priorReply = [segment(0, false, "One."), segment(1, true, "Two.")];
    const { rerender } = renderHook((props: BridgeProps) => useSpeechPlaybackBridge(props), {
      initialProps: {
        runtime,
        canonicalSynthesisEvent: priorReply[priorReply.length - 1],
        latestAvailableSynthesisEvent: priorReply[priorReply.length - 1],
        canonicalSynthesisSegments: priorReply,
        lifecycleReady: true
      }
    });

    await flush();
    // Snapshot replay on load -> must NOT auto-voice.
    expect(FakeAudio.instances).toHaveLength(0);
    expect((runtime.beginSpeechReaction as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // A genuinely new utterance (different utterance_id) arrives after the
    // baseline -> it IS voiced.
    const nextReply = [segment(0, true, "A fresh reply.", "u2")];
    await act(async () => {
      rerender({
        runtime,
        canonicalSynthesisEvent: nextReply[0],
        latestAvailableSynthesisEvent: nextReply[0],
        canonicalSynthesisSegments: nextReply,
        lifecycleReady: true
      });
    });
    await flush();
    expect(FakeAudio.instances).toHaveLength(1);
    expect((runtime.beginSpeechReaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
