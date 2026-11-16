import {
  locationConflictDetailSchema,
  locationListSchema,
  receiptDetailSchema,
  resolveLocationConflictResponseSchema,
  scanResolveResponseSchema,
  storageUnitDetailSchema,
  undoResultSchema,
  type LocationConflictDetail,
  type ReceiptDetail,
  type ResolveLocationConflictRequest,
  type ScanResolveResponse,
  type StorageLocation,
  type StorageUnitDetail,
  type UndoResult,
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
  return read('/api/locations?includeRetired=true&all=true', locationListSchema);
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

/** Put away (STRATA-80): the receipt the units came from, named by its date and receiver. */
export function fetchReceipt(receiptId: string): Promise<Fetched<ReceiptDetail>> {
  return read(`/api/receipts/${encodeURIComponent(receiptId)}`, receiptDetailSchema);
}

/**
 * Undo of a saved move (STRATA-123, lane 1C): a new, audited compensating move the server checks
 * again. On a LAB station `moverUserId` is the person the move was credited to.
 */
export function undoMove(body: {
  sourceId: string;
  idempotencyKey: string;
  moverUserId?: string;
}): Promise<Fetched<UndoResult>> {
  return read('/api/undo', undoResultSchema, {
    method: 'POST',
    body: JSON.stringify({ action: 'move', ...body }),
  });
}
