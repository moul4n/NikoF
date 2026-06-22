// Write seam for operator-triggered one-shot gesture animations. Posting here
// makes the backend broadcast the gesture over the session-animation SSE stream,
// so every avatar-rendering client (the stage desktop window, the display
// surface) plays it once and settles back to its current idle. This is distinct
// from the speech write seam (submitOperatorCommand).

export const SESSION_GESTURE_ROUTE_PATH = "/session/animation/gesture";

type BackendErrorResponseDocument = {
  detail?: string;
};

export class SessionGestureSubmitError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = "SessionGestureSubmitError";
    this.status = status;
    this.detail = detail;
  }
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

export async function submitSessionGesture(
  semanticId: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const response = await fetcher(buildBackendApiUrl(SESSION_GESTURE_ROUTE_PATH), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ semantic_id: semanticId })
  });

  if (!response.ok) {
    let detail: string | null = null;
    try {
      const text = await response.text();
      detail = text ? ((JSON.parse(text) as BackendErrorResponseDocument).detail ?? null) : null;
    } catch {
      detail = null;
    }
    throw new SessionGestureSubmitError(
      detail ?? `Backend gesture request failed with status ${response.status}.`,
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
