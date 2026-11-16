import {
  inventoryPageSchema,
  labProgramListSchema,
  locationListSchema,
  projectSearchResponseSchema,
  receiptLogPageSchema,
  scanResolveResponseSchema,
  type ConcreteSearch,
  type InventoryPage,
  type LabProgramList,
  type ProjectSummary,
  type ReceiptLogPage,
  type ScanResolveResponse,
  type StorageLocation,
} from '@materialmule/shared';
import type { z } from 'zod';
import { apiFetch } from '../api/client';
import { fetchConcreteSearch } from '../concrete/lab/api';

// Strata search (the Ctrl K menu and /search): each kind of record through the list or search the
// app already has for it. Every call resolves. A refusal (403) means this account can't read that
// kind of record, so its group is left out rather than shown as an error.

export type SearchResult<T> =
  { ok: true; data: T } | { ok: false; forbidden: boolean; message: string };

/** How many of each kind the results page lists before "Show all". */
export const SEARCH_PREVIEW = 5;
/** Units read to find test holes and the units list (test holes are found through their units). */
export const SEARCH_UNIT_PAGE = 50;

async function getJson<T>(
  url: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<SearchResult<T>> {
  try {
    const response = await apiFetch(url);
    if (!response.ok) {
      return {
        ok: false,
        forbidden: response.status === 403,
        message: `${what} couldn't load. Try again.`,
      };
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, forbidden: false, message: `${what} couldn't load: unexpected response.` };
  } catch {
    return { ok: false, forbidden: false, message: `${what} couldn't load. Check the connection.` };
  }
}

/** Storage units, disposed ones included (a disposed unit keeps its ID and history). */
export function searchUnits(
  q: string,
  pageSize = SEARCH_UNIT_PAGE,
): Promise<SearchResult<InventoryPage>> {
  const params = new URLSearchParams({ search: q, status: 'all', pageSize: String(pageSize) });
  return getJson(`/api/inventory?${params.toString()}`, inventoryPageSchema, 'Storage units');
}

export function searchProjects(q: string): Promise<SearchResult<ProjectSummary[]>> {
  const params = new URLSearchParams({ q, limit: String(SEARCH_PREVIEW) });
  return getJson(
    `/api/projects/search?${params.toString()}`,
    projectSearchResponseSchema,
    'Projects',
  );
}

export function searchPrograms(q: string): Promise<SearchResult<LabProgramList>> {
  return getJson(
    `/api/lab-programs?${new URLSearchParams({ search: q }).toString()}`,
    labProgramListSchema,
    'Lab programs',
  );
}

export function searchLocations(q: string): Promise<SearchResult<StorageLocation[]>> {
  return getJson(
    `/api/locations?${new URLSearchParams({ search: q }).toString()}`,
    locationListSchema,
    'Shelves',
  );
}

export function searchReceipts(q: string): Promise<SearchResult<ReceiptLogPage>> {
  const params = new URLSearchParams({ search: q, pageSize: String(SEARCH_PREVIEW) });
  return getJson(`/api/receipts?${params.toString()}`, receiptLogPageSchema, 'Deliveries');
}

/**
 * What a scanned or typed code is, exactly (a unit's ID or a shelf label); null when the check
 * itself failed, so the caller falls back to the results page.
 */
export async function resolveExact(q: string): Promise<ScanResolveResponse | null> {
  const result = await getJson(
    `/api/scan/resolve?${new URLSearchParams({ payload: q }).toString()}`,
    scanResolveResponseSchema,
    'Scan',
  );
  return result.ok ? result.data : null;
}

/**
 * Concrete field reports and their sets (MM-V2-C31's search), as a search result. A 404 means the
 * concrete search isn't there for this session, so the group is left out like a refusal.
 */
export async function searchConcrete(
  q: string,
  pageSize = SEARCH_PREVIEW,
): Promise<SearchResult<ConcreteSearch>> {
  const result = await fetchConcreteSearch(q, 1, pageSize);
  if (result.ok) return result;
  return {
    ok: false,
    forbidden: result.notFound === true,
    message: "Concrete records couldn't load. Try again.",
  };
}

/** The page an exact match opens: the unit itself, or the shelf page for a shelf label. */
export function exactDestination(exact: ScanResolveResponse | null): string | null {
  if (exact?.type === 'storage_unit') {
    return `/sample-storage/${encodeURIComponent(exact.storageUnit.readableId)}`;
  }
  if (exact?.type === 'location') {
    return `/sample-storage/locations/${encodeURIComponent(exact.location.code)}`;
  }
  return null;
}

/** The results page for `q`. */
export function resultsPath(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

/**
 * Where a search for `q` lands: the unit itself for an exact unit ID or label, the shelf page for
 * a shelf label, else /search.
 */
export async function searchDestination(q: string): Promise<string> {
  return exactDestination(await resolveExact(q)) ?? resultsPath(q);
}
