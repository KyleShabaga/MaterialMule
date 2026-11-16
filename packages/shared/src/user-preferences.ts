import { z } from 'zod';
import { DEFAULT_DATE_FORMAT, LAB_TIME_ZONE } from './date-format';

// STRATA-29: Settings › Preferences, saved per person on the server (one store, one version),
// shared with the Settings modal (STRATA-101). STRATA-51: optional table columns per person per
// table live beside it. Device settings (printer, station) stay separate and are not here.
//
// The badge rule (STRATA-55, Settings › Notifications) is part of this store: requests always
// count; updates count unless the person mutes them. `/api/me/notification-preferences` keeps the
// email switch it already has (email sending stays off pending IT, D39).
//
// Routes (personal and test accounts; LAB reads defaults read-only and never saves):
//   GET   /api/me/preferences
//   PATCH /api/me/preferences             changed fields only, with the version last read
//   GET   /api/me/table-columns
//   PUT   /api/me/table-columns/:tableId  hidden optional columns, with the version last read

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Settings › Table rows: Comfortable or Compact (36 px). The Inbox "Table" view is its own. */
export const TABLE_DENSITIES = ['comfortable', 'compact'] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];

export const INBOX_VIEWS = ['stream', 'grouped', 'table'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

/** After confirming a receipt: show the done page, or go straight to Put away. */
export const AFTER_RECEIPT_CHOICES = ['done_page', 'put_away'] as const;
export type AfterReceiptChoice = (typeof AFTER_RECEIPT_CHOICES)[number];

export const DATE_FORMATS = ['iso', 'medium'] as const;

const preferenceFields = {
  theme: z.enum(THEME_CHOICES),
  tableDensity: z.enum(TABLE_DENSITIES),
  inboxView: z.enum(INBOX_VIEWS),
  /** Privacy: show my Inbox on shared LAB computers. Off by default (it's a choice to share). */
  shareInboxOnStations: z.boolean(),
  afterReceipt: z.enum(AFTER_RECEIPT_CHOICES),
  dateFormat: z.enum(DATE_FORMATS),
  weekStartsMonday: z.boolean(),
  /** Scanning: open a scanned label's record. */
  openScannedRecord: z.boolean(),
  sidebarStartCollapsed: z.boolean(),
  /** Notifications: updates raise the bell and sidebar badge. Requests always do. */
  badgeUpdates: z.boolean(),
};

export const userPreferencesSchema = z.object(preferenceFields);
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: 'system',
  tableDensity: 'comfortable',
  inboxView: 'stream',
  shareInboxOnStations: false,
  afterReceipt: 'done_page',
  dateFormat: DEFAULT_DATE_FORMAT,
  weekStartsMonday: false,
  openScannedRecord: true,
  sidebarStartCollapsed: false,
  badgeUpdates: true,
};

/**
 * A stored row may predate a field or hold a value a later release dropped: each field falls back
 * to its default on its own, so one bad field never resets the others.
 */
