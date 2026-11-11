import {
  inventoryPageSchema,
  labProgramListSchema,
  locationListSchema,
  projectSearchResponseSchema,
  receiptLogPageSchema,
  scanResolveResponseSchema,
  type InventoryPage,
  type LabProgramList,
  type ProjectSummary,
  type ReceiptLogPage,
  type ScanResolveResponse,
  type StorageLocation,
} from '@materialmule/shared';
import type { z } from 'zod';
import { apiFetch } from '../api/client';

// Field Ledger search (top bar and /search): each kind of record through the list or search the
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
export function searchUnits(q: string): Promise<SearchResult<InventoryPage>> {
  const params = new URLSearchParams({
    search: q,
    status: 'all',
    pageSize: String(SEARCH_UNIT_PAGE),
  });
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
