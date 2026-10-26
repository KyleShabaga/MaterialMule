import {
  inventoryLocationListSchema,
  inventoryPageSchema,
  projectSummarySchema,
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  storageUnitLookupResponseSchema,
  unresolvedLabLinksResponseSchema,
  validationErrorResponseSchema,
  type FieldError,
  type InventoryLocation,
  type InventoryPage,
  type LabRequestLink,
  type ProjectSummary,
  type StorageUnitCorrectionRequestInput,
  type StorageUnitDetail,
  type StorageUnitHistoryPage,
  type StorageUnitLookupResponse,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// Inventory, lookup and storage unit detail (MM-T12). Every call resolves; failures carry a
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
      message: "Material Mule couldn't be reached. Check the connection.",
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
    : { ok: false, notFound: false, message: 'Material Mule returned an unexpected response.' };
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

/** Outcome of `PATCH /api/storage-units/:id` (MM-T13). */
export type CorrectionResult =
  | { kind: 'saved'; unit: StorageUnitDetail }
  | { kind: 'conflict' }
  | { kind: 'lab_links'; links: LabRequestLink[] }
  | { kind: 'invalid'; errors: FieldError[] }
  | { kind: 'error'; message: string };

export async function correctStorageUnit(
  id: string,
  body: StorageUnitCorrectionRequestInput,
): Promise<CorrectionResult> {
  let response: Response;
  try {
    response = await apiFetch(`/api/storage-units/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'error', message: "Material Mule couldn't be reached. Check the connection." };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const unit = storageUnitDetailSchema.safeParse(json);
    return unit.success
      ? { kind: 'saved', unit: unit.data }
      : { kind: 'error', message: 'Material Mule returned an unexpected response.' };
  }
  if (response.status === 409) {
    const links = unresolvedLabLinksResponseSchema.safeParse(json);
    return links.success ? { kind: 'lab_links', links: links.data.links } : { kind: 'conflict' };
  }
  if (response.status === 400 || response.status === 422) {
    // 422 (test hole not in the project) carries field errors in the same shape as a 400.
    const invalid = validationErrorResponseSchema.safeParse({
      ...(json as object),
      code: 'validation_failed',
    });
    if (invalid.success) return { kind: 'invalid', errors: invalid.data.errors };
  }
  if (response.status === 403) {
    return { kind: 'error', message: 'Corrections need a personal account.' };
  }
  if (response.status === 404) return { kind: 'error', message: 'No storage unit found.' };
  return { kind: 'error', message: `The correction couldn't be saved (HTTP ${response.status}).` };
}
