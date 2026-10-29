import { z } from 'zod';
import {
  TEST_REQUEST_STATUSES,
  personSnapshotSchema,
  type TestRequestStatus,
} from './lab-programs';
import { REVIEW_STATES, REVIEW_STATE_LABEL, type ReviewState } from './lab-review';

// Program lifecycle, cancellation and repeats (MM-T26).
//
// A submitted program is shown as Open. The project's Lead Project Engineer closes it only when it has at least
// one test request and every request is Accepted or Cancelled with a recorded reason. An empty
// program is never closable (no vacuous "all tests resolved"). Closing never disposes material,
// approves disposal or changes retention. Reopening (Lead Project Engineer or Lab Manager, reason required)
// changes only the program's status.
//
// Not enabled (product edges the card leaves unresolved; refused until the owner decides):
// cancelling an Accepted test, editing or restoring a Cancelled test, and repeating a test that
// is not Accepted.

export const LIFECYCLE_REASON_MAX_LENGTH = 2000;

export const PROGRAM_STATUS_LABEL = {
  draft: 'Draft',
  submitted: 'Open',
  closed: 'Closed',
} as const;

/** Statuses a test can be cancelled from (Accepted is an unresolved edge; Cancelled is final). */
export const CANCELLABLE_STATUSES: readonly TestRequestStatus[] = [
  'requested',
  'in_progress',
  'completed',
  'review',
];

/** A genuine repeat is made from an Accepted original only (other origins are unresolved). */
export const REPEATABLE_STATUSES: readonly TestRequestStatus[] = ['accepted'];

export type ClosureBlockerReason =
  'requested' | 'in_progress' | 'completed' | 'review' | 'cancelled_without_reason';

export interface ClosureBlocker {
  testRequestId: string;
  status: TestRequestStatus;
  reviewState: ReviewState | null;
  reason: ClosureBlockerReason;
}

export interface ClosureEligibility {
  eligible: boolean;
  /** No test requests at all: never closable. */
  emptyProgram: boolean;
  blockers: ClosureBlocker[];
  /** Unresolved requests per reason. */
  counts: Partial<Record<ClosureBlockerReason, number>>;
  /** Plain-language summary for the UI ("3 tests still in Review"). */
  summary: string;
}

const BLOCKER_PHRASE: Record<ClosureBlockerReason, [string, string]> = {
  requested: ['test still Requested', 'tests still Requested'],
  in_progress: ['test still In progress', 'tests still In progress'],
  completed: [
    'test Completed but not yet reviewed or accepted',
    'tests Completed but not yet reviewed or accepted',
  ],
  review: ['test still in Review', 'tests still in Review'],
  cancelled_without_reason: [
    'cancelled test without a recorded reason',
    'cancelled tests without a recorded reason',
  ],
};

/**
 * Whether a program with these requests may be closed (D06 + the empty-program rule). Pure, so the
 * server (which also enforces it in the database under lock) and the browser agree.
 */
export function closureEligibility(
  requests: {
    id: string;
    status: TestRequestStatus;
    reviewState: ReviewState | null;
    cancelReason: string | null;
  }[],
): ClosureEligibility {
  if (requests.length === 0) {
    return {
      eligible: false,
      emptyProgram: true,
      blockers: [],
      counts: {},
      summary:
        'This program has no test requests. At least one test is needed before it can close.',
    };
  }
  const blockers: ClosureBlocker[] = [];
  for (const request of requests) {
    let reason: ClosureBlockerReason | null = null;
    if (request.status === 'cancelled') {
      if (!request.cancelReason?.trim()) reason = 'cancelled_without_reason';
    } else if (request.status !== 'accepted') {
      reason = request.status;
    }
    if (reason) {
      blockers.push({
        testRequestId: request.id,
        status: request.status,
        reviewState: request.reviewState,
        reason,
      });
    }
  }
  const counts: Partial<Record<ClosureBlockerReason, number>> = {};
  for (const blocker of blockers) counts[blocker.reason] = (counts[blocker.reason] ?? 0) + 1;
  const parts = (Object.keys(BLOCKER_PHRASE) as ClosureBlockerReason[])
    .filter((reason) => counts[reason])
    .map((reason) => {
      const n = counts[reason]!;
      return `${n} ${BLOCKER_PHRASE[reason][n === 1 ? 0 : 1]}`;
    });
  return {
    eligible: blockers.length === 0,
    emptyProgram: false,
    blockers,
    counts,
    summary:
      blockers.length === 0
        ? requests.every((r) => r.status === 'cancelled')
          ? 'All tests cancelled with reasons'
          : requests.every((r) => r.status === 'accepted')
            ? 'All tests accepted'
            : 'All tests resolved'
        : parts.join(', '),
  };
}

