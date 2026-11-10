import { z } from 'zod';
import { CONCRETE_FIELD_REPORT_WARNINGS } from './concrete-field-reports';
import {
  CONCRETE_REPORT_ROUTE_KINDS,
  CONCRETE_REPORT_KINDS,
  reportVersionNoSchema,
} from './concrete-report-lifecycle';
import {
  CONCRETE_STRENGTH_REPORT_WARNINGS,
  CONCRETE_STRENGTH_WARNING_MESSAGE,
} from './concrete-strength-reports';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C28: the review queue, the review checklist and issuance (field reports; strength reports
// join once owner decision G2 settles their shape). Combined Plan "Review queue structure",
// "Review interaction", "Issuance workflow" and "Reviewer change comparison". The lifecycle
// commands are C09's; this adds the cross-project queue, documenting an exception on a submitted
// version, the rule that Mark reviewed needs every required exception resolved or documented, and
// the issue options stored with the issued version.

const idSchema = z.uuid({ error: 'must be an ID' });
const dateSchema = z.iso.date({ error: 'Enter a date as YYYY-MM-DD' });

// ---- Queue ----------------------------------------------------------------------------------------

/** The queue's four filters (Combined Plan, confirmed by Kyle), in their order on screen. */
export const CONCRETE_REVIEW_QUEUE_STATUSES = [
  'awaiting_review',
  'returned',
  'reviewed_awaiting_issue',
  'issued',
] as const;
export type ConcreteReviewQueueStatus = (typeof CONCRETE_REVIEW_QUEUE_STATUSES)[number];

export const CONCRETE_REVIEW_QUEUE_STATUS_LABEL: Record<ConcreteReviewQueueStatus, string> = {
  awaiting_review: 'Awaiting review',
  returned: 'Returned for correction',
  reviewed_awaiting_issue: 'Reviewed awaiting issuance',
  issued: 'Issued',
};

export const CONCRETE_REPORT_KIND_LABEL: Record<(typeof CONCRETE_REPORT_KINDS)[number], string> = {
  field: 'Field report',
  strength: 'Strength report',
};

/** Exception codes of either report kind (field: C04/C05/C27; strength: MM-V2-C39). */
export const CONCRETE_REPORT_EXCEPTION_CODES = [
  ...CONCRETE_FIELD_REPORT_WARNINGS,
  ...CONCRETE_STRENGTH_REPORT_WARNINGS,
] as const;
export type ConcreteReportExceptionCode = (typeof CONCRETE_REPORT_EXCEPTION_CODES)[number];

export const CONCRETE_REVIEW_QUEUE_PAGE_SIZE = 25;
export const CONCRETE_REVIEW_QUEUE_PAGE_SIZE_MAX = 100;

const queryBoolean = z
  .enum(['true', 'false'], { error: 'Use true or false' })
  .transform((value) => value === 'true');

export const concreteReviewQueueQuerySchema = z
  .object({
    status: z
      .enum(CONCRETE_REVIEW_QUEUE_STATUSES, { error: 'Choose a queue status' })
      .default('awaiting_review'),
    projectId: idSchema.optional(),
    technicianUserId: idSchema.optional(),
    reportType: z.enum(CONCRETE_REPORT_KINDS, { error: 'Choose a report type' }).optional(),
    /** Latest submission on or after / on or before this date (America/Edmonton). */
    submittedFrom: dateSchema.optional(),
    submittedTo: dateSchema.optional(),
    /** `with`: at least one exception on the latest version; `without`: none. */
    exceptions: z
      .enum(['any', 'with', 'without'], { error: 'Choose any, with or without' })
      .default('any'),
    /** Only the reports the caller could act on now (review, return, issue or correct). */
    mine: queryBoolean.default(false),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONCRETE_REVIEW_QUEUE_PAGE_SIZE_MAX)
      .default(CONCRETE_REVIEW_QUEUE_PAGE_SIZE),
  })
  .refine((q) => !q.submittedFrom || !q.submittedTo || q.submittedFrom <= q.submittedTo, {
    path: ['submittedTo'],
    message: 'The end date must be on or after the start date',
  });
export type ConcreteReviewQueueQuery = z.output<typeof concreteReviewQueueQuerySchema>;
export type ConcreteReviewQueueQueryInput = z.input<typeof concreteReviewQueueQuerySchema>;

