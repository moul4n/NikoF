import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechAudioStream } from "./useSpeechAudioStream";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  binaryType = "blob";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.({});
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
}

let objectUrlCounter = 0;
const revoked: string[] = [];
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

beforeEach(() => {
  FakeWebSocket.instances = [];
  objectUrlCounter = 0;
  revoked.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // Attach the object-URL helpers to the real URL constructor (jsdom omits
  // them) without shadowing `new URL(...)`.
  URL.createObjectURL = vi.fn(() => `blob:fake-${++objectUrlCounter}`);
  URL.revokeObjectURL = vi.fn((value: string) => {
    revoked.push(value);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
});

function audioHeader(utteranceId: string, segmentIndex: number, isFinal = false): string {
  return JSON.stringify({
    event: "speech.audio",
    utterance_id: utteranceId,
    segment_index: segmentIndex,
    is_final: isFinal,
    mime: "audio/wav",
    bytes: 4
  });
}

describe("useSpeechAudioStream", () => {
  it("does not connect when disabled", () => {
    const { result } = renderHook(() => useSpeechAudioStream({ enabled: false }));
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(result.current.status).toBe("disabled");
    expect(result.current.getSegmentAudioUrl("u1", 0)).toBeNull();
  });

  it("connects to the proxied /api/session/stream websocket when enabled", () => {
    renderHook(() => useSpeechAudioStream({ enabled: true }));
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toMatch(/^ws:\/\/.+\/api\/session\/stream$/);
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("pairs a speech.audio header with the following binary frame into a blob url", () => {
    const { result } = renderHook(() => useSpeechAudioStream({ enabled: true }));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit(audioHeader("u1", 0));
      socket.emit(new Uint8Array([1, 2, 3, 4]).buffer);
    });

    expect(result.current.status).toBe("open");
    expect(result.current.getSegmentAudioUrl("u1", 0)).toBe("blob:fake-1");
    // A different segment that has not streamed in yields null (fetch fallback).
    expect(result.current.getSegmentAudioUrl("u1", 1)).toBeNull();
  });

  it("ignores binary frames with no preceding header and lifecycle json frames", () => {
    const { result } = renderHook(() => useSpeechAudioStream({ enabled: true }));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.open();
      // Lifecycle control frame on the same socket — must be ignored here.
      socket.emit(JSON.stringify({ event: "speech.lifecycle", kind: "event" }));
      // Orphan binary frame with no armed header — dropped.
      socket.emit(new Uint8Array([9, 9]).buffer);
    });

    expect(result.current.getSegmentAudioUrl("u1", 0)).toBeNull();
  });

  it("revokes blob urls and clears the cache on unmount", () => {
    const { result, unmount } = renderHook(() => useSpeechAudioStream({ enabled: true }));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit(audioHeader("u1", 0));
      socket.emit(new Uint8Array([1, 2, 3, 4]).buffer);
    });
    expect(result.current.getSegmentAudioUrl("u1", 0)).toBe("blob:fake-1");

    unmount();
    expect(revoked).toContain("blob:fake-1");
  });

  it("does not key non-segmented (legacy) events", () => {
    const { result } = renderHook(() => useSpeechAudioStream({ enabled: true }));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.open();
    });
    // No segment_index -> not streamable-keyable.
    expect(result.current.getSegmentAudioUrl("u1", null)).toBeNull();
  });
});
