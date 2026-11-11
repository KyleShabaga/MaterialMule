import {
  activityResponseSchema,
  inventoryPageSchema,
  locationListSchema,
  recentlyReceivedResponseSchema,
  worklistSchema,
  type ActivityItem,
  type InventoryPage,
  type RecentlyReceivedResponse,
  type RecentlyReceivedShow,
  type StorageLocation,
  type Worklist,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// Today's data, each through the list or count the app already has. Every call resolves; a
// failure carries a message for ErrorState. `forbidden` marks a refusal (this account can't
// read that kind of record), which Today leaves out rather than showing as an error.

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string; forbidden?: boolean };

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function get<T>(path: string, what: string, schema: Schema<T>): Promise<Loaded<T>> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    return { ok: false, message: `${what} couldn't load. Check the connection.` };
  }
  if (!response.ok) {
    // No status codes on screen (design guide): say what failed and offer Retry.
    return {
      ok: false,
      message: `${what} couldn't load. Try again.`,
      forbidden: response.status === 403,
    };
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, message: `${what} couldn't load: unexpected response.` };
}

/** Hours Today's ledger covers. */
export const LEDGER_HOURS = 24;
export const LEDGER_LIMIT = 12;

/** Today's ledger: the last 24 hours of receipts, labels, corrections, moves and disposals. */
export function fetchLedger(): Promise<Loaded<ActivityItem[]>> {
  return get(
    `/api/activity/recent?limit=${LEDGER_LIMIT}&hours=${LEDGER_HOURS}`,
    'The ledger',
    activityResponseSchema,
  );
}

/** Kept for callers of the former dashboard list. */
export function fetchRecentActivity(): Promise<Loaded<ActivityItem[]>> {
  return get('/api/activity/recent?limit=8', 'Recent activity', activityResponseSchema);
}

export function fetchRecentlyReceived(
  show: RecentlyReceivedShow,
  limit?: number,
): Promise<Loaded<RecentlyReceivedResponse>> {
  return get(
    `/api/inventory/recently-received?show=${show}${limit ? `&limit=${limit}` : ''}`,
    'Recently received',
    recentlyReceivedResponseSchema,
  );
}

/** Units whose retain-until date has been reached (the Retention screen decides what happens). */
export const RETENTION_PAGE = 100;

export function fetchRetentionDue(): Promise<Loaded<InventoryPage>> {
  return get(
    `/api/inventory?retention=eligible_by_date&pageSize=${RETENTION_PAGE}`,
    'Retention',
    inventoryPageSchema,
  );
}

/** Units whose saved location has an open conflict a person must confirm (MM-T81). */
export function fetchOpenConflicts(): Promise<Loaded<InventoryPage>> {
  return get('/api/inventory?conflict=open&pageSize=1', 'Location conflicts', inventoryPageSchema);
}

export function fetchLocations(): Promise<Loaded<StorageLocation[]>> {
  return get('/api/locations', 'The storage room', locationListSchema);
}

/** Lab programs with open tests (the lab worklist). */
export function fetchOpenPrograms(): Promise<Loaded<Worklist>> {
  return get('/api/worklist?open=true', 'Lab programs', worklistSchema);
}
