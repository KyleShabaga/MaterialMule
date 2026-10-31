import { z } from 'zod';
import { effectiveJobTitleSchema } from './job-title';
import { personSnapshotSchema } from './lab-programs';
import { positionSchema } from './profile';

// Project assignments, scoped grants and effective capabilities (MM-AO03; owner decisions D01,
// D04–D08, D12, D15 of 2026-10-29). The server enforces every rule here; the browser only shows
// what the server reports. Nothing the browser sends about roles, capabilities or approvers is
// ever trusted: recipients are named by ID and the server loads their standing itself.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const idSchema = z.uuid({ error: 'must be an ID' });

/** D15: a reason is required for every grant, revocation, assignment and removal. */
export const grantReasonSchema = z
  .string({ error: 'Enter a reason.' })
  .trim()
  .min(1, { error: 'Enter a reason.' })
  .max(2000, { error: 'Reason must be 2000 characters or fewer' })
  .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
    message: "Reason can't contain control characters",
  });

/** The firm's approval document or reference for an issuer grant (D06), when there is one. */
export const approvalReferenceSchema = z
  .string({ error: 'Approval reference must be text' })
  .trim()
  .min(1, { error: 'Approval reference must be text' })
  .max(200, { error: 'Approval reference must be 200 characters or fewer' })
  .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value) && !value.includes('\n'), {
    message: "Approval reference can't contain control characters",
  });

/** A workflow / report-type scope (`review_scope`, D05/D06). */
export const reviewScopeSchema = z.object({
  code: z.string(),
  label: z.string(),
});
export type ReviewScope = z.infer<typeof reviewScopeSchema>;

/** `GET /api/review-scopes`: the active scopes, in display order. */
export const reviewScopesSchema = z.array(reviewScopeSchema);

/** The body of every removal / revocation (`DELETE …/:id`). */
export const endGrantRequestSchema = z.strictObject({ reason: grantReasonSchema });
export type EndGrantRequest = z.output<typeof endGrantRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Project team (D04)
// ---------------------------------------------------------------------------------------------

/** `POST /api/projects/:projectId/team-members` (Lead Project Engineer or admin). */
export const addTeamMemberRequestSchema = z.strictObject({
  userId: idSchema,
  reason: grantReasonSchema,
  idempotencyKey: idSchema,
});
export type AddTeamMemberRequest = z.output<typeof addTeamMemberRequestSchema>;

