import {
  RECEIPT_LOG_PAGE_SIZE_DEFAULT,
  RECEIPT_LOG_SORT_KEYS,
  receiptLogQuerySchema,
  type ReceiptLogQuery,
  type ReceiptLogSortKey,
  type ReceiptLogStatus,
} from '@materialmule/shared';
import type { TableQuery } from '@/components/strata/table-query';

// Receiving log URL state (MM-T51, STRATA-78). The table tools keep search, filters, sort and
// view in the URL (lane 1B `useTableQuery`); this turns them, with `page`, into the server query.
// Filter ids: `status:confirmed`, `status:corrected`, `project:<id>`, `receiver:<id>`. Older links
// with `projectId`, `receiverUserId`, `receivedFrom` and `receivedTo` still work.

export const STATUS_FILTER: Record<ReceiptLogStatus, string> = {
  confirmed: 'status:confirmed',
  corrected: 'status:corrected',
};
export const projectFilter = (id: string) => `project:${id}`;
export const receiverFilter = (id: string) => `receiver:${id}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lastWith(filters: readonly string[], prefix: string): string | undefined {
  for (let i = filters.length - 1; i >= 0; i--) {
    const f = filters[i]!;
    if (f.startsWith(prefix)) {
      const value = f.slice(prefix.length);
      return UUID.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/** One project and one person at a time: picking another replaces the earlier one. */
export function normalizeFilters(filters: readonly string[]): string[] {
  const project = lastWith(filters, 'project:');
  const receiver = lastWith(filters, 'receiver:');
  const out: string[] = [];
  for (const f of filters) {
    if (f.startsWith('project:')) {
      if (project && f === projectFilter(project) && !out.includes(f)) out.push(f);
    } else if (f.startsWith('receiver:')) {
      if (receiver && f === receiverFilter(receiver) && !out.includes(f)) out.push(f);
    } else if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** The server query for the table's state, the page and any older-style parameters. */
export function receiptLogQueryFor(
  table: TableQuery,
  params: URLSearchParams,
): { query: ReceiptLogQuery; ignored: boolean } {
  const filters = table.filters;
  const statuses = (['confirmed', 'corrected'] as const).filter((s) =>
    filters.includes(STATUS_FILTER[s]),
  );
  const sortKey = table.sort?.key as ReceiptLogSortKey | undefined;
  const raw: Record<string, string | undefined> = {
    search: table.search.trim() || undefined,
    projectId: lastWith(filters, 'project:') ?? params.get('projectId') ?? undefined,
    receiverUserId: lastWith(filters, 'receiver:') ?? params.get('receiverUserId') ?? undefined,
    receivedFrom: params.get('receivedFrom') ?? undefined,
    receivedTo: params.get('receivedTo') ?? undefined,
    // Both statuses on (or neither) is every receipt.
    status: statuses.length === 1 ? statuses[0] : undefined,
    sort: sortKey && RECEIPT_LOG_SORT_KEYS.includes(sortKey) ? sortKey : undefined,
    dir: sortKey ? table.sort!.dir : undefined,
    page: params.get('page') ?? undefined,
  };
  const parsed = receiptLogQuerySchema.safeParse(raw);
  if (parsed.success) return { query: parsed.data, ignored: false };
  // A hand-edited link: drop whatever isn't valid and say so.
  for (const issue of parsed.error.issues) delete raw[String(issue.path[0])];
  const retry = receiptLogQuerySchema.safeParse(raw);
  return { query: retry.success ? retry.data : receiptLogQuerySchema.parse({}), ignored: true };
}

/** API query string for `query`, leaving out defaults. */
export function receiptLogSearchParams(query: ReceiptLogQuery): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined, fallback?: string | number) => {
    if (value !== undefined && value !== '' && value !== fallback) params.set(key, String(value));
  };
  set('search', query.search);
  set('projectId', query.projectId);
  set('receiverUserId', query.receiverUserId);
  set('receivedFrom', query.receivedFrom);
  set('receivedTo', query.receivedTo);
  set('status', query.status);
  set('sort', query.sort);
  set('dir', query.sort ? query.dir : undefined);
  set('page', query.page, 1);
  set('pageSize', query.pageSize, RECEIPT_LOG_PAGE_SIZE_DEFAULT);
  return params;
}

export function hasActiveFilters(table: TableQuery, params: URLSearchParams): boolean {
  return Boolean(
    table.search.trim() ||
    table.filters.length > 0 ||
    params.get('projectId') ||
    params.get('receiverUserId') ||
    params.get('receivedFrom') ||
    params.get('receivedTo'),
  );
}

/** Every filter, the search and the older-style parameters cleared; the view and drawer kept. */
export function clearedParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of [
    'search',
    'filter',
    'page',
    'projectId',
    'receiverUserId',
    'receivedFrom',
    'receivedTo',
  ]) {
    next.delete(key);
  }
  return next;
}
