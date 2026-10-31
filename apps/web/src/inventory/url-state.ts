import {
  INVENTORY_PAGE_SIZE_DEFAULT,
  inventoryQuerySchema,
  type InventoryQuery,
} from '@materialmule/shared';

// Inventory filter and page state lives in the URL query (MM-T12), using the API's parameter
// names, so a view can be shared and Back returns to it.

const KEYS = [
  'search',
  'projectId',
  'testHoleId',
  'type',
  'locationId',
  'receiptId',
  'status',
  'receivedFrom',
  'receivedTo',
  'retention',
  'conflict',
  'sort',
  'dir',
  'page',
  'pageSize',
] as const satisfies readonly (keyof InventoryQuery)[];

/** Reads the query from the URL. Invalid values (e.g. a hand-edited link) fall back to defaults. */
export function readInventoryQuery(params: URLSearchParams): InventoryQuery {
  const raw: Record<string, string> = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }
  const first = inventoryQuerySchema.safeParse(raw);
  if (first.success) return first.data;
  for (const issue of first.error.issues) {
    delete raw[String(issue.path[0])];
  }
  return inventoryQuerySchema.safeParse(raw).data ?? inventoryQuerySchema.parse({});
}

/** URL query for `query`, leaving out defaults so links stay short. */
export function inventorySearchParams(query: InventoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined, fallback?: string | number) => {
    if (value !== undefined && value !== '' && value !== fallback) params.set(key, String(value));
  };
  set('search', query.search);
  set('projectId', query.projectId);
  set('testHoleId', query.testHoleId);
  set('type', query.type);
  set('locationId', query.locationId);
  set('receiptId', query.receiptId);
  set('status', query.status, 'current');
  set('receivedFrom', query.receivedFrom);
  set('receivedTo', query.receivedTo);
  set('retention', query.retention);
  set('conflict', query.conflict);
  set('sort', query.sort, 'received');
  set('dir', query.dir);
  set('page', query.page, 1);
  set('pageSize', query.pageSize, INVENTORY_PAGE_SIZE_DEFAULT);
  return params;
}

/** True when anything narrows the list beyond the default Current stock view. */
export function hasActiveFilters(query: InventoryQuery): boolean {
  return Boolean(
    query.search ||
    query.projectId ||
    query.testHoleId ||
    query.type ||
    query.locationId ||
    query.receiptId ||
    query.status !== 'current' ||
    query.receivedFrom ||
    query.receivedTo ||
    query.retention ||
    query.conflict,
  );
}

/** Same sort and page size, everything else back to Current stock. */
export function clearedInventoryQuery(query: InventoryQuery): InventoryQuery {
  return {
    ...inventoryQuerySchema.parse({}),
    sort: query.sort,
    dir: query.dir,
    pageSize: query.pageSize,
  };
}
