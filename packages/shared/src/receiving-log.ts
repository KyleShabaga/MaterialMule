import { z } from 'zod';
import {
  STORAGE_UNIT_STATUSES,
  STORAGE_UNIT_TYPES,
  normalizeStorageUnitCode,
  splitInventorySearch,
  storageUnitHoleSummarySchema,
} from './inventory';

// Receiving Log (MM-T51): confirmed receipts, one row per receipt, and a receipt's detail with
// every storage unit it created. Read-only. Local drafts never appear here (they stay on the
// computer that holds them, MM-T11).

export const RECEIPT_LOG_PAGE_SIZE_DEFAULT = 25;
export const RECEIPT_LOG_PAGE_SIZE_MAX = 100;
export const RECEIPT_LOG_SEARCH_MAX_LENGTH = 200;

/** Search words for the receipt list: the inventory's rules (lower case, unique, at most 10). */
export const splitReceiptLogSearch = splitInventorySearch;

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
  /** Last saved location. */
  location: z.object({ id: z.string(), code: z.string(), name: z.string() }),
});
export type ReceiptUnit = z.infer<typeof receiptUnitSchema>;

/** `GET /api/receipts/:receiptId` response. 404 `receipt_not_found` for an unknown ID. */
export const receiptDetailSchema = receiptLogItemSchema.extend({
  description: z.string().nullable(),
  /** Every storage unit the receipt created, disposed and corrected ones included. */
  units: z.array(receiptUnitSchema),
});
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;

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
