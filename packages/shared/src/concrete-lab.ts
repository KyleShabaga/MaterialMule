import { z } from 'zod';
import { CONCRETE_PERMANENT_SET_ID_PATTERN, CONCRETE_TEMPORARY_SET_ID_PATTERN } from './concrete';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C31: the Concrete dashboard, the Concrete Lab workspace and search (no migration of its
// own beyond the search indexes in 0030).
//
// Dashboard (combined plan "Daily lab briefing", confirmed by Kyle): Awaiting pickup, Awaiting
// receiving, Tests due today / overdue, HOLDs due for review, Reports awaiting review /
// issuance. Each count is read from the list it opens (AC3): pickup and receiving from the
// receiving queue below, tests and HOLDs from C22's lab worklist, reports from C28's review
// queue. Personalization: My reports (the technician who did the field test) come first in
// pickup and receiving and are clearly separated; other work stays listed. Testing and HOLD
// lists stay lab-wide.
//
// Search (placement and scope confirmed by Kyle): Concrete search sits in Concrete screens and
// covers concrete content; the top-bar Lab search covers every lab area within the caller's
// access. A readable set number may repeat across projects (26-05 in two projects): every match
// is listed with its project and never silently chosen.

// ---------------------------------------------------------------------------------------------
// Receiving queue (Awaiting pickup / Awaiting receiving)
// ---------------------------------------------------------------------------------------------

export const CONCRETE_RECEIVING_STAGES = ['awaiting_pickup', 'awaiting_receiving'] as const;
export type ConcreteReceivingStage = (typeof CONCRETE_RECEIVING_STAGES)[number];

export const CONCRETE_RECEIVING_STAGE_LABEL: Record<ConcreteReceivingStage, string> = {
  awaiting_pickup: 'Awaiting pickup',
  awaiting_receiving: 'Awaiting receiving',
};

export const CONCRETE_RECEIVING_QUEUE_PAGE_SIZE = 50;
export const CONCRETE_RECEIVING_QUEUE_PAGE_SIZE_MAX = 100;

const idSchema = z.uuid({ error: 'must be an ID' });

/** `GET /api/concrete/receiving-queue` (`inventory.read`). */
export const concreteReceivingQueueQuerySchema = z.strictObject({
  stage: z
    .enum(CONCRETE_RECEIVING_STAGES, { error: 'Choose awaiting_pickup or awaiting_receiving' })
    .default('awaiting_pickup'),
  projectId: idSchema.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONCRETE_RECEIVING_QUEUE_PAGE_SIZE_MAX)
    .default(CONCRETE_RECEIVING_QUEUE_PAGE_SIZE),
});
export type ConcreteReceivingQueueQuery = z.output<typeof concreteReceivingQueueQuerySchema>;
export type ConcreteReceivingQueueQueryInput = z.input<typeof concreteReceivingQueueQuerySchema>;

/** One set with at least one specimen in the stage. */
export const concreteReceivingQueueRowSchema = z.object({
  setId: z.string(),
  fieldReportId: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  identity: z.object({ temporaryId: z.string().nullable(), permanentId: z.string().nullable() }),
  /**
   * Null: casting time not recorded (STRATA-120). The set is listed and can be received; its test
   * dates stay unscheduled until the casting time is recorded.
   */
  castAt: z.string().nullable(),
  /** The person who did the field test (never LAB). */
  technician: personSnapshotSchema.nullable(),
  /** The caller did the field test: listed under My reports. */
  mine: z.boolean(),
  /** Specimen letters in this stage, in order. */
  letters: z.array(z.string()),
  /** Specimens in the set (all stages). */
  specimenCount: z.number().int(),
  reportState: z.string(),
});
export type ConcreteReceivingQueueRow = z.infer<typeof concreteReceivingQueueRowSchema>;

export const concreteReceivingQueueSchema = z.object({
  stage: z.enum(CONCRETE_RECEIVING_STAGES),
  /** Sets per stage with the same filters (the dashboard counts and the tab counts). */
  counts: z.record(z.enum(CONCRETE_RECEIVING_STAGES), z.number().int()),
  /** My reports in this stage (all pages). */
  mineTotal: z.number().int(),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /**
   * My reports first, then the rest, each oldest casting first and sets without a casting time
   * last (then project number, set number, temporary ID, set ID: a stable page order).
   */
  items: z.array(concreteReceivingQueueRowSchema),
});
export type ConcreteReceivingQueue = z.infer<typeof concreteReceivingQueueSchema>;

// ---------------------------------------------------------------------------------------------
// Concrete search
// ---------------------------------------------------------------------------------------------

export const CONCRETE_SEARCH_PAGE_SIZE = 25;
export const CONCRETE_SEARCH_PAGE_SIZE_MAX = 50;
/** Shortest text searched by contains (names); IDs and numbers match from their start. */
export const CONCRETE_SEARCH_MIN_LENGTH = 2;

