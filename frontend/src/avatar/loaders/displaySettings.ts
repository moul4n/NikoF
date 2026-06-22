// Read/write seam for persistent display + wardrobe settings. The control
// surface (browser) and the always-on-top stage/display window can't share
// browser state, so the backend holds them: the control surface PUTs changes,
// the display surfaces poll GET and apply them. Durable across restarts.
// Global bone-overlay + captions toggles; per-character wardrobe values.

export const DISPLAY_SETTINGS_ROUTE_PATH = "/session/display-settings";

export interface DisplaySettingsDocument {
  global: { bone_overlay: boolean; captions: boolean };
  // characterId -> controlId -> value (toggles 0/1, sliders 0..1)
  characters: Record<string, Record<string, number>>;
}

export interface DisplaySettingsUpdate {
  bone_overlay?: boolean;
  captions?: boolean;
  wardrobe?: Record<string, Record<string, number>>;
}

const DEFAULT_DOCUMENT: DisplaySettingsDocument = {
  global: { bone_overlay: false, captions: true },
  characters: {}
};

const backendApiBaseUrl = resolveBackendApiBaseUrl();

function normalizeDocument(raw: unknown): DisplaySettingsDocument {
  const doc = (raw ?? {}) as Partial<DisplaySettingsDocument>;
  const global = (doc.global ?? {}) as Partial<DisplaySettingsDocument["global"]>;
  const characters: Record<string, Record<string, number>> = {};
  if (doc.characters && typeof doc.characters === "object") {
    for (const [characterId, controls] of Object.entries(doc.characters)) {
      if (controls && typeof controls === "object") {
        const resolved: Record<string, number> = {};
        for (const [controlId, value] of Object.entries(controls as Record<string, unknown>)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            resolved[controlId] = value;
          }
        }
        characters[characterId] = resolved;
      }
    }
  }
  return {
    global: {
      bone_overlay: typeof global.bone_overlay === "boolean" ? global.bone_overlay : DEFAULT_DOCUMENT.global.bone_overlay,
      captions: typeof global.captions === "boolean" ? global.captions : DEFAULT_DOCUMENT.global.captions
    },
    characters
  };
}

export async function getDisplaySettings(fetcher: typeof fetch = fetch): Promise<DisplaySettingsDocument | null> {
  try {
    const response = await fetcher(buildBackendApiUrl(DISPLAY_SETTINGS_ROUTE_PATH));
    if (!response.ok) {
      return null;
    }
    return normalizeDocument(await response.json());
  } catch {
    return null;
  }
}

export async function updateDisplaySettings(
  update: DisplaySettingsUpdate,
  fetcher: typeof fetch = fetch
): Promise<DisplaySettingsDocument | null> {
  try {
    const response = await fetcher(buildBackendApiUrl(DISPLAY_SETTINGS_ROUTE_PATH), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update)
    });
    if (!response.ok) {
      return null;
    }
    return normalizeDocument(await response.json());
  } catch {
    return null;
  }
}

function resolveBackendApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env?.VITE_BACKEND_API_BASE_URL?.trim();
  if (!configuredBaseUrl) {
    return "/api";
  }
  return configuredBaseUrl.replace(/\/+$/, "");
}

function buildBackendApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${backendApiBaseUrl}${normalizedPath}`;
}