export function normalizeUserPreferences(raw: unknown): UserPreferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_USER_PREFERENCES } as Record<string, unknown>;
  for (const [key, schema] of Object.entries(preferenceFields)) {
    const parsed = (schema as z.ZodType).safeParse(value[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as UserPreferences;
}

/**
 * `GET /api/me/preferences` (and the body of a successful PATCH).
 * - `labTimeZone` is read-only: America/Edmonton for everyone.
 * - `readOnly`: the shared LAB account sees defaults and never saves (a station's picked person
 *   changes their preferences from their own computer).
 */
export const userPreferencesResponseSchema = z.object({
  preferences: userPreferencesSchema,
  version: z.number().int().min(0),
  labTimeZone: z.literal(LAB_TIME_ZONE),
  readOnly: z.boolean(),
});
export type UserPreferencesResponse = z.infer<typeof userPreferencesResponseSchema>;

/**
 * `PATCH /api/me/preferences`: the fields that changed, plus the version last read (0 when never
 * saved). A stale version gets 409 `version_conflict` with the current preferences, so the screen
 * can roll back. At least one field is required. LAB gets 403.
 */
export const updateUserPreferencesSchema = z
  .strictObject({
    ...Object.fromEntries(
      Object.entries(preferenceFields).map(([key, schema]) => [key, schema.optional()]),
    ),
    version: z.number({ error: 'is required' }).int().min(0),
  } as { [K in keyof typeof preferenceFields]: z.ZodOptional<(typeof preferenceFields)[K]> } & {
    version: z.ZodNumber;
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    error: 'Change at least one preference',
  });
export type UpdateUserPreferences = z.output<typeof updateUserPreferencesSchema>;

/** 409 body of a stale `PATCH /api/me/preferences`: the preferences as they now stand. */
export const userPreferencesVersionConflictSchema = z.object({
  code: z.literal('version_conflict'),
  current: userPreferencesResponseSchema,
});
export type UserPreferencesVersionConflict = z.infer<typeof userPreferencesVersionConflictSchema>;

// ---------------------------------------------------------------------------------------------
// STRATA-51: table columns per person per table.

export interface TableColumnDefinition {
  /** Stable ID; never renamed once shipped. */
  id: string;
  label: string;
  /** Required columns are always shown (checked, disabled, "Always shown"). */
  required: boolean;
  /** Shown before the person changes anything. */
  defaultVisible: boolean;
  /**
   * Responsive priority (STRATA-64): lower stays longer as the table narrows. Responsive hiding is
   * temporary and never rewrites the saved choice.
   */
  priority: number;
}

/**
 * The column registry. New tables are added here by the lane that builds them; a table missing
 * here can't save columns (400 `unknown_table`).
 */
export const TABLE_COLUMN_REGISTRY = {
  inbox: [
    { id: 'task', label: 'Task', required: true, defaultVisible: true, priority: 1 },
    { id: 'title', label: 'Title', required: true, defaultVisible: true, priority: 0 },
    { id: 'job_number', label: 'Job number', required: true, defaultVisible: true, priority: 2 },
    { id: 'record', label: 'Record', required: false, defaultVisible: true, priority: 3 },
    { id: 'from', label: 'From', required: false, defaultVisible: true, priority: 4 },
    { id: 'received', label: 'Received', required: false, defaultVisible: true, priority: 5 },
  ],
  inventory: [
    { id: 'id', label: 'Storage unit', required: true, defaultVisible: true, priority: 0 },
    { id: 'project', label: 'Project', required: true, defaultVisible: true, priority: 1 },
    { id: 'stage', label: 'Stage', required: true, defaultVisible: true, priority: 2 },
    { id: 'type', label: 'Type', required: false, defaultVisible: true, priority: 5 },
    { id: 'holes', label: 'Test holes', required: false, defaultVisible: true, priority: 4 },
    { id: 'location', label: 'Location', required: false, defaultVisible: true, priority: 3 },
    { id: 'received', label: 'Received', required: false, defaultVisible: true, priority: 6 },
    {
      id: 'retain_until',
      label: 'Retain until',
      required: false,
      defaultVisible: false,
      priority: 7,
    },
  ],
} as const satisfies Record<string, readonly TableColumnDefinition[]>;

export type TableId = keyof typeof TABLE_COLUMN_REGISTRY;
export const TABLE_IDS = Object.keys(TABLE_COLUMN_REGISTRY) as TableId[];
export const tableIdSchema = z.enum(TABLE_IDS as [TableId, ...TableId[]]);

/** Optional columns of a table (the only ones a person can hide). */
export function optionalColumnIds(tableId: TableId): string[] {
  return TABLE_COLUMN_REGISTRY[tableId].filter((c) => !c.required).map((c) => c.id);
}

/**
 * The hidden optional columns to use: unknown ids and required columns are dropped; with nothing
 * saved, the registry's default-hidden columns.
 */
export function normalizeHiddenColumns(tableId: TableId, saved: unknown): string[] {
  const optional = optionalColumnIds(tableId);
  if (!Array.isArray(saved)) {
    return TABLE_COLUMN_REGISTRY[tableId].filter((c) => !c.defaultVisible).map((c) => c.id);
  }
  const out: string[] = [];
  for (const id of saved) {
    if (typeof id === 'string' && optional.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** `GET /api/me/table-columns`: every registered table, normalized. LAB gets defaults, read-only. */
export const tableColumnsResponseSchema = z.object({
  tables: z.record(z.string(), z.object({ hidden: z.array(z.string()) })),
  version: z.number().int().min(0),
  readOnly: z.boolean(),
});
export type TableColumnsResponse = z.infer<typeof tableColumnsResponseSchema>;

/**
 * `PUT /api/me/table-columns/:tableId`: hide these optional columns (an empty list shows them
 * all). Required or unknown column ids are 400 `invalid_column`. One version covers all tables;
 * a stale one gets 409 `version_conflict`. LAB gets 403.
 */
export const updateTableColumnsSchema = z.strictObject({
  hidden: z.array(z.string().min(1).max(64)).max(50),
  version: z.number({ error: 'is required' }).int().min(0),
});
export type UpdateTableColumns = z.output<typeof updateTableColumnsSchema>;

/** 409 body of a stale `PUT /api/me/table-columns/:tableId`: every table as it now stands. */
export const tableColumnsVersionConflictSchema = z.object({
  code: z.literal('version_conflict'),
  current: tableColumnsResponseSchema,
});
export type TableColumnsVersionConflict = z.infer<typeof tableColumnsVersionConflictSchema>;
