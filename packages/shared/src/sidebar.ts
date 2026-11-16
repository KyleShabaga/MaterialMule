import { z } from 'zod';
import { stageKeySchema } from './stage';

// STRATA-41 (with 38 and 39): the sidebar layout, saved per person on the server so it comes back
// as they left it on any computer they sign in to. STRATA-11 pins and STRATA-40 recents are
// separate per-person stores with the same identity rules.
//
// Today, Projects and Inbox are fixed at the top: never reordered, hidden or folded. The five
// sections below them can be reordered and hidden; sections and the Retention drop-down fold.
//
// Routes (personal and test accounts; the shared LAB account rules are on each schema):
//   GET /api/me/sidebar-layout            layout, normalized
//   PUT /api/me/sidebar-layout            replace it (optimistic version; stale gets 409)
//   GET /api/me/pins                      pinned records, oldest pin first
//   PUT /api/me/pins/:kind/:id            pin (idempotent)
//   DELETE /api/me/pins/:kind/:id         unpin (idempotent)
//   GET /api/me/recents                   the last 8 records opened, newest first
//   POST /api/me/recents                  record that a record page opened

/** The rows fixed at the top of the sidebar. */
export const SIDEBAR_FIXED_ITEMS = ['today', 'projects', 'inbox'] as const;
export type SidebarFixedItem = (typeof SIDEBAR_FIXED_ITEMS)[number];

/** The five sections, in their default order. */
export const SIDEBAR_SECTION_IDS = [
  'pinned',
  'recent',
  'storage_units',
  'soils',
  'concrete',
] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];
export const sidebarSectionIdSchema = z.enum(SIDEBAR_SECTION_IDS);

export const SIDEBAR_SECTION_LABELS: Record<SidebarSectionId, string> = {
  pinned: 'Pinned',
  recent: 'Recent',
  storage_units: 'Storage units',
  soils: 'Soils',
  concrete: 'Concrete',
};

/** Everything that folds: the five sections plus the Retention drop-down under Storage units. */
export const SIDEBAR_FOLD_IDS = [...SIDEBAR_SECTION_IDS, 'retention'] as const;
export type SidebarFoldId = (typeof SIDEBAR_FOLD_IDS)[number];
export const sidebarFoldIdSchema = z.enum(SIDEBAR_FOLD_IDS);

export interface SidebarLayout {
  /** Every section exactly once, in display order. */
  order: SidebarSectionId[];
  /** Sections hidden from the sidebar (their pages stay reachable from search). */
  hidden: SidebarSectionId[];
  /** Folded sections and drop-downs. */
  folded: SidebarFoldId[];
}

/** Recent and the Retention drop-down start folded; everything else starts open and shown. */
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = {
  order: [...SIDEBAR_SECTION_IDS],
  hidden: [],
  folded: ['recent', 'retention'],
};

function keepKnown<T extends string>(values: readonly unknown[], known: readonly T[]): T[] {
  const out: T[] = [];
  for (const value of values) {
    if (typeof value === 'string' && (known as readonly string[]).includes(value)) {
      if (!out.includes(value as T)) out.push(value as T);
    }
  }
  return out;
}

/**
 * Makes any stored or submitted layout valid: unknown and duplicate ids are dropped, and sections
 * missing from `order` are appended in default order, so a section added in a later release shows
 * up for everyone. Anything that isn't an array is treated as empty.
 */
export function normalizeSidebarLayout(raw: unknown): SidebarLayout {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (key: string): readonly unknown[] =>
    Array.isArray(value[key]) ? (value[key] as unknown[]) : [];
  const order = keepKnown(list('order'), SIDEBAR_SECTION_IDS);
  for (const id of SIDEBAR_SECTION_IDS) if (!order.includes(id)) order.push(id);
  const folded =
    value.folded === undefined
      ? [...DEFAULT_SIDEBAR_LAYOUT.folded]
      : keepKnown(list('folded'), SIDEBAR_FOLD_IDS);
  return { order, hidden: keepKnown(list('hidden'), SIDEBAR_SECTION_IDS), folded };
}

const sidebarLayoutFields = {
  order: z.array(sidebarSectionIdSchema),
  hidden: z.array(sidebarSectionIdSchema),
  folded: z.array(sidebarFoldIdSchema),
};

/**
 * `GET /api/me/sidebar-layout` (and the body of a successful PUT). Always normalized.
 * - `source`: `own` (the signed-in person's saved layout), `default` (nothing saved yet), or
 *   `station_person` (the shared LAB account reading the picked person's layout with
 *   `?personId=`; read-only, and never their pins or recents).
 * - `readOnly`: true for the shared LAB account, which never saves anyone's layout.
 */
