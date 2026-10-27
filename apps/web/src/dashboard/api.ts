import {
  activityResponseSchema,
  recentlyReceivedResponseSchema,
  type ActivityItem,
  type RecentlyReceivedResponse,
  type RecentlyReceivedShow,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// Dashboard data. Every call resolves; a failure carries a message for ErrorState.

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

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
    return { ok: false, message: `${what} couldn't load. Try again.` };
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, message: `${what} couldn't load: unexpected response.` };
}

export function fetchRecentActivity(): Promise<Loaded<ActivityItem[]>> {
  return get('/api/activity/recent?limit=8', 'Recent activity', activityResponseSchema);
}

export function fetchRecentlyReceived(
  show: RecentlyReceivedShow,
): Promise<Loaded<RecentlyReceivedResponse>> {
  return get(
    `/api/inventory/recently-received?show=${show}`,
    'Recently received',
    recentlyReceivedResponseSchema,
  );
}