/** One assignment or grant row, with who started and who ended it and why. */
const historyFields = {
  id: z.string(),
  startedBy: personSnapshotSchema,
  startedAt: z.string(),
  startReason: z.string().nullable(),
  endedBy: personSnapshotSchema.nullable(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
};

export const teamMemberSchema = z.object({ ...historyFields, person: personSnapshotSchema });
export type TeamMember = z.infer<typeof teamMemberSchema>;

/** Newest history rows returned with each list; `historyTotal` counts them all. */
export const PROJECT_ACCESS_HISTORY_LIMIT = 50;

export const projectTeamSchema = z.object({
  projectId: z.string(),
  canManage: z.boolean(),
  active: z.array(teamMemberSchema),
  history: z.array(teamMemberSchema),
  historyTotal: z.number(),
});
export type ProjectTeam = z.infer<typeof projectTeamSchema>;

// ---------------------------------------------------------------------------------------------
// Scoped reviewers (D04/D05)
// ---------------------------------------------------------------------------------------------

/** `POST /api/projects/:projectId/reviewer-assignments` (Lead Project Engineer or admin). */
export const assignReviewerRequestSchema = z.strictObject({
  reviewerUserId: idSchema,
  scopeCode: z.string().min(1).max(40),
  reason: grantReasonSchema,
  idempotencyKey: idSchema,
});
export type AssignReviewerRequest = z.output<typeof assignReviewerRequestSchema>;

export const reviewerAssignmentSchema = z.object({
  ...historyFields,
  reviewer: personSnapshotSchema,
  scope: reviewScopeSchema,
  /**
   * An active assignment counts only while the reviewer is an active account holding active
   * eligibility for its scope; `blockedReason` says why it doesn't.
   */
  effective: z.boolean(),
  /**
   * MISC-08: the first missing condition, in order: an active account, effective eligibility,
   * accepted team membership, then the lead's review approval.
   */
  blockedReason: z
    .enum(['account_not_active', 'eligibility_revoked', 'not_accepted_member', 'not_approved'])
    .nullable(),
  /** The lead's active review approval of this assignment (MISC-08), if any. */
  approval: z
    .object({
      id: z.string(),
      approvedBy: personSnapshotSchema,
      approvedAt: z.string(),
      reason: z.string().nullable(),
    })
    .nullable(),
  /** Eligibility and team membership shown apart from the approval (MISC-08). */
  eligible: z.boolean(),
  acceptedMember: z.boolean(),
});
export type ReviewerAssignment = z.infer<typeof reviewerAssignmentSchema>;

/** `POST …/reviewer-assignments/:id/approval` (the project's Lead Project Engineer only). */
export const approveReviewerRequestSchema = z.strictObject({
  reason: grantReasonSchema.optional(),
  idempotencyKey: idSchema,
});
export type ApproveReviewerRequest = z.output<typeof approveReviewerRequestSchema>;

/** Why a review approval ended (MISC-08). */
export const REVIEW_APPROVAL_END_KINDS = [
  'withdrawn',
  'eligibility_lost',
  'assignment_ended',
] as const;
export const reviewApprovalSchema = z.object({
  ...historyFields,
  reviewer: personSnapshotSchema,
  scope: reviewScopeSchema,
  reviewerAssignmentId: z.string(),
  endKind: z.enum(REVIEW_APPROVAL_END_KINDS).nullable(),
});
export type ReviewApproval = z.infer<typeof reviewApprovalSchema>;

export const projectReviewersSchema = z.object({
  projectId: z.string(),
  canManage: z.boolean(),
  /** True for the project's Lead Project Engineer, who alone approves reviewers (MISC-08). */
  canApprove: z.boolean(),
  /** Ended approvals, newest first, so a loss and its reason stay visible (MISC-08). */
  approvalHistory: z.array(reviewApprovalSchema),
  active: z.array(reviewerAssignmentSchema),
  history: z.array(reviewerAssignmentSchema),
  historyTotal: z.number(),
});
export type ProjectReviewers = z.infer<typeof projectReviewersSchema>;

// ---------------------------------------------------------------------------------------------
// Authorized report issuers (D06/D07)
// ---------------------------------------------------------------------------------------------

/** `POST /api/projects/:projectId/report-issuers` (the project's Lead Project Engineer only). */
export const grantReportIssuerRequestSchema = z.strictObject({
  issuerUserId: idSchema,
  scopeCode: z.string().min(1).max(40),
  reason: grantReasonSchema,
  approvalReference: approvalReferenceSchema.nullish(),
  /** Optional expiry (ISO 8601 with an offset); must be in the future. */
  expiresAt: z.iso.datetime({ offset: true, error: 'must be a date and time' }).nullish(),
  idempotencyKey: idSchema,
});
export type GrantReportIssuerRequest = z.output<typeof grantReportIssuerRequestSchema>;

export const REVOCATION_KINDS = ['ordinary', 'emergency'] as const;
export type RevocationKind = (typeof REVOCATION_KINDS)[number];

/** `DELETE /api/projects/:projectId/report-issuers/:id`: emergency suspension is a revocation. */
export const revokeReportIssuerRequestSchema = z.strictObject({
  reason: grantReasonSchema,
  kind: z.enum(REVOCATION_KINDS).default('ordinary'),
});
export type RevokeReportIssuerRequest = z.output<typeof revokeReportIssuerRequestSchema>;

export const reportIssuerGrantSchema = z.object({
  ...historyFields,
  issuer: personSnapshotSchema,
  scope: reviewScopeSchema,
  approvalReference: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revocationKind: z.enum(REVOCATION_KINDS).nullable(),
  /** Usable now: not revoked, not expired, and the holder's account is active. */
  effective: z.boolean(),
  blockedReason: z.enum(['account_not_active', 'expired']).nullable(),
});
export type ReportIssuerGrant = z.infer<typeof reportIssuerGrantSchema>;

export const projectReportIssuersSchema = z.object({
  projectId: z.string(),
  canManage: z.boolean(),
  active: z.array(reportIssuerGrantSchema),
  history: z.array(reportIssuerGrantSchema),
  historyTotal: z.number(),
});
export type ProjectReportIssuers = z.infer<typeof projectReportIssuersSchema>;

// ---------------------------------------------------------------------------------------------
// Reviewer eligibility (D05) and staff capabilities (D01), per person
// ---------------------------------------------------------------------------------------------

export const STAFF_CAPABILITIES = ['project.create_and_lead'] as const;
export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];
export const STAFF_CAPABILITY_LABEL: Record<StaffCapability, string> = {
  'project.create_and_lead': 'Can create and lead projects',
};

