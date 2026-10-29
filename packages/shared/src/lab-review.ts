import { z } from 'zod';
import { personSnapshotSchema } from './lab-programs';
import { grantReasonSchema } from './project-access';

// Review corrections and delegated acceptance (MM-T25).
//
// A test in Review has a review sub-state; it is not a new progress stage, and returning a test
// for correction never moves it back to In progress. The one table below is shared by the server
// (which enforces it, as does the database) and the browser (which offers only allowed actions).
//
// Not enabled: Review complete → Returned for correction. The card leaves that reverse edge
// unresolved (Notion MM-T25 §12 B), so it is refused until the owner decides. Nothing requires
// the re-reviewer to differ from the earlier reviewer.

export const REVIEW_STATES = [
  'awaiting_review',
  'returned',
  'correction_done',
  'review_complete',
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  awaiting_review: 'Awaiting review',
  returned: 'Returned to Lab Manager',
  correction_done: 'Correction done — awaiting re-review',
  review_complete: 'Review complete',
};

export type ReviewAction = 'complete' | 'return' | 'correction_done';

/** Review sub-state moves: from → action → to. Acceptance needs `review_complete`. */
export const REVIEW_TRANSITIONS: Readonly<
  Record<ReviewState, Partial<Record<ReviewAction, ReviewState>>>
> = {
  awaiting_review: { complete: 'review_complete', return: 'returned' },
  returned: { correction_done: 'correction_done' },
  correction_done: { complete: 'review_complete', return: 'returned' },
  review_complete: {},
};

/** The sub-state `action` leads to from `from`, or null when it isn't allowed. */
export function nextReviewState(from: ReviewState, action: ReviewAction): ReviewState | null {
  return REVIEW_TRANSITIONS[from][action] ?? null;
}

export const REVIEW_COMMENT_MAX_LENGTH = 4000;

const idSchema = z.uuid({ error: 'must be an ID' });
const versionSchema = z.number({ error: 'is required' }).int().min(1);
const textSchema = (what: string) =>
  z
    .string({ error: 'is required' })
    .trim()
    .min(1, { error: `${what} can’t be blank` })
    .max(REVIEW_COMMENT_MAX_LENGTH, {
      error: `must be at most ${REVIEW_COMMENT_MAX_LENGTH} characters`,
    });

/** `POST /api/test-requests/:id/review`: a return needs a nonblank comment. */
export const reviewDecisionRequestSchema = z
  .strictObject({
    action: z.enum(['complete', 'return'], { error: 'must be complete or return' }),
    comment: z.string().optional(),
    version: versionSchema,
    idempotencyKey: idSchema,
  })
  .transform((value, ctx) => {
    const comment = value.comment?.trim() ?? '';
    if (value.action === 'return' && comment.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'a comment is required' });
      return z.NEVER;
    }
    if (comment.length > REVIEW_COMMENT_MAX_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: `must be at most ${REVIEW_COMMENT_MAX_LENGTH} characters`,
      });
      return z.NEVER;
    }
    return { ...value, comment: comment.length > 0 ? comment : null };
  });
export type ReviewDecisionRequest = z.output<typeof reviewDecisionRequestSchema>;
export type ReviewDecisionRequestInput = z.input<typeof reviewDecisionRequestSchema>;

/**
 * `POST /api/test-requests/:id/correction-done` (Lab Manager). `actionItemId`, when sent, must be
 * the outstanding correction, so an old screen can't resolve a newer return.
 */
export const correctionDoneRequestSchema = z.strictObject({
  note: textSchema('The note'),
  version: versionSchema,
  idempotencyKey: idSchema,
  actionItemId: idSchema.optional(),
});
export type CorrectionDoneRequest = z.output<typeof correctionDoneRequestSchema>;

/** `POST /api/test-requests/:id/accept` (Lead Project Engineer or active delegate). */
export const acceptTestRequestSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idSchema,
});
export type AcceptTestRequest = z.output<typeof acceptTestRequestSchema>;

/**
 * `POST /api/projects/:projectId/acceptance-delegates` (the project's Lead Project Engineer). A
 * reason is required (D15, MM-AO03); revoking sends `endGrantRequestSchema` (a reason too).
 */
