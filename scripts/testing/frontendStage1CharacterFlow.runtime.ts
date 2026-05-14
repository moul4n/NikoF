import { readFile } from "fs/promises";
import {
  createBackendCharacterCatalogBridge,
  createRejectedActiveCharacterSyncState,
  createSuccessfulActiveCharacterSyncState
} from "../../frontend/src/avatar/loaders/backendCharacterFlow.js";
import type {
  BackendActiveCharacterResponseDocument,
  BackendCharacterCatalogResponseDocument,
  CharacterCatalog,
  CharacterManifestSummary
} from "../../frontend/src/shared/types/character.js";

type BackendStage1ContractsSnapshot = {
  responses: {
    characters: BackendCharacterCatalogResponseDocument;
    get_active_character: BackendActiveCharacterResponseDocument;
    put_active_character: {
      request: {
        character_id: string;
        reason: string;
      };
      response: BackendActiveCharacterResponseDocument;
    };
    put_active_character_invalid: {
      request: {
        character_id: string;
        reason: string;
      };
      http_status: number;
      response: BackendActiveCharacterResponseDocument;
    };
  };
};

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];

  if (!snapshotPath) {
    throw new Error("Expected a backend Stage 1 snapshot path argument.");
  }

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as BackendStage1ContractsSnapshot;
  const localCatalog = buildLocalCatalog(snapshot.responses.characters);
  const firstLocalDisplayName = localCatalog.entries[0]?.summary.displayName ?? null;
  const bridgedCatalog = createBackendCharacterCatalogBridge(
    localCatalog,
    snapshot.responses.characters,
    snapshot.responses.get_active_character
  );
  const successState = createSuccessfulActiveCharacterSyncState(localCatalog, snapshot.responses.put_active_character.response);
  const rejectionState = createRejectedActiveCharacterSyncState(
    localCatalog,
    snapshot.responses.put_active_character_invalid.response
  );

  const result = {
    bridge_runtime: {
      summaries_connected: bridgedCatalog.summariesConnected,
      active_character_connected: bridgedCatalog.activeCharacterConnected,
      active_character_id: bridgedCatalog.activeCharacterId,
      first_display_name_before: firstLocalDisplayName,
      first_display_name_after: bridgedCatalog.catalog.entries[0]?.summary.displayName ?? null,
      catalog_envelope_consumed:
        bridgedCatalog.catalog.entries[0]?.summary.displayName === snapshot.responses.characters.characters[0]?.display_name,
      catalog_message_count: bridgedCatalog.messages.length
    },
    success_sync_runtime: {
      requested_character_id: snapshot.responses.put_active_character.request.character_id,
      backend_confirmed_character_id: snapshot.responses.put_active_character.response.active_character.character_id,
      selected_character_id: successState.selectedCharacterId,
      message: successState.message,
      session_id: successState.sessionId,
      matched_backend_confirmed_character:
        successState.selectedCharacterId === snapshot.responses.put_active_character.response.active_character.character_id
    },
    rejection_sync_runtime: {
      requested_character_id: snapshot.responses.put_active_character_invalid.request.character_id,
      backend_confirmed_character_id: snapshot.responses.put_active_character_invalid.response.active_character.character_id,
      selected_character_id: rejectionState.selectedCharacterId,
      message: rejectionState.message,
      session_id: rejectionState.sessionId,
      matched_backend_confirmed_character:
        rejectionState.selectedCharacterId === snapshot.responses.put_active_character_invalid.response.active_character.character_id
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function buildLocalCatalog(catalogResponse: BackendCharacterCatalogResponseDocument): CharacterCatalog {
  return {
    entries: catalogResponse.characters.map((character, index) => ({
      manifestUrl: `/assets/characters/${character.character_id}/manifest.json`,
      summary: buildLocalManifestSummary(character, index)
    })),
    defaultCharacterId: catalogResponse.characters[0]?.character_id ?? null,
    loadedAt: "2026-05-14T00:00:00.000Z"
  };
}

function buildLocalManifestSummary(
  character: BackendCharacterCatalogResponseDocument["characters"][number],
  index: number
): CharacterManifestSummary {
  return {
    schemaVersion: 0,
    characterId: character.character_id,
    displayName: `Local Placeholder ${index + 1}`,
    identitySource: "local-placeholder",
    assetVersion: "test-snapshot",
    vrmSpecVersion: "0.0-local",
    supportedStates: ["idle"],
    sharedAnimationSet: `local-placeholder-${index + 1}`,
    assets: {
      baseUrl: `/assets/characters/${character.character_id}/`,
      manifestUrl: `/assets/characters/${character.character_id}/manifest.json`,
      modelUrl: `/assets/characters/${character.character_id}/model.vrm`,
      metadataUrl: `/assets/characters/${character.character_id}/metadata/identity.json`,
      expressionMapUrl: `/assets/characters/${character.character_id}/expressions/map.json`,
      animationOverridesUrl: `/assets/characters/${character.character_id}/overrides/animations.json`,
      voiceProfile: {
        profileId: `local-profile-${index + 1}`,
        url: `/assets/characters/${character.character_id}/voice/profile.json`
      }
    }
  };
}

void main();