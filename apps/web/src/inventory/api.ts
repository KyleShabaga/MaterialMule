import {
  inventoryLocationListSchema,
  inventoryPageSchema,
  projectSummarySchema,
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  storageUnitLookupResponseSchema,
  type InventoryLocation,
  type InventoryPage,
  type ProjectSummary,
  type StorageUnitDetail,
  type StorageUnitHistoryPage,
  type StorageUnitLookupResponse,
} from '@trapezoid/shared';
import { apiFetch } from '../api/client';

// Inventory, lookup and storage unit detail (TRP-T12). Every call resolves; failures carry a
// readable message, and `notFound` marks a 404 so screens can say "No storage unit found".

export type InventoryResult<T> =
  { ok: true; data: T } | { ok: false; notFound: boolean; message: string };

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function get<T>(path: string, schema: Schema<T>): Promise<InventoryResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    return {
      ok: false,
      notFound: false,
      message: "Trapezoid couldn't be reached. Check the connection.",
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      response.status === 404
        ? 'No storage unit found.'
        : response.status === 403
          ? "You don't have permission to see this."
          : `Request failed (HTTP ${response.status}).`;
    return { ok: false, notFound: response.status === 404, message };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, notFound: false, message: 'Trapezoid returned an unexpected response.' };
}

/** `params` is the page's own URL query, which uses the API's parameter names. */
export function fetchInventory(params: URLSearchParams): Promise<InventoryResult<InventoryPage>> {
  const query = params.toString();
  return get(`/api/inventory${query ? `?${query}` : ''}`, inventoryPageSchema);
}

/** The selected project filter's label (number, name, client). */
export function fetchProject(id: string): Promise<InventoryResult<ProjectSummary>> {
  return get(`/api/projects/${encodeURIComponent(id)}`, projectSummarySchema);
}

export function fetchLocations(): Promise<InventoryResult<InventoryLocation[]>> {
  return get('/api/locations', inventoryLocationListSchema);
}

export function lookupStorageUnit(
  code: string,
): Promise<InventoryResult<StorageUnitLookupResponse>> {
  return get(
    `/api/storage-units/lookup?code=${encodeURIComponent(code)}`,
    storageUnitLookupResponseSchema,
  );
}

export function fetchStorageUnit(suNumber: string): Promise<InventoryResult<StorageUnitDetail>> {
  return get(`/api/storage-units/${encodeURIComponent(suNumber)}`, storageUnitDetailSchema);
}

export function fetchStorageUnitHistory(
  id: string,
  page: number,
): Promise<InventoryResult<StorageUnitHistoryPage>> {
  return get(
    `/api/storage-units/${encodeURIComponent(id)}/history?page=${page}`,
    storageUnitHistoryPageSchema,
  );
}