/** `POST /api/staff/:id/reviewer-eligibility` (admin). */
export const grantReviewerEligibilityRequestSchema = z.strictObject({
  scopeCode: z.string().min(1).max(40),
  reason: grantReasonSchema,
  idempotencyKey: idSchema,
});
export type GrantReviewerEligibilityRequest = z.output<
  typeof grantReviewerEligibilityRequestSchema
>;

/** `POST /api/staff/:id/capabilities` (admin). */
export const grantStaffCapabilityRequestSchema = z.strictObject({
  capability: z.enum(STAFF_CAPABILITIES),
  reason: grantReasonSchema,
  idempotencyKey: idSchema,
});
export type GrantStaffCapabilityRequest = z.output<typeof grantStaffCapabilityRequestSchema>;

export const reviewerEligibilitySchema = z.object({ ...historyFields, scope: reviewScopeSchema });
export type ReviewerEligibility = z.infer<typeof reviewerEligibilitySchema>;

export const staffCapabilityGrantSchema = z.object({
  ...historyFields,
  capability: z.enum(STAFF_CAPABILITIES),
});
export type StaffCapabilityGrant = z.infer<typeof staffCapabilityGrantSchema>;

/** `POST /api/staff/:id/reviewer-exclusions` (admin): one scope, or `scopeCode: null` for all. */
export const addReviewerExclusionRequestSchema = z.strictObject({
  scopeCode: z.string().min(1).max(40).nullable(),
  reason: grantReasonSchema,
  idempotencyKey: idSchema,
});
export type AddReviewerExclusionRequest = z.output<typeof addReviewerExclusionRequestSchema>;

/** An exclusion: `scope` null means every review scope, including ones added later. */
export const reviewerExclusionSchema = z.object({
  ...historyFields,
  scope: reviewScopeSchema.nullable(),
});
export type ReviewerExclusion = z.infer<typeof reviewerExclusionSchema>;

/** Effective review eligibility for one scope, with each source shown apart (MISC-08). */
export const effectiveEligibilitySchema = z.object({
  scope: reviewScopeSchema,
  eligible: z.boolean(),
  individualGrant: z.boolean(),
  positionRule: z.boolean(),
  excluded: z.boolean(),
});
export type EffectiveEligibility = z.infer<typeof effectiveEligibilitySchema>;

/** `GET /api/staff/:id/grants` (admin), and the person's own via `GET /api/me/access`. */
export const staffGrantsSchema = z.object({
  userId: z.string(),
  canManage: z.boolean(),
  /** The person's position as an Admin sees it (Settings → Staff & access only). */
  position: positionSchema.nullable(),
  effectiveEligibility: z.array(effectiveEligibilitySchema),
  exclusions: z.object({
    active: z.array(reviewerExclusionSchema),
    history: z.array(reviewerExclusionSchema),
  }),
  reviewerEligibility: z.object({
    active: z.array(reviewerEligibilitySchema),
    history: z.array(reviewerEligibilitySchema),
  }),
  capabilities: z.object({
    active: z.array(staffCapabilityGrantSchema),
    history: z.array(staffCapabilityGrantSchema),
  }),
});
export type StaffGrants = z.infer<typeof staffGrantsSchema>;

// ---------------------------------------------------------------------------------------------
// Position-based review eligibility (MISC-08), admin only
// ---------------------------------------------------------------------------------------------

