import { useEffect, useState } from "react";
import {
  startSpeechLifecycleLiveConsumption,
  type ConsumedSpeechLifecycleSnapshot,
  type SpeechLifecycleDeliveryMode
} from "../avatar/loaders/speechLifecycle.js";
import type { CharacterId } from "../shared/types/character";

const backendRecoveryRetryIntervalMs = 3000;

export type SpeechLifecycleLoadState = {
  status: "loading" | "ready" | "offline";
  snapshot: ConsumedSpeechLifecycleSnapshot | null;
  deliveryMode: SpeechLifecycleDeliveryMode;
  message: string | null;
};

interface UseSpeechLifecycleStateOptions {
  catalogLoadStatus: "loading" | "ready" | "error";
  externalRefreshKey: number;
}

export function describeSpeechLifecycleStateMessage(state: SpeechLifecycleLoadState): string | null {
  if (state.status !== "ready") {
    return state.message;
  }

  if (state.deliveryMode === "live") {
    return "Live SSE is connected on the backend-owned speech.lifecycle envelope.";
  }

  return state.message ?? "The shell is reading the backend-owned snapshot envelope while live delivery is unavailable.";
}

export function resolveSpeechLifecycleDeliveryLabel(state: SpeechLifecycleLoadState): string {
  if (state.status === "offline") {
    return "offline";
  }

  if (state.status === "loading") {
    return "loading";
  }

  return state.deliveryMode === "live" ? "live SSE" : "snapshot fallback";
}

export function resolveSpeechLifecycleCharacterId(snapshot: ConsumedSpeechLifecycleSnapshot | null): CharacterId | null {
  return (
    snapshot?.canonicalSpeechSynthesisEvent?.character_id ??
    snapshot?.canonicalAssistantMessageEvent?.character_id ??
    snapshot?.canonicalTranscriptionEvent?.character_id ??
    null
  );
}

export function useSpeechLifecycleState({
  catalogLoadStatus,
  externalRefreshKey
}: UseSpeechLifecycleStateOptions): SpeechLifecycleLoadState {
  const [speechLifecycleState, setSpeechLifecycleState] = useState<SpeechLifecycleLoadState>({
    status: "loading",
    snapshot: null,
    deliveryMode: "snapshot",
    message: null
  });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (catalogLoadStatus === "error") {
      setSpeechLifecycleState({
        status: "offline",
        snapshot: null,
        deliveryMode: "snapshot",
        message: "Speech lifecycle read surface unavailable until the local manifest catalog loads successfully."
      });
      return;
    }

    if (catalogLoadStatus !== "ready") {
      return;
    }

    let cancelled = false;
    let liveConsumption: { close(): void } | null = null;

    if (externalRefreshKey === 0 && retryKey === 0) {
      setSpeechLifecycleState({
        status: "loading",
        snapshot: null,
        deliveryMode: "snapshot",
        message: null
      });
    }

    void startSpeechLifecycleLiveConsumption({
      onSnapshot: (snapshot, deliveryMode) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState((currentState) => ({
          status: "ready",
          snapshot,
          deliveryMode,
          message: deliveryMode === "live" ? null : currentState.message
        }));
      },
      onDeliveryModeChange: (deliveryMode, error) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState((currentState) => {
          if (currentState.status === "offline") {
            return currentState;
          }

          return {
            status: currentState.snapshot ? "ready" : currentState.status,
            snapshot: currentState.snapshot,
            deliveryMode,
            message:
              deliveryMode === "live"
                ? null
                : error
                  ? `${error.message} The shell is continuing from the latest backend snapshot.`
                  : currentState.message
          };
        });
      }
    })
      .then((subscription) => {
        if (cancelled) {
          subscription.close();
          return;
        }

        liveConsumption = subscription;
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState({
          status: "offline",
          snapshot: null,
          deliveryMode: "snapshot",
          message:
            error instanceof Error
              ? `${error.message} The shell stays on backend-confirmed character state without live speech delivery in this slice.`
              : "Backend speech lifecycle snapshot unavailable."
        });
      });

    return () => {
      cancelled = true;
      liveConsumption?.close();
    };
  }, [catalogLoadStatus, externalRefreshKey, retryKey]);

  useEffect(() => {
    if (catalogLoadStatus !== "ready" || speechLifecycleState.status !== "offline") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRetryKey((currentKey) => currentKey + 1);
    }, backendRecoveryRetryIntervalMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [catalogLoadStatus, speechLifecycleState.status]);

  return speechLifecycleState;
}