export const sidebarLayoutResponseSchema = z.object({
  ...sidebarLayoutFields,
  version: z.number().int().min(0),
  source: z.enum(['own', 'default', 'station_person']),
  readOnly: z.boolean(),
});
export type SidebarLayoutResponse = z.infer<typeof sidebarLayoutResponseSchema>;

/** `GET /api/me/sidebar-layout?personId=`: LAB only; ignored (400) for personal accounts. */
export const sidebarLayoutQuerySchema = z.strictObject({
  personId: z.uuid({ error: 'must be a person ID' }).optional(),
});
export type SidebarLayoutQuery = z.output<typeof sidebarLayoutQuerySchema>;

/**
 * `PUT /api/me/sidebar-layout`. The server normalizes before saving (unknown ids are refused by
 * this schema; missing sections are appended). `version` is the one last read (0 when nothing was
 * saved); a stale version gets 409 `version_conflict` with the current layout. LAB gets 403.
 */
export const updateSidebarLayoutSchema = z.strictObject({
  order: z.array(sidebarSectionIdSchema).max(SIDEBAR_SECTION_IDS.length * 2),
  hidden: z.array(sidebarSectionIdSchema).max(SIDEBAR_SECTION_IDS.length * 2),
  folded: z.array(sidebarFoldIdSchema).max(SIDEBAR_FOLD_IDS.length * 2),
  version: z.number({ error: 'is required' }).int().min(0),
});
export type UpdateSidebarLayout = z.output<typeof updateSidebarLayoutSchema>;

/** 409 body of a stale `PUT /api/me/sidebar-layout`: the layout as it now stands. */
export const sidebarLayoutVersionConflictSchema = z.object({
  code: z.literal('version_conflict'),
  current: sidebarLayoutResponseSchema,
});
export type SidebarLayoutVersionConflict = z.infer<typeof sidebarLayoutVersionConflictSchema>;

// ---------------------------------------------------------------------------------------------
// Pins (STRATA-11) and recents (STRATA-40).

/** Records that can be pinned or show in Recent, by stable kind and ID. */
export const SIDEBAR_RECORD_KINDS = [
  'storage_unit',
  'project',
  'lab_program',
  'specimen_set',
] as const;
export type SidebarRecordKind = (typeof SIDEBAR_RECORD_KINDS)[number];
export const sidebarRecordKindSchema = z.enum(SIDEBAR_RECORD_KINDS);

/** Most pins one person keeps; pinning another past this is 409 `pin_limit`. */
export const SIDEBAR_PINS_MAX = 20;
/** Recent keeps the last 8 records opened (Kyle). */
export const SIDEBAR_RECENTS_MAX = 8;

/** Path params of `PUT|DELETE /api/me/pins/:kind/:id`, and the body of `POST /api/me/recents`. */
export const sidebarRecordRefSchema = z.strictObject({
  kind: sidebarRecordKindSchema,
  id: z.uuid({ error: 'must be a record ID' }),
});
export type SidebarRecordRef = z.output<typeof sidebarRecordRefSchema>;

/**
 * One pinned or recent row. Access is checked when the list is read: a record the person can no
 * longer open (or one that no longer exists) comes back with `available: false` and no label or
 * name, so the row can say so and offer Unpin, without leaking what it was.
 */
export const sidebarRecordSchema = z.object({
  kind: sidebarRecordKindSchema,
  id: z.string(),
  available: z.boolean(),
  /** The record's own ID in mono, e.g. BKT-2026-000014, DEMO-2601, LP-001. Null when unavailable. */
  label: z.string().nullable(),
  /** A short name: the project name, a unit's project and hole. Null when unavailable. */
  name: z.string().nullable(),
  /** Tints the row's square. Null when unavailable. */
  stage: stageKeySchema.nullable(),
  /** In-app link; opening it still checks access. Null when unavailable. */
  href: z.string().nullable(),
  /** When it was pinned, or last opened (recents). */
  at: z.string(),
});
export type SidebarRecord = z.infer<typeof sidebarRecordSchema>;

/** `GET /api/me/pins` and `GET /api/me/recents`. LAB gets 403 (no one's pins on a station). */
export const sidebarRecordListSchema = z.object({ items: z.array(sidebarRecordSchema) });
export type SidebarRecordList = z.infer<typeof sidebarRecordListSchema>;