/** `POST /api/review-eligibility/position-rules`. */
export const enablePositionRuleRequestSchema = z.strictObject({
  position: positionSchema,
  scopeCode: z.string().min(1).max(40),
  reason: grantReasonSchema,
  idempotencyKey: idSchema,
});
export type EnablePositionRuleRequest = z.output<typeof enablePositionRuleRequestSchema>;

export const positionRuleSchema = z.object({
  ...historyFields,
  position: positionSchema,
  scope: reviewScopeSchema,
});
export type PositionRule = z.infer<typeof positionRuleSchema>;

/** `GET /api/review-eligibility/position-rules`. No position is eligible until a rule says so. */
export const positionRulesSchema = z.object({
  active: z.array(positionRuleSchema),
  history: z.array(positionRuleSchema),
});
export type PositionRules = z.infer<typeof positionRulesSchema>;

// ---------------------------------------------------------------------------------------------
// Effective capabilities (MM-AO03) and My projects involvement (D12)
// ---------------------------------------------------------------------------------------------

/** Where a capability comes from. `internal`: any active personal account. */
export const PERMISSION_SOURCES = [
  'lab',
  'internal',
  'lab_manager',
  'admin',
  'lead_project_engineer',
  'acceptance_delegate',
  'report_issuer',
  // MM-AO08 concrete contract (no capability action uses them until the concrete routes exist).
  'designated_reviewer',
  'concrete_lab_manager',
] as const;
export type CapabilitySource = (typeof PERMISSION_SOURCES)[number];

export const CAPABILITY_SOURCE_LABEL: Record<CapabilitySource, string> = {
  lab: 'Shared LAB account',
  internal: 'Any staff member',
  lab_manager: 'Lab Manager',
  admin: 'Administrator',
  lead_project_engineer: 'Lead Project Engineer',
  acceptance_delegate: 'Acceptance delegate',
  report_issuer: 'Authorized report issuer',
  designated_reviewer: 'Designated reviewer',
  concrete_lab_manager: 'Lab Manager with this project’s concrete grant',
};

/** The project actions a capability list reports, in display order. */
export const PROJECT_CAPABILITY_ACTIONS = [
  'project.edit',
  'project.lead_project_engineer.change',
  'project_team.manage',
  'project_reviewer.manage',
  'report_issuer.manage',
  'acceptance_delegation.manage',
  'test.accept',
  'program.close',
  'program.reopen',
  'program.priority.set',
  'test.cancel',
  'retention.manage',
  'disposal.approve',
] as const;
export type ProjectCapabilityAction = (typeof PROJECT_CAPABILITY_ACTIONS)[number];

/** How the Team & Permissions screen (MM-AO05) names each project action. */
export const PROJECT_CAPABILITY_ACTION_LABEL: Record<ProjectCapabilityAction, string> = {
  'project.edit': 'Edit project details',
  'project.lead_project_engineer.change': 'Appoint or remove the Lead Project Engineer',
  'project_team.manage': 'Add or remove team members',
  'project_reviewer.manage': 'Assign or remove reviewers',
  'report_issuer.manage': 'Authorize report issuers',
  'acceptance_delegation.manage': 'Add or revoke acceptance delegates',
  'test.accept': 'Accept reviewed tests',
  'program.close': 'Close lab programs',
  'program.reopen': 'Reopen lab programs',
  'program.priority.set': 'Change program priority',
  'test.cancel': 'Cancel tests',
  'retention.manage': 'Manage retention and holds',
  'disposal.approve': 'Approve disposal',
};

export const BLOCKED_REASONS = [
  'account_not_active',
  'shared_lab_account',
  // D02 (MM-AO04): only the Lead Project Engineer could do this, and the project has none yet.
  'no_lead_project_engineer',
  'not_permitted',
] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** Why an action is unavailable, in words (MM-AO05). */
export const BLOCKED_REASON_LABEL: Record<BlockedReason, string> = {
  account_not_active: 'Your account isn’t active.',
  shared_lab_account: 'The shared LAB account can’t do this.',
  no_lead_project_engineer:
    'Only the Lead Project Engineer can do this, and the project has none yet.',
  not_permitted: 'You don’t hold a role or grant that allows this.',
};

