import { useEffect, useState } from "react";
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
const backendRecoveryRetryIntervalMs = 3000;

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
  setBackendSyncState: StateSetter<BackendSyncState>
): void {
  void bridgeCharacterCatalogWithBackend(catalog).then((bridge) => {
    const nextMessages = [...bridge.messages];

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
      if (bridge.activeCharacterConnected) {
        return resolveSelectedCharacterId(bridge.catalog, bridge.activeCharacterId);
      }

      return resolvePreferredCharacterId(
        bridge.catalog,
        currentCharacterId,
        readPersistedSelectedCharacterId()
      );
    });
    setBackendSyncState({
      summariesConnected: bridge.summariesConnected,
      activeCharacterConnected: bridge.activeCharacterConnected,
      healthPayload: bridge.healthPayload,
      sessionId: bridge.sessionId,
      message: nextMessages[0] ?? null
    });
  });
}

export function useCharacterShellState(): UseCharacterShellStateResult {
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
        applyBackendBridge(catalog, setLoadState, setSelectedCharacterId, setBackendSyncState);
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

    applyBackendBridge(loadState.catalog, setLoadState, setSelectedCharacterId, setBackendSyncState);
  }, [backendBridgeRefreshKey, loadState.catalog, loadState.status]);

  useEffect(() => {
    if (
      loadState.status !== "ready" ||
      (backendSyncState.summariesConnected && backendSyncState.activeCharacterConnected)
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setBackendBridgeRefreshKey((currentKey) => currentKey + 1);
    }, backendRecoveryRetryIntervalMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [backendSyncState.activeCharacterConnected, backendSyncState.summariesConnected, loadState.status]);

  function refreshSpeechLifecycle(): void {
    setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
  }

  function handleSelectCharacter(characterId: CharacterId): void {
    if (characterId === selectedCharacterId) {
      return;
    }

    setSelectedCharacterId(characterId);

    if (!backendSyncState.activeCharacterConnected) {
      return;
    }

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