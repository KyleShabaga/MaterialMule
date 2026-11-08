import { z } from 'zod';
import type { ConcreteWorkflowState } from './concrete';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C09: report versions and the review / issue lifecycle (field-report path). Combined Plan
// "Corrections and revisions" and section 9: drafts are editable; a submitted version is locked
// and may be recalled by its technician (not yet reviewed) or returned by the reviewer with a
// comment; a change after review needs a fresh review; issuing never overwrites an issued
// version, and corrections after issue make a linked revision. One model for both report types:
// strength reports join once owner decision G2 settles their shape and number format.

const idSchema = z.uuid({ error: 'must be an ID' });

export const CONCRETE_REPORT_KINDS = ['field'] as const;
export type ConcreteReportKind = (typeof CONCRETE_REPORT_KINDS)[number];

export const CONCRETE_REPORT_ACTIONS = [
  'submit',
  'recall',
  'return',
  'resubmit',
  'review',
  'issue',
  'revise',
] as const;
export type ConcreteReportAction = (typeof CONCRETE_REPORT_ACTIONS)[number];

/**
 * Where a report stands in the lifecycle. Stored as the report's `workflow_state`, except
 * `issued`: the workflow stays `reviewed` and the issuance columns say it was issued.
 */
export const CONCRETE_REPORT_LIFECYCLE_STATES = [
  'draft',
  'ready_to_submit',
  'submitted',
  'returned',
  'reviewed',
  'issued',
  'void',
] as const;
export type ConcreteReportLifecycleState = (typeof CONCRETE_REPORT_LIFECYCLE_STATES)[number];

export const CONCRETE_REPORT_VERSION_STATES = [
  'submitted',
  'recalled',
  'returned',
  'reviewed',
  'issued',
] as const;
export type ConcreteReportVersionState = (typeof CONCRETE_REPORT_VERSION_STATES)[number];

/**
 * The confirmed transitions (card T1). Anything not listed is refused (422 `invalid_transition`).
 * Ready to submit (C19) is submission intent, so submitting from it is allowed.
 */
export const CONCRETE_REPORT_TRANSITIONS: Readonly<
  Record<
    ConcreteReportLifecycleState,
    Partial<Record<ConcreteReportAction, ConcreteReportLifecycleState>>
  >
> = {
  draft: { submit: 'submitted' },
  ready_to_submit: { submit: 'submitted' },
  submitted: { recall: 'draft', return: 'returned', review: 'reviewed' },
  returned: { resubmit: 'submitted' },
  reviewed: { return: 'returned', issue: 'issued' },
  issued: { revise: 'draft' },
  void: {},
};

/** The state `action` leads to from `state`, or null when the transition isn't allowed. */
export function concreteReportNextState(
  state: ConcreteReportLifecycleState,
  action: ConcreteReportAction,
): ConcreteReportLifecycleState | null {
  return CONCRETE_REPORT_TRANSITIONS[state][action] ?? null;
}

/** The lifecycle state a report shows: its workflow state, with issuance on top. */
export function concreteReportLifecycleState(
  workflowState: ConcreteWorkflowState,
  latestVersionState: ConcreteReportVersionState | null,
): ConcreteReportLifecycleState {
  if (workflowState === 'reviewed' && latestVersionState === 'issued') return 'issued';
  return workflowState;
}

/** The workflow state stored for a lifecycle state (`issued` is stored as `reviewed`). */
export function concreteReportStoredState(
  state: ConcreteReportLifecycleState,
): ConcreteWorkflowState {
  return state === 'issued' ? 'reviewed' : state;
}

export const CONCRETE_REPORT_ROUTE_KINDS = [
  'designated_reviewers',
  'original_reviewer',
  'lead_project_engineer',
] as const;
export type ConcreteReportRouteKind = (typeof CONCRETE_REPORT_ROUTE_KINDS)[number];
export const CONCRETE_REPORT_ROUTE_REASONS = [
  'resubmission',
  'lab_manager_correction',
  'original_reviewer_unavailable',
] as const;
export type ConcreteReportRouteReason = (typeof CONCRETE_REPORT_ROUTE_REASONS)[number];

