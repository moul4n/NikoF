/**
 * VRMA Asset Resolution
 *
 * Resolves semantic animation IDs to VRMA asset URLs.
 * Resolution order:
 *   1. Character-specific override: /assets/animations/library/{characterId}/{semanticId}.vrma
 *   2. Shared library: /assets/animations/library/shared/{semanticId}.vrma
 *
 * During the migration period, the caller should fall back to the legacy mixer
 * playback if no VRMA asset is found.
 */

const LIBRARY_BASE = "/assets/animations/library";

export interface VrmaAssetResolution {
  url: string;
  source: "character" | "shared";
  semanticId: string;
}

/**
 * Resolve the URL for a VRMA asset given a semantic ID and optional character context.
 * Returns null if no resolution is possible (caller should fall back to legacy pipeline).
 */
export function resolveVrmaAssetUrl(
  semanticId: string,
  characterId?: string
): VrmaAssetResolution | null {
  const fileName = `${semanticId}.vrma`;

  if (characterId) {
    return {
      url: `${LIBRARY_BASE}/${characterId}/${fileName}`,
      source: "character",
      semanticId,
    };
  }

  return {
    url: `${LIBRARY_BASE}/shared/${fileName}`,
    source: "shared",
    semanticId,
  };
}

/**
 * Build the full set of VRMA URLs to attempt for a semantic ID.
 * Returns in priority order: character override first, shared fallback second.
 */
export function resolveVrmaAssetCandidates(
  semanticId: string,
  characterId?: string
): VrmaAssetResolution[] {
  const candidates: VrmaAssetResolution[] = [];
  const fileName = `${semanticId}.vrma`;

  if (characterId) {
    candidates.push({
      url: `${LIBRARY_BASE}/${characterId}/${fileName}`,
      source: "character",
      semanticId,
    });
  }

  candidates.push({
    url: `${LIBRARY_BASE}/shared/${fileName}`,
    source: "shared",
    semanticId,
  });

  return candidates;
}

/**
 * Attempt to load a VRMA asset, trying each candidate URL in order.
 * Returns the first URL that responds successfully, or null if none work.
 */
export async function probeVrmaAsset(
  semanticId: string,
  characterId?: string
): Promise<VrmaAssetResolution | null> {
  const candidates = resolveVrmaAssetCandidates(semanticId, characterId);

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url, { method: "HEAD" });
      if (response.ok) {
        return candidate;
      }
    } catch {
      // Network error or file not found — try next candidate
    }
  }

  return null;
}
