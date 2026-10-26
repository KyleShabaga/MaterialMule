import { z } from 'zod';
import { HOLE_SUMMARY_TYPES } from './receipts';

// Storage unit inventory, search and detail (TRP-T12). One row per tracked storage unit; ordinary
// samples are never inventory rows. Filtering, sorting and paging all happen on the server.

export const STORAGE_UNIT_TYPES = ['bucket', 'shelby_tube', 'bulk_container'] as const;
export type StorageUnitType = (typeof STORAGE_UNIT_TYPES)[number];

export const STORAGE_UNIT_STATUSES = ['in_stock', 'approved_for_disposal', 'disposed'] as const;
export type StorageUnitStatus = (typeof STORAGE_UNIT_STATUSES)[number];

/** `current` (the default "Current stock" view) excludes disposed units; `all` includes them. */
export const INVENTORY_STATUS_FILTERS = ['current', 'all', ...STORAGE_UNIT_STATUSES] as const;
export type InventoryStatusFilter = (typeof INVENTORY_STATUS_FILTERS)[number];

export const INVENTORY_SORTS = ['received', 'id'] as const;
export type InventorySort = (typeof INVENTORY_SORTS)[number];
export const INVENTORY_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type InventorySortDirection = (typeof INVENTORY_SORT_DIRECTIONS)[number];

export const INVENTORY_PAGE_SIZE_DEFAULT = 25;
export const INVENTORY_PAGE_SIZE_MAX = 100;
/** Extra words beyond this are ignored, which keeps the query bounded. */
export const INVENTORY_SEARCH_MAX_WORDS = 10;
export const STORAGE_UNIT_HISTORY_PAGE_SIZE = 20;

export function storageUnitTypeLabel(type: StorageUnitType): string {
  switch (type) {
    case 'bucket':
      return 'Bucket';
    case 'shelby_tube':
      return 'Shelby tube';
    case 'bulk_container':
      return 'Bulk container';
  }
}

export function storageUnitStatusLabel(status: StorageUnitStatus): string {
  switch (status) {
    case 'in_stock':
      return 'In stock';
    case 'approved_for_disposal':
      return 'Approved for disposal';
    case 'disposed':
      return 'Disposed';
  }
}

export function inventoryStatusFilterLabel(filter: InventoryStatusFilter): string {
  switch (filter) {
    case 'current':
      return 'Current stock';
    case 'all':
      return 'All statuses';
    default:
      return storageUnitStatusLabel(filter);
  }
}

/** Search words: split on whitespace, lower-cased, duplicates dropped, at most 10. */
export function splitInventorySearch(search: string | undefined): string[] {
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, INVENTORY_SEARCH_MAX_WORDS);
}

/** What a typed or scanned storage unit ID is compared as: trimmed and upper case. */
export function normalizeStorageUnitCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Query-string values: a missing or blank parameter means "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalParam = <S extends z.ZodType>(schema: S) =>
  z.preprocess(blankToUndefined, schema.optional());

/**
 * `GET /api/inventory` query. The web app parses its URL with the same schema, so a shared link
 * shows exactly what the server returns.
 */
export const inventoryQuerySchema = z.object({
  search: optionalParam(z.string().trim().max(200, { error: 'must be at most 200 characters' })),
  projectId: optionalParam(z.uuid({ error: 'must be a project ID' })),
  testHoleId: optionalParam(z.uuid({ error: 'must be a test hole ID' })),
  type: optionalParam(z.enum(STORAGE_UNIT_TYPES, { error: 'is not a storage unit type' })),
  locationId: optionalParam(z.uuid({ error: 'must be a location ID' })),
  status: z.preprocess(
    blankToUndefined,
    z.enum(INVENTORY_STATUS_FILTERS, { error: 'is not a status filter' }).default('current'),
  ),
  receivedFrom: optionalParam(z.iso.date({ error: 'must be a date (YYYY-MM-DD)' })),
  receivedTo: optionalParam(z.iso.date({ error: 'must be a date (YYYY-MM-DD)' })),
  sort: z.preprocess(
    blankToUndefined,
    z.enum(INVENTORY_SORTS, { error: 'must be received or id' }).default('received'),
  ),
  /** Defaults to newest first for received date and A–Z for storage unit ID. */
  dir: optionalParam(z.enum(INVENTORY_SORT_DIRECTIONS, { error: 'must be asc or desc' })),
  page: z.preprocess(
    blankToUndefined,
    z.coerce.number({ error: 'must be a number' }).int().min(1).max(100_000).default(1),
  ),
  pageSize: z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: 'must be a number' })
      .int()
      .min(1)
      .max(INVENTORY_PAGE_SIZE_MAX, { error: `must be at most ${INVENTORY_PAGE_SIZE_MAX}` })
      .default(INVENTORY_PAGE_SIZE_DEFAULT),
  ),
});

export type InventoryQuery = z.output<typeof inventoryQuerySchema>;

