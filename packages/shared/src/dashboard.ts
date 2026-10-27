import { z } from 'zod';
import { inventoryItemSchema } from './inventory';
import { PRINT_JOB_STATUSES, type PrintJob } from './printing';

// Dashboard "Recently received" (approved design, 2026-10-27): the newest storage units with
// when and by whom they were received and their latest label print status.

export const RECENTLY_RECEIVED_SHOWS = ['all', 'today', 'labels'] as const;
export type RecentlyReceivedShow = (typeof RECENTLY_RECEIVED_SHOWS)[number];

export const RECENTLY_RECEIVED_LIMIT_DEFAULT = 6;
export const RECENTLY_RECEIVED_LIMIT_MAX = 20;

/**
 * "Labels to check" looks at storage units received in this many days. Older unconfirmed labels
 * stay on each storage unit's Labels section; the dashboard is about what just came in.
 */
export const LABELS_TO_CHECK_DAYS = 30;

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** `GET /api/inventory/recently-received?show=&limit=` query. */
export const recentlyReceivedQuerySchema = z.object({
  show: z.preprocess(
    blankToUndefined,
    z.enum(RECENTLY_RECEIVED_SHOWS, { error: 'must be all, today or labels' }).default('all'),
  ),
  limit: z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: 'must be a number' })
      .int()
      .min(1)
      .max(RECENTLY_RECEIVED_LIMIT_MAX, { error: `must be at most ${RECENTLY_RECEIVED_LIMIT_MAX}` })
      .default(RECENTLY_RECEIVED_LIMIT_DEFAULT),
  ),
});

export type RecentlyReceivedQuery = z.output<typeof recentlyReceivedQuerySchema>;

/** The fields printJobStatusText needs, from the unit's newest print job. */
export const latestPrintSchema = z.object({
  status: z.enum(PRINT_JOB_STATUSES),
  attempts: z.number(),
  printerMessage: z.string().nullable(),
  physicallyConfirmedAt: z.string().nullable(),
}) satisfies z.ZodType<
  Pick<PrintJob, 'status' | 'attempts' | 'printerMessage' | 'physicallyConfirmedAt'>
>;

export type LatestPrint = z.infer<typeof latestPrintSchema>;

export const recentlyReceivedItemSchema = inventoryItemSchema.extend({
  /** When the receipt was confirmed (ISO timestamp). */
  receivedAt: z.string(),
  /** The receiver recorded on the receipt (not the LAB account that confirmed it). */
  receiver: z.object({ initials: z.string(), name: z.string() }),
  /** Null when no label has been requested for the unit yet. */
  latestPrint: latestPrintSchema.nullable(),
});

export type RecentlyReceivedItem = z.infer<typeof recentlyReceivedItemSchema>;

export const recentlyReceivedResponseSchema = z.object({
  items: z.array(recentlyReceivedItemSchema),
  /** Units matching `show` (the list holds at most `limit` of them). */
  total: z.number(),
  /** Received since Monday of this week, in the business time zone. */
  receivedThisWeek: z.number(),
  /** See LABELS_TO_CHECK_DAYS and needsLabelCheck. */
  labelsToCheck: z.number(),
});

export type RecentlyReceivedResponse = z.infer<typeof recentlyReceivedResponseSchema>;

/**
 * A label someone should look at: sent (or maybe sent) to the printer, and nobody has confirmed
 * that it came out. Matches the "Labels to check" filter on the server.
 */
export function needsLabelCheck(
  print: Pick<LatestPrint, 'status' | 'physicallyConfirmedAt'> | null,
): boolean {
  return (
    print !== null &&
    (print.status === 'sent' || print.status === 'uncertain') &&
    print.physicallyConfirmedAt === null
  );
}
