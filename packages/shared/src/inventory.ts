import { z } from 'zod';
import { locationConflictSummarySchema } from './moves';
import { HOLE_SUMMARY_TYPES } from './receipts';
import { bulkGroupDetailSchema, bulkMembershipSchema, sampleIdentitySchema } from './samples';
import { TESTED_REMOVAL_REASONS, storageUnitTestingSchema } from './tested-removal';

// Storage unit inventory, search and detail (MM-T12). One row per tracked storage unit; ordinary
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
      // A bucket holding a bulk soil sample (MM-T36); its BKT- ID still names the bucket.
      return 'Bulk soil sample';
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

/**
 * Dashes people paste or type for a range: hyphens (U+2010, U+2011), figure/en/em dashes and the
 * horizontal bar (U+2012–U+2015), the minus sign (U+2212) and small/full-width hyphens. The
 * inventory search document folds exactly these to "-" (storage_unit_search_document), so keep the two in step.
 */
const SEARCH_DASHES = /[‐-―−﹘﹣－]/g;

/** Search words: split on whitespace, lower-cased, duplicates dropped, at most 10. */
export function splitSearchWords(search: string | undefined): string[] {
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, INVENTORY_SEARCH_MAX_WORDS);
}

/**
 * Inventory search words (MM-T59): every dash folded to "-" first, so "G1–S10" copied from the
 * table matches like "G1-S10", and a dash standing alone between spaced words ("G1 – S10") dropped.
 */
export function splitInventorySearch(search: string | undefined): string[] {
  const folded = (search ?? '').replace(SEARCH_DASHES, '-');
  return splitSearchWords(folded.replace(/(^|\s)-+(?=\s|$)/g, ' '));
}

/**
 * Where a unit is now, as screens show it (MISC-12, owner decision 2026-10-31): a disposed unit
 * has no current location, so it reads "No location". Its last saved location stays in the
 * database and in History; only the display changes.
 */
