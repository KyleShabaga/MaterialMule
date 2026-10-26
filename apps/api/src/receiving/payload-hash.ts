import { createHash } from 'node:crypto';
import type { ConfirmReceiptRequest } from '@materialmule/shared';

/**
 * JSON with object keys sorted at every level, so two payloads that differ only in key order
 * serialise identically. Array order is kept: unit and summary order are meaningful.
 * `undefined` properties are skipped, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * SHA-256 (hex) of the validated, normalised request without its idempotency key. Stored on the
 * receipt; a retry with the same key must produce the same hash to get the original result.
 */
export function receiptPayloadHash(request: ConfirmReceiptRequest): string {
  const { idempotencyKey: _key, ...payload } = request;
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
