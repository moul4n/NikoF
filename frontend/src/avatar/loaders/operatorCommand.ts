import type {
  BackendOperatorCommandRequestDocument,
  BackendOperatorCommandResponseDocument
} from "../../shared/types/character";

type BackendErrorResponseDocument = {
  detail?: string;
};

export class OperatorCommandSubmitError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = "OperatorCommandSubmitError";
    this.status = status;
    this.detail = detail;
  }
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

export async function submitOperatorCommand(
  command: BackendOperatorCommandRequestDocument,
  fetcher: typeof fetch = fetch
): Promise<BackendOperatorCommandResponseDocument> {
  const response = await fetcher(buildBackendApiUrl("/session/operator-command"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const document = await parseOperatorCommandResponse(response);

  if (!response.ok) {
    const detail = (document as BackendErrorResponseDocument | null)?.detail ?? null;

    throw new OperatorCommandSubmitError(
      detail ?? `Backend operator-command request failed with status ${response.status}.`,
      response.status,
      detail
    );
  }

  if (!document) {
    throw new OperatorCommandSubmitError("Backend operator-command response was empty.", response.status);
  }

  return document as BackendOperatorCommandResponseDocument;
}

async function parseOperatorCommandResponse(response: Response): Promise<unknown> {
  const responseText = await response.text();

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new OperatorCommandSubmitError(
      `Backend operator-command response could not be parsed for status ${response.status}.`,
      response.status
    );
  }
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