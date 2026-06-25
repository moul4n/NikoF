// Read/write seam for the durable ambient-context settings (enabled + timezone +
// location) the companion planner prompt reads each turn. The control surface
// PUTs changes; the backend persists them and the turn pipeline reads them live,
// so a change applies without a backend restart.

export const AMBIENT_CONTEXT_ROUTE_PATH = "/session/ambient-context";

export interface AmbientContextDocument {
  enabled: boolean;
  timezone: string;
  location: string;
  weather_enabled: boolean;
  sky_enabled: boolean;
}

export interface AmbientContextUpdate {
  enabled?: boolean;
  timezone?: string;
  location?: string;
  weather_enabled?: boolean;
  sky_enabled?: boolean;
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

function normalizeDocument(raw: unknown): AmbientContextDocument | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const data = raw as {
    enabled?: unknown;
    timezone?: unknown;
    location?: unknown;
    weather_enabled?: unknown;
    sky_enabled?: unknown;
  };
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : false,
    timezone: typeof data.timezone === "string" ? data.timezone : "",
    location: typeof data.location === "string" ? data.location : "",
    weather_enabled: typeof data.weather_enabled === "boolean" ? data.weather_enabled : false,
    sky_enabled: typeof data.sky_enabled === "boolean" ? data.sky_enabled : false
  };
}

export async function getAmbientContext(fetcher: typeof fetch = fetch): Promise<AmbientContextDocument | null> {
  try {
    const response = await fetcher(buildBackendApiUrl(AMBIENT_CONTEXT_ROUTE_PATH));
    if (!response.ok) {
      return null;
    }
    return normalizeDocument(await response.json());
  } catch {
    return null;
  }
}

export async function updateAmbientContext(
  update: AmbientContextUpdate,
  fetcher: typeof fetch = fetch
): Promise<AmbientContextDocument | null> {
  try {
    const response = await fetcher(buildBackendApiUrl(AMBIENT_CONTEXT_ROUTE_PATH), {
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
