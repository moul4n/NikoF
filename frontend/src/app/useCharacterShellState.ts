import { useEffect, useRef, useState } from "react";
import { computeReconnectDelayMs } from "../shared/reconnectBackoff";
import {
  ActiveCharacterSyncError,
  bridgeCharacterCatalogWithBackend,
  loadCharacterCatalog,
  syncActiveCharacterSelection
} from "../avatar/loaders/characterCatalog";
import {
  createSuccessfulActiveCharacterSyncState,
  resolveSelectedCharacterId
} from "../avatar/loaders/backendCharacterFlow";
import type {
  BackendHealthPayloadDocument,
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterId
} from "../shared/types/character";

export type CatalogLoadState =
  | {
      status: "loading";
      catalog: null;
      error: null;
    }
  | {
      status: "ready";
      catalog: CharacterCatalog;
      error: null;
    }
  | {
      status: "error";
      catalog: null;
      error: string;
    };

export type BackendSyncState = {
  summariesConnected: boolean;
  activeCharacterConnected: boolean;
  healthPayload: BackendHealthPayloadDocument | null;
  sessionId: string | null;
  message: string | null;
};

export interface UseCharacterShellStateResult {
  loadState: CatalogLoadState;
  backendSyncState: BackendSyncState;
  backendStatusMessage: string;
  selectedCharacter: CharacterCatalogEntry | null;
  selectedCharacterId: CharacterId | null;
  setSelectedCharacterId: StateSetter<CharacterId | null>;
  speechLifecycleRefreshKey: number;
  sessionAnimationRefreshKey: number;
  refreshSpeechLifecycle: () => void;
  handleSelectCharacter: (characterId: CharacterId) => void;
}

const SHARED_SELECTED_CHARACTER_STORAGE_KEY = "nikof.selectedCharacterId";

type StateSetter<TValue> = (value: TValue | ((currentValue: TValue) => TValue)) => void;

function findCharacterEntry(catalog: CharacterCatalog | null, characterId: CharacterId | null): CharacterCatalogEntry | null {
  if (!catalog || !characterId) {
    return null;
  }

  return catalog.entries.find((entry) => entry.summary.characterId === characterId) ?? null;
}

function resolveRenderableCharacterEntry(
  catalog: CharacterCatalog | null,
  preferredCharacterId: CharacterId | null
): CharacterCatalogEntry | null {
  if (!catalog) {
    return null;
  }

  return findCharacterEntry(catalog, resolveSelectedCharacterId(catalog, preferredCharacterId));
}

function resolvePreferredCharacterId(
  catalog: CharacterCatalog,
  preferredCharacterId: CharacterId | null,
  fallbackCharacterId: CharacterId | null
): CharacterId | null {
  if (preferredCharacterId && findCharacterEntry(catalog, preferredCharacterId)) {
    return preferredCharacterId;
  }

  if (fallbackCharacterId && findCharacterEntry(catalog, fallbackCharacterId)) {
    return fallbackCharacterId;
  }

  return catalog.defaultCharacterId;
}

function readPersistedSelectedCharacterId(): CharacterId | null {
  if (typeof window === "undefined") {
    return null;
  }

  const persistedCharacterId = window.localStorage.getItem(SHARED_SELECTED_CHARACTER_STORAGE_KEY)?.trim();
  return persistedCharacterId ? persistedCharacterId : null;
}

function writePersistedSelectedCharacterId(characterId: CharacterId | null): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!characterId) {
    window.localStorage.removeItem(SHARED_SELECTED_CHARACTER_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SHARED_SELECTED_CHARACTER_STORAGE_KEY, characterId);
}

function describeBackendSyncState(syncState: BackendSyncState): string {
  if (syncState.message) {
    return syncState.message;
  }

  if (syncState.summariesConnected && syncState.activeCharacterConnected) {
    return "Backend bridge connected: shell is overlaying backend summaries and active-character state onto the local manifest catalog.";
  }

  if (syncState.summariesConnected) {
    return "Backend summaries connected; active-character selection is still local in this session.";
  }

  return "Backend bridge offline; shell is using the local manifest catalog only.";
}