export const capabilitySchema = z.object({
  action: z.string(),
  allowed: z.boolean(),
  /** Every source that grants it to this user (empty when not allowed). */
  sources: z.array(z.enum(PERMISSION_SOURCES)),
  /** Why not, and who could: the sources that would grant it. Null when allowed. */
  blocked: z
    .object({ code: z.enum(BLOCKED_REASONS), grantedBy: z.array(z.enum(PERMISSION_SOURCES)) })
    .nullable(),
});
export type Capability = z.infer<typeof capabilitySchema>;

/** D12: why a project is "mine". Relevance only: it grants nothing and hides nothing. */
export const PROJECT_INVOLVEMENTS = [
  'lead_project_engineer',
  'team_member',
  'reviewer',
  'acceptance_delegate',
  'report_issuer',
] as const;
export type ProjectInvolvement = (typeof PROJECT_INVOLVEMENTS)[number];

export const PROJECT_INVOLVEMENT_LABEL: Record<ProjectInvolvement, string> = {
  lead_project_engineer: 'Lead Project Engineer',
  team_member: 'Team member',
  reviewer: 'Reviewer',
  acceptance_delegate: 'Acceptance delegate',
  report_issuer: 'Report issuer',
};

/** `GET /api/projects/:projectId/capabilities`: what the signed-in user may do here, and why. */
export const projectCapabilitiesSchema = z.object({
  projectId: z.string(),
  involvement: z.array(z.enum(PROJECT_INVOLVEMENTS)),
  /** Report scopes this user may issue on this project (lead: every active scope). */
  issuerScopes: z.array(reviewScopeSchema),
  /** Scopes this user is an effective reviewer for on this project. */
  reviewerScopes: z.array(reviewScopeSchema),
  capabilities: z.array(capabilitySchema),
});
export type ProjectCapabilities = z.infer<typeof projectCapabilitiesSchema>;

/**
 * MTR-21: one person involved in the project (lead, team, reviewer, delegate or issuer), their
 * effective job title, and what they may do here and why, computed as for themselves.
 */
export const projectPersonSchema = projectCapabilitiesSchema.omit({ projectId: true }).extend({
  userId: z.string(),
  initials: z.string().nullable(),
  name: z.string(),
  jobTitle: effectiveJobTitleSchema,
});
export type ProjectPerson = z.infer<typeof projectPersonSchema>;

/** `GET /api/projects/:projectId/people`: the same viewers as the team (project_access.read). */
export const projectPeopleSchema = z.object({
  projectId: z.string(),
  people: z.array(projectPersonSchema),
});
export type ProjectPeople = z.infer<typeof projectPeopleSchema>;

// ---------------------------------------------------------------------------------------------
// Lead nomination and appointment (MM-AO04; D01, D02)
// ---------------------------------------------------------------------------------------------

const noteSchema = z
  .string({ error: 'Note must be text' })
  .trim()
  .max(2000, { error: 'Note must be 2000 characters or fewer' })
  .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
    message: "Note can't contain control characters",
  });

/** An optional note (blank means none). */
export const nominationNoteSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  noteSchema.nullish(),
);

export const NOMINATION_STATUSES = ['pending', 'confirmed', 'rejected', 'withdrawn'] as const;
export type NominationStatus = (typeof NOMINATION_STATUSES)[number];

export const leadNominationSchema = z.object({
  id: z.string(),
  nominee: personSnapshotSchema,
  nominatedBy: personSnapshotSchema,
  nominatedAt: z.string(),
  note: z.string().nullable(),
  status: z.enum(NOMINATION_STATUSES),
  decidedBy: personSnapshotSchema.nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
});
export type LeadNomination = z.infer<typeof leadNominationSchema>;

/**
 * `POST /api/projects/:projectId/lead-nominations`: any active personal staff member, on a project
 * with no lead and no pending nomination. A nomination grants nothing (D01).
 */
export const nominateLeadRequestSchema = z.strictObject({
  nomineeUserId: idSchema,
  note: nominationNoteSchema,
  idempotencyKey: idSchema,
});
export type NominateLeadRequest = z.output<typeof nominateLeadRequestSchema>;