export const concreteReviewQueueRowSchema = z.object({
  reportId: z.string(),
  reportType: z.enum(CONCRETE_REPORT_KINDS),
  /** Strength reports (MM-V2-C39): the specimen set, which opens the report. Null for field. */
  setId: z.string().nullable(),
  setLabel: z.string().nullable(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  reportDate: z.string().nullable(),
  technician: personSnapshotSchema.nullable(),
  status: z.enum(CONCRETE_REVIEW_QUEUE_STATUSES),
  versionNo: z.number(),
  revisionOfVersionNo: z.number().nullable(),
  /** Issued before and now a later version is in progress or issued. */
  revised: z.boolean(),
  submittedAt: z.string(),
  route: z.object({
    kind: z.enum(CONCRETE_REPORT_ROUTE_KINDS),
    routedTo: personSnapshotSchema.nullable(),
  }),
  reviewedBy: personSnapshotSchema.nullable(),
  reviewedAt: z.string().nullable(),
  returnedBy: personSnapshotSchema.nullable(),
  returnedAt: z.string().nullable(),
  issuedBy: personSnapshotSchema.nullable(),
  issuedAt: z.string().nullable(),
  /** The latest version's exceptions as submitted, one entry per code. */
  exceptions: z.array(
    z.object({ code: z.enum(CONCRETE_REPORT_EXCEPTION_CODES), count: z.number() }),
  ),
  /** How many of those (code + field) were documented by the reviewer. */
  documentedCount: z.number(),
  /** Whether the caller could act on it now (the server checks again on every command). */
  canAct: z.boolean(),
});
export type ConcreteReviewQueueRow = z.infer<typeof concreteReviewQueueRowSchema>;

export const concreteReviewQueueSchema = z.object({
  items: z.array(concreteReviewQueueRowSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  /** Rows per status with the same filters (for the tab counts). */
  counts: z.record(z.enum(CONCRETE_REVIEW_QUEUE_STATUSES), z.number()),
});
export type ConcreteReviewQueue = z.infer<typeof concreteReviewQueueSchema>;

// ---- Exceptions on a submitted version ------------------------------------------------------------

export const CONCRETE_EXCEPTION_LABEL: Record<ConcreteReportExceptionCode, string> = {
  ...CONCRETE_STRENGTH_WARNING_MESSAGE,
  unknown_mix: 'Mix not in the project registry',
  unapproved_mix: 'Mix not approved',
  slump_out_of_range: 'Slump out of range',
  air_out_of_range: 'Air out of range',
  ticket_differs_from_spec: 'Ticket differs from the specification',
  duplicate_ticket: 'Duplicate ticket',
  air_meter_flag: 'Air meter flag',
  specimens_recorded_but_not_cast: 'Specimens recorded but not cast',
};

/** `POST /api/concrete/field-reports/:id/versions/:versionNo/exception-notes`. */
export const concreteExceptionNoteRequestSchema = z.strictObject({
  code: z.enum(CONCRETE_REPORT_EXCEPTION_CODES, { error: 'Choose an exception' }),
  /** The exception's field path, as on the version (null when it has none). */
  field: z.string().trim().min(1).max(200).nullable(),
  note: z
    .string({ error: 'Enter a note' })
    .trim()
    .min(1, { error: 'Enter a note explaining how it was addressed' })
    .max(2000, { error: 'At most 2000 characters' }),
});
export type ConcreteExceptionNoteRequest = z.input<typeof concreteExceptionNoteRequestSchema>;

export const concreteExceptionNoteSchema = z.object({
  id: z.string(),
  versionNo: z.number(),
  code: z.enum(CONCRETE_REPORT_EXCEPTION_CODES),
  field: z.string().nullable(),
  note: z.string(),
  documentedBy: personSnapshotSchema,
  documentedAt: z.string(),
});
export type ConcreteExceptionNote = z.infer<typeof concreteExceptionNoteSchema>;

export const concreteExceptionNoteListSchema = z.object({
  reportId: z.string(),
  versionNo: z.number(),
  notes: z.array(concreteExceptionNoteSchema),
});
export type ConcreteExceptionNoteList = z.infer<typeof concreteExceptionNoteListSchema>;

/** A warning of either report kind, as frozen on a version. */
type ReportWarning = { code: ConcreteReportExceptionCode; field: string | null; message: string };

export type ConcreteChecklistStatus = 'open' | 'resolved' | 'documented';

export interface ConcreteChecklistItem {
  key: string;
  code: ConcreteReportExceptionCode;
  field: string | null;
  /** The messages as submitted (one exception code and field can carry several). */
  messages: string[];
  /** Every exception the queue knows today must be resolved or documented (proposal Q2). */
  required: true;
  status: ConcreteChecklistStatus;
  note: ConcreteExceptionNote | null;
}

const exceptionKey = (code: string, field: string | null) => `${code}|${field ?? ''}`;

/**
 * The review checklist for one submitted version: its exceptions as submitted, each resolved
 * (no longer raised by the live report, e.g. the duplicate report was voided), documented (a
 * reviewer's note on this version) or open. `live` is null when the live report isn't this
 * version any more (nothing resolves by live recheck then). Used by the review screen and by the
 * server's Mark reviewed rule, so both agree.
 */
export function concreteReviewChecklist(input: {
  submitted: readonly ReportWarning[];
  live: readonly Pick<ReportWarning, 'code' | 'field'>[] | null;
  notes: readonly ConcreteExceptionNote[];
}): ConcreteChecklistItem[] {
  const items = new Map<string, ConcreteChecklistItem>();
  for (const warning of input.submitted) {
    const key = exceptionKey(warning.code, warning.field);
    const existing = items.get(key);
    if (existing) {
      existing.messages.push(warning.message);
      continue;
    }
    items.set(key, {
      key,
      code: warning.code,
      field: warning.field,
      messages: [warning.message],
      required: true,
      status: 'open',
      note: null,
    });
  }
  const live = input.live ? new Set(input.live.map((w) => exceptionKey(w.code, w.field))) : null;
  for (const item of items.values()) {
    const note = input.notes.find((n) => exceptionKey(n.code, n.field) === item.key) ?? null;
    if (note) {
      item.status = 'documented';
      item.note = note;
    } else if (live && !live.has(item.key)) {
      item.status = 'resolved';
    }
  }
  return [...items.values()];
}

/** The required exceptions still open (Mark reviewed waits for none). */
export function concreteReviewOpenExceptions(items: readonly ConcreteChecklistItem[]) {
  return items.filter((item) => item.required && item.status === 'open');
}

// ---- Changes between versions ---------------------------------------------------------------------

export interface ConcreteSnapshotChange {
  /** Dotted path into the snapshot, e.g. `fields.ticketNumber`, `fields.readings.<id>.value`. */
  path: string;
  before: unknown;
  after: unknown;
}

/** The parts of a version snapshot that are report content (the rest is derived or identity). */
export const CONCRETE_SNAPSHOT_COMPARED = [
  'fields',
  'mixSnapshot',
  'airMeterUse',
  'specimenSets',
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasIds = (value: unknown): value is { id: string }[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => isPlainObject(item) && typeof item.id === 'string');

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffValue(path: string, a: unknown, b: unknown, out: ConcreteSnapshotChange[]) {
  if (same(a, b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffValue(`${path}.${key}`, a[key], b[key], out);
    }
    return;
  }
  // Lists of records with ids (readings, attachments, sets, specimens): matched by id, so a
  // reading added or removed doesn't mark every later one as changed.
  if (
    (hasIds(a) || hasIds(b)) &&
    (Array.isArray(a) || a == null) &&
    (Array.isArray(b) || b == null)
  ) {
    const before = new Map((hasIds(a) ? a : []).map((item) => [item.id, item]));
    const after = new Map((hasIds(b) ? b : []).map((item) => [item.id, item]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const x = before.get(id);
      const y = after.get(id);
      if (x && y) diffValue(`${path}.${id}`, x, y, out);
      else if (!same(x, y))
        out.push({ path: `${path}.${id}`, before: x ?? null, after: y ?? null });
    }
    return;
  }
  out.push({ path, before: a ?? null, after: b ?? null });
}

/**
 * What changed from one submitted version to the next (Combined Plan "Reviewer change
 * comparison": highlight only what changed, keep the complete record available). Leaf paths
 * only; derived parts (warnings, completeness, duplicate list) are left out.
 */
export function diffConcreteReportSnapshots(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): ConcreteSnapshotChange[] {
  if (!previous) return [];
  const out: ConcreteSnapshotChange[] = [];
  for (const key of CONCRETE_SNAPSHOT_COMPARED) {
    diffValue(key, previous[key], next[key], out);
  }
  return out;
}

/** Whether `path` (a field shown on the preview) or anything under it changed. */
export function concreteSnapshotChanged(
  changes: readonly ConcreteSnapshotChange[],
  path: string,
): boolean {
  return changes.some((c) => c.path === path || c.path.startsWith(`${path}.`));
}

// ---- Issuance -------------------------------------------------------------------------------------

/**
 * `POST /api/concrete/field-reports/:id/issue` (C09) with the issuer's choices (Combined Plan
 * "Issuance workflow"), stored with the issued version so the final layout (C32) renders exactly
 * what was chosen. Photos arrive with C15: until then nothing can be included, so only `false`.
 * `includeMachineInfo` is optional (MM-V2-C38, owner decision 2026-11-09): omitted, the server
 * uses the project's concrete setting, and leaves machine information out when that is unset.
 */
export const concreteReportIssueRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  version: z.int().positive(),
  comment: z
    .string()
    .trim()
    .min(1, { error: 'enter a comment' })
    .max(2000, { error: 'at most 2000 characters' })
    .optional(),
  includePhotos: z.literal(false, { error: 'Photos can’t be included yet' }).default(false),
  includeMachineInfo: z
    .boolean({ error: 'Include testing machine information: true or false' })
    .optional(),
});
export type ConcreteReportIssueRequest = z.input<typeof concreteReportIssueRequestSchema>;

/** Field-report issue: also bound to the version shown (review fix #139, `reportVersionNo`). */
export const concreteFieldReportIssueRequestSchema = concreteReportIssueRequestSchema.extend({
  reportVersionNo: reportVersionNoSchema,
});

export const concreteIssueOptionsSchema = z.object({
  includePhotos: z.boolean(),
  includeMachineInfo: z.boolean(),
});
export type ConcreteIssueOptions = z.infer<typeof concreteIssueOptionsSchema>;