function applyBackendBridge(
  catalog: CharacterCatalog,
  setLoadState: StateSetter<CatalogLoadState>,
  setSelectedCharacterId: StateSetter<CharacterId | null>,
  setBackendSyncState: StateSetter<BackendSyncState>,
  followBackendActiveCharacter: boolean,
  assertSelectionToBackend: boolean
): void {
  void bridgeCharacterCatalogWithBackend(catalog).then((bridge) => {
    const nextMessages = [...bridge.messages];
    const persistedCharacterId = readPersistedSelectedCharacterId();

    if (bridge.activeCharacterId && !findCharacterEntry(bridge.catalog, bridge.activeCharacterId)) {
      nextMessages.push(
        `Backend selected ${bridge.activeCharacterId}, but this shell only mounts characters with a local manifest package in the repo.`
      );
    }

    setLoadState({
      status: "ready",
      catalog: bridge.catalog,
      error: null
    });
    setSelectedCharacterId((currentCharacterId) => {
      // Follower surfaces (display / always-on-top stage) mirror the backend's
      // active character rather than their own persisted pick, so switching the
      // character on the control surface hot-swaps the model here.
      if (
        followBackendActiveCharacter &&
        bridge.activeCharacterConnected &&
        bridge.activeCharacterId &&
        findCharacterEntry(bridge.catalog, bridge.activeCharacterId)
      ) {
        return bridge.activeCharacterId;
      }

      return resolvePreferredCharacterId(
        bridge.catalog,
        currentCharacterId ?? persistedCharacterId,
        bridge.activeCharacterConnected ? bridge.activeCharacterId : persistedCharacterId
      );
    });
    setBackendSyncState({
      summariesConnected: bridge.summariesConnected,
      activeCharacterConnected: bridge.activeCharacterConnected,
      healthPayload: bridge.healthPayload,
      sessionId: bridge.sessionId,
      message: nextMessages[0] ?? null
    });

    // Control surface only: the backend's active character is in-memory and
    // resets to the catalog default on restart, but the operator's last dropdown
    // pick is retained in localStorage. Restore it to the backend on startup so
    // follower surfaces (stage / display) open on the last-selected character
    // instead of the default. Best-effort; the operator can re-pick on failure.
    if (
      assertSelectionToBackend &&
      bridge.activeCharacterConnected &&
      persistedCharacterId &&
      persistedCharacterId !== bridge.activeCharacterId &&
      findCharacterEntry(bridge.catalog, persistedCharacterId)
    ) {
      void syncActiveCharacterSelection(persistedCharacterId).catch(() => {
        /* best-effort restore */
      });
    }
  });
}

