import React from "react";
import type { CharacterCatalog, CharacterId } from "../../shared/types/character";

interface CharacterCatalogPanelProps {
  catalog: CharacterCatalog | null;
  error: string | null;
  isLoading: boolean;
  selectedCharacterId: CharacterId | null;
  onSelectCharacter: (characterId: CharacterId) => void;
}

export function CharacterCatalogPanel({
  catalog,
  error,
  isLoading,
  selectedCharacterId,
  onSelectCharacter
}: CharacterCatalogPanelProps): JSX.Element {
  return (
    <section className="catalog-panel" aria-labelledby="catalog-panel-title">
      <div className="catalog-panel__header">
        <div>
          <p className="eyebrow">Character catalog</p>
          <h2 id="catalog-panel-title">Manifest-backed packages</h2>
        </div>
        {catalog ? <span className="catalog-panel__count">{catalog.entries.length} packages</span> : null}
      </div>

      {isLoading ? <p className="catalog-panel__message">Loading placeholder manifest catalog...</p> : null}
      {error ? <p className="catalog-panel__message catalog-panel__message--error">{error}</p> : null}

      {catalog ? (
        <ul className="catalog-panel__list">
          {catalog.entries.map((entry) => {
            const isSelected = entry.summary.characterId === selectedCharacterId;

            return (
              <li key={entry.summary.characterId}>
                <button
                  type="button"
                  className={isSelected ? "catalog-panel__item catalog-panel__item--selected" : "catalog-panel__item"}
                  onClick={() => onSelectCharacter(entry.summary.characterId)}
                >
                  <span className="catalog-panel__item-title">{entry.summary.displayName}</span>
                  <span className="catalog-panel__item-meta">{entry.summary.characterId}</span>
                  <span className="catalog-panel__item-meta">{entry.summary.supportedStates.join(", ")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}