import { useEffect, useState } from "react";
import { resolveSelectedCharacterId } from "../avatar/loaders/backendCharacterFlow";
import {
  startSessionAnimationLiveConsumption,
  type ConsumedSessionAnimationSnapshot,
  type SessionAnimationDeliveryMode,
  updateSessionAnimationLifecycleState
} from "../avatar/loaders/sessionAnimation";
import type {
  CharacterCatalog,
  CharacterId
} from "../shared/types/character";

const backendRecoveryRetryIntervalMs = 3000;

type StateSetter<TValue> = (value: TValue | ((currentValue: TValue) => TValue)) => void;

type AnimationLifecycleState = "idle" | "listen" | "speak";

const lifecycleSemanticByState: Record<AnimationLifecycleState, string> = {
  idle: "idle.neutral",
  listen: "listen.loop",
  speak: "speak.loop"
};

export type SessionAnimationLoadState = {
  status: "loading" | "ready" | "offline";
  snapshot: ConsumedSessionAnimationSnapshot | null;
  deliveryMode: SessionAnimationDeliveryMode;
  message: string | null;
};

interface UseSessionAnimationStateOptions {
  catalog: CharacterCatalog | null;
  catalogLoadStatus: "loading" | "ready" | "error";
  backendActiveCharacterConnected: boolean;
  selectedCharacterId: CharacterId | null;
  setSelectedCharacterId: StateSetter<CharacterId | null>;
  externalRefreshKey: number;
  desiredLifecycleState: AnimationLifecycleState | null;
  desiredLifecycleReason: string | null;
  shouldReconcileLifecycle: boolean;
}

export function useSessionAnimationState({
  catalog,
  catalogLoadStatus,
  backendActiveCharacterConnected,
  selectedCharacterId,
  setSelectedCharacterId,
  externalRefreshKey,
  desiredLifecycleState,
  desiredLifecycleReason,
  shouldReconcileLifecycle
}: UseSessionAnimationStateOptions): SessionAnimationLoadState {
  const [sessionAnimationState, setSessionAnimationState] = useState<SessionAnimationLoadState>({
    status: "loading",
    snapshot: null,
    deliveryMode: "snapshot",
    message: null
  });
  const [retryKey, setRetryKey] = useState(0);
  const [animationLifecycleBridge] = useState(() => ({
    requestedStateKey: null as string | null
  }));

  useEffect(() => {
    if (
      !shouldReconcileLifecycle ||
      catalogLoadStatus !== "ready" ||
      !selectedCharacterId ||
      !desiredLifecycleState ||
      !desiredLifecycleReason
    ) {
      return;
    }

    const currentAnimationSnapshot = sessionAnimationState.snapshot;
    const expectedSemanticId = lifecycleSemanticByState[desiredLifecycleState];
    const requestKey = `${selectedCharacterId}:${desiredLifecycleState}:${expectedSemanticId}`;

    if (
      currentAnimationSnapshot?.characterId === selectedCharacterId &&
      currentAnimationSnapshot.lifecycleState === desiredLifecycleState &&
      currentAnimationSnapshot.semanticCommand.id === expectedSemanticId
    ) {
      animationLifecycleBridge.requestedStateKey = requestKey;
      return;
    }

    if (animationLifecycleBridge.requestedStateKey === requestKey) {
      return;
    }

    animationLifecycleBridge.requestedStateKey = requestKey;

    let cancelled = false;

    void updateSessionAnimationLifecycleState(desiredLifecycleState, desiredLifecycleReason)
      .then((snapshot) => {
        if (cancelled) {
          return;
        }

        setSessionAnimationState((currentState) => ({
          status: "ready",
          snapshot,
          deliveryMode: currentState.deliveryMode,
          message: currentState.deliveryMode === "live" ? null : currentState.message
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setSessionAnimationState((currentState) => {
          if (currentState.snapshot) {
            return currentState;
          }

          return {
            status: "offline",
            snapshot: null,
            deliveryMode: "snapshot",
            message: "Backend session animation update unavailable; viewer is holding the local idle fallback."
          };
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    animationLifecycleBridge,
    catalogLoadStatus,
    desiredLifecycleReason,
    desiredLifecycleState,
    selectedCharacterId,
    sessionAnimationState.snapshot,
    shouldReconcileLifecycle
  ]);

  useEffect(() => {
    if (catalogLoadStatus === "error") {
      setSessionAnimationState({
        status: "offline",
        snapshot: null,
        deliveryMode: "snapshot",
        message: "Session animation read surface unavailable until the local manifest catalog loads successfully."
      });
      return;
    }

    if (catalogLoadStatus !== "ready") {
      return;
    }

    let cancelled = false;
    let liveConsumption: { close(): void } | null = null;

    setSessionAnimationState((currentState) =>
      currentState.snapshot
        ? currentState
        : {
            status: "loading",
            snapshot: null,
            deliveryMode: "snapshot",
            message: null
          }
    );

    void startSessionAnimationLiveConsumption({
      onSnapshot: (snapshot, deliveryMode) => {
        if (cancelled) {
          return;
        }

        if (backendActiveCharacterConnected && catalog) {
          const reconciledCharacterId = resolveSelectedCharacterId(catalog, snapshot.characterId);

          if (reconciledCharacterId) {
            setSelectedCharacterId((currentCharacterId) =>
              currentCharacterId && resolveSelectedCharacterId(catalog, currentCharacterId) === currentCharacterId
                ? currentCharacterId
                : reconciledCharacterId
            );
          }
        }

        setSessionAnimationState((currentState) => ({
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

        setSessionAnimationState((currentState) => {
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
                  ? `${error.message} The shell is continuing from the latest backend animation snapshot when available.`
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

        setSessionAnimationState({
          status: "offline",
          snapshot: null,
          deliveryMode: "snapshot",
          message:
            error instanceof Error
              ? `${error.message} The viewer is holding the local idle fallback until backend animation delivery returns.`
              : "Backend session animation snapshot unavailable."
        });
      });

    return () => {
      cancelled = true;
      liveConsumption?.close();
    };
  }, [
    backendActiveCharacterConnected,
    catalog,
    catalogLoadStatus,
    externalRefreshKey,
    retryKey,
    setSelectedCharacterId
  ]);

  useEffect(() => {
    if (catalogLoadStatus !== "ready" || sessionAnimationState.status !== "offline") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRetryKey((currentKey) => currentKey + 1);
    }, backendRecoveryRetryIntervalMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [catalogLoadStatus, sessionAnimationState.status]);

  return sessionAnimationState;
}