export function inventorySortDirection(query: Pick<InventoryQuery, 'sort' | 'dir'>) {
  return query.dir ?? (query.sort === 'received' ? 'desc' : 'asc');
}

export const storageUnitHoleSummarySchema = z.object({
  testHoleId: z.string(),
  testHoleName: z.string(),
  type: z.enum(HOLE_SUMMARY_TYPES),
  sampleFrom: z.string().nullable(),
  sampleTo: z.string().nullable(),
  depthFrom: z.number().nullable(),
  depthTo: z.number().nullable(),
  depthUnit: z.enum(['ft', 'm']).nullable(),
  customText: z.string().nullable(),
  note: z.string().nullable(),
});
export type StorageUnitHoleSummary = z.infer<typeof storageUnitHoleSummarySchema>;

/** The SAMPLE#/DEPTH summary as people read it: "ALL", "G1–S12", "0–1.5 ft" or the Custom text. */
export function formatStorageUnitHoleSummary(
  summary: Pick<
    StorageUnitHoleSummary,
    'type' | 'sampleFrom' | 'sampleTo' | 'depthFrom' | 'depthTo' | 'depthUnit' | 'customText'
  >,
): string {
  switch (summary.type) {
    case 'all':
      return 'ALL';
    case 'sample_range':
      return `${summary.sampleFrom ?? ''}–${summary.sampleTo ?? ''}`;
    case 'depth_range':
      return `${summary.depthFrom ?? ''}–${summary.depthTo ?? ''} ${summary.depthUnit ?? ''}`.trim();
    case 'custom':
      return summary.customText ?? '';
  }
}

export const inventoryLocationSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type InventoryLocation = z.infer<typeof inventoryLocationSchema>;

/** `GET /api/locations`: read-only list for the location filter (management is TRP-T37). */
export const inventoryLocationListSchema = z.array(inventoryLocationSchema);

const projectRef = z.object({
  id: z.string(),
  projectNumber: z.string(),
  name: z.string(),
  client: z.string(),
});

const locationRef = z.object({ id: z.string(), code: z.string(), name: z.string() });

export const inventoryItemSchema = z.object({
  id: z.string(),
  /** Exactly as stored, e.g. BKT-2026-000014. */
  readableId: z.string(),
  unitType: z.enum(STORAGE_UNIT_TYPES),
  status: z.enum(STORAGE_UNIT_STATUSES),
  project: projectRef,
  holes: z.array(storageUnitHoleSummarySchema),
  /** Last saved location (a pending move never replaces it, TRP-T28). */
  location: locationRef,
  receivedDate: z.string(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/** `GET /api/inventory` response. */
export const inventoryPageSchema = z.object({
  items: z.array(inventoryItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type InventoryPage = z.infer<typeof inventoryPageSchema>;

/** `GET /api/storage-units/lookup?code=` response. 404 `storage_unit_not_found` otherwise. */
export const storageUnitLookupResponseSchema = z.object({
  id: z.string(),
  readableId: z.string(),
});
export type StorageUnitLookupResponse = z.infer<typeof storageUnitLookupResponseSchema>;

const personRef = z.object({ initials: z.string().nullable(), name: z.string() });

/** `GET /api/storage-units/:suNumber` response. */
export const storageUnitDetailSchema = z.object({
  id: z.string(),
  readableId: z.string(),
  unitType: z.enum(STORAGE_UNIT_TYPES),
  status: z.enum(STORAGE_UNIT_STATUSES),
  note: z.string().nullable(),
  receivedDate: z.string(),
  project: projectRef,
  holes: z.array(storageUnitHoleSummarySchema),
  location: locationRef,
  receipt: z.object({
    id: z.string(),
    receivedDate: z.string(),
    /** Snapshots taken at confirmation; renaming the person later never changes them. */
    receiver: personRef,
    /** The signed-in account that confirmed the receipt (e.g. LAB). */
    account: personRef,
    description: z.string().nullable(),
    quantity: z.number(),
    confirmedAt: z.string(),
  }),
});
export type StorageUnitDetail = z.infer<typeof storageUnitDetailSchema>;

export const storageUnitHistoryEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  actor: z.object({
    initials: z.string().nullable(),
    name: z.string().nullable(),
    accountType: z.string().nullable(),
  }),
  receiver: personRef.nullable(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type StorageUnitHistoryEvent = z.infer<typeof storageUnitHistoryEventSchema>;

/** `GET /api/storage-units/:id/history?page=`: newest first, 20 per page. */
export const storageUnitHistoryPageSchema = z.object({
  items: z.array(storageUnitHistoryEventSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type StorageUnitHistoryPage = z.infer<typeof storageUnitHistoryPageSchema>;

/** Plain-language name of a storage unit history event. */
export function storageUnitHistoryActionLabel(action: string): string {
  switch (action) {
    case 'receipt.confirmed':
      return 'Receipt confirmed';
    case 'storage_unit.created':
      return 'Storage unit created';
    default:
      return action;
  }
}
