import type { BackendAnimationCommandDocument, SemanticAnimationCommand } from "../../shared/types/animation.js";

type ImportMetaWithOptionalEnv = ImportMeta & {
  env?: {
    VITE_BACKEND_API_BASE_URL?: string;
  };
};

export type AnimationWebSocketState = "connecting" | "connected" | "disconnected";

export interface AnimationWebSocketFactory {
  (url: string): WebSocket;
}

export interface AnimationWebSocketCallbacks {
  webSocketFactory?: AnimationWebSocketFactory;
  onCommand: (command: SemanticAnimationCommand) => void;
  onStateChange?: (state: AnimationWebSocketState) => void;
}

export interface AnimationWebSocketSubscription {
  close(): void;
}

export function startAnimationWebSocketConsumption(
  callbacks: AnimationWebSocketCallbacks
): AnimationWebSocketSubscription {
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimeoutId: number | null = null;
  let reconnectAttempts = 0;
  const maxReconnectDelayMs = 30_000;

  function connect(): void {
    if (closed) {
      return;
    }

    const url = buildAnimationWebSocketUrl();

    if (!url) {
      return;
    }

    try {
      const factory = callbacks.webSocketFactory ?? ((u: string) => new WebSocket(u));
      ws = factory(url);
    } catch {
      scheduleReconnect();
      return;
    }

    callbacks.onStateChange?.("connecting");

    ws.addEventListener("open", () => {
      if (closed) {
        ws?.close();
        return;
      }

      reconnectAttempts = 0;
      callbacks.onStateChange?.("connected");
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (closed) {
        return;
      }

      try {
        const doc = JSON.parse(event.data as string) as BackendAnimationCommandDocument;

        if (!doc || typeof doc.animation_id !== "string" || doc.animation_id === "") {
          return;
        }

        const command = mapBackendCommandToSemantic(doc);
        callbacks.onCommand(command);
      } catch {
        // Drop malformed frames without breaking the connection.
      }
    });

    ws.addEventListener("close", () => {
      if (closed) {
        return;
      }

      ws = null;
      callbacks.onStateChange?.("disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // The close event fires after error; reconnect is handled there.
    });
  }

  function scheduleReconnect(): void {
    if (closed) {
      return;
    }

    // Cap reconnectAttempts to prevent Math.pow overflow on very long disconnects.
    const safeAttempts = Math.min(reconnectAttempts, 20);
    const delayMs = Math.min(1_000 * Math.pow(1.5, safeAttempts), maxReconnectDelayMs);
    reconnectAttempts += 1;

    reconnectTimeoutId = window.setTimeout(() => {
      reconnectTimeoutId = null;
      connect();
    }, delayMs);
  }

  function close(): void {
    if (closed) {
      return;
    }

    closed = true;

    if (reconnectTimeoutId !== null) {
      window.clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }

    ws?.close();
    ws = null;
    callbacks.onStateChange?.("disconnected");
  }

  connect();

  return { close };
}

export function mapBackendCommandToSemantic(doc: BackendAnimationCommandDocument): SemanticAnimationCommand {
  let durationMs: number | undefined;

  if (doc.parameters?.duration_ms != null && doc.parameters.duration_ms !== "") {
    const parsed = Number(doc.parameters.duration_ms);
    if (!Number.isNaN(parsed)) {
      durationMs = parsed;
    }
  }

  return {
    id: doc.animation_id,
    source: doc.parameters?.source === "override" ? "override" : "shared",
    playback: doc.parameters?.playback === "once" ? "once" : "loop",
    intensity: typeof doc.intensity === "number" ? doc.intensity : undefined,
    durationMs
  };
}

function buildAnimationWebSocketUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const configuredBaseUrl = (import.meta as ImportMetaWithOptionalEnv).env?.VITE_BACKEND_API_BASE_URL?.trim();

  if (configuredBaseUrl && /^https?:\/\//i.test(configuredBaseUrl)) {
    const wsBase = configuredBaseUrl
      .replace(/^http/i, "ws")
      .replace(/\/api\/?$/, "")
      .replace(/\/+$/, "");
    return `${wsBase}/ws/animation`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/animation`;
}