/** Text for one blocker in the closure checklist. */
export function closureBlockerLabel(blocker: ClosureBlocker): string {
  switch (blocker.reason) {
    case 'review':
      return blocker.reviewState
        ? `In review — ${REVIEW_STATE_LABEL[blocker.reviewState]}`
        : 'In review';
    case 'requested':
      return 'Requested';
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'Completed — review and acceptance still needed';
    case 'cancelled_without_reason':
      return 'Cancelled without a recorded reason';
  }
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const idSchema = z.uuid({ error: 'must be an ID' });
const versionSchema = z.number({ error: 'is required' }).int().min(1);
const reasonSchema = z
  .string({ error: 'is required' })
  .trim()
  .min(1, { error: 'A reason is required' })
  .max(LIFECYCLE_REASON_MAX_LENGTH, {
    error: `must be at most ${LIFECYCLE_REASON_MAX_LENGTH} characters`,
  });

/** `POST /api/lab-programs/:id/close` (the project's Lead Project Engineer). `version` is the program's. */
export const closeProgramRequestSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idSchema,
});
export type CloseProgramRequest = z.output<typeof closeProgramRequestSchema>;

/** `POST /api/lab-programs/:id/reopen` (Lead Project Engineer or Lab Manager). */
export const reopenProgramRequestSchema = z.strictObject({
  reason: reasonSchema,
  version: versionSchema,
  idempotencyKey: idSchema,
});
export type ReopenProgramRequest = z.output<typeof reopenProgramRequestSchema>;

/** `POST /api/lab-programs/:id/close-request` and `POST /api/test-requests/:id/cancel-request`. */
export const lifecycleRequestSchema = z.strictObject({
  reason: reasonSchema,
  idempotencyKey: idSchema,
});
export type LifecycleRequest = z.output<typeof lifecycleRequestSchema>;

/** `POST /api/test-requests/:id/cancel` (Lead Project Engineer of the project or Lab Manager). */
export const cancelTestRequestSchema = z.strictObject({
  reason: reasonSchema,
  version: versionSchema,
  idempotencyKey: idSchema,
});
export type CancelTestRequest = z.output<typeof cancelTestRequestSchema>;

/** `POST /api/test-requests/:id/repeat`. `version` is the original's. */
export const repeatTestRequestSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idSchema,
});
export type RepeatTestRequest = z.output<typeof repeatTestRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Accepted-request changes (D09) and amendments (D02)
// ---------------------------------------------------------------------------------------------

const depthNumber = z
  .number({ error: 'must be a number' })
  .min(0, { error: 'must be 0 or more' })
  .max(999_999.99, { error: 'is too large' })
  .refine((value) => Math.round(value * 100) / 100 === value, {
    error: 'must have at most two decimal places',
  });

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A complete Specific sample identity (label, single depth or interval, unit). */
export const sampleIdentityInputSchema = z
  .strictObject({
    sampleLabel: z
      .string({ error: 'is required' })
      .trim()
      .min(1, { error: 'Enter the sample label' })
      .max(40, { error: 'must be at most 40 characters' })
      .refine((value) => !CONTROL_CHARACTERS.test(value), {
        error: 'can’t contain control characters',
      }),
    depthMode: z.enum(['point', 'interval'], { error: 'must be point or interval' }),
    depthFrom: depthNumber,
    depthTo: depthNumber.nullish().transform((value) => value ?? null),
    depthUnit: z.enum(['ft', 'm'], { error: 'must be ft or m' }),
  })
  .superRefine((value, ctx) => {
    if (value.depthMode === 'point' && value.depthTo !== null) {
      ctx.addIssue({ code: 'custom', path: ['depthTo'], message: 'is only for an interval' });
    }
    if (value.depthMode === 'interval' && value.depthTo === null) {
      ctx.addIssue({ code: 'custom', path: ['depthTo'], message: 'Enter where the interval ends' });
    }
    if (value.depthTo !== null && value.depthTo < value.depthFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['depthTo'],
        message: 'must be greater than or equal to depth from',
      });
    }
  });
export type SampleIdentityInput = z.output<typeof sampleIdentityInputSchema>;

