import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Phase 2 increment 3: frontend consumer of the binary-audio WebSocket
 * (`/session/stream`). The backend publishes, per synthesized segment, a JSON
 * header frame `{event:"speech.audio",utterance_id,segment_index,is_final,
 * mime,bytes}` immediately followed by the WAV bytes (see
 * backend/app/services/speech_audio_broadcast.py). This hook pairs each header
 * with its binary frame, turns the bytes into a `blob:` URL, and caches it by
 * (utterance_id, segment_index) so the playback bridge can start audio without
 * a separate artifact fetch.
 *
 * It is an OPTIMIZATION layered on the canonical seams: `speech.lifecycle`
 * (SSE) remains the source of truth for text/timing/visemes, and the
 * `/api/session/speech-artifacts/{id}/audio` fetch remains the fallback when a
 * segment's bytes have not streamed in. The same JSON lifecycle frames also
 * arrive on this socket but are ignored here — SSE owns that read seam.
 *
 * Gating: the consumer only connects when `enabled` is true. The caller wires
 * `enabled` to "is this the avatar/display surface?" so audio plays on exactly
 * one page and never duplicates onto control/settings windows.
 */

export type SpeechAudioStreamStatus = "disabled" | "connecting" | "open" | "closed";

export interface SpeechAudioStreamHandle {
  status: SpeechAudioStreamStatus;
  /**
   * Browser-safe `blob:` URL for a segment whose audio has streamed in, or
   * null when it has not (caller falls back to the artifact fetch). Stable
   * identity — safe to pass into effects.
   */
  getSegmentAudioUrl: (utteranceId: string | null, segmentIndex: number | null) => string | null;
}

interface SpeechAudioFrameHeader {
  event?: string;
  utterance_id?: string | null;
  segment_index?: number | null;
  is_final?: boolean | null;
  mime?: string | null;
  bytes?: number | null;
}

const RECONNECT_DELAY_MS = 2000;

export function useSpeechAudioStream({ enabled }: { enabled: boolean }): SpeechAudioStreamHandle {
  const [status, setStatus] = useState<SpeechAudioStreamStatus>("disabled");
  const cacheRef = useRef<Map<string, string>>(new Map());

  const getSegmentAudioUrl = useCallback(
    (utteranceId: string | null, segmentIndex: number | null): string | null => {
      const key = buildSegmentKey(utteranceId, segmentIndex);
      if (!key) {
        return null;
      }
      return cacheRef.current.get(key) ?? null;
    },
    []
  );

  useEffect(() => {
    if (
      !enabled ||
      typeof window === "undefined" ||
      typeof window.WebSocket !== "function"
    ) {
      setStatus("disabled");
      return;
    }

    const streamUrl = buildSpeechStreamWebSocketUrl();
    if (!streamUrl) {
      setStatus("disabled");
      return;
    }

    const cache = cacheRef.current;
    let socket: WebSocket | null = null;
    let reconnectTimeoutId: number | null = null;
    let pendingHeader: SpeechAudioFrameHeader | null = null;
    let disposed = false;

    const scheduleReconnect = (): void => {
      if (disposed || reconnectTimeoutId !== null) {
        return;
      }
      reconnectTimeoutId = window.setTimeout(() => {
        reconnectTimeoutId = null;
        connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = (): void => {
      if (disposed) {
        return;
      }

      setStatus("connecting");

      let nextSocket: WebSocket;
      try {
        nextSocket = new window.WebSocket(streamUrl);
      } catch {
        scheduleReconnect();
        return;
      }

      socket = nextSocket;
      nextSocket.binaryType = "arraybuffer";

      nextSocket.onopen = (): void => {
        if (!disposed) {
          setStatus("open");
        }
      };

      nextSocket.onmessage = (event: MessageEvent): void => {
        if (typeof event.data === "string") {
          // JSON control frame. Lifecycle frames are ignored (SSE owns that
          // seam); only a speech.audio header arms the next binary frame.
          let frame: SpeechAudioFrameHeader | null = null;
          try {
            frame = JSON.parse(event.data) as SpeechAudioFrameHeader;
          } catch {
            return;
          }
          pendingHeader = frame && frame.event === "speech.audio" ? frame : null;
          return;
        }

        const header = pendingHeader;
        pendingHeader = null;
        if (!header || !(event.data instanceof ArrayBuffer)) {
          return;
        }

        const key = buildSegmentKey(header.utterance_id ?? null, header.segment_index ?? null);
        if (!key) {
          return;
        }

        const blob = new Blob([event.data], { type: header.mime || "audio/wav" });
        const previous = cache.get(key);
        if (previous) {
          URL.revokeObjectURL(previous);
        }
        cache.set(key, URL.createObjectURL(blob));
      };

      nextSocket.onerror = (): void => {
        // The close handler drives reconnection; nothing to do here.
      };

      nextSocket.onclose = (): void => {
        socket = null;
        pendingHeader = null;
        if (disposed) {
          return;
        }
        setStatus("closed");
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimeoutId !== null) {
        window.clearTimeout(reconnectTimeoutId);
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // best-effort close
        }
      }
      cache.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
      cache.clear();
      setStatus("disabled");
    };
  }, [enabled]);

  return { status, getSegmentAudioUrl };
}

/**
 * Join key for a synthesized segment. Non-segmented (legacy) events carry no
 * segment_index; those are not streamed-keyable, so the bridge falls back to
 * the artifact fetch for them.
 */
function buildSegmentKey(utteranceId: string | null, segmentIndex: number | null): string | null {
  if (segmentIndex === null || segmentIndex === undefined) {
    return null;
  }
  return `${utteranceId ?? "_"}:${segmentIndex}`;
}

function resolveBackendApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env?.VITE_BACKEND_API_BASE_URL?.trim();
  if (!configuredBaseUrl) {
    return "/api";
  }
  return configuredBaseUrl.replace(/\/+$/, "");
}

function buildSpeechStreamWebSocketUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const base = resolveBackendApiBaseUrl().replace(/\/+$/, "");
  const httpUrl = new URL(`${base}/session/stream`, window.location.origin);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}
