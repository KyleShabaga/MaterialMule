import { z } from 'zod';
import {
  PROGRAM_PRIORITIES,
  TEST_REQUEST_STATUSES,
  accountSnapshotSchema,
  personSnapshotSchema,
  type ProgramPriority,
  type TestRequestStatus,
} from './lab-programs';
import {
  REVIEW_STATES,
  actionItemSchema,
  reviewActionsSchema,
  reviewEventSchema,
} from './lab-review';
import { programLifecycleSchema, requestLifecycleSchema } from './lab-lifecycle';

// Lab worklist, per-test progress, priority and comments (MM-T24).
//
// One transition table, shared by the server (which enforces it) and the browser (which offers
// only the moves it allows): Requested → In progress (Start) → Completed (Mark completed) →
// Awaiting review (Send to review). Review decisions and acceptance are MM-T25; cancellation,
// repeats and reopening are MM-T26. A shared LAB station names "Who is doing this?" on every
// action; that person is attribution only.

export const STATUS_TRANSITIONS: Readonly<
  Record<TestRequestStatus, { to: TestRequestStatus; action: string } | null>
> = {
  requested: { to: 'in_progress', action: 'Start' },
  in_progress: { to: 'completed', action: 'Mark completed' },
  completed: { to: 'review', action: 'Send to review' },
  // Review decisions and acceptance have their own endpoints (MM-T25, lab-review.ts).
  review: null,
  accepted: null,
  // Cancellation, repeats and accepted-request changes have their own endpoints (MM-T26).
  cancelled: null,
};

/** True when `from → to` is one of this card's moves. */
export function isAllowedTransition(from: TestRequestStatus, to: string): boolean {
  return STATUS_TRANSITIONS[from]?.to === to;
}

/** Tests still waiting on lab work (D52 "open"): not yet sent to review. */
export const OPEN_STATUSES: readonly TestRequestStatus[] = [
  'requested',
  'in_progress',
  'completed',
];

export const COMMENT_MAX_LENGTH = 4000;
/** Owner decision 2026-10-25: the author may edit for 15 minutes after posting. */
export const COMMENT_EDIT_WINDOW_MINUTES = 15;

const idSchema = z.uuid({ error: 'must be an ID' });
const versionSchema = z.number({ error: 'is required' }).int().min(1);

/**
 * `POST /api/test-requests/:id/status`. `to` also accepts 'accepted' so a jump there is refused
 * as an invalid transition (or 403 for LAB) instead of a shape error: acceptance is
 * `POST /api/test-requests/:id/accept` (MM-T25). `testedStorageUnitIds` lists
 * the exact physical units used; it is required when completing a test whose frozen coverage
 * includes a Shelby tube or bulk-sample bucket (an empty list then says none of them was used).
 */
export const changeTestStatusRequestSchema = z
  .strictObject({
    to: z.enum(TEST_REQUEST_STATUSES, { error: 'must be a test status' }),
    version: versionSchema,
    idempotencyKey: idSchema,
    actingStaffUserId: idSchema.optional(),
    testedStorageUnitIds: z
      .array(idSchema)
      .max(50)
      .superRefine((ids, ctx) => {
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({ code: 'custom', message: 'lists a unit more than once' });
        }
      })
      .optional(),
    /**
     * MM-T73: units in `testedStorageUnitIds` that are outside the line's frozen coverage, which
     * the person completing the test confirms are from the line's own source (a Shelby tube or
     * bulk-sample bucket of the same test hole or standalone source, same project). Covered units
     * never need it. The confirmation (account, person, time) is stored with the link.
     */
    sameSourceConfirmedUnitIds: z
      .array(idSchema)
      .max(50)
      .superRefine((ids, ctx) => {
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({ code: 'custom', message: 'lists a unit more than once' });
        }
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    const tested = new Set(body.testedStorageUnitIds ?? []);
    if (body.sameSourceConfirmedUnitIds?.some((id) => !tested.has(id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['sameSourceConfirmedUnitIds'],
        message: 'must only list units that are also in testedStorageUnitIds',
      });
    }
  });