export function currentLocationName(unit: {
  status: StorageUnitStatus;
  location: { name: string };
}): string {
  return unit.status === 'disposed' ? 'No location' : unit.location.name;
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
/**
 * MM-T29 retention filters: units under an active hold, or whose effective retain-until date has
 * been reached (date only; full disposal eligibility is MM-T30's).
 */
export const INVENTORY_RETENTION_FILTERS = [
  'on_hold',
  'eligible_by_date',
  // MM-T30: full standard eligibility (date, no hold, covering programs closed, in stock).
  'eligible_for_disposal',
] as const;
export type InventoryRetentionFilter = (typeof INVENTORY_RETENTION_FILTERS)[number];

export const INVENTORY_RETENTION_FILTER_LABEL: Record<InventoryRetentionFilter, string> = {
  on_hold: 'On hold',
  eligible_by_date: 'Eligible by date',
  eligible_for_disposal: 'Eligible for disposal',
};

/** MM-T81: units whose saved location has an open conflict (MM-T28) that a person must confirm. */
export const INVENTORY_CONFLICT_FILTERS = ['open'] as const;
export type InventoryConflictFilter = (typeof INVENTORY_CONFLICT_FILTERS)[number];

export const inventoryQuerySchema = z.object({
  search: optionalParam(z.string().trim().max(200, { error: 'must be at most 200 characters' })),
  projectId: optionalParam(z.uuid({ error: 'must be a project ID' })),
  testHoleId: optionalParam(z.uuid({ error: 'must be a test hole ID' })),
  type: optionalParam(z.enum(STORAGE_UNIT_TYPES, { error: 'is not a storage unit type' })),
  locationId: optionalParam(z.uuid({ error: 'must be a location ID' })),
  /** Units issued by one receipt (the dashboard's "received" activity links here). */
  receiptId: optionalParam(z.uuid({ error: 'must be a receipt ID' })),
  status: z.preprocess(
    blankToUndefined,
    z.enum(INVENTORY_STATUS_FILTERS, { error: 'is not a status filter' }).default('current'),
  ),
  receivedFrom: optionalParam(z.iso.date({ error: 'must be a date (YYYY-MM-DD)' })),
  receivedTo: optionalParam(z.iso.date({ error: 'must be a date (YYYY-MM-DD)' })),
  retention: optionalParam(
    z.enum(INVENTORY_RETENTION_FILTERS, { error: 'is not a retention filter' }),
  ),
  /** MM-T81: only units with an open location conflict. */
  conflict: optionalParam(
    z.enum(INVENTORY_CONFLICT_FILTERS, { error: 'is not a conflict filter' }),
  ),
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

/** `GET /api/locations`: read-only list for the location filter (management is MM-T37). */
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
  /**
   * A Shelby tube's own sampling source, sample reference and depth, or a bulk soil bucket's
   * group identity (MM-T36). Null for units summarised per test hole.
   */
  sample: sampleIdentitySchema.nullable(),
  /** "Bucket n of N" in the unit's bulk group; null unless it holds a bulk soil sample. */
  bulkGroup: bulkMembershipSchema.nullable(),
  /** Last saved location (a pending move never replaces it, MM-T28). */
  location: locationRef,
  /**
   * MM-T81: the saved location has an open conflict. Always sent by the API; optional so older
   * fixtures stay valid.
   */
  openConflict: z.boolean().optional(),
  receivedDate: z.string(),
  /**
   * MM-T36: the post-testing route that disposed this unit ("Disposed after testing"), or null.
   * Optional so older fixtures stay valid.
   */
  testedRemovalReason: z.enum(TESTED_REMOVAL_REASONS).nullable().optional(),
  /** MM-T36: a tested Shelby tube still on the shelf: its contents are disposed after testing. */
  contentsDestroyed: z.boolean().optional(),
  /** MM-T29: effective retain-until, hold and exemption (optional so older fixtures stay valid). */
  retention: z
    .object({
      effectiveRetainUntil: z.string(),
      onHold: z.boolean(),
      eligibleByDate: z.boolean(),
      retentionExempt: z.boolean(),
    })
    .optional(),
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
  /** Current received date; a correction (MM-T13) may change it, the receipt header keeps its own. */
  receivedDate: z.string(),
  /** Received date + 1 year until full retention rules arrive (MM-T29). */
  minimumRetainUntil: z.string(),
  /** Bumped by every correction; a correction must send the version it was based on. */
  version: z.number(),
  project: projectRef,
  holes: z.array(storageUnitHoleSummarySchema),
  /** As on inventory rows (MM-T36). */
  sample: sampleIdentitySchema.nullable(),
  /** The unit's bulk group with every member bucket and its own place in it (MM-T36). */
  bulkGroup: bulkGroupDetailSchema.nullable(),
  location: locationRef,
  /**
   * Open location conflict (MM-T28): the saved location needs a person to confirm it. Always sent
   * by the API; optional so older fixtures stay valid.
   */
  locationConflict: locationConflictSummarySchema.nullable().optional(),
  /**
   * MM-T36 tested-unit evidence, contents and post-testing removal. Always sent by the API;
   * optional so older fixtures stay valid.
   */
  testing: storageUnitTestingSchema.optional(),
  /** The original receipt header, as recorded at confirmation; corrections never rewrite it. */
  receipt: z.object({
    id: z.string(),
    receivedDate: z.string(),
    project: projectRef,
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
export function storageUnitHistoryActionLabel(
  action: string,
  after?: Record<string, unknown> | null,
): string {
  switch (action) {
    case 'receipt.confirmed':
      return 'Receipt confirmed';
    case 'storage_unit.created':
      return 'Storage unit created';
    case 'storage_unit.corrected':
      return 'Details corrected';
    case 'storage_unit.bulk_group_changed':
      return 'Bulk sample changed';
    case 'bulk_group.created':
      return 'Bulk sample created';
    case 'bulk_group.corrected':
      return 'Bulk sample corrected';
    case 'storage_unit.moved':
      return 'Moved';
    case 'storage_unit.location_conflict':
      return 'Location conflict';
    case 'storage_unit.location_conflict_resolved':
      return 'Location confirmed';
    case 'disposal.removed':
      // MM-T30's standard scan records route 'standard'; MM-T36's post-testing route doesn't.
      return after?.route === 'standard' ? 'Disposed' : 'Disposed after testing';
    case 'disposal.approved':
      return 'Approved for disposal';
    case 'disposal.approval_revoked':
      return 'Disposal approval revoked';
    case 'disposal.approval_used':
      return 'Disposal approval used';
    case 'disposal.blocked':
      return 'Disposal scan refused';
    // MTR-59: holds and extensions covering the unit (its own or its project's).
    case 'retention.hold_placed':
      return after?.scope === 'project' ? 'Project-wide hold placed' : 'Hold placed';
    case 'retention.hold_released':
      return 'Hold released';
    case 'retention.extended': {
      const what =
        after?.scope === 'project' ? 'Project-wide retention extended' : 'Retention extended';
      if (typeof after?.retainUntil === 'string') return `${what} to ${after.retainUntil}`;
      if (typeof after?.extendMonths === 'number') return `${what} by ${after.extendMonths} months`;
      return what;
    }
    case 'retention.extension_released':
      return 'Retention extension released';
    default:
      return labHistoryLabel(action, after) ?? action;
  }
}

const LAB_PROGRAM_ACTIONS: Record<string, string> = {
  created: 'created',
  submitted: 'submitted',
  amended: 'amended',
  priority_changed: 'priority changed',
  closure_requested: 'closure requested',
  closed: 'closed',
  reopened: 'reopened',
  discarded: 'discarded',
};

const TEST_REQUEST_ACTIONS: Record<string, string> = {
  created: 'requested',
  status_changed: 'status changed',
  cancellation_requested: 'cancellation requested',
  cancelled: 'cancelled',
  repeat_created: 'repeat requested',
  identity_changed: 'changed by amendment',
};

/** MTR-59: lab program and test request events for programs covering the unit. */
function labHistoryLabel(action: string, after?: Record<string, unknown> | null): string | null {
  const [entity, verb = ''] = action.split('.');
  const program = typeof after?.programNumber === 'string' ? ` ${after.programNumber}` : '';
  if (entity === 'lab_program' && verb in LAB_PROGRAM_ACTIONS) {
    return `Lab program${program} ${LAB_PROGRAM_ACTIONS[verb]}`;
  }
  if (entity === 'test_request' && verb in TEST_REQUEST_ACTIONS) {
    const code = typeof after?.code === 'string' ? ` ${after.code}` : '';
    const where = program ? ` (${program.trim()})` : '';
    return `Test${code}${where} ${TEST_REQUEST_ACTIONS[verb]}`;
  }
  return null;
}
