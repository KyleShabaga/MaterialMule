import {
  disposalReadySchema,
  disposalScanCheckResponseSchema,
  disposalScanRecordResponseSchema,
  type DisposalReady,
  type DisposalScanCheckResponse,
  type DisposalScanIntent,
  type DisposalScanRecordResponse,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// The Disposal scan-out routes (STRATA-92). Every answer is classified so the page knows whether
// the outcome is known: only `ok` changes what an intent shows. No answer, a server error or an
// expired session leaves each intent as it was (an unanswered recording stays "uncertain" and is
// checked again before anything else).

export type ScanCall<T> =
  | { kind: 'ok'; body: T }
  /** The session ended: keep everything and ask the person to sign in again. */
  | { kind: 'unauthenticated' }
  /** This account may not record disposal scans (a LAB station, or the permission was removed). */
  | { kind: 'forbidden' }
  /** No answer or a server error: the outcome is unknown. */
  | { kind: 'unavailable' }
  /** The server couldn't read the request (a bug or a damaged record): nothing was done. */
  | { kind: 'invalid'; message: string };

const TIMEOUT_MS = 20_000;

async function post<T>(
  path: string,
  intents: DisposalScanIntent[],
  parse: (body: unknown) => T,
): Promise<ScanCall<T>> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // The page says when the session ends; it keeps the person (and their scans) in place.
    response = await apiFetch(
      path,
      { method: 'POST', body: JSON.stringify({ intents }), signal: controller.signal },
      { reportUnauthenticated: false },
    );
  } catch {
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 403) return { kind: 'forbidden' };
  if (response.status === 400) {
    return { kind: 'invalid', message: 'Material Mule couldn’t read these scans.' };
  }
  if (!response.ok) return { kind: 'unavailable' };
  try {
    return { kind: 'ok', body: parse(await response.json()) };
  } catch {
    // A 200 we can't read: what happened is unknown.
    return { kind: 'unavailable' };
  }
}

/** What recording each intent would do now. Changes nothing on the server. */
export function checkScans(
  intents: DisposalScanIntent[],
): Promise<ScanCall<DisposalScanCheckResponse>> {
  return post('/api/disposal/scan/check', intents, (body) =>
    disposalScanCheckResponseSchema.parse(body),
  );
}

/** Records the intents (only ever after the person confirmed this exact list). */
export function recordScans(
  intents: DisposalScanIntent[],
): Promise<ScanCall<DisposalScanRecordResponse>> {
  return post('/api/disposal/scan/record', intents, (body) =>
    disposalScanRecordResponseSchema.parse(body),
  );
}

/** The first page of units ready for disposal, every project; null when it couldn't load. */
export async function fetchApprovedWaiting(): Promise<DisposalReady | null> {
  try {
    const response = await apiFetch('/api/disposal/ready?page=1');
    if (!response.ok) return null;
    return disposalReadySchema.parse(await response.json());
  } catch {
    return null;
  }
}
