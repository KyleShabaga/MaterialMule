import { z } from 'zod';
import {
  INVENTORY_SORTS,
  inventoryItemSchema,
  inventoryPageSchema,
  inventoryQuerySchema,
} from './inventory';
import type { StorageUnitRecordStatus } from './stage';

// Inventory list with stage tabs (STRATA-79). `GET /api/inventory` takes the MM-T12 query plus a
// stage tab, more heading sorts and an opt-in `counts=1` that returns every tab's count under the
// same search and filters. Tabs, counts, filters, sort and paging all run on the server.

/**
 * The stage tabs in lifecycle order (Kyle 2026-11-12): All, In lab, Short-term, Long-term,
 * Retention due, Disposed, Conflicts. All includes disposed units.
 */
export const INVENTORY_STAGE_TABS = [
  'all',
  'in_lab',
  'short_term',
  'long_term',
  'retention_due',
  'disposed',
  'conflicts',
] as const;
export type InventoryStageTab = (typeof INVENTORY_STAGE_TABS)[number];

export const INVENTORY_STAGE_TAB_LABELS: Record<InventoryStageTab, string> = {
  all: 'All',
  in_lab: 'In lab',
  short_term: 'Short-term',
  long_term: 'Long-term',
  retention_due: 'Retention due',
  disposed: 'Disposed',
  conflicts: 'Conflicts',
};

/**
 * The record statuses each tab shows (STRATA-58's one rule decides a unit's status). Retention
 * due also holds overdue units. A unit that is confirmed but not put away yet ('received') shows
 * under All only. `all` is every unit, disposed included.
 */
export const INVENTORY_STAGE_TAB_STATUSES: Record<
  Exclude<InventoryStageTab, 'all'>,
  readonly StorageUnitRecordStatus[]
> = {
  in_lab: ['in_lab'],
  short_term: ['short_term'],
  long_term: ['long_term'],
  retention_due: ['retention_due', 'retention_overdue'],
  disposed: ['disposed'],
  conflicts: ['location_conflict'],
};

/** Heading sorts beyond MM-T12's: project number, type, where (location code) and stage. */
export const INVENTORY_LIST_SORTS = [
  ...INVENTORY_SORTS,
  'project',
  'type',
  'where',
  'stage',
] as const;
export type InventoryListSort = (typeof INVENTORY_LIST_SORTS)[number];

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * `GET /api/inventory` query (STRATA-79): MM-T12's parameters plus
 * - `stage`: a stage tab. When `stage` or `counts` is sent, the tab decides which units show and
 *   the older `status` parameter is ignored (the tabs replace it);
 * - `counts=1`: also return `stageCounts`, every tab's count under the same search and filters;
 * - `sort`: also project, type, where and stage.
 */
export const inventoryListQuerySchema = inventoryQuerySchema.extend({
  stage: z.preprocess(
    blankToUndefined,
    z.enum(INVENTORY_STAGE_TABS, { error: 'is not a stage tab' }).optional(),
  ),
  counts: z.preprocess(
    blankToUndefined,
    z
      .enum(['1', 'true'], { error: 'must be 1' })
      .transform(() => true)
      .optional(),
  ),
  sort: z.preprocess(
    blankToUndefined,
    z
      .enum(INVENTORY_LIST_SORTS, {
        error: 'must be received, id, retain_until, project, type, where or stage',
      })
      .default('received'),
  ),
});
export type InventoryListQuery = z.output<typeof inventoryListQuerySchema>;

/** True when the stage tabs decide the units (and `status` is ignored). */
export function inventoryUsesStageTabs(query: Pick<InventoryListQuery, 'stage' | 'counts'>) {
  return query.stage !== undefined || query.counts === true;
}

/** Newest first for received date; A–Z (or earliest, or lifecycle order) for the rest. */
export function inventoryListSortDirection(query: Pick<InventoryListQuery, 'sort' | 'dir'>) {
  return query.dir ?? (query.sort === 'received' ? 'desc' : 'asc');
}

export const inventoryStageCountsSchema = z.object({
  all: z.number(),
  in_lab: z.number(),
  short_term: z.number(),
  long_term: z.number(),
  retention_due: z.number(),
  disposed: z.number(),
  conflicts: z.number(),
}) satisfies z.ZodType<Record<InventoryStageTab, number>>;
export type InventoryStageCounts = z.infer<typeof inventoryStageCountsSchema>;

export const inventoryListItemSchema = inventoryItemSchema.extend({
  /**
   * The saved location's names from the top (warehouse › bay › shelf), e.g. ["Warehouse A",
   * "Bay 2", "Shelf 3"]. Optional so older fixtures stay valid; the API always sends it.
   */
  locationPath: z.array(z.string()).optional(),
});
export type InventoryListItem = z.infer<typeof inventoryListItemSchema>;

/** `GET /api/inventory` response; `stageCounts` only when `counts=1` was sent. */
export const inventoryListPageSchema = inventoryPageSchema.extend({
  items: z.array(inventoryListItemSchema),
  stageCounts: inventoryStageCountsSchema.optional(),
});
export type InventoryListPage = z.infer<typeof inventoryListPageSchema>;
