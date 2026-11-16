import {
  stationInboxPageSchema,
  stationInboxSummarySchema,
  type StationInboxPage,
  type StationInboxSummary,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// The station Inbox (STRATA-27): the picked person's Inbox on a shared LAB computer, read-only,
// only when that person turned on "Show my Inbox on shared LAB computers". The server checks the
// consent on every call and answers `private` (no items, no counts) when it is off. The person ID
// is a UUID in the query, never anything sensitive.

export const STATION_INBOX_PATH = '/api/station/inbox';
export const STATION_INBOX_SUMMARY_PATH = '/api/station/inbox/summary';

/** One page of the person's All tab, newest first; null when it couldn't be read. */
export async function fetchStationInbox(
  personId: string,
  page = 1,
): Promise<StationInboxPage | null> {
  const query = new URLSearchParams({
    personId,
    tab: 'all',
    sort: 'newest',
    page: String(page),
  });
  try {
    const response = await apiFetch(`${STATION_INBOX_PATH}?${query.toString()}`);
    if (!response.ok) return null;
    const parsed = stationInboxPageSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The person's counts and preview (or `private`); null when it couldn't be read. */
export async function fetchStationInboxSummary(
  personId: string,
): Promise<StationInboxSummary | null> {
  try {
    const response = await apiFetch(
      `${STATION_INBOX_SUMMARY_PATH}?${new URLSearchParams({ personId }).toString()}`,
    );
    if (!response.ok) return null;
    const parsed = stationInboxSummarySchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