/**
 * `PATCH /api/test-requests/:id`: change the sample/depth (Specific lines) and/or the requested
 * test of an Accepted request. Only that request returns to Requested (D09).
 */
export const changeTestRequestSchema = z
  .strictObject({
    identity: sampleIdentityInputSchema.optional(),
    testTypeId: idSchema.optional(),
    reason: reasonSchema,
    version: versionSchema,
    idempotencyKey: idSchema,
  })
  .refine((value) => value.identity !== undefined || value.testTypeId !== undefined, {
    error: 'Change the sample, depth or test',
    path: ['identity'],
  });
export type ChangeTestRequest = z.output<typeof changeTestRequestSchema>;
export type ChangeTestRequestInput = z.input<typeof changeTestRequestSchema>;

const idList = (label: string, max: number) =>
  z
    .array(idSchema, { error: `must be a list of ${label} IDs` })
    .max(max)
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: 'custom', message: `lists a ${label} more than once` });
      }
    });

/** A new line added by an amendment: complete, with the coverage the requester reviewed. */
export const amendmentLineInputSchema = z.strictObject({
  source: z.strictObject({
    kind: z.enum(['test_hole', 'standalone_unit', 'standalone_bulk_group']),
    id: idSchema,
  }),
  scope: z.enum(['all', 'grabs', 'spt', 'specific']),
  identity: sampleIdentityInputSchema.nullish().transform((value) => value ?? null),
  testTypeIds: idList('test', 100).min(1, { error: 'Pick at least one test' }),
  /** Grabs/SPT units explicitly included after review, or the units linked to a Specific sample. */
  unitIds: idList('storage unit', 200).default([]),
  /** Included coverage the requester reviewed (ALL/Grabs/SPT); must match the server's. */
  reviewedCoverageUnitIds: idList('storage unit', 500).default([]),
  /** Different depths of the same sample the requester acknowledged, e.g. ["7.5 ft"]. */
  acknowledgedDepths: z.array(z.string().max(60)).max(50).default([]),
});
export type AmendmentLineInput = z.output<typeof amendmentLineInputSchema>;

/** `POST /api/lab-programs/:id/amend` (D02): explicit additions to an open program. */
export const amendProgramRequestSchema = z
  .strictObject({
    version: versionSchema,
    idempotencyKey: idSchema,
    reason: z
      .string()
      .trim()
      .max(LIFECYCLE_REASON_MAX_LENGTH)
      .nullish()
      .transform((value) => (value ? value : null)),
    addTests: z
      .array(z.strictObject({ lineId: idSchema, testTypeIds: idList('test', 100).min(1) }))
      .max(200)
      .default([]),
    addLines: z.array(amendmentLineInputSchema).max(50).default([]),
    /** Later receipts to include in an ALL/Grabs/SPT line: the exact units reviewed. */
    includeLaterReceipts: z
      .array(z.strictObject({ lineId: idSchema, unitIds: idList('storage unit', 500).min(1) }))
      .max(200)
      .default([]),
  })
  .refine(
    (value) =>
      value.addTests.length + value.addLines.length + value.includeLaterReceipts.length > 0,
    { error: 'An amendment needs at least one change', path: ['addTests'] },
  );
export type AmendProgramRequest = z.output<typeof amendProgramRequestSchema>;
export type AmendProgramRequestInput = z.input<typeof amendProgramRequestSchema>;

export const amendmentSchema = z.object({
  id: z.string(),
  amendmentNumber: z.number().int(),
  reason: z.string().nullable(),
  addedLineIds: z.array(z.string()),
  addedRequestIds: z.array(z.string()),
  addedUnitReadableIds: z.array(z.string()),
  person: personSnapshotSchema,
  createdAt: z.string(),
});
export type Amendment = z.infer<typeof amendmentSchema>;

export const identityRevisionSchema = z.object({
  id: z.string(),
  testRequestId: z.string(),
  revisionNumber: z.number().int(),
  before: z.object({ test: z.string(), sample: z.string().nullable() }),
  after: z.object({ test: z.string(), sample: z.string().nullable() }),
  reason: z.string(),
  person: personSnapshotSchema,
  changedAt: z.string(),
});
export type IdentityRevision = z.infer<typeof identityRevisionSchema>;