export function useCharacterShellState(
  options: { followBackendActiveCharacter?: boolean; assertSelectionToBackend?: boolean } = {}
): UseCharacterShellStateResult {
  const followBackendActiveCharacter = options.followBackendActiveCharacter ?? false;
  const assertSelectionToBackend = options.assertSelectionToBackend ?? false;
  const [loadState, setLoadState] = useState<CatalogLoadState>({
    status: "loading",
    catalog: null,
    error: null
  });
  const [backendSyncState, setBackendSyncState] = useState<BackendSyncState>({
    summariesConnected: false,
    activeCharacterConnected: false,
    healthPayload: null,
    sessionId: null,
    message: null
  });
  const [backendBridgeRefreshKey, setBackendBridgeRefreshKey] = useState(0);
  const backendReconnectAttemptRef = useRef(0);
  const [speechLifecycleRefreshKey, setSpeechLifecycleRefreshKey] = useState(0);
  const [sessionAnimationRefreshKey, setSessionAnimationRefreshKey] = useState(0);
  const [selectedCharacterId, setSelectedCharacterId] = useState<CharacterId | null>(() => readPersistedSelectedCharacterId());

  useEffect(() => {
    writePersistedSelectedCharacterId(selectedCharacterId);
  }, [selectedCharacterId]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== SHARED_SELECTED_CHARACTER_STORAGE_KEY || event.newValue === event.oldValue) {
        return;
      }

      const nextSelectedCharacterId = event.newValue?.trim() || null;

      setSelectedCharacterId((currentCharacterId) =>
        currentCharacterId === nextSelectedCharacterId ? currentCharacterId : nextSelectedCharacterId
      );
      setBackendBridgeRefreshKey((currentKey) => currentKey + 1);
      setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
      setSessionAnimationRefreshKey((currentKey) => currentKey + 1);
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadCharacterCatalog()
      .then((catalog) => {
        if (cancelled) {
          return;
        }

        setLoadState({
          status: "ready",
          catalog,
          error: null
        });
        setSelectedCharacterId((currentCharacterId) =>
          resolvePreferredCharacterId(catalog, currentCharacterId, readPersistedSelectedCharacterId())
        );
        applyBackendBridge(catalog, setLoadState, setSelectedCharacterId, setBackendSyncState, followBackendActiveCharacter, assertSelectionToBackend);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setLoadState({
          status: "error",
          catalog: null,
          error: error instanceof Error ? error.message : "Character catalog failed to load."
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loadState.status !== "ready" || backendBridgeRefreshKey === 0) {
      return;
    }

    applyBackendBridge(loadState.catalog, setLoadState, setSelectedCharacterId, setBackendSyncState, followBackendActiveCharacter, assertSelectionToBackend);
  }, [assertSelectionToBackend, backendBridgeRefreshKey, followBackendActiveCharacter, loadState.catalog, loadState.status]);

  useEffect(() => {
    if (loadState.status !== "ready") {
      return;
    }

    if (backendSyncState.summariesConnected && backendSyncState.activeCharacterConnected) {
      // Fully reconnected — reset the backoff so the next outage starts fast again.
      backendReconnectAttemptRef.current = 0;
      return;
    }

    // Exponential backoff with jitter instead of a fixed interval, so a recovering
    // backend isn't hammered in lockstep by every reconnecting surface. The refresh
    // key is in the deps so each attempt re-runs this effect and schedules the next
    // (larger) delay until the bridge reconnects.
    const delayMs = computeReconnectDelayMs(backendReconnectAttemptRef.current);
    backendReconnectAttemptRef.current += 1;

    const timeoutId = window.setTimeout(() => {
      setBackendBridgeRefreshKey((currentKey) => currentKey + 1);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    backendBridgeRefreshKey,
    backendSyncState.activeCharacterConnected,
    backendSyncState.summariesConnected,
    loadState.status
  ]);

  function refreshSpeechLifecycle(): void {
    setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
  }

  function handleSelectCharacter(characterId: CharacterId): void {
    if (characterId === selectedCharacterId) {
      return;
    }

    writePersistedSelectedCharacterId(characterId);
    setSelectedCharacterId(characterId);

    // Always push the selection to the backend (the source of truth that the
    // stage/display follow). We intentionally do NOT gate on the cached
    // activeCharacterConnected flag: it can be stale-false (e.g. the control tab
    // loaded while the backend was briefly down), which would silently swallow
    // the model switch. If the backend is genuinely unreachable the catch below
    // surfaces it and the shell stays on the local selection.
    setBackendSyncState((currentState) => ({
      ...currentState,
      message: `Syncing ${characterId} to the backend active-character session...`
    }));

    void syncActiveCharacterSelection(characterId)
      .then((response) => {
        const nextSyncState = createSuccessfulActiveCharacterSyncState(loadState.catalog, response);

        setSelectedCharacterId(nextSyncState.selectedCharacterId);
        refreshSpeechLifecycle();
        setBackendSyncState((currentState) => ({
          ...currentState,
          ...nextSyncState
        }));
      })
      .catch((error: unknown) => {
        const message = error instanceof ActiveCharacterSyncError
          ? error.response?.selection?.message ?? `Backend rejected character change (status ${error.status}).`
          : error instanceof Error ? error.message : "Backend active-character sync failed; shell remains local.";

        setBackendSyncState((currentState) => ({
          ...currentState,
          message
        }));
      });
  }

  return {
    loadState,
    backendSyncState,
    backendStatusMessage: describeBackendSyncState(backendSyncState),
    selectedCharacter: resolveRenderableCharacterEntry(loadState.catalog, selectedCharacterId),
    selectedCharacterId,
    setSelectedCharacterId,
    speechLifecycleRefreshKey,
    sessionAnimationRefreshKey,
    refreshSpeechLifecycle,
    handleSelectCharacter
  };
}