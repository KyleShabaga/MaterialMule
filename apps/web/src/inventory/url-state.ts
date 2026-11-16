import {
  INVENTORY_PAGE_SIZE_DEFAULT,
  INVENTORY_STAGE_TABS,
  inventoryListQuerySchema,
  type InventoryListQuery,
  type InventoryStageTab,
} from '@materialmule/shared';
import {
  readTableQuery,
  writeTableQuery,
  type SortState,
  type TableQuery,
} from '../components/strata/table-query';

// Inventory state lives in the URL (MM-T12, STRATA-79), using the API's parameter names, so a
// view can be shared and Back returns to it. The table tools' keys (search, filter, sort, dir,
// view, page) are lane 1B's (table-query.ts); the stage tab is `stage` (left out for All) and each
// filter's value has its own API key (projectId, testHoleId, type, locationId, receivedFrom,
// receivedTo, retention). `filter=<id>` marks a chip added from "+ Add filter" whose value isn't
// chosen yet. Older links keep working: `status=disposed` and `conflict=open` open their tabs.

/** The chip filters in the Filter menu, in the order the menu lists them. */
export const INVENTORY_FILTERS = [
  'project',
  'testHole',
  'type',
  'location',
  'received',
  'retention',
] as const;
export type InventoryFilter = (typeof INVENTORY_FILTERS)[number];

export const INVENTORY_FILTER_LABELS: Record<InventoryFilter, string> = {
  project: 'Project',
  testHole: 'Test hole',
  type: 'Type',
  location: 'Location',
  received: 'Received',
  retention: 'Retention',
};

/** The URL keys each filter writes. */
export const INVENTORY_FILTER_KEYS: Record<InventoryFilter, readonly string[]> = {
  project: ['projectId', 'testHoleId'],
  testHole: ['testHoleId'],
  type: ['type'],
  location: ['locationId'],
  received: ['receivedFrom', 'receivedTo'],
  retention: ['retention'],
};

/** Older keys that still narrow the list (dashboard and retention links) and show as chips. */
const EXTRA_KEYS = ['receiptId', 'retainUntilFrom', 'retainUntilTo'] as const;

/** Every key a filter or older link may set; Clear filters removes them all. */
const FILTER_URL_KEYS = [
  ...new Set([...Object.values(INVENTORY_FILTER_KEYS).flat(), ...EXTRA_KEYS]),
] as const;

const API_KEYS = [
  'projectId',
  'testHoleId',
  'type',
  'locationId',
  'receiptId',
  'receivedFrom',
  'receivedTo',
  'retention',
  'retainUntilFrom',
  'retainUntilTo',
  'search',
  'sort',
  'dir',
  'page',
  'pageSize',
] as const;

const isStage = (value: string | null): value is InventoryStageTab =>
  value !== null && (INVENTORY_STAGE_TABS as readonly string[]).includes(value);

/** The stage tab from the URL; older `conflict=open` and `status=disposed` links open theirs. */
export function readStage(params: URLSearchParams): InventoryStageTab {
  const stage = params.get('stage');
  if (isStage(stage)) return stage;
  if (params.get('conflict') === 'open') return 'conflicts';
  if (params.get('status') === 'disposed') return 'disposed';
  return 'all';
}

/** The table tools' state, with the sort keys the API knows (others read as the default). */
export function readInventoryTable(params: URLSearchParams): TableQuery {
  const table = readTableQuery(params);
  const sort = table.sort && isSort(table.sort) ? table.sort : null;
  const isDefault = sort?.key === 'received' && sort.dir === 'desc';
  return {
    ...table,
    sort: isDefault ? null : sort,
    filters: table.filters.filter((f): f is InventoryFilter =>
      (INVENTORY_FILTERS as readonly string[]).includes(f),
    ),
  };
}

const SORT_KEYS = new Set(['received', 'id', 'retain_until', 'project', 'type', 'where', 'stage']);
function isSort(sort: SortState): boolean {
  return SORT_KEYS.has(sort.key);
}

/**
 * The API request for this URL: the page's own keys validated with the shared schema (an invalid
 * value from a hand-edited link is dropped, and `ignored` says so), plus the stage tab, counts and
 * the page size. Search comes from `search` so the caller can debounce it.
 */
