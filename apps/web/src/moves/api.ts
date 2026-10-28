import {
  locationConflictDetailSchema,
  locationListSchema,
  resolveLocationConflictResponseSchema,
  scanResolveResponseSchema,
  storageUnitDetailSchema,
  type LocationConflictDetail,
  type ResolveLocationConflictRequest,
  type ScanResolveResponse,
  type StorageLocation,
  type StorageUnitDetail,
} from '@materialmule/shared';
import type { z } from 'zod';
import { apiFetch } from '../api/client';

// Reads the Move screen needs (MM-T28). `unavailable` means no answer (offline, timeout, server
// error): the screen then falls back to this computer's cache, never to a guess.

export type Fetched<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'error'; status: number; body: unknown };

const READ_TIMEOUT_MS = 10_000;

async function read<S extends z.ZodType>(
  path: string,
  schema: S,
  init: RequestInit = {},
): Promise<Fetched<z.output<S>>> {
  let response: Response;
  try {
    response = await apiFetch(
      path,
      { signal: AbortSignal.timeout(READ_TIMEOUT_MS), ...init },
      { reportUnauthenticated: false },
    );
  } catch {
    return { kind: 'unavailable' };
  }
  if (response.status >= 500) return { kind: 'unavailable' };
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404) return { kind: 'not_found' };
  if (!response.ok) return { kind: 'error', status: response.status, body };
  const parsed = schema.safeParse(body);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
}

export function resolveScan(payload: string): Promise<Fetched<ScanResolveResponse>> {
  return read(
    `/api/scan/resolve?payload=${encodeURIComponent(payload)}`,
    scanResolveResponseSchema,
  );
}

export function fetchUnit(readableId: string): Promise<Fetched<StorageUnitDetail>> {
  return read(`/api/storage-units/${encodeURIComponent(readableId)}`, storageUnitDetailSchema);
}

/** Every location, retired included, so an offline scan of a retired label is recognised. */
export function fetchAllLocations(): Promise<Fetched<StorageLocation[]>> {
  return read('/api/locations?includeRetired=true', locationListSchema);
}

export function fetchConflict(id: string): Promise<Fetched<LocationConflictDetail>> {
  return read(`/api/location-conflicts/${encodeURIComponent(id)}`, locationConflictDetailSchema);
}

export function resolveConflict(id: string, body: ResolveLocationConflictRequest) {
  return read(
    `/api/location-conflicts/${encodeURIComponent(id)}/resolve`,
    resolveLocationConflictResponseSchema,
    { method: 'POST', body: JSON.stringify(body) },
  );
}