/** Confirm, reject (admin) or withdraw (the nominator): always with a reason (D15). */
export const decideNominationRequestSchema = z.strictObject({ reason: grantReasonSchema });
export type DecideNominationRequest = z.output<typeof decideNominationRequestSchema>;

/** MISC-03: confirming needs no reason (blank or absent is none); one given is recorded. */
export const confirmNominationRequestSchema = z.strictObject({
  reason: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    grantReasonSchema.nullish(),
  ),
});
export type ConfirmNominationRequest = z.output<typeof confirmNominationRequestSchema>;

/** `GET /api/projects/:projectId/lead-nominations`: the pending one first, then history. */
export const projectLeadNominationsSchema = z.object({
  projectId: z.string(),
  /** Whether the project has an effective Lead Project Engineer now. */
  hasLead: z.boolean(),
  pending: leadNominationSchema.nullable(),
  history: z.array(leadNominationSchema),
  canNominate: z.boolean(),
  canDecide: z.boolean(),
  canWithdraw: z.boolean(),
});
export type ProjectLeadNominations = z.infer<typeof projectLeadNominationsSchema>;

// ---------------------------------------------------------------------------------------------
// Access summary: "My access" and the admin's read-only view of a person (MM-AO06)
// ---------------------------------------------------------------------------------------------

/** Projects listed in one access summary (ordered by project number; `projectsTotal` counts all). */
export const ACCESS_SUMMARY_PROJECT_LIMIT = 200;

const sinceSchema = z.object({
  since: z.string(),
  by: personSnapshotSchema,
  reason: z.string().nullable(),
});

export const accessProjectSchema = z.object({
  project: z.object({ id: z.string(), projectNumber: z.string(), name: z.string() }),
  /** Responsibilities on this project. */
  lead: z.boolean(),
  teamMember: sinceSchema.nullable(),
  reviewer: z.array(
    sinceSchema.extend({
      scope: reviewScopeSchema,
      effective: z.boolean(),
      blockedReason: z.enum(['account_not_active', 'eligibility_revoked']).nullable(),
    }),
  ),
  /** Scoped grants on this project. */
  acceptanceDelegate: sinceSchema.nullable(),
  reportIssuer: z.array(
    sinceSchema.extend({
      scope: reviewScopeSchema,
      expiresAt: z.string().nullable(),
      effective: z.boolean(),
      blockedReason: z.enum(['account_not_active', 'expired']).nullable(),
    }),
  ),
  /** Nominated as Lead Project Engineer, waiting for an admin (grants nothing, D01). */
  pendingLeadNomination: z.boolean(),
});
export type AccessProject = z.infer<typeof accessProjectSchema>;

/**
 * `GET /api/me/access` (one's own) and `GET /api/staff/:id/access` (admin, read-only): current
 * roles, per-person grants and project responsibilities with their sources. Active rows only;
 * history stays on each project's Team & Permissions page.
 */
export const accessSummarySchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  initials: z.string().nullable(),
  accountType: z.string(),
  status: z.string(),
  effectiveJobTitle: effectiveJobTitleSchema,
  roles: z.array(z.enum(['admin', 'lab_manager'])),
  reviewerEligibility: z.array(reviewerEligibilitySchema),
  capabilities: z.array(staffCapabilityGrantSchema),
  projects: z.array(accessProjectSchema),
  projectsTotal: z.number(),
});
export type AccessSummary = z.infer<typeof accessSummarySchema>;

// ---------------------------------------------------------------------------------------------
// Inherited grants after a lead change (MTR-25, owner decision 2026-10-30)
// ---------------------------------------------------------------------------------------------

export const GRANT_REVIEW_KINDS = ['acceptance_delegate', 'report_issuer', 'reviewer'] as const;
export type GrantReviewKind = (typeof GRANT_REVIEW_KINDS)[number];

export const GRANT_REVIEW_KIND_LABEL: Record<GrantReviewKind, string> = {
  acceptance_delegate: 'Acceptance delegate',
  report_issuer: 'Report issuer',
  reviewer: 'Reviewer',
};

