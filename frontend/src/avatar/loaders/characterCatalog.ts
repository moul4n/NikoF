import type {
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterCatalogSeed,
  CharacterManifestDocument,
  CharacterManifestSummary
} from "../../shared/types/character";

const placeholderCharacterCatalog: CharacterCatalogSeed[] = [
  {
    characterId: "test-vrm-01",
    manifestUrl: "/assets/characters/test-vrm-01/manifest.json"
  },
  {
    characterId: "test-vrm-02",
    manifestUrl: "/assets/characters/test-vrm-02/manifest.json"
  },
  {
    characterId: "test-vrm-03",
    manifestUrl: "/assets/characters/test-vrm-03/manifest.json"
  }
];

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

function normalizeCharacterManifest(document: CharacterManifestDocument, manifestUrl: string): CharacterManifestSummary {
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
      baseUrl: resolveManifestAssetUrl(manifestUrl, "."),
      manifestUrl: resolveManifestAssetUrl(manifestUrl, ""),
      modelUrl: resolveManifestAssetUrl(manifestUrl, document.model_file),
      metadataUrl: resolveManifestAssetUrl(manifestUrl, document.metadata_file),
      expressionMapUrl: resolveManifestAssetUrl(manifestUrl, document.expression_map),
      animationOverridesUrl: resolveManifestAssetUrl(manifestUrl, document.animation_overrides),
      voiceProfile: {
        profileId: document.voice_profile.profile_id,
        url: resolveManifestAssetUrl(manifestUrl, document.voice_profile.path)
      }
    }
  };
}

function resolveManifestAssetUrl(manifestUrl: string, relativePath: string): string {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const baseUrl = new URL(manifestUrl, origin);

  return new URL(relativePath, baseUrl).toString();
}