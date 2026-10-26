import { storageUnitLookupResponseSchema, type StorageUnitLookupResponse } from '@trapezoid/shared';
import { apiFetch } from '../api/client';

// Scan lookups (TRP-T16/T17) reuse T12's `GET /api/storage-units/lookup?code=`: the server trims,
// upper-cases and matches. A scan only reads; nothing here moves or changes a storage unit.

export type ScanLookupResult =
  | { kind: 'found'; unit: StorageUnitLookupResponse }
  /** Unknown or malformed code (404, or 400 for a code the server refuses to read). */
  | { kind: 'not_found' }
  /** No answer from Trapezoid (network down, server error, timeout): keep the value, offer Retry. */
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

/** A lookup that hasn't answered after this long counts as "server unavailable". */
const LOOKUP_TIMEOUT_MS = 10_000;

const UNAVAILABLE = "Trapezoid couldn't be reached. Check the connection, then Retry.";

export async function scanLookup(code: string): Promise<ScanLookupResult> {
  let response: Response;
  try {
    response = await apiFetch(`/api/storage-units/lookup?code=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unavailable', message: UNAVAILABLE };
  }
  if (response.status === 404 || response.status === 400) return { kind: 'not_found' };
  if (response.status >= 500) return { kind: 'unavailable', message: UNAVAILABLE };
  if (response.status === 401) {
    return { kind: 'error', message: 'Your session has ended. Sign in again.' };
  }
  if (response.status === 403) {
    return { kind: 'error', message: "You don't have permission to look up storage units." };
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = storageUnitLookupResponseSchema.safeParse(body);
  return response.ok && parsed.success
    ? { kind: 'found', unit: parsed.data }
    : { kind: 'error', message: 'Trapezoid returned an unexpected response.' };
}
