import React, { useEffect, useState } from "react";
import { AvatarStage } from "../avatar/components/AvatarStage";
import { CharacterCatalogPanel } from "../avatar/components/CharacterCatalogPanel";
import { bridgeCharacterCatalogWithBackend, loadCharacterCatalog, syncActiveCharacterSelection } from "../avatar/loaders/characterCatalog";
import { createAvatarRuntime, type AvatarRuntimeBridge } from "../avatar/runtime/avatarRuntime";
import type { CharacterCatalog, CharacterCatalogEntry, CharacterId } from "../shared/types/character";

type CatalogLoadState =
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

type BackendSyncState = {
  summariesConnected: boolean;
  activeCharacterConnected: boolean;
  sessionId: string | null;
  message: string | null;
};

function findCharacterEntry(catalog: CharacterCatalog | null, characterId: CharacterId | null): CharacterCatalogEntry | null {
  if (!catalog || !characterId) {
    return null;
  }

  return catalog.entries.find((entry) => entry.summary.characterId === characterId) ?? null;
}

function resolveSelectedCharacterId(catalog: CharacterCatalog, preferredCharacterId: CharacterId | null): CharacterId | null {
  if (preferredCharacterId && findCharacterEntry(catalog, preferredCharacterId)) {
    return preferredCharacterId;
  }

  return catalog.defaultCharacterId;
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

export function App(): JSX.Element {
  const [runtime] = useState<AvatarRuntimeBridge>(() => createAvatarRuntime());
  const [loadState, setLoadState] = useState<CatalogLoadState>({
    status: "loading",
    catalog: null,
    error: null
  });
  const [backendSyncState, setBackendSyncState] = useState<BackendSyncState>({
    summariesConnected: false,
    activeCharacterConnected: false,
    sessionId: null,
    message: null
  });
  const [selectedCharacterId, setSelectedCharacterId] = useState<CharacterId | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadCharacterCatalog()
      .then((catalog) => bridgeCharacterCatalogWithBackend(catalog))
      .then((bridge) => {
        if (cancelled) {
          return;
        }

        const nextMessages = [...bridge.messages];
        const nextSelectedCharacterId = resolveSelectedCharacterId(bridge.catalog, bridge.activeCharacterId);

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
        setSelectedCharacterId(nextSelectedCharacterId);
        setBackendSyncState({
          summariesConnected: bridge.summariesConnected,
          activeCharacterConnected: bridge.activeCharacterConnected,
          sessionId: bridge.sessionId,
          message: nextMessages[0] ?? null
        });
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
      runtime.unmount();
    };
  }, [runtime]);

  useEffect(() => {
    const activeCharacter = findCharacterEntry(loadState.catalog, selectedCharacterId);

    if (!activeCharacter) {
      return;
    }

    void runtime.loadCharacter(activeCharacter.summary);
    runtime.setState("idle");
  }, [loadState.catalog, runtime, selectedCharacterId]);

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
        setBackendSyncState((currentState) => ({
          ...currentState,
          activeCharacterConnected: true,
          sessionId: response.session_id,
          message: `Backend active character synced to ${response.active_character.display_name}.`
        }));
      })
      .catch((error: unknown) => {
        setBackendSyncState((currentState) => ({
          ...currentState,
          message: error instanceof Error ? error.message : "Backend active-character sync failed; shell remains local."
        }));
      });
  }

  const selectedCharacter = findCharacterEntry(loadState.catalog, selectedCharacterId);
  const backendStatusMessage = describeBackendSyncState(backendSyncState);

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div>
          <p className="eyebrow">Phase 0 scaffold</p>
          <h1>NikoF avatar shell</h1>
        </div>
        <p className="app-shell__summary">
          The catalog is seeded with manifest entry points only. All avatar asset URLs are resolved from the manifest that each
          character package publishes.
        </p>
        <p className="app-shell__summary">{backendStatusMessage}</p>
      </header>

      <main className="app-shell__content">
        <CharacterCatalogPanel
          catalog={loadState.catalog}
          error={loadState.error}
          isLoading={loadState.status === "loading"}
          statusMessage={loadState.status === "ready" ? backendStatusMessage : null}
          selectedCharacterId={selectedCharacterId}
          onSelectCharacter={handleSelectCharacter}
        />
        <AvatarStage runtime={runtime} selectedCharacter={selectedCharacter} />
      </main>
    </div>
  );
}