/** What a search matched on, best first (the ranking order). */
export const CONCRETE_SEARCH_MATCHES = [
  'set_id',
  'set_id_prefix',
  'ticket',
  'project',
  'field_id',
  'casting_date',
  'mix',
  'technician',
] as const;
export type ConcreteSearchMatch = (typeof CONCRETE_SEARCH_MATCHES)[number];

export const CONCRETE_SEARCH_MATCH_LABEL: Record<ConcreteSearchMatch, string> = {
  set_id: 'Specimen ID',
  set_id_prefix: 'Specimen ID (start)',
  ticket: 'Ticket',
  project: 'Project',
  field_id: 'Field ID',
  casting_date: 'Casting date',
  mix: 'Mix',
  technician: 'Technician',
};

/** `GET /api/concrete/search` (`inventory.read`). */
export const concreteSearchQuerySchema = z.strictObject({
  q: z
    .string({ error: 'Enter something to search for' })
    .trim()
    .min(1, { error: 'Enter something to search for' })
    .max(100, { error: 'Keep the search under 100 characters' }),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONCRETE_SEARCH_PAGE_SIZE_MAX)
    .default(CONCRETE_SEARCH_PAGE_SIZE),
});
export type ConcreteSearchQuery = z.output<typeof concreteSearchQuerySchema>;

/**
 * How a search text is read. A specimen ID (set alias plus letter, `26-05A`, `TMP-D07-001B`)
 * searches its set and remembers the letter; a date (YYYY-MM-DD) also searches casting dates.
 */
export interface ConcreteSearchTerms {
  /** Upper-cased text with the dashes folded, for ID and number matches. */
  text: string;
  /** Lower-cased text for the name and number matches. */
  lower: string;
  /** The set alias when the text is a set or specimen ID (exact). */
  setAlias: string | null;
  /** The specimen letter when the text was a specimen ID. */
  letter: string | null;
  /** The casting date when the text is a date. */
  date: string | null;
}

const DASHES = /[‐‑‒–—―−]/g;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day (YYYY-MM-DD). `Date` would roll 2026-02-30 over into March. */
function calendarDate(text: string): string | null {
  const parts = DATE.exec(text);
  if (!parts) return null;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // PostgreSQL has no year 0 (1 BC is year 0 to JavaScript); such text is searched as text only.
  if (year < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? text
    : null;
}

export function concreteSearchTerms(raw: string): ConcreteSearchTerms {
  const text = raw.trim().replace(DASHES, '-').replace(/\s+/g, ' ').toUpperCase();
  let setAlias: string | null = null;
  let letter: string | null = null;
  if (
    CONCRETE_PERMANENT_SET_ID_PATTERN.test(text) ||
    CONCRETE_TEMPORARY_SET_ID_PATTERN.test(text)
  ) {
    setAlias = text;
  } else {
    const withLetter = /^(.*\d)([A-Z])$/.exec(text);
    if (
      withLetter &&
      (CONCRETE_PERMANENT_SET_ID_PATTERN.test(withLetter[1]!) ||
        CONCRETE_TEMPORARY_SET_ID_PATTERN.test(withLetter[1]!))
    ) {
      setAlias = withLetter[1]!;
      letter = withLetter[2]!;
    }
  }
  const date = calendarDate(text);
  return { text, lower: text.toLowerCase(), setAlias, letter, date };
}

export const concreteSearchSetSchema = z.object({
  setId: z.string(),
  identity: z.object({ temporaryId: z.string().nullable(), permanentId: z.string().nullable() }),
  specimenCount: z.number().int(),
  voided: z.boolean(),
  /** This set is what the ID matched (not just a set on a matching report). */
  matched: z.boolean(),
});

/** One field report: its project is always shown, with every set on it. */
export const concreteSearchResultSchema = z.object({
  fieldReportId: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  reportDate: z.string().nullable(),
  castingDate: z.string().nullable(),
  paperFieldId: z.string().nullable(),
  ticketNumber: z.string().nullable(),
  supplierName: z.string().nullable(),
  mixNumber: z.string().nullable(),
  technician: personSnapshotSchema.nullable(),
  workflowState: z.string(),
  /** What matched, best first; the first decides the ranking. */
  matches: z.array(z.enum(CONCRETE_SEARCH_MATCHES)).min(1),
  sets: z.array(concreteSearchSetSchema),
});
export type ConcreteSearchResult = z.infer<typeof concreteSearchResultSchema>;

export const concreteSearchSchema = z.object({
  q: z.string(),
  /** The specimen letter when the search was a specimen ID (26-05A → A). */
  letter: z.string().nullable(),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Distinct projects among all matches: more than one means the ID repeats across projects. */
  projectCount: z.number().int(),
  items: z.array(concreteSearchResultSchema),
});
export type ConcreteSearch = z.infer<typeof concreteSearchSchema>;
