import type {
  BackendActiveCharacterResponseDocument,
  BackendCharacterCatalogResponseDocument,
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
import {
  createBackendCharacterCatalogBridge,
  type BackendCharacterCatalogBridge
} from "./backendCharacterFlow";

export class ActiveCharacterSyncError extends Error {
  readonly response: BackendActiveCharacterResponseDocument;
  readonly status: number;

  constructor(response: BackendActiveCharacterResponseDocument, status: number) {
    super(response.selection.message ?? `Backend active-character update failed with status ${status}.`);
    this.name = "ActiveCharacterSyncError";
    this.response = response;
    this.status = status;
  }
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
  return createBackendCharacterCatalogBridge(
    catalog,
    summariesResult.status === "fulfilled" ? summariesResult.value : null,
    activeCharacterResult.status === "fulfilled" ? activeCharacterResult.value : null
  );
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

  const document = (await response.json()) as BackendActiveCharacterResponseDocument;

  if (!response.ok) {
    throw new ActiveCharacterSyncError(document, response.status);
  }

  return document;
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

async function fetchBackendCharacterSummaries(fetcher: typeof fetch): Promise<BackendCharacterCatalogResponseDocument> {
  const response = await fetcher(buildBackendApiUrl("/characters"));

  if (!response.ok) {
    throw new Error(`Backend character-summary request failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendCharacterCatalogResponseDocument;
}

async function fetchBackendActiveCharacter(fetcher: typeof fetch): Promise<BackendActiveCharacterResponseDocument> {
  const response = await fetcher(buildBackendApiUrl("/session/active-character"));

  if (!response.ok) {
    throw new Error(`Backend active-character request failed with status ${response.status}.`);
  }

  return (await response.json()) as BackendActiveCharacterResponseDocument;
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