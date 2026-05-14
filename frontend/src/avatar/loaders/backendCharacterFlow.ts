import type {
  BackendActiveCharacterResponseDocument,
  BackendCharacterCatalogResponseDocument,
  BackendCharacterSummaryDocument,
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterId
} from "../../shared/types/character.js";

export interface BackendCharacterCatalogBridge {
  catalog: CharacterCatalog;
  activeCharacterId: CharacterId | null;
  summariesConnected: boolean;
  activeCharacterConnected: boolean;
  sessionId: string | null;
  messages: string[];
}

export interface ActiveCharacterSyncStatePatch {
  selectedCharacterId: CharacterId | null;
  activeCharacterConnected: true;
  sessionId: string;
  message: string;
}

export function resolveSelectedCharacterId(catalog: CharacterCatalog, preferredCharacterId: CharacterId | null): CharacterId | null {
  if (preferredCharacterId && findCharacterEntry(catalog, preferredCharacterId)) {
    return preferredCharacterId;
  }

  return catalog.defaultCharacterId;
}

export function createBackendCharacterCatalogBridge(
  catalog: CharacterCatalog,
  summariesDocument: BackendCharacterCatalogResponseDocument | null,
  activeCharacterDocument: BackendActiveCharacterResponseDocument | null
): BackendCharacterCatalogBridge {
  const messages: string[] = [];

  let nextCatalog = catalog;
  let summariesConnected = false;
  let activeCharacterConnected = false;
  let activeCharacterId: CharacterId | null = null;
  let sessionId: string | null = null;

  if (summariesDocument) {
    summariesConnected = true;
    nextCatalog = mergeCatalogSummaries(catalog, summariesDocument.characters);
    activeCharacterId = summariesDocument.active_character_id;
  } else {
    messages.push("Backend character summaries unavailable; using local manifest summaries.");
  }

  if (activeCharacterDocument) {
    activeCharacterConnected = true;
    activeCharacterId = activeCharacterDocument.active_character.character_id;
    sessionId = activeCharacterDocument.session_id;
  } else {
    messages.push("Backend active-character state unavailable; using local default selection.");
  }

  return {
    catalog: nextCatalog,
    activeCharacterId,
    summariesConnected,
    activeCharacterConnected,
    sessionId,
    messages
  };
}

export function createSuccessfulActiveCharacterSyncState(
  catalog: CharacterCatalog | null,
  response: BackendActiveCharacterResponseDocument
): ActiveCharacterSyncStatePatch {
  return {
    selectedCharacterId: resolveBackendConfirmedCharacterId(catalog, response.active_character.character_id),
    activeCharacterConnected: true,
    sessionId: response.session_id,
    message: response.selection.message ?? `Backend active character synced to ${response.active_character.display_name}.`
  };
}

export function createRejectedActiveCharacterSyncState(
  catalog: CharacterCatalog | null,
  response: BackendActiveCharacterResponseDocument
): ActiveCharacterSyncStatePatch {
  return {
    selectedCharacterId: resolveBackendConfirmedCharacterId(catalog, response.active_character.character_id),
    activeCharacterConnected: true,
    sessionId: response.session_id,
    message: response.selection.message ?? `Backend kept ${response.active_character.display_name} as the active character.`
  };
}

function findCharacterEntry(catalog: CharacterCatalog | null, characterId: CharacterId | null): CharacterCatalogEntry | null {
  if (!catalog || !characterId) {
    return null;
  }

  return catalog.entries.find((entry) => entry.summary.characterId === characterId) ?? null;
}

function mergeCatalogSummaries(
  catalog: CharacterCatalog,
  backendSummaries: readonly BackendCharacterSummaryDocument[]
): CharacterCatalog {
  const summariesById = new Map(backendSummaries.map((summary) => [summary.character_id, summary]));

  return {
    ...catalog,
    entries: catalog.entries.map((entry) => {
      const backendSummary = summariesById.get(entry.summary.characterId);

      if (!backendSummary) {
        return entry;
      }

      return {
        ...entry,
        summary: {
          ...entry.summary,
          schemaVersion: backendSummary.schema_version,
          displayName: backendSummary.display_name,
          identitySource: backendSummary.identity_source,
          vrmSpecVersion: backendSummary.vrm_spec_version,
          sharedAnimationSet: backendSummary.shared_animation_set,
          supportedStates: [...backendSummary.supported_states]
        }
      };
    })
  };
}

function resolveBackendConfirmedCharacterId(catalog: CharacterCatalog | null, backendCharacterId: CharacterId): CharacterId {
  if (!catalog) {
    return backendCharacterId;
  }

  return resolveSelectedCharacterId(catalog, backendCharacterId) ?? backendCharacterId;
}