export interface ConcreteReportRoute {
  kind: ConcreteReportRouteKind;
  routedToUserId: string | null;
  reason: ConcreteReportRouteReason | null;
}

export interface ConcreteReportRouteInput {
  action: 'submit' | 'resubmit';
  /** A person holding the Lab Manager role saved a correction to the returned report. */
  labManagerCorrection: boolean;
  /** Who returned the version being corrected (resubmit only). */
  originalReviewerUserId: string | null;
  /** Whether that person can still review on this project and scope right now. */
  originalReviewerCanReview: boolean;
  leadProjectEngineerUserId: string | null;
  /** The report's technician, who never reviews it (owner decision 2026-11-08). */
  technicianUserId?: string | null;
}

/**
 * Who reviews a submission (D11, Combined Plan review routing). A first submission (or one after
 * a recall or a revision) goes to the project's designated reviewers and its lead. A resubmission
 * goes back to the reviewer who returned it; a Lab Manager's correction goes to the project's Lead
 * Project Engineer instead. When the original reviewer can no longer review, the lead takes it
 * (owner decision 2026-11-08). Nobody reviews their own report: a target who is the report's
 * technician is skipped, and if that leaves only the lead who is the technician, the designated
 * reviewers take it. Error `no_lead_project_engineer` when only a lead could take it and the
 * project has none (D02).
 */
export function concreteReportRoute(
  input: ConcreteReportRouteInput,
): ConcreteReportRoute | { error: 'no_lead_project_engineer' } {
  if (input.action === 'submit') {
    return { kind: 'designated_reviewers', routedToUserId: null, reason: null };
  }
  const technician = input.technicianUserId ?? null;
  const toLead = (
    reason: ConcreteReportRouteReason,
  ): ConcreteReportRoute | { error: 'no_lead_project_engineer' } => {
    if (input.leadProjectEngineerUserId === null) return { error: 'no_lead_project_engineer' };
    if (input.leadProjectEngineerUserId === technician) {
      return { kind: 'designated_reviewers', routedToUserId: null, reason: null };
    }
    return {
      kind: 'lead_project_engineer',
      routedToUserId: input.leadProjectEngineerUserId,
      reason,
    };
  };
  if (input.labManagerCorrection) return toLead('lab_manager_correction');
  if (
    input.originalReviewerUserId !== null &&
    input.originalReviewerCanReview &&
    input.originalReviewerUserId !== technician
  ) {
    return {
      kind: 'original_reviewer',
      routedToUserId: input.originalReviewerUserId,
      reason: 'resubmission',
    };
  }
  return toLead('original_reviewer_unavailable');
}

/**
 * Whether `userId`, who already holds `concrete.review`, may review or return a version with this
 * route: anyone for an unrouted version; otherwise the person it was routed to or the lead.
 */
export function concreteReportMayReviewRouted(
  route: Pick<ConcreteReportRoute, 'kind' | 'routedToUserId'>,
  userId: string,
  leadProjectEngineerUserId: string | null,
): boolean {
  if (route.kind === 'designated_reviewers') return true;
  return route.routedToUserId === userId || leadProjectEngineerUserId === userId;
}

// ---- Requests -------------------------------------------------------------------------------------

const commentSchema = z
  .string()
  .trim()
  .min(1, { error: 'enter a comment' })
  .max(2000, { error: 'at most 2000 characters' });

const commandBase = {
  idempotencyKey: idSchema,
  /** The report version the command is based on; a stale one is 409 `version_conflict`. */
  version: z.int().positive(),
};

/** Submit / resubmit: LAB names the performing staff member (the report's technician). */
export const concreteReportSubmitRequestSchema = z.strictObject({
  ...commandBase,
  technicianUserId: idSchema.optional(),
});
export type ConcreteReportSubmitRequest = z.input<typeof concreteReportSubmitRequestSchema>;

/** Recall, review, issue: an optional note. */
export const concreteReportCommandRequestSchema = z.strictObject({
  ...commandBase,
  comment: commentSchema.optional(),
});
export type ConcreteReportCommandRequest = z.input<typeof concreteReportCommandRequestSchema>;

