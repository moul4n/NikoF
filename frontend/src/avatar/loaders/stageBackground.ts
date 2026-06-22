// Read/write seam for the stage backdrop selection. The control surface (browser)
// and the stage window (separate Tauri WebView) can't share browser state, so the
// backend holds the selection: control PUTs it, the stage polls GET and applies it.

export const STAGE_BACKGROUND_ROUTE_PATH = "/session/stage-background";

export class StageBackgroundError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = "StageBackgroundError";
    this.status = status;
    this.detail = detail;
  }
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

export async function getStageBackground(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(buildBackendApiUrl(STAGE_BACKGROUND_ROUTE_PATH));
    if (!response.ok) {
      return null;
    }
    const document = (await response.json()) as { background_id?: unknown };
    return typeof document.background_id === "string" ? document.background_id : null;
  } catch {
    return null;
  }
}

export async function setStageBackground(backgroundId: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(buildBackendApiUrl(STAGE_BACKGROUND_ROUTE_PATH), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ background_id: backgroundId })
  });

  if (!response.ok) {
    let detail: string | null = null;
    try {
      const text = await response.text();
      detail = text ? ((JSON.parse(text) as { detail?: string }).detail ?? null) : null;
    } catch {
      detail = null;
    }
    throw new StageBackgroundError(
      detail ?? `Stage background request failed with status ${response.status}.`,
      response.status,
      detail
    );
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
