import {
  bulkGroupSummarySchema,
  confirmTestedRemovalResponseSchema,
  inventoryLocationListSchema,
  inventoryPageSchema,
  projectSummarySchema,
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  storageUnitLookupResponseSchema,
  unresolvedLabLinksResponseSchema,
  validationErrorResponseSchema,
  type BulkGroupSummary,
  type ChangeBulkGroupRequestInput,
  type ConfirmTestedRemovalRequest,
  type ConfirmTestedRemovalResponse,
  type CorrectBulkGroupRequestInput,
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
          : 'Material Mule had a problem loading this. Try again.';
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
  // Retired locations too (MM-T37), so units that were kept there can still be found.
  return get('/api/locations?includeRetired=true', inventoryLocationListSchema);
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
  return { kind: 'error', message: "The correction wasn't saved. Try again." };
}

/** Outcome of a bulk sample correction (MM-T36): the saved value, or why it wasn't saved. */
export type BulkCorrectionResult<T> =
  | { kind: 'saved'; value: T }
  | { kind: 'conflict' }
  | { kind: 'invalid'; errors: FieldError[] }
  | { kind: 'error'; message: string };

async function patchBulk<T>(
  path: string,
  body: unknown,
  schema: Schema<T>,
): Promise<BulkCorrectionResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  } catch {
    return { kind: 'error', message: "Material Mule couldn't be reached. Check the connection." };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { kind: 'saved', value: parsed.data }
      : { kind: 'error', message: 'Material Mule returned an unexpected response.' };
  }
  if (response.status === 409) return { kind: 'conflict' };
  if (response.status === 400 || response.status === 422) {
    const invalid = validationErrorResponseSchema.safeParse({
      ...(json as object),
      code: 'validation_failed',
    });
    if (invalid.success) return { kind: 'invalid', errors: invalid.data.errors };
  }
  if (response.status === 403) {
    return { kind: 'error', message: 'Corrections need a personal account.' };
  }
  if (response.status === 404) return { kind: 'error', message: 'Not found. Reload the page.' };
  return { kind: 'error', message: "The correction wasn't saved. Try again." };
}

/** `PATCH /api/storage-units/:id/bulk-group`: move a bulk soil bucket to another bulk sample. */
export function changeBulkGroup(
  storageUnitId: string,
  body: ChangeBulkGroupRequestInput,
): Promise<BulkCorrectionResult<StorageUnitDetail>> {
  return patchBulk(
    `/api/storage-units/${encodeURIComponent(storageUnitId)}/bulk-group`,
    body,
    storageUnitDetailSchema,
  );
}

/** `PATCH /api/bulk-groups/:id`: correct a bulk sample's identity for all its buckets. */
export function correctBulkGroup(
  groupId: string,
  body: CorrectBulkGroupRequestInput,
): Promise<BulkCorrectionResult<BulkGroupSummary>> {
  return patchBulk(`/api/bulk-groups/${encodeURIComponent(groupId)}`, body, bulkGroupSummarySchema);
}

/** Outcome of `POST /api/storage-units/:id/tested-removal` (MM-T36). */
export type TestedRemovalResult =
  | { kind: 'removed'; response: ConfirmTestedRemovalResponse }
  | { kind: 'refused'; status: number; code: string | null; message: string }
  | { kind: 'unreachable' };

export async function confirmTestedRemoval(
  storageUnitId: string,
  body: ConfirmTestedRemovalRequest,
): Promise<TestedRemovalResult> {
  let response: Response;
  try {
    response = await apiFetch(
      `/api/storage-units/${encodeURIComponent(storageUnitId)}/tested-removal`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  } catch {
    return { kind: 'unreachable' };
  }
  const json = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  if (response.ok) {
    const parsed = confirmTestedRemovalResponseSchema.safeParse(json);
    return parsed.success
      ? { kind: 'removed', response: parsed.data }
      : {
          kind: 'refused',
          status: 500,
          code: null,
          message: 'Material Mule returned an unexpected response.',
        };
  }
  const code = json?.code ?? null;
  const message =
    response.status === 403
      ? 'Removal after testing needs a personal account.'
      : code === 'version_conflict'
        ? 'This unit changed since you opened it. Review the latest and confirm again.'
        : code === 'already_removed'
          ? 'This unit was already removed after testing.'
          : (json?.message ?? 'The removal wasn’t recorded. Try again.');
  return { kind: 'refused', status: response.status, code, message };
}