/** Return for correction and revise after issue: the comment / reason is required. */
export const concreteReportCommentRequiredSchema = z.strictObject({
  ...commandBase,
  comment: commentSchema,
});
export type ConcreteReportCommentRequiredRequest = z.input<
  typeof concreteReportCommentRequiredSchema
>;

// ---- Responses ------------------------------------------------------------------------------------

export const concreteReportVersionSummarySchema = z.object({
  id: z.string(),
  versionNo: z.number(),
  state: z.enum(CONCRETE_REPORT_VERSION_STATES),
  /** The issued version this revision corrects. */
  revisionOfVersionNo: z.number().nullable(),
  snapshotSha256: z.string(),
  submittedAt: z.string(),
  /** The signed-in account (may be LAB) and the person credited. */
  submittedBy: personSnapshotSchema,
  submittedStaff: personSnapshotSchema,
  route: z.object({
    kind: z.enum(CONCRETE_REPORT_ROUTE_KINDS),
    routedTo: personSnapshotSchema.nullable(),
    reason: z.enum(CONCRETE_REPORT_ROUTE_REASONS).nullable(),
  }),
  review: z
    .object({
      reviewedBy: personSnapshotSchema,
      reviewedAt: z.string(),
      source: z.enum(['lead_project_engineer', 'designated_reviewer']),
      /** False once the version was returned after review: a fresh review is needed (AC3). */
      counted: z.boolean(),
      clearedAt: z.string().nullable(),
    })
    .nullable(),
  closed: z
    .object({
      kind: z.enum(['recalled', 'returned']),
      by: personSnapshotSchema,
      at: z.string(),
      comment: z.string().nullable(),
    })
    .nullable(),
  issued: z
    .object({
      by: personSnapshotSchema,
      at: z.string(),
      source: z.enum(['lead_project_engineer', 'report_issuer']),
    })
    .nullable(),
});
export type ConcreteReportVersionSummary = z.infer<typeof concreteReportVersionSummarySchema>;

/** One version with the report exactly as submitted (never re-read from the live report). */
export const concreteReportVersionDetailSchema = concreteReportVersionSummarySchema.extend({
  reportId: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
});
export type ConcreteReportVersionDetail = z.infer<typeof concreteReportVersionDetailSchema>;

export const concreteReportTransitionSchema = z.object({
  id: z.string(),
  versionNo: z.number(),
  action: z.enum(CONCRETE_REPORT_ACTIONS),
  fromState: z.string(),
  toState: z.string(),
  actor: personSnapshotSchema,
  staff: personSnapshotSchema.nullable(),
  comment: z.string().nullable(),
  routeKind: z.enum(CONCRETE_REPORT_ROUTE_KINDS).nullable(),
  routedTo: personSnapshotSchema.nullable(),
  at: z.string(),
});
export type ConcreteReportTransition = z.infer<typeof concreteReportTransitionSchema>;

export const concreteReportVersionListSchema = z.object({
  reportId: z.string(),
  versions: z.array(concreteReportVersionSummarySchema),
  transitions: z.array(concreteReportTransitionSchema),
});
export type ConcreteReportVersionList = z.infer<typeof concreteReportVersionListSchema>;

/** The lifecycle part of a field report's detail, from the server (never assumed locally). */
export const concreteReportLifecycleSchema = z.object({
  state: z.enum(CONCRETE_REPORT_LIFECYCLE_STATES),
  /** Issued at least once and now a later version is in progress or issued ("Revised"). */
  revised: z.boolean(),
  latestVersion: concreteReportVersionSummarySchema.nullable(),
  latestIssuedVersionNo: z.number().nullable(),
  /** The latest version's review counts as approval (reviewed or issued, not returned). */
  reviewCounted: z.boolean(),
  /** A Lab Manager corrected the returned report: resubmission goes to the lead (D11). */
  labManagerCorrection: z.boolean(),
  /** The commands the caller may send now (permission and state; the server checks again). */
  allowedActions: z.array(z.enum(CONCRETE_REPORT_ACTIONS)),
});
export type ConcreteReportLifecycle = z.infer<typeof concreteReportLifecycleSchema>;
