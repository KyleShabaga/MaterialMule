import {
  LIST_TOTAL_HEADER,
  locationDetailSchema,
  locationLabelPreviewSchema,
  locationListSchema,
  locationSchema,
  printJobSchema,
  validationErrorResponseSchema,
  type CreateLocationLabelRequest,
  type CreateLocationRequest,
  type FieldError,
  type LocationDetail,
  type LocationLabelPreview,
  type PrintJob,
  type RetireLocationRequest,
  type StorageLocation,
  type UpdateLocationRequest,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// Settings → Locations (MM-T37). Every call resolves; failures say what happened in plain words
// and keep what the screen needs (field errors, the current location after a conflict, the
// number of units still at a location).

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';
const FORBIDDEN = 'Only Lab Managers and administrators can change locations.';

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

export type Failure =
  | { ok: false; kind: 'forbidden'; message: string }
  | { ok: false; kind: 'conflict'; message: string; current: StorageLocation }
  | { ok: false; kind: 'occupied'; message: string; inStockCount: number }
  | { ok: false; kind: 'invalid'; message: string; errors: FieldError[] }
  | { ok: false; kind: 'failed'; message: string; code?: string; field?: string };

export type Result<T> = { ok: true; data: T } | Failure;

function messageOf(body: unknown, fallback: string): string {
  return body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
    ? body.message
    : fallback;
}

async function call<T>(
  path: string,
  schema: Schema<T>,
  init?: RequestInit,
  onResponse?: (response: Response) => void,
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    return { ok: false, kind: 'failed', message: UNREACHABLE };
  }
  onResponse?.(response);
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(body);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, kind: 'failed', message: UNEXPECTED };
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (response.status === 403) {
    return { ok: false, kind: 'forbidden', message: FORBIDDEN };
  }
  if (response.status === 409 && record.code === 'version_conflict') {
    const current = locationSchema.safeParse(record.current);
    if (current.success) {
      return {
        ok: false,
        kind: 'conflict',
        current: current.data,
        message: messageOf(body, 'Someone else changed this location.'),
      };
    }
  }
  if (response.status === 409 && record.code === 'location_occupied') {
    return {
      ok: false,
      kind: 'occupied',
      inStockCount: typeof record.inStockCount === 'number' ? record.inStockCount : 0,
      message: messageOf(body, 'Storage units are still at this location.'),
    };
  }
  const invalid = validationErrorResponseSchema.safeParse(body);
  if (response.status === 400 && invalid.success && invalid.data.code === 'validation_failed') {
    return {
      ok: false,
      kind: 'invalid',
      errors: invalid.data.errors,
      message: 'Check the highlighted fields.',
    };
  }
  return {
    ok: false,
    kind: 'failed',
    message: messageOf(body, 'Material Mule had a problem with that request. Try again.'),
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.field === 'string' ? { field: record.field } : {}),
  };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export async function listLocations(params: {
  search: string;
  includeRetired: boolean;
}): Promise<Result<{ locations: StorageLocation[]; total: number }>> {
  const query = new URLSearchParams();
  if (params.search.trim()) query.set('search', params.search.trim());
  if (params.includeRetired) query.set('includeRetired', 'true');
  const suffix = query.toString();
  let header: string | null = null;
  const result = await call(
    `/api/locations${suffix ? `?${suffix}` : ''}`,
    locationListSchema,
    undefined,
    (response) => (header = response.headers.get(LIST_TOTAL_HEADER)),
  );
  if (!result.ok) return result;
  // More matches than rows means the server cut the list (BUG-007).
  const total = Number(header ?? result.data.length);
  return {
    ok: true,
    data: {
      locations: result.data,
      total: Number.isFinite(total) ? total : result.data.length,
    },
  };
}

export function fetchLocation(id: string): Promise<Result<LocationDetail>> {
  return call(`/api/locations/${encodeURIComponent(id)}`, locationDetailSchema);
}

export function fetchLocationLabelPreview(id: string): Promise<Result<LocationLabelPreview>> {
  return call(`/api/locations/${encodeURIComponent(id)}/label/preview`, locationLabelPreviewSchema);
}

export function createLocation(request: CreateLocationRequest): Promise<Result<StorageLocation>> {
  return call('/api/locations', locationSchema, json('POST', request));
}

export function updateLocation(
  id: string,
  request: UpdateLocationRequest,
): Promise<Result<StorageLocation>> {
  return call(`/api/locations/${encodeURIComponent(id)}`, locationSchema, json('PATCH', request));
}

export function retireLocation(
  id: string,
  request: RetireLocationRequest,
): Promise<Result<StorageLocation>> {
  return call(
    `/api/locations/${encodeURIComponent(id)}/retire`,
    locationSchema,
    json('POST', request),
  );
}

/** Print or reprint the location's label (the server decides which from its history). */
export async function printLocationLabel(
  id: string,
  request: CreateLocationLabelRequest,
): Promise<Result<PrintJob>> {
  const result = await call(
    `/api/locations/${encodeURIComponent(id)}/labels`,
    printJobSchema,
    json('POST', request),
  );
  // Label printing is allowed for every active session; a 403 here isn't about management.
  return !result.ok && result.kind === 'forbidden'
    ? { ok: false, kind: 'failed', message: "You don't have permission to print labels." }
    : result;
}