export const GRANT_REVIEW_STATUSES = ['pending', 'kept', 'revoked'] as const;
export type GrantReviewStatus = (typeof GRANT_REVIEW_STATUSES)[number];

/** One inherited grant flagged "Needs review by new lead", and how it was settled. */
export const grantReviewSchema = z.object({
  id: z.string(),
  kind: z.enum(GRANT_REVIEW_KINDS),
  grantId: z.string(),
  /** Who holds the grant. */
  holder: personSnapshotSchema,
  /** The scope label of an issuer grant or reviewer assignment; null for a delegate. */
  scope: z.string().nullable(),
  flaggedFor: personSnapshotSchema,
  flaggedAt: z.string(),
  status: z.enum(GRANT_REVIEW_STATUSES),
  decidedBy: personSnapshotSchema.nullable(),
  decidedAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export type GrantReview = z.infer<typeof grantReviewSchema>;

/** A change of the project's Lead Project Engineer, from the audit (MTR-25 History). */
export const leadChangeSchema = z.object({
  at: z.string(),
  /** The new lead; null when the lead was removed. */
  lead: personSnapshotSchema.nullable(),
  by: personSnapshotSchema.nullable(),
  reason: z.string().nullable(),
});
export type LeadChange = z.infer<typeof leadChangeSchema>;

/** `GET /api/projects/:projectId/grant-reviews`. */
export const projectGrantReviewsSchema = z.object({
  projectId: z.string(),
  /** The project's lead or an admin may keep or revoke a flagged grant. */
  canDecide: z.boolean(),
  pending: z.array(grantReviewSchema),
  history: z.array(grantReviewSchema),
  leadChanges: z.array(leadChangeSchema),
});
export type ProjectGrantReviews = z.infer<typeof projectGrantReviewsSchema>;

/** Body of `POST …/grant-reviews/:id/keep` and `…/revoke`: both need a reason. */
export const decideGrantReviewRequestSchema = z.strictObject({ reason: grantReasonSchema });
export type DecideGrantReviewRequest = z.output<typeof decideGrantReviewRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Team self-join with Lead Project Engineer acceptance (MISC-07, owner decision 2026-10-30)
// ---------------------------------------------------------------------------------------------

export const TEAM_JOIN_STATUSES = ['pending', 'accepted', 'declined'] as const;
export type TeamJoinStatus = (typeof TEAM_JOIN_STATUSES)[number];

/** Shown on a self-joined member until the lead or an admin accepts them. */
export const PENDING_LPE_ACCEPTANCE = 'Pending LPE acceptance';

export const teamJoinRequestSchema = z.object({
  id: z.string(),
  teamMemberId: z.string(),
  person: personSnapshotSchema,
  requestedAt: z.string(),
  status: z.enum(TEAM_JOIN_STATUSES),
  decidedBy: personSnapshotSchema.nullable(),
  decidedAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export type TeamJoinRequest = z.infer<typeof teamJoinRequestSchema>;

/** `GET /api/projects/:projectId/team-join-requests`. */
export const projectTeamJoinRequestsSchema = z.object({
  projectId: z.string(),
  /** The viewer may ask to join (a personal account not on the team and not its lead). */
  canRequest: z.boolean(),
  /** The viewer is the project's lead or an admin. */
  canDecide: z.boolean(),
  /** The viewer's own latest request here, so a decline (and its reason) reaches them. */
  mine: teamJoinRequestSchema.nullable(),
  pending: z.array(teamJoinRequestSchema),
});
export type ProjectTeamJoinRequests = z.infer<typeof projectTeamJoinRequestsSchema>;

/** Body of `POST …/team-join-requests`: a retry with the same key returns the same request. */
export const requestTeamJoinSchema = z.strictObject({ idempotencyKey: z.uuid() });

/** Body of `POST …/team-join-requests/:id/accept`: a reason is optional. */
export const acceptTeamJoinSchema = confirmNominationRequestSchema;

/** Body of `POST …/team-join-requests/:id/decline`: a reason is required. */
export const declineTeamJoinSchema = z.strictObject({ reason: grantReasonSchema });
