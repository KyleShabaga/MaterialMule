import { z } from 'zod';
import {
  STORAGE_UNIT_STATUSES,
  STORAGE_UNIT_TYPES,
  normalizeStorageUnitCode,
  splitSearchWords,
  storageUnitHistoryEventSchema,
  storageUnitHoleSummarySchema,
} from './inventory';
import { bulkMembershipSchema, sampleIdentitySchema } from './samples';

// Receiving Log (MM-T51): confirmed receipts, one row per receipt, and a receipt's detail with
// every storage unit it created. Read-only. Local drafts never appear here (they stay on the
// computer that holds them, MM-T11).

export const RECEIPT_LOG_PAGE_SIZE_DEFAULT = 25;
export const RECEIPT_LOG_PAGE_SIZE_MAX = 100;
export const RECEIPT_LOG_SEARCH_MAX_LENGTH = 200;

/**
 * Search words for the receipt list: lower case, unique, at most 10. Dashes stay as typed: the
 * columns it matches (project number and name, receiver) are not dash-folded like the inventory's
 * search document (MM-T59).
 */
export const splitReceiptLogSearch = splitSearchWords;

/** The search as a storage unit ID, compared exactly (trimmed, upper case). */
export const receiptLogUnitCode = (search: string | undefined) =>
  normalizeStorageUnitCode(search ?? '');

/** Query-string values: a missing or blank parameter means "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalParam = <S extends z.ZodType>(schema: S) =>
  z.preprocess(blankToUndefined, schema.optional());

const dateParam = optionalParam(z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }));

/**
 * A receipt's status (STRATA-78): `confirmed` as received, or `corrected` once any of its storage
 * units has had a correction (MM-T13). Both share the storage stage; the receipt header itself
 * never changes.
 */
export const RECEIPT_LOG_STATUSES = ['confirmed', 'corrected'] as const;
export type ReceiptLogStatus = (typeof RECEIPT_LOG_STATUSES)[number];
export const RECEIPT_LOG_STATUS_LABELS: Record<ReceiptLogStatus, string> = {
  confirmed: 'Confirmed',
  corrected: 'Corrected',
};

/**
 * Sort keys (STRATA-78, table tools): `received` (received date, then confirmation time),
 * `project` (project number) and `units` (storage unit count). No key is the default: newest
 * confirmation first.
 */
export const RECEIPT_LOG_SORT_KEYS = ['received', 'project', 'units'] as const;
export type ReceiptLogSortKey = (typeof RECEIPT_LOG_SORT_KEYS)[number];

/** How many storage unit IDs a log row names (the rest are counted: "+3"). */
export const RECEIPT_LOG_UNIT_ID_LIMIT = 3;

/**
 * `GET /api/receipts` query. The web app parses its URL with the same schema, so a shared link
 * shows exactly what the server returns. Dates are inclusive and apply to the original receipt
 * header's received date; the project filter applies to the receipt's own project.
 */
export const receiptLogQuerySchema = z
  .object({
    /** Project number or name, received-by name or initials, or an exact storage unit ID. */
    search: optionalParam(
      z
        .string()
        .trim()
        .max(RECEIPT_LOG_SEARCH_MAX_LENGTH, {
          error: `must be at most ${RECEIPT_LOG_SEARCH_MAX_LENGTH} characters`,
        }),
    ),
    projectId: optionalParam(z.uuid({ error: 'must be a project ID' })),
    /** The receiver's stable user ID; initials are never a filter key (two people can share them). */
    receiverUserId: optionalParam(z.uuid({ error: 'must be a staff member ID' })),
    receivedFrom: dateParam,
    receivedTo: dateParam,
    /** One status; both or neither means every receipt. */
    status: optionalParam(
      z.enum(RECEIPT_LOG_STATUSES, { error: 'must be confirmed or corrected' }),
    ),
    sort: optionalParam(
      z.enum(RECEIPT_LOG_SORT_KEYS, { error: 'must be received, project or units' }),
    ),
    dir: optionalParam(z.enum(['asc', 'desc'], { error: 'must be asc or desc' })),
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
        .max(RECEIPT_LOG_PAGE_SIZE_MAX, { error: `must be at most ${RECEIPT_LOG_PAGE_SIZE_MAX}` })
        .default(RECEIPT_LOG_PAGE_SIZE_DEFAULT),
    ),
  })
  .superRefine((query, ctx) => {
    if (query.receivedFrom && query.receivedTo && query.receivedTo < query.receivedFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['receivedTo'],
        message: 'must be on or after the "received from" date',
        params: { code: 'date_range_reversed' },
      });
    }
  });

export type ReceiptLogQuery = z.output<typeof receiptLogQuerySchema>;