export function inventoryRequest(
  params: URLSearchParams,
  search: string,
): { query: InventoryListQuery; ignored: boolean } {
  const raw: Record<string, string> = {};
  for (const key of API_KEYS) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }
  const table = readInventoryTable(params);
  delete raw.sort;
  delete raw.dir;
  if (table.sort) {
    raw.sort = table.sort.key;
    raw.dir = table.sort.dir;
  }
  if (search.trim()) raw.search = search.trim();
  else delete raw.search;
  raw.stage = readStage(params);
  raw.counts = '1';
  let ignored = false;
  const first = inventoryListQuerySchema.safeParse(raw);
  if (first.success) return { query: first.data, ignored };
  for (const issue of first.error.issues) {
    delete raw[String(issue.path[0])];
    ignored = true;
  }
  const second = inventoryListQuerySchema.safeParse(raw);
  return {
    query: second.success
      ? second.data
      : inventoryListQuerySchema.parse({ stage: raw.stage, counts: '1' }),
    ignored,
  };
}

/** `GET /api/inventory` parameters for `query`, leaving out defaults. */
export function inventoryRequestParams(query: InventoryListQuery): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | boolean | undefined, fallback?: unknown) => {
    if (value !== undefined && value !== '' && value !== fallback) params.set(key, String(value));
  };
  set('stage', query.stage);
  if (query.counts) params.set('counts', '1');
  set('search', query.search);
  set('projectId', query.projectId);
  set('testHoleId', query.testHoleId);
  set('type', query.type);
  set('locationId', query.locationId);
  set('receiptId', query.receiptId);
  set('receivedFrom', query.receivedFrom);
  set('receivedTo', query.receivedTo);
  set('retention', query.retention);
  set('retainUntilFrom', query.retainUntilFrom);
  set('retainUntilTo', query.retainUntilTo);
  set('sort', query.sort, 'received');
  set('dir', query.dir);
  set('page', query.page, 1);
  set('pageSize', query.pageSize, INVENTORY_PAGE_SIZE_DEFAULT);
  return params;
}

/** Applies `patch` to the URL: each key set, or removed when undefined. Drops the page. */
export function withFilterValues(
  params: URLSearchParams,
  patch: Record<string, string | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  next.delete('page');
  return next;
}

/** The tab: `stage` (left out for All). Clears the older status and conflict keys and the page. */
export function withStage(params: URLSearchParams, stage: InventoryStageTab): URLSearchParams {
  const next = new URLSearchParams(params);
  if (stage === 'all') next.delete('stage');
  else next.set('stage', stage);
  next.delete('status');
  next.delete('conflict');
  next.delete('page');
  return next;
}

/** Adds or removes a chip that has no value yet (`filter=<id>`). */
export function withPendingFilter(
  params: URLSearchParams,
  filter: InventoryFilter,
  on: boolean,
): URLSearchParams {
  const table = readTableQuery(params);
  const filters = on
    ? table.filters.includes(filter)
      ? table.filters
      : [...table.filters, filter]
    : table.filters.filter((f) => f !== filter);
  return writeTableQuery(params, { ...table, filters });
}

/** Removes a chip: its value keys and any pending marker. */
export function withoutFilter(params: URLSearchParams, filter: InventoryFilter): URLSearchParams {
  const next = withPendingFilter(params, filter, false);
  return withFilterValues(
    next,
    Object.fromEntries(INVENTORY_FILTER_KEYS[filter].map((key) => [key, undefined])),
  );
}

/** Whether a filter has a value in the URL. */
export function filterHasValue(params: URLSearchParams, filter: InventoryFilter): boolean {
  if (filter === 'project') return params.has('projectId');
  return INVENTORY_FILTER_KEYS[filter].some((key) => params.has(key));
}

/** True when a search or any filter narrows the list (the tab doesn't count). */
export function hasActiveFilters(params: URLSearchParams): boolean {
  return (
    Boolean(params.get('search')?.trim()) ||
    FILTER_URL_KEYS.some((key) => params.has(key)) ||
    readTableQuery(params).filters.length > 0
  );
}

/**
 * Clear filters: the search, every filter and chip, back to the first page. The tab, sort, view
 * and an open drawer stay.
 */
export function clearedParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of [...FILTER_URL_KEYS, 'search', 'filter', 'page', 'status', 'conflict']) {
    next.delete(key);
  }
  return next;
}

/**
 * What a selection belongs to: the units this query can show, whatever the page, sort or view.
 * Selection is kept across pages of one query and cleared when this changes (STRATA-79).
 */
export function selectionScope(query: InventoryListQuery): string {
  const params = inventoryRequestParams({ ...query, page: 1 });
  for (const key of ['sort', 'dir', 'page', 'pageSize', 'counts']) params.delete(key);
  return params.toString();
}