export const grantDelegationRequestSchema = z.strictObject({
  delegateUserId: idSchema,
  reason: grantReasonSchema,
  idempotencyKey: idSchema,
});
export type GrantDelegationRequest = z.output<typeof grantDelegationRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const REVIEW_EVENT_KINDS = [
  'review_completed',
  'returned',
  'correction_done',
  'accepted',
] as const;
export type ReviewEventKind = (typeof REVIEW_EVENT_KINDS)[number];

export const REVIEW_EVENT_LABEL: Record<ReviewEventKind, string> = {
  review_completed: 'Review complete',
  returned: 'Returned for correction',
  correction_done: 'Correction done',
  accepted: 'Accepted',
};

export const reviewEventSchema = z.object({
  id: z.string(),
  testRequestId: z.string(),
  kind: z.enum(REVIEW_EVENT_KINDS),
  fromReviewState: z.enum(REVIEW_STATES),
  toReviewState: z.enum(REVIEW_STATES).nullable(),
  comment: z.string().nullable(),
  correctionCycle: z.number().int(),
  person: personSnapshotSchema,
  /** Accepted as an acceptance delegate (the grant may since have been revoked). */
  viaDelegation: z.boolean(),
  occurredAt: z.string(),
});
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

/** Correction items (MM-T25); cancellation and closure requests (MM-T26). */
export const ACTION_ITEM_KINDS = ['correction', 'cancellation_request', 'closure_request'] as const;
export type ActionItemKind = (typeof ACTION_ITEM_KINDS)[number];

export const ACTION_ITEM_KIND_LABEL: Record<ActionItemKind, string> = {
  correction: 'Correction for the Lab Manager',
  cancellation_request: 'Cancellation requested',
  closure_request: 'Closure requested',
};

export const actionItemSchema = z.object({
  id: z.string(),
  kind: z.enum(ACTION_ITEM_KINDS),
  targetRole: z.literal('lab_manager').nullable(),
  /** The test it concerns; null for a closure request (it concerns the program). */
  testRequestId: z.string().nullable(),
  /** The return comment of a correction, or the requester's reason. */
  comment: z.string(),
  status: z.enum(['open', 'resolved']),
  /** How it was resolved (null while open, and for corrections resolved before MM-T26). */
  resolution: z.enum(['correction_done', 'cancelled', 'closed']).nullable(),
  createdAt: z.string(),
  createdBy: personSnapshotSchema,
  resolvedAt: z.string().nullable(),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const ACCEPT_BLOCKED_REASONS = {
  no_authority: 'You don’t have acceptance authority for this project',
  review_not_complete: 'Review not complete',
  personal_sign_in: 'Review and acceptance need a personal sign-in',
  program_not_open: 'This program isn’t open',
} as const;
export type AcceptBlockedReason = keyof typeof ACCEPT_BLOCKED_REASONS;

/** What the signed-in account may do to one test now (computed by the server). */
export const reviewActionsSchema = z.object({
  canReview: z.boolean(),
  canCorrectionDone: z.boolean(),
  canAccept: z.boolean(),
  acceptBlockedReason: z
    .enum(Object.keys(ACCEPT_BLOCKED_REASONS) as [AcceptBlockedReason])
    .nullable(),
});
export type ReviewActions = z.infer<typeof reviewActionsSchema>;

/** `POST …/review`, `…/correction-done`, `…/accept` result. */
export const reviewResultSchema = z.object({
  testRequestId: z.string(),
  status: z.enum(['review', 'accepted']),
  reviewState: z.enum(REVIEW_STATES).nullable(),
  version: z.number().int(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const acceptanceDelegationSchema = z.object({
  id: z.string(),
  delegate: personSnapshotSchema,
  grantedBy: personSnapshotSchema,
  grantedAt: z.string(),
  /** Null only for grants made before reasons were required (D15). */
  grantReason: z.string().nullable(),
  revokedBy: personSnapshotSchema.nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
});
export type AcceptanceDelegation = z.infer<typeof acceptanceDelegationSchema>;

/** `GET /api/projects/:projectId/acceptance-delegates`: active grants first, then history. */
export const acceptanceDelegatesSchema = z.object({
  projectId: z.string(),
  canManage: z.boolean(),
  active: z.array(acceptanceDelegationSchema),
  history: z.array(acceptanceDelegationSchema),
});
export type AcceptanceDelegates = z.infer<typeof acceptanceDelegatesSchema>;