const projectRef = z.object({
  id: z.string(),
  projectNumber: z.string(),
  name: z.string(),
  client: z.string(),
});

/** Who received it, from the receipt's snapshots; `userId` is the stable filter key. */
const receiverRef = z.object({
  userId: z.string(),
  initials: z.string(),
  name: z.string(),
});

/** The signed-in account that confirmed the receipt, e.g. the shared LAB station. */
const accountRef = z.object({
  initials: z.string().nullable(),
  name: z.string(),
  sharedStation: z.boolean(),
});

export const receiptLogItemSchema = z.object({
  id: z.string(),
  /** Original received date on the receipt header (YYYY-MM-DD); unit corrections never change it. */
  receivedDate: z.string(),
  /** The receipt's original project. Number and name are the project's current values. */
  project: projectRef,
  receiver: receiverRef,
  account: accountRef,
  /** Physical storage units in the receipt (D41). */
  quantity: z.number(),
  confirmedAt: z.string(),
  /** Optional so an older server's rows still parse; this server always sends them. */
  status: z.enum(RECEIPT_LOG_STATUSES).optional(),
  /** The first storage unit IDs in ID order (at most RECEIPT_LOG_UNIT_ID_LIMIT). */
  unitIds: z.array(z.string()).optional(),
});
export type ReceiptLogItem = z.infer<typeof receiptLogItemSchema>;

/** `GET /api/receipts` response: newest confirmation first, receipt ID breaking ties. */
export const receiptLogPageSchema = z.object({
  items: z.array(receiptLogItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ReceiptLogPage = z.infer<typeof receiptLogPageSchema>;

export const receiptUnitSchema = z.object({
  id: z.string(),
  readableId: z.string(),
  unitType: z.enum(STORAGE_UNIT_TYPES),
  status: z.enum(STORAGE_UNIT_STATUSES),
  /** Current values: a correction (MM-T13) may differ from the receipt header. */
  receivedDate: z.string(),
  project: projectRef,
  holes: z.array(storageUnitHoleSummarySchema),
  /** Shelby tube source or bulk sample identity, as on inventory rows (MM-T36). */
  sample: sampleIdentitySchema.nullable(),
  bulkGroup: bulkMembershipSchema.nullable(),
  /** Last saved location. */
  location: z.object({ id: z.string(), code: z.string(), name: z.string() }),
});
export type ReceiptUnit = z.infer<typeof receiptUnitSchema>;

/** `GET /api/receipts/:receiptId` response. 404 `receipt_not_found` for an unknown ID. */
export const receiptDetailSchema = receiptLogItemSchema.extend({
  description: z.string().nullable(),
  /** Every storage unit the receipt created, disposed and corrected ones included. */
  units: z.array(receiptUnitSchema),
  /** The newest correction of any of its units, or null. Optional for older servers. */
  lastCorrection: z.object({ at: z.string(), by: z.string().nullable() }).nullable().optional(),
});
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;

export const RECEIPT_HISTORY_PAGE_SIZE = 20;

/** `GET /api/receipts/:receiptId/history?page=` query. */
export const receiptHistoryQuerySchema = z.object({
  page: z.preprocess(
    blankToUndefined,
    z.coerce.number({ error: 'must be a number' }).int().min(1).max(100_000).default(1),
  ),
});

/** One event about the receipt or one of its units; `readableId` names the unit, if any. */
export const receiptHistoryEventSchema = storageUnitHistoryEventSchema.extend({
  readableId: z.string().nullable(),
});
export type ReceiptHistoryEvent = z.infer<typeof receiptHistoryEventSchema>;

/**
 * `GET /api/receipts/:receiptId/history?page=`: corrections first-class with everything else that
 * happened to the receipt and its units, newest first, 20 per page.
 */
export const receiptHistoryPageSchema = z.object({
  items: z.array(receiptHistoryEventSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ReceiptHistoryPage = z.infer<typeof receiptHistoryPageSchema>;

/** `GET /api/receipts/:receiptId` path parameter. */
export const receiptIdParamSchema = z.object({
  receiptId: z.uuid({ error: 'must be a receipt ID' }),
});

export const RECEIPT_LOG_RECEIVER_LIMIT = 20;

/**
 * `GET /api/receipts/receivers?search=` or `?id=`: people who have received at least one
 * receipt, for the Received by filter. Unlike the receiving selector it includes people who were
 * later disabled or renamed, so their receipts stay findable. Same option shape as
 * `GET /api/staff/receivers`.
 */
export const receiptReceiverQuerySchema = z.object({
  search: optionalParam(z.string().trim().max(100, { error: 'must be at most 100 characters' })),
  id: optionalParam(z.uuid({ error: 'must be a staff member ID' })),
});
export type ReceiptReceiverQuery = z.output<typeof receiptReceiverQuerySchema>;
