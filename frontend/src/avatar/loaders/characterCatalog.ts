import type {
  CharacterAssetUrlOverrides,
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterCatalogSeed,
  CharacterManifestDocument,
  CharacterManifestSummary
} from "../../shared/types/character";
import defaultCharacterManifest from "../../../../assets/characters/test-vrm-01/manifest.json";
import defaultCharacterModelUrl from "../../../../assets/characters/test-vrm-01/model.vrm?url";

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