/** `GET /api/lab-programs/:id/later-receipts`: units received since each line's coverage froze. */
export const laterReceiptsSchema = z.object({
  programId: z.string(),
  version: z.number().int(),
  lines: z.array(
    z.object({
      lineId: z.string(),
      lineNumber: z.number().int(),
      scope: z.enum(['all', 'grabs', 'spt']),
      /** Not yet covered. ALL units are includable as they are; Grabs/SPT have unknown G/S. */
      units: z.array(
        z.object({
          storageUnitId: z.string(),
          readableId: z.string(),
          unitType: z.string(),
          contents: z.string().nullable(),
          receivedDate: z.string(),
          unknownClassification: z.boolean(),
        }),
      ),
    }),
  ),
});
export type LaterReceipts = z.infer<typeof laterReceiptsSchema>;

export const amendmentResultSchema = z.object({
  programId: z.string(),
  amendmentId: z.string(),
  version: z.number().int(),
});
export type AmendmentResult = z.infer<typeof amendmentResultSchema>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const CLOSURE_BLOCKER_REASONS = [
  'requested',
  'in_progress',
  'completed',
  'review',
  'cancelled_without_reason',
] as const;

export const closureBlockerSchema = z.object({
  testRequestId: z.string(),
  status: z.enum(TEST_REQUEST_STATUSES),
  reviewState: z.enum(REVIEW_STATES).nullable(),
  reason: z.enum(CLOSURE_BLOCKER_REASONS),
});

export const closureEligibilitySchema = z.object({
  eligible: z.boolean(),
  emptyProgram: z.boolean(),
  blockers: z.array(closureBlockerSchema),
  counts: z.record(z.string(), z.number().int()),
  summary: z.string(),
});

export const lifecycleEventSchema = z.object({
  id: z.string(),
  kind: z.enum(['closed', 'reopened']),
  reason: z.string().nullable(),
  person: personSnapshotSchema,
  occurredAt: z.string(),
});
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export const CLOSE_BLOCKED_REASONS = {
  personal_sign_in: 'Closing a program needs a personal sign-in',
  not_lead_project_engineer: 'Only the project’s Lead Project Engineer can close this program',
  not_open: 'This program isn’t open',
  unresolved: 'Some tests aren’t resolved',
  empty_program: 'This program has no test requests',
} as const;
export type CloseBlockedReason = keyof typeof CLOSE_BLOCKED_REASONS;

/** The program's lifecycle and what the signed-in account may do to it now. */
export const programLifecycleSchema = z.object({
  status: z.enum(['submitted', 'closed']),
  version: z.number().int(),
  closedAt: z.string().nullable(),
  closedBy: personSnapshotSchema.nullable(),
  events: z.array(lifecycleEventSchema),
  closure: closureEligibilitySchema,
  canClose: z.boolean(),
  closeBlockedReason: z.enum(Object.keys(CLOSE_BLOCKED_REASONS) as [CloseBlockedReason]).nullable(),
  canRequestClose: z.boolean(),
  canReopen: z.boolean(),
  /** Add lines/tests or include later receipts (open program, personal account). */
  canAmend: z.boolean(),
  amendments: z.array(amendmentSchema),
  identityRevisions: z.array(identityRevisionSchema),
});
export type ProgramLifecycle = z.infer<typeof programLifecycleSchema>;

/** What the signed-in account may do to one test's lifecycle now. */
export const requestLifecycleSchema = z.object({
  cancelReason: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: personSnapshotSchema.nullable(),
  repeatOfId: z.string().nullable(),
  repeatIds: z.array(z.string()),
  canCancel: z.boolean(),
  canRequestCancel: z.boolean(),
  canRepeat: z.boolean(),
  /** Change the sample/depth/test of this Accepted test (resets only it to Requested). */
  canChange: z.boolean(),
});
export type RequestLifecycle = z.infer<typeof requestLifecycleSchema>;

/** `POST …/close` and `…/reopen` result. */
export const programLifecycleResultSchema = z.object({
  programId: z.string(),
  status: z.enum(['submitted', 'closed']),
  version: z.number().int(),
});
export type ProgramLifecycleResult = z.infer<typeof programLifecycleResultSchema>;

/** `POST …/cancel` result, and `…/repeat` (the new request). */
export const testRequestResultSchema = z.object({
  testRequestId: z.string(),
  status: z.string(),
  version: z.number().int(),
});
export type TestRequestResult = z.infer<typeof testRequestResultSchema>;

/** `POST …/cancel-request` and `…/close-request` result. */
export const lifecycleRequestResultSchema = z.object({ actionItemId: z.string() });
export type LifecycleRequestResult = z.infer<typeof lifecycleRequestResultSchema>;
