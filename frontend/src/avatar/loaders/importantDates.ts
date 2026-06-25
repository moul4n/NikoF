// Read/write seam for the operator-curated important dates (birthdays /
// anniversaries) the companion's ambient block surfaces when they're near.

export const IMPORTANT_DATES_ROUTE_PATH = "/session/important-dates";

export interface ImportantDateEntry {
  label: string;
  month: number;
  day: number;
  year: number | null;
}

const backendApiBaseUrl = resolveBackendApiBaseUrl();

function normalizeEntries(raw: unknown): ImportantDateEntry[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  const result: ImportantDateEntry[] = [];
  for (const item of entries) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as { label?: unknown; month?: unknown; day?: unknown; year?: unknown };
    if (typeof entry.label === "string" && typeof entry.month === "number" && typeof entry.day === "number") {
      result.push({
        label: entry.label,
        month: entry.month,
        day: entry.day,
        year: typeof entry.year === "number" ? entry.year : null
      });
    }
  }
  return result;
}

export async function getImportantDates(fetcher: typeof fetch = fetch): Promise<ImportantDateEntry[]> {
  try {
    const response = await fetcher(buildBackendApiUrl(IMPORTANT_DATES_ROUTE_PATH));
    if (!response.ok) {
      return [];
    }
    return normalizeEntries(await response.json());
  } catch {
    return [];
  }
}

export async function updateImportantDates(
  entries: ImportantDateEntry[],
  fetcher: typeof fetch = fetch
): Promise<ImportantDateEntry[] | null> {
  try {
    const response = await fetcher(buildBackendApiUrl(IMPORTANT_DATES_ROUTE_PATH), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries })
    });
    if (!response.ok) {
      return null;
    }
    return normalizeEntries(await response.json());
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
