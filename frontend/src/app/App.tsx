import React, { useEffect, useState } from "react";
import { AvatarStage } from "../avatar/components/AvatarStage";
import { CharacterCatalogPanel } from "../avatar/components/CharacterCatalogPanel";
import { loadCharacterCatalog } from "../avatar/loaders/characterCatalog";
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

function findCharacterEntry(catalog: CharacterCatalog | null, characterId: CharacterId | null): CharacterCatalogEntry | null {
  if (!catalog || !characterId) {
    return null;
  }

  return catalog.entries.find((entry) => entry.summary.characterId === characterId) ?? null;
}

export function App(): JSX.Element {
  const [runtime] = useState<AvatarRuntimeBridge>(() => createAvatarRuntime());
  const [loadState, setLoadState] = useState<CatalogLoadState>({
    status: "loading",
    catalog: null,
    error: null
  });
  const [selectedCharacterId, setSelectedCharacterId] = useState<CharacterId | null>(null);

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
        setSelectedCharacterId(catalog.defaultCharacterId);
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

    runtime.loadCharacter(activeCharacter.summary);
    runtime.setState("idle");
  }, [loadState.catalog, runtime, selectedCharacterId]);

  const selectedCharacter = findCharacterEntry(loadState.catalog, selectedCharacterId);

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
      </header>

      <main className="app-shell__content">
        <CharacterCatalogPanel
          catalog={loadState.catalog}
          error={loadState.error}
          isLoading={loadState.status === "loading"}
          selectedCharacterId={selectedCharacterId}
          onSelectCharacter={setSelectedCharacterId}
        />
        <AvatarStage runtime={runtime} selectedCharacter={selectedCharacter} />
      </main>
    </div>
  );
}