export type ChangeTestStatusRequest = z.output<typeof changeTestStatusRequestSchema>;
export type ChangeTestStatusRequestInput = z.input<typeof changeTestStatusRequestSchema>;

/** `PATCH /api/lab-programs/:id/priority` (project PM/PE or Lab Manager only). */
export const changePriorityRequestSchema = z.strictObject({
  priority: z.enum(PROGRAM_PRIORITIES, { error: 'must be normal or urgent' }),
  version: versionSchema,
  idempotencyKey: idSchema,
});
export type ChangePriorityRequest = z.output<typeof changePriorityRequestSchema>;

const bodySchema = z
  .string({ error: 'is required' })
  .trim()
  .min(1, { error: 'can’t be blank' })
  .max(COMMENT_MAX_LENGTH, { error: `must be at most ${COMMENT_MAX_LENGTH} characters` });

/** `POST /api/lab-programs/:id/comments`. */
export const addCommentRequestSchema = z.strictObject({
  lineId: idSchema.nullish().transform((value) => value ?? null),
  body: bodySchema,
  idempotencyKey: idSchema,
  actingStaffUserId: idSchema.optional(),
});
export type AddCommentRequest = z.output<typeof addCommentRequestSchema>;
export type AddCommentRequestInput = z.input<typeof addCommentRequestSchema>;

/** `PATCH /api/comments/:id`. */
export const editCommentRequestSchema = z.strictObject({
  body: bodySchema,
  version: versionSchema,
  idempotencyKey: idSchema,
  actingStaffUserId: idSchema.optional(),
});
export type EditCommentRequest = z.output<typeof editCommentRequestSchema>;
export type EditCommentRequestInput = z.input<typeof editCommentRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const statusEventSchema = z.object({
  id: z.string(),
  testRequestId: z.string(),
  fromStatus: z.enum(TEST_REQUEST_STATUSES),
  toStatus: z.enum(TEST_REQUEST_STATUSES),
  account: accountSnapshotSchema,
  person: personSnapshotSchema,
  changedAt: z.string(),
});
export type StatusEvent = z.infer<typeof statusEventSchema>;

/** Why a tested-unit link is allowed (MM-T73). */
export const TESTED_UNIT_COVERAGE_BASES = ['frozen_coverage', 'same_source_confirmed'] as const;
export type TestedUnitCoverageBasis = (typeof TESTED_UNIT_COVERAGE_BASES)[number];

/** Who confirmed a same-source unit outside the line's coverage, and when (MM-T73). */
export const sameSourceConfirmationSchema = z.object({
  accountUserId: z.string(),
  person: personSnapshotSchema,
  confirmedAt: z.string(),
});
export type SameSourceConfirmation = z.infer<typeof sameSourceConfirmationSchema>;

export const testedUnitSchema = z.object({
  testRequestId: z.string(),
  storageUnitId: z.string(),
  readableId: z.string(),
  statusEventId: z.string(),
  linkedAt: z.string(),
  coverageBasis: z.enum(TESTED_UNIT_COVERAGE_BASES),
  /** Set only for a same-source unit outside the line's coverage. */
  confirmation: sameSourceConfirmationSchema.nullable(),
});
export type TestedUnit = z.infer<typeof testedUnitSchema>;

/**
 * `GET /api/test-requests/:id/same-source-units` (MM-T73): Shelby tubes and bulk-sample buckets
 * of the line's own source, in the program's project, that are outside its frozen coverage and
 * can still be recorded as tested by this program (not disposed, contents not destroyed by
 * another program). Completing with one needs `sameSourceConfirmedUnitIds`.
 */
export const sameSourceUnitSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  unitType: z.string(),
  contents: z.string().nullable(),
  receivedDate: z.string(),
});
export type SameSourceUnit = z.infer<typeof sameSourceUnitSchema>;

export const sameSourceUnitsSchema = z.object({
  testRequestId: z.string(),
  sourceLabel: z.string().nullable(),
  units: z.array(sameSourceUnitSchema),
});
export type SameSourceUnits = z.infer<typeof sameSourceUnitsSchema>;

