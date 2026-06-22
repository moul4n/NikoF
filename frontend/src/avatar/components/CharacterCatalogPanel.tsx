import React from "react";
import type { CharacterCatalog, CharacterId } from "../../shared/types/character";

interface CharacterCatalogPanelProps {
  catalog: CharacterCatalog | null;
  error: string | null;
  isLoading: boolean;
  statusMessage: string | null;
  selectedCharacterId: CharacterId | null;
  onSelectCharacter: (characterId: CharacterId) => void;
}

export function CharacterCatalogPanel({
  catalog,
  error,
  isLoading,
  statusMessage,
  selectedCharacterId,
  onSelectCharacter
}: CharacterCatalogPanelProps): JSX.Element {
  const selectedEntry =
    catalog?.entries.find((entry) => entry.summary.characterId === selectedCharacterId) ??
    catalog?.entries[0] ??
    null;

  return (
    <section className="catalog-panel" aria-labelledby="catalog-panel-title">
      <div className="catalog-panel__header">
        <div>
          <p className="eyebrow">Character selection</p>
          <h2 id="catalog-panel-title">Active manifest package</h2>
        </div>
        {catalog ? <span className="catalog-panel__count">{catalog.entries.length} packages</span> : null}
      </div>

      {isLoading ? <p className="catalog-panel__message">Loading placeholder manifest catalog...</p> : null}
      {error ? <p className="catalog-panel__message catalog-panel__message--error">{error}</p> : null}
      {statusMessage ? <p className="catalog-panel__message">{statusMessage}</p> : null}

      {catalog ? (
        <div className="catalog-panel__compact-layout">
          <label className="catalog-panel__field" htmlFor="catalog-panel-select">
            <span className="catalog-panel__label">Character package</span>
            <select
              id="catalog-panel-select"
              className="catalog-panel__select"
              value={selectedEntry?.summary.characterId ?? ""}
              onChange={(event: { target: { value: string } }) => onSelectCharacter(event.target.value as CharacterId)}
            >
              {catalog.entries.map((entry) => (
                <option key={entry.summary.characterId} value={entry.summary.characterId}>
                  {entry.summary.displayName} · {entry.summary.characterId}
                </option>
              ))}
            </select>
          </label>

          {selectedEntry ? (
            <p className="catalog-panel__meta">
              <span className="catalog-panel__meta-item">Animations: {selectedEntry.summary.sharedAnimationSet}</span>
              <span className="catalog-panel__meta-item">States: {selectedEntry.summary.supportedStates.join(", ")}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}