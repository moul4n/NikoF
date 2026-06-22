/**
 * VRMA Asset Resolution
 *
 * Resolves semantic animation IDs to VRMA asset URLs in the shared library:
 *   /assets/animations/library/shared/{semanticId}.vrma
 *
 * If no VRMA asset is found, the caller should fall back to the legacy mixer
 * playback pipeline.
 */

const LIBRARY_BASE = "/assets/animations/library";

export interface VrmaAssetResolution {
  url: string;
  semanticId: string;
}

/**
 * Resolve the shared-library URL for a VRMA asset given a semantic ID.
 */
export function resolveVrmaAssetUrl(semanticId: string): VrmaAssetResolution {
  return {
    url: `${LIBRARY_BASE}/shared/${semanticId}.vrma`,
    semanticId,
  };
}

/**
 * Attempt to load the shared VRMA asset for a semantic ID.
 * Returns the resolution if the asset responds successfully, or null if missing
 * (caller should fall back to the legacy pipeline).
 */
export async function probeVrmaAsset(semanticId: string): Promise<VrmaAssetResolution | null> {
  const candidate = resolveVrmaAssetUrl(semanticId);

  try {
    const response = await fetch(candidate.url, { method: "HEAD" });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

    // Vite's SPA fallback can return index.html for missing /assets/* paths.
    // Treat HTML responses as missing assets so callers can fall back cleanly.
    if (response.ok && !contentType.includes("text/html")) {
      return candidate;
    }
  } catch {
    // Network error or file not found — caller falls back to the legacy pipeline.
  }

  return null;
}
