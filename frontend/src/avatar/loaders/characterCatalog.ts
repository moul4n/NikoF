import type {
  BackendActiveCharacterResponseDocument,
  BackendCharacterSummaryDocument,
  CharacterAssetUrlOverrides,
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterCatalogSeed,
  CharacterId,
  CharacterManifestDocument,
  CharacterManifestSummary
} from "../../shared/types/character";
import defaultCharacterManifest from "../../../../assets/characters/test-vrm-01/manifest.json";
import defaultCharacterModelUrl from "../../../../assets/characters/test-vrm-01/model.vrm?url";

export interface BackendCharacterCatalogBridge {
  catalog: CharacterCatalog;
  activeCharacterId: CharacterId | null;
  summariesConnected: boolean;
  activeCharacterConnected: boolean;
  sessionId: string | null;
  messages: string[];
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

const placeholderCharacterCatalog: CharacterCatalogSeed[] = [
  {
    characterId: "test-vrm-01",
    manifestUrl: "/assets/characters/test-vrm-01/manifest.json"
  }
];

const bundledManifestDocuments: Partial<Record<string, CharacterManifestDocument>> = {
  "test-vrm-01": defaultCharacterManifest as CharacterManifestDocument
};

const bundledAssetUrlOverrides: Partial<Record<string, CharacterAssetUrlOverrides>> = {
  "test-vrm-01": {
    "model.vrm": defaultCharacterModelUrl
  }
};

export function getPlaceholderCharacterCatalog(): readonly CharacterCatalogSeed[] {
  return placeholderCharacterCatalog;
}

export async function loadCharacterCatalog(fetcher: typeof fetch = fetch): Promise<CharacterCatalog> {
  const entries = await Promise.all(placeholderCharacterCatalog.map((seed) => loadCharacterCatalogEntry(seed, fetcher)));

  return {
    entries,
    defaultCharacterId: entries[0]?.summary.characterId ?? null,
    loadedAt: new Date().toISOString()
  };
}

export async function bridgeCharacterCatalogWithBackend(
  catalog: CharacterCatalog,
  fetcher: typeof fetch = fetch
): Promise<BackendCharacterCatalogBridge> {
  const [summariesResult, activeCharacterResult] = await Promise.allSettled([
    fetchBackendCharacterSummaries(fetcher),
    fetchBackendActiveCharacter(fetcher)
  ]);
  const messages: string[] = [];

  let nextCatalog = catalog;
  let summariesConnected = false;
  let activeCharacterConnected = false;
  let activeCharacterId: CharacterId | null = null;
  let sessionId: string | null = null;

  if (summariesResult.status === "fulfilled") {
    summariesConnected = true;
    nextCatalog = mergeCatalogSummaries(catalog, summariesResult.value);
  } else {
    messages.push("Backend character summaries unavailable; using local manifest summaries.");
  }

  if (activeCharacterResult.status === "fulfilled") {
    activeCharacterConnected = true;
    activeCharacterId = activeCharacterResult.value.active_character.character_id;
    sessionId = activeCharacterResult.value.session_id;
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

export async function syncActiveCharacterSelection(
  characterId: CharacterId,
  fetcher: typeof fetch = fetch
): Promise<BackendActiveCharacterResponseDocument> {
  const response = await fetcher(buildBackendApiUrl("/session/active-character"), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      character_id: characterId,
      reason: "user_selected"
    })
  });

  if (!response.ok) {
    throw new Error(`Backend active-character update failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendActiveCharacterResponseDocument;
}

async function loadCharacterCatalogEntry(seed: CharacterCatalogSeed, fetcher: typeof fetch): Promise<CharacterCatalogEntry> {
  const bundledManifest = bundledManifestDocuments[seed.characterId];

  if (bundledManifest) {
    return {
      manifestUrl: seed.manifestUrl,
      summary: normalizeCharacterManifest(bundledManifest, seed.manifestUrl, bundledAssetUrlOverrides[seed.characterId])
    };
  }

  const response = await fetcher(seed.manifestUrl);

  if (!response.ok) {
    throw new Error(`Character manifest could not be loaded for ${seed.characterId}.`);
  }

  const document = (await response.json()) as CharacterManifestDocument;

  if (document.character_id !== seed.characterId) {
    throw new Error(`Character manifest id mismatch for ${seed.manifestUrl}.`);
  }

  return {
    manifestUrl: seed.manifestUrl,
    summary: normalizeCharacterManifest(document, seed.manifestUrl)
  };
}

function normalizeCharacterManifest(
  document: CharacterManifestDocument,
  manifestUrl: string,
  assetUrlOverrides: CharacterAssetUrlOverrides = {}
): CharacterManifestSummary {
  return {
    schemaVersion: document.schema_version,
    characterId: document.character_id,
    displayName: document.display_name,
    identitySource: document.identity_source,
    assetVersion: document.asset_version,
    vrmSpecVersion: document.vrm_spec_version,
    supportedStates: document.supported_states,
    sharedAnimationSet: document.shared_animation_set,
    assets: {
      baseUrl: resolveManifestAssetUrl(manifestUrl, ".", assetUrlOverrides),
      manifestUrl: resolveManifestAssetUrl(manifestUrl, "", assetUrlOverrides),
      modelUrl: resolveManifestAssetUrl(manifestUrl, document.model_file, assetUrlOverrides),
      metadataUrl: resolveManifestAssetUrl(manifestUrl, document.metadata_file, assetUrlOverrides),
      expressionMapUrl: resolveManifestAssetUrl(manifestUrl, document.expression_map, assetUrlOverrides),
      animationOverridesUrl: resolveManifestAssetUrl(manifestUrl, document.animation_overrides, assetUrlOverrides),
      voiceProfile: {
        profileId: document.voice_profile.profile_id,
        url: resolveManifestAssetUrl(manifestUrl, document.voice_profile.path, assetUrlOverrides)
      }
    }
  };
}

function resolveManifestAssetUrl(
  manifestUrl: string,
  relativePath: string,
  assetUrlOverrides: CharacterAssetUrlOverrides = {}
): string {
  const overriddenAssetUrl = assetUrlOverrides[relativePath];

  if (overriddenAssetUrl) {
    return overriddenAssetUrl;
  }

  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const baseUrl = new URL(manifestUrl, origin);

  return new URL(relativePath, baseUrl).toString();
}

async function fetchBackendCharacterSummaries(fetcher: typeof fetch): Promise<BackendCharacterSummaryDocument[]> {
  const response = await fetcher(buildBackendApiUrl("/characters"));

  if (!response.ok) {
    throw new Error(`Backend character-summary request failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendCharacterSummaryDocument[];
}

async function fetchBackendActiveCharacter(fetcher: typeof fetch): Promise<BackendActiveCharacterResponseDocument> {
  const response = await fetcher(buildBackendApiUrl("/session/active-character"));

  if (!response.ok) {
    throw new Error(`Backend active-character request failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendActiveCharacterResponseDocument;
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

function resolveBackendApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_BACKEND_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return "/api";
  }

  return configuredBaseUrl.replace(/\/+$/, "");
}

function buildBackendApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${backendApiBaseUrl}${normalizedPath}`;
}