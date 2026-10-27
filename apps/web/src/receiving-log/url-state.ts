import {
  RECEIPT_LOG_PAGE_SIZE_DEFAULT,
  receiptLogQuerySchema,
  type ReceiptLogQuery,
} from '@materialmule/shared';

// Receiving Log filters and page live in the URL query (MM-T51), using the API's parameter
// names, so a view can be shared, reloaded, and returned to with Back.

const KEYS = [
  'search',
  'projectId',
  'receiverUserId',
  'receivedFrom',
  'receivedTo',
  'page',
  'pageSize',
] as const satisfies readonly (keyof ReceiptLogQuery)[];

const FIELD_LABELS: Record<(typeof KEYS)[number], string> = {
  search: 'Search',
  projectId: 'Project',
  receiverUserId: 'Received by',
  receivedFrom: 'Received from',
  receivedTo: 'Received through',
  page: 'Page',
  pageSize: 'Page size',
};

export interface ReadQuery {
  query: ReceiptLogQuery;
  /** Labels of URL values that weren't valid and were left out (e.g. a hand-edited link). */
  ignored: string[];
}

/** Reads the query from the URL, leaving out invalid values and saying which. */
export function readReceiptLogQuery(params: URLSearchParams): ReadQuery {
  const raw: Record<string, string> = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }
  const first = receiptLogQuerySchema.safeParse(raw);
  if (first.success) return { query: first.data, ignored: [] };
  const ignored = new Set<string>();
  for (const issue of first.error.issues) {
    const key = String(issue.path[0]) as (typeof KEYS)[number];
    delete raw[key];
    ignored.add(FIELD_LABELS[key] ?? key);
  }
  const query = receiptLogQuerySchema.safeParse(raw).data ?? receiptLogQuerySchema.parse({});
  return { query, ignored: [...ignored] };
}

/** URL query for `query`, leaving out defaults so links stay short. */
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
  set('page', query.page, 1);
  set('pageSize', query.pageSize, RECEIPT_LOG_PAGE_SIZE_DEFAULT);
  return params;
}

export function hasActiveFilters(query: ReceiptLogQuery): boolean {
  return Boolean(
    query.search ||
    query.projectId ||
    query.receiverUserId ||
    query.receivedFrom ||
    query.receivedTo,
  );
}

/** Same page size, every filter cleared, back to page 1. */
export function clearedReceiptLogQuery(query: ReceiptLogQuery): ReceiptLogQuery {
  return { ...receiptLogQuerySchema.parse({}), pageSize: query.pageSize };
}

/**
 * Applies filter changes to `prev`; any change other than the page goes back to page 1. A
 * reversed date range set from the form keeps the newest date and clears the other bound rather
 * than producing a link the server refuses.
 */
export function withFilters(
  prev: URLSearchParams,
  changes: Partial<ReceiptLogQuery>,
): URLSearchParams {
  const next = { ...readReceiptLogQuery(prev).query, page: 1, ...changes };
  if (next.receivedFrom && next.receivedTo && next.receivedTo < next.receivedFrom) {
    if ('receivedFrom' in changes) next.receivedTo = undefined;
    else next.receivedFrom = undefined;
  }
  return receiptLogSearchParams(next);
}