export const priorityEventSchema = z.object({
  id: z.string(),
  fromPriority: z.enum(PROGRAM_PRIORITIES),
  toPriority: z.enum(PROGRAM_PRIORITIES),
  person: personSnapshotSchema,
  changedAt: z.string(),
});
export type PriorityEvent = z.infer<typeof priorityEventSchema>;

export const commentRevisionSchema = z.object({
  revisionNumber: z.number().int(),
  body: z.string(),
  person: personSnapshotSchema,
  createdAt: z.string(),
});

export const labCommentSchema = z.object({
  id: z.string(),
  lineId: z.string().nullable(),
  account: accountSnapshotSchema,
  author: personSnapshotSchema,
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  /** End of the author's edit window (server clock). */
  editableUntil: z.string(),
  version: z.number().int(),
  revisions: z.array(commentRevisionSchema),
});
export type LabComment = z.infer<typeof labCommentSchema>;

export const requestProgressSchema = z.object({
  testRequestId: z.string(),
  status: z.enum(TEST_REQUEST_STATUSES),
  version: z.number().int(),
  /** Frozen coverage includes a Shelby tube or bulk-sample bucket: completion names the units. */
  needsTestedUnits: z.boolean(),
  /** Review sub-state while in Review (MM-T25), null otherwise. */
  reviewState: z.enum(REVIEW_STATES).nullable(),
  acceptedAt: z.string().nullable(),
  acceptedBy: personSnapshotSchema.nullable(),
  acceptedViaDelegation: z.boolean(),
  /** What the signed-in account may do to this test now. */
  reviewActions: reviewActionsSchema,
  /** Cancellation, repeat links and lifecycle actions (MM-T26). */
  lifecycle: requestLifecycleSchema,
});
export type RequestProgress = z.infer<typeof requestProgressSchema>;

/** `GET /api/lab-programs/:id/work`: everything the program detail shows beyond the program. */
export const programWorkSchema = z.object({
  programId: z.string(),
  canChangePriority: z.boolean(),
  requests: z.array(requestProgressSchema),
  statusHistory: z.array(statusEventSchema),
  testedUnits: z.array(testedUnitSchema),
  priorityHistory: z.array(priorityEventSchema),
  comments: z.array(labCommentSchema),
  /** Review decisions and acceptances, oldest first (MM-T25). */
  reviewEvents: z.array(reviewEventSchema),
  /** Correction items, cancellation and closure requests, open and resolved. */
  actionItems: z.array(actionItemSchema),
  /** Open/Closed, closure eligibility, lifecycle history and allowed actions (MM-T26). */
  lifecycle: programLifecycleSchema,
});
export type ProgramWork = z.infer<typeof programWorkSchema>;

export const STATUS_COUNT_KEYS = TEST_REQUEST_STATUSES;

export const worklistItemSchema = z.object({
  programId: z.string(),
  programNumber: z.string(),
  priority: z.enum(PROGRAM_PRIORITIES),
  project: z.object({ id: z.string(), projectNumber: z.string(), name: z.string() }),
  submittedAt: z.string(),
  requestedBy: z.string(),
  counts: z.record(z.enum(TEST_REQUEST_STATUSES), z.number().int()),
  openCount: z.number().int(),
  /** Age in seconds of the oldest open test (from submission), null when none is open. */
  oldestOpenSeconds: z.number().nullable(),
});
export type WorklistItem = z.infer<typeof worklistItemSchema>;
export const worklistSchema = z.object({ items: z.array(worklistItemSchema) });
export type Worklist = z.infer<typeof worklistSchema>;

/**
 * D52 order: Urgent first, then Normal; oldest submission first within each; program ID breaks
 * ties so the order never wobbles. Ordering never changes any status.
 */
export function compareWorklist(
  a: { priority: ProgramPriority; submittedAt: string; programId: string },
  b: { priority: ProgramPriority; submittedAt: string; programId: string },
): number {
  if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  return a.programId < b.programId ? -1 : a.programId > b.programId ? 1 : 0;
}
