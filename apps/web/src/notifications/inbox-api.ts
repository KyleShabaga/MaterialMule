import {
  INBOX_BULK_ACTIONS,
  INBOX_BULK_MAX,
  INBOX_PAGE_SIZE_MAX,
  inboxBulkResultSchema,
  inboxPageSchema,
  inboxSummarySchema,
  normalizeHiddenColumns,
  notificationCountSchema,
  tableColumnsResponseSchema,
  tableColumnsVersionConflictSchema,
  type InboxBulkResult,
  type InboxFilter,
  type InboxItem,
  type InboxPage,
  type InboxSort,
  type InboxSummary,
  type InboxTab,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';
import { announceNotificationsChanged } from './api';
import { setInboxUnreadCount } from './inbox-count';

// The Inbox page's calls (STRATA-24, 26, 64) on lane 1C's single feed (packages/shared/src/inbox.ts):
//   GET  /api/inbox                         one page of the feed
//   POST /api/inbox/requests/:id/read|unread  a request's read state (never resolves it)
//   POST /api/inbox/read-all                  every unread item read
//   POST /api/inbox/bulk                      read, unread or dismiss checked rows (STRATA-48)
//   POST /api/notifications/:id/read|dismiss|restore   an update's state
//   GET  /api/me/table-columns, PUT /api/me/table-columns/inbox   the Table view's columns
// Every mutation keeps the sidebar badge and the bell (one shared count) in step.

/** Thrown when the feed is refused, so the page says so instead of offering Try again. */
export class InboxForbiddenError extends Error {
  constructor() {
    super('HTTP 403');
  }
}

export interface InboxRequest {
  tab: InboxTab;
  filters: readonly InboxFilter[];
  q: string;
  sort: InboxSort;
  page: number;
  pageSize?: number;
}

export function inboxRequestParams(request: InboxRequest): URLSearchParams {
  const params = new URLSearchParams({ tab: request.tab, sort: request.sort });
  if (request.filters.length > 0) params.set('filter', request.filters.join(','));
  const q = request.q.trim();
  if (q) params.set('q', q);
  if (request.page > 1) params.set('page', String(request.page));
  if (request.pageSize) params.set('pageSize', String(request.pageSize));
  return params;
}

export async function fetchInboxPage(params: URLSearchParams): Promise<InboxPage> {
  const response = await apiFetch(`/api/inbox?${params.toString()}`);
  if (response.status === 403) throw new InboxForbiddenError();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return inboxPageSchema.parse(await response.json());
}

/** Where a summary lands: the shared count, and anyone listening for notification changes. */
function took(summary: InboxSummary): InboxSummary {
  setInboxUnreadCount(summary.counts.badge);
  announceNotificationsChanged();
  return summary;
}

async function postSummary(path: string, body?: unknown): Promise<InboxSummary | null> {
  try {
    const response = await apiFetch(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) return null;
    return took(inboxSummarySchema.parse(await response.json()));
  } catch {
    return null;
  }
}

/** Marks a request read or unread for me. Null when it failed. Never resolves the request. */
export function markRequest(id: string, read: boolean): Promise<InboxSummary | null> {
  return postSummary(`/api/inbox/requests/${encodeURIComponent(id)}/${read ? 'read' : 'unread'}`);
}

export function markAllInboxRead(): Promise<InboxSummary | null> {
  return postSummary('/api/inbox/read-all');
}

export type UpdateAction = 'read' | 'dismiss' | 'restore';

/** One update (notification) action. True when the server took it. */
export async function updateAction(id: string, action: UpdateAction): Promise<boolean> {
  try {
    const response = await apiFetch(`/api/notifications/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
    });
    if (!response.ok) return false;
    notificationCountSchema.parse(await response.json());
    // The shared count reads the Inbox summary again (one value for the badge and the bell).
    announceNotificationsChanged();
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks an item read the way its type needs: a request through the Inbox route, an update through
 * its notification route. True when the server took it.
 */
export async function markItemRead(item: InboxItem): Promise<boolean> {
  if (item.type === 'request') return (await markRequest(item.sourceId, true)) !== null;
  return updateAction(item.sourceId, 'read');
}

// ---------------------------------------------------------------------------------------------
// STRATA-48: bulk actions on checked rows (Kyle, 2026-11-13): Mark read, Mark unread, Dismiss.

export type InboxBulkAction = (typeof INBOX_BULK_ACTIONS)[number];
export { INBOX_BULK_ACTIONS, INBOX_BULK_MAX };

export type BulkOutcome =
  { ok: true; result: InboxBulkResult } | { ok: false; code: 'dismiss_requests' | 'failed' };

export async function bulkInbox(action: InboxBulkAction, keys: string[]): Promise<BulkOutcome> {
  try {
    const response = await apiFetch('/api/inbox/bulk', {
      method: 'POST',
      body: JSON.stringify({ action, keys: keys.slice(0, INBOX_BULK_MAX) }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      return { ok: false, code: body.code === 'dismiss_requests' ? 'dismiss_requests' : 'failed' };
    }
    const result = inboxBulkResultSchema.parse(await response.json());
    took(result.summary);
    return { ok: true, result };
  } catch {
    return { ok: false, code: 'failed' };
  }
}

// ---------------------------------------------------------------------------------------------
// STRATA-51: the Table view's optional columns, saved per person (tableId `inbox`).

export const TABLE_COLUMNS_PATH = '/api/me/table-columns';

export interface InboxColumnsState {
  hidden: string[];
  version: number;
  readOnly: boolean;
}

export async function fetchInboxColumns(): Promise<InboxColumnsState | null> {
  try {
    const response = await apiFetch(TABLE_COLUMNS_PATH);
    if (!response.ok) return null;
    const data = tableColumnsResponseSchema.parse(await response.json());
    return {
      hidden: normalizeHiddenColumns('inbox', data.tables.inbox?.hidden),
      version: data.version,
      readOnly: data.readOnly,
    };
  } catch {
    return null;
  }
}

export type SaveColumnsResult =
  | { kind: 'saved'; state: InboxColumnsState }
  | { kind: 'conflict'; state: InboxColumnsState }
  | { kind: 'failed' };

export async function saveInboxColumns(
  hidden: string[],
  version: number,
): Promise<SaveColumnsResult> {
  try {
    const response = await apiFetch(`${TABLE_COLUMNS_PATH}/inbox`, {
      method: 'PUT',
      body: JSON.stringify({ hidden, version }),
    });
    if (response.ok) {
      const data = tableColumnsResponseSchema.parse(await response.json());
      return {
        kind: 'saved',
        state: {
          hidden: normalizeHiddenColumns('inbox', data.tables.inbox?.hidden),
          version: data.version,
          readOnly: data.readOnly,
        },
      };
    }
    if (response.status === 409) {
      const conflict = tableColumnsVersionConflictSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (conflict.success) {
        const current = conflict.data.current;
        return {
          kind: 'conflict',
          state: {
            hidden: normalizeHiddenColumns('inbox', current.tables.inbox?.hidden),
            version: current.version,
            readOnly: current.readOnly,
          },
        };
      }
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

// ---------------------------------------------------------------------------------------------
// One item by key, for the full page (`/inbox/:key`) after a reload: the feed has no single-item
// route, so it walks All, then Done, in pages of 100 (the feed covers 90 days).

const FIND_PAGES = 20;

/**
 * Items seen on the list, so Open as full page shows one without walking the feed. Kept per
 * signed-in person, so another person signing in on this browser never sees them.
 */
const seen = new Map<string, InboxItem>();
const SEEN_MAX = 500;

export function rememberInboxItems(personId: string, items: readonly InboxItem[]): void {
  for (const item of items) {
    const id = `${personId}|${item.key}`;
    seen.delete(id);
    seen.set(id, item);
  }
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
}

export function seenInboxItem(personId: string, key: string): InboxItem | null {
  return seen.get(`${personId}|${key}`) ?? null;
}

/** Tests only. */
export function forgetInboxItems(): void {
  seen.clear();
}

export async function findInboxItem(key: string): Promise<InboxItem | null> {
  for (const tab of ['all', 'done'] as const) {
    for (let page = 1; page <= FIND_PAGES; page += 1) {
      const data = await fetchInboxPage(
        inboxRequestParams({
          tab,
          filters: [],
          q: '',
          sort: 'newest',
          page,
          pageSize: INBOX_PAGE_SIZE_MAX,
        }),
      );
      const found = data.items.find((item) => item.key === key);
      if (found) return found;
      if (page * data.pageSize >= data.total) break;
    }
  }
  return null;
}
