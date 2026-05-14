export type CharacterId = string;

export type CharacterRuntimeState = "idle" | "listen" | "speak" | "emote" | (string & {});

export interface CharacterCatalogSeed {
  characterId: CharacterId;
  manifestUrl: string;
}

export interface CharacterVoiceProfileDocument {
  profile_id: string;
  path: string;
}

export interface CharacterManifestDocument {
  schema_version: number;
  character_id: CharacterId;
  display_name: string;
  identity_source: string;
  asset_version: string;
  vrm_spec_version: string;
  model_file: string;
  metadata_file: string;
  supported_states: CharacterRuntimeState[];
  shared_animation_set: string;
  voice_profile: CharacterVoiceProfileDocument;
  expression_map: string;
  animation_overrides: string;
}

export interface CharacterVoiceProfileSummary {
  profileId: string;
  url: string;
}

export interface CharacterAssetPaths {
  baseUrl: string;
  manifestUrl: string;
  modelUrl: string;
  metadataUrl: string;
  expressionMapUrl: string;
  animationOverridesUrl: string;
  voiceProfile: CharacterVoiceProfileSummary;
}

export type CharacterAssetUrlOverrides = Partial<Record<string, string>>;

export interface CharacterManifestSummary {
  schemaVersion: number;
  characterId: CharacterId;
  displayName: string;
  identitySource: string;
  assetVersion: string;
  vrmSpecVersion: string;
  supportedStates: CharacterRuntimeState[];
  sharedAnimationSet: string;
  assets: CharacterAssetPaths;
}

export interface CharacterCatalogEntry {
  manifestUrl: string;
  summary: CharacterManifestSummary;
}

export interface CharacterCatalog {
  entries: CharacterCatalogEntry[];
  defaultCharacterId: CharacterId | null;
  loadedAt: string;
}