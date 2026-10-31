import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PROJECT_ACCESS_HISTORY_LIMIT,
  PROJECT_CAPABILITY_ACTIONS,
  addTeamMemberRequestSchema,
  approveReviewerRequestSchema,
  effectiveJobTitle,
  assignReviewerRequestSchema,
  endGrantRequestSchema,
  grantReportIssuerRequestSchema,
  revokeReportIssuerRequestSchema,
  type Capability,
  type ProjectCapabilities,
  type ProjectPeople,
  type ProjectReportIssuers,
  type ProjectReviewers,
  type ProjectTeam,
  type ReceiverOption,
  type ReportIssuerGrant,
  type ReviewScope,
  type ReviewerAssignment,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import {
  can,
  permissionSources,
  possibleSources,
  type AuthUser,
  type Permission,
  type ProjectContext,
} from '../auth/policy.js';
import { asLocked, isActiveStaff, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { likePattern } from '../staff/staff.service.js';
import { parseBody } from '../validation/parse-body.js';
import { lockReviewEligibility } from './review-eligibility.js';
import {
  REPORT_ISSUER_GRANT,
  REVIEWABLE_GRANTS,
  REVIEWER_ASSIGNMENT,
  REVIEW_APPROVAL,
  TEAM_MEMBER,
  endGrant,
  findByKey,
  hasActive,
  historyView,
  insertGrant,
  listGrants,
  lockGrant,
  lockGrantReviews,
  type GrantRow,
  type GrantTable,
} from './grant-tables.js';
import { involvementOf, projectPeopleIds } from './involvement.js';

/** People offered by the reviewer lookup (MM-AO05); typing narrows it. */
const ELIGIBLE_REVIEWER_LIMIT = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = Pool | PoolClient;

export function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, errors: [{ field, code, message }] });
}

export const forbidden = () => new ForbiddenException({ code: 'forbidden' });

interface ProjectFacts {
  id: string;
  lead_project_engineer_user_id: string | null;
  project_number: string;
}

export async function findProject(
  db: Db,
  id: string,
  lock: '' | 'FOR SHARE' | 'FOR UPDATE' = '',
): Promise<ProjectFacts | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<ProjectFacts>(
    `SELECT id, lead_project_engineer_user_id, project_number FROM project WHERE id = $1 ${lock}`,
    [id],
  );
  return rows[0] ?? null;
}

/** Active scopes by code (`review_scope`). */
export async function activeScopes(db: Db): Promise<Map<string, ReviewScope>> {
  const { rows } = await db.query<ReviewScope>(
    'SELECT code, label FROM review_scope WHERE active ORDER BY sort_order, code',
  );
  return new Map(rows.map((row) => [row.code, row]));
}

async function allScopes(db: Db): Promise<Map<string, ReviewScope>> {
  const { rows } = await db.query<ReviewScope>(
    'SELECT code, label FROM review_scope ORDER BY sort_order, code',
  );
  return new Map(rows.map((row) => [row.code, row]));
}

/** What a project-scoped check needs, read from the project as it stands (never the browser). */
export async function projectContext(
  db: Db,
  project: ProjectFacts,
  reportScope?: string,
  reviewScope?: string,
): Promise<ProjectContext> {
  const { rows: delegates } = await db.query<{ delegate_user_id: string }>(
    `SELECT delegate_user_id FROM acceptance_delegation
     WHERE project_id = $1 AND revoked_at IS NULL`,
    [project.id],
  );
  const context: ProjectContext = {
    leadProjectEngineerUserId: project.lead_project_engineer_user_id,
    acceptanceDelegateUserIds: delegates.map((row) => row.delegate_user_id),
  };
  if (reportScope) {
    const { rows: issuers } = await db.query<{ issuer_user_id: string }>(
      `SELECT issuer_user_id FROM project_report_issuer_grant
       WHERE project_id = $1 AND report_scope_code = $2 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [project.id, reportScope],
    );
    context.reportIssuerUserIds = issuers.map((row) => row.issuer_user_id);
  }
  if (reviewScope) {
    context.designatedReviewerUserIds = await designatedReviewers(db, project.id, reviewScope);
  }
  return context;
}

/**
 * MISC-08: who may review on `projectId` in `scope` right now, read live on every check (so an
 * open session loses it the moment eligibility does): an active reviewer assignment with the
 * lead's active approval, effective eligibility and accepted team membership. Account state and
 * the shared LAB rule are applied by the policy on top.
 */
export async function designatedReviewers(
  db: Db,
  projectId: string,
  scope: string,
): Promise<string[]> {
  const { rows } = await db.query<{ reviewer_user_id: string }>(
    `SELECT a.reviewer_user_id FROM project_reviewer_assignment a
     JOIN project_review_approval ap ON ap.reviewer_assignment_id = a.id AND ap.ended_at IS NULL
     WHERE a.project_id = $1 AND a.scope_code = $2 AND a.removed_at IS NULL
       AND reviewer_is_eligible(a.reviewer_user_id, a.scope_code)
       AND project_team_member_accepted(a.project_id, a.reviewer_user_id)`,
    [projectId, scope],
  );
  return rows.map((row) => row.reviewer_user_id);
}

/** One effective capability, with its sources or the reason it is blocked (MM-AO03). */
export function capability(
  user: AuthUser,
  permission: Permission,
  context?: ProjectContext,
): Capability {
  const sources = permissionSources(user, permission, context);
  if (sources.length > 0) return { action: permission, allowed: true, sources, blocked: null };
  const grantedBy = possibleSources(permission);
  const code =
    user.status !== 'active'
      ? 'account_not_active'
      : user.accountType === 'shared_lab'
        ? 'shared_lab_account'
        : // D02: only the lead could, and the project has none yet.
          context &&
            context.leadProjectEngineerUserId === null &&
            grantedBy.includes('lead_project_engineer')
          ? 'no_lead_project_engineer'
          : 'not_permitted';
  return {
    action: permission,
    allowed: false,
    sources: [],
    blocked: { code, grantedBy },
  };
}

/**
 * Project team (D04), scoped reviewers (D04/D05) and Authorized report issuers (D06/D07), plus the
 * signed-in user's effective capabilities on a project (MM-AO03).
 *
 * Every write is one transaction in the documented lock order: the project (FOR UPDATE for a new
 * row, so two grants for one project serialise; FOR SHARE for an ending), then the actor's and the
 * recipient's accounts (FOR SHARE, `lockStanding`), then the reviewer's eligibility or the row
 * being ended. Authority is checked with the request's user before the body is read (403 before
 * 400, and before 404 for a caller who could never manage this anywhere), then again with roles and
 * status as they stand under the locks: a lead change, role removal or disable that committed first
 * wins. The row and its audit event commit together, or nothing does.
 *
 * Exact retries (same key, same intent, same account) return the current list without a second
 * row; a reused key for a different intent is 409 `idempotency_key_reused`. Ending a row that has
 * already ended changes nothing.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async team(projectId: string, user: AuthUser): Promise<ProjectTeam> {
    const project = await this.mustFind(projectId);
    return this.teamView(this.database.pool, project, user);
  }

  async reviewers(projectId: string, user: AuthUser): Promise<ProjectReviewers> {
    const project = await this.mustFind(projectId);
    return this.reviewersView(this.database.pool, project, user);
  }

  async reportIssuers(projectId: string, user: AuthUser): Promise<ProjectReportIssuers> {
    const project = await this.mustFind(projectId);
    return this.issuersView(this.database.pool, project, user);
  }

  /**
   * Active personal staff with active eligibility for a scope (MM-AO05): the people a Lead
   * Project Engineer or admin may assign as reviewers. Lookup only; the assignment re-checks
   * eligibility under lock.
   */
  async eligibleReviewers(
    scopeCode: string,
    search: string | undefined,
  ): Promise<ReceiverOption[]> {
    const db = this.database.pool;
    const scopes = await activeScopes(db);
    if (!scopes.has(scopeCode)) throw new NotFoundException({ code: 'review_scope_not_found' });
    const text = likePattern(search?.trim() ?? '');
    const { rows } = await db.query<{
      id: string;
      official_initials: string;
      display_name: string;
    }>(
      `SELECT u.id, u.official_initials, u.display_name
       FROM app_user u
       WHERE reviewer_is_eligible(u.id, $1)
         AND u.status = 'active' AND u.account_type <> 'shared_lab'
         AND u.official_initials IS NOT NULL
         AND ($2 = '' OR u.official_initials ILIKE $2 || '%' OR u.display_name ILIKE '%' || $2 || '%')
       ORDER BY u.official_initials, lower(u.display_name), u.id
       LIMIT ${ELIGIBLE_REVIEWER_LIMIT}`,
      [scopeCode, text],
    );
    return rows.map((row) => ({
      id: row.id,
      initials: row.official_initials,
      displayName: row.display_name,
    }));
  }

  async capabilities(projectId: string, user: AuthUser): Promise<ProjectCapabilities> {
    const db = this.database.pool;
    const project = await this.mustFind(projectId);
    const context = await projectContext(db, project);
    const scopes = await activeScopes(db);
    return this.capabilitiesOf(db, project, context, scopes, user);
  }

  /**
   * MTR-21: each person on the project with their effective job title and what they may do here,
   * and why: the capability list computed as for them, from their roles and status as they stand.
   * The same viewers as the team itself (project_access.read); it reveals nothing the team,
   * reviewer and grant lists don't already show, apart from each person's org-wide roles.
   */
  async people(projectId: string): Promise<ProjectPeople> {
    const db = this.database.pool;
    const project = await this.mustFind(projectId);
    const context = await projectContext(db, project);
    const scopes = await activeScopes(db);
    const ids = await projectPeopleIds(db, project.id);
    const { rows } = await db.query<{
      id: string;
      account_type: AuthUser['accountType'];
      status: AuthUser['status'];
      display_name: string;
      official_initials: string | null;
      job_title: string | null;
      job_title_override: string | null;
      roles: AuthUser['roles'];
    }>(
      `SELECT u.id, u.account_type, u.status, u.display_name, u.official_initials, u.job_title,
              u.job_title_override,
              COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM role_assignment r
                        WHERE r.user_id = u.id), '{}') AS roles
       FROM app_user u WHERE u.id = ANY($1::uuid[])
       ORDER BY u.official_initials NULLS LAST, lower(u.display_name), u.id`,
      [ids],
    );
    const people = [];
    for (const row of rows) {
      const subject: AuthUser = {
        userId: row.id,
        sessionId: '',
        accountType: row.account_type,
        status: row.status,
        roles: row.roles,
        displayName: row.display_name,
        initials: row.official_initials,
      };
      const { projectId: _projectId, ...capabilities } = await this.capabilitiesOf(
        db,
        project,
        context,
        scopes,
        subject,
      );
      people.push({
        userId: row.id,
        initials: row.official_initials,
        name: row.display_name,
        jobTitle: effectiveJobTitle(row.job_title, row.job_title_override),
        ...capabilities,
      });
    }
    return { projectId: project.id, people };
  }

  private async capabilitiesOf(
    db: Pool,
    project: ProjectFacts,
    context: ProjectContext,
    scopes: Map<string, ReviewScope>,
    user: AuthUser,
  ): Promise<ProjectCapabilities> {
    const { rows: issuing } = await db.query<{ report_scope_code: string }>(
      `SELECT report_scope_code FROM project_report_issuer_grant
       WHERE project_id = $1 AND issuer_user_id = $2 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [project.id, user.userId],
    );
    const issuerScopes = [...scopes.values()].filter((scope) =>
      can(user, 'report.issue', {
        ...context,
        reportIssuerUserIds: issuing.some((row) => row.report_scope_code === scope.code)
          ? [user.userId]
          : [],
      }),
    );
    // MISC-08: the same live check the server applies to a review action, never assignment alone.
    const reviewerScopes: ReviewScope[] = [];
    for (const scope of scopes.values()) {
      const designated = await designatedReviewers(db, project.id, scope.code);
      if (
        can(user, 'concrete.review', { ...context, designatedReviewerUserIds: designated }) &&
        designated.includes(user.userId)
      ) {
        reviewerScopes.push(scope);
      }
    }
    return {
      projectId: project.id,
      involvement: await involvementOf(db, project.id, user.userId),
      issuerScopes,
      reviewerScopes,
      capabilities: PROJECT_CAPABILITY_ACTIONS.map((action) => capability(user, action, context)),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Team (D04)
  // -------------------------------------------------------------------------------------------

  addTeamMember(projectId: string, body: unknown, user: AuthUser): Promise<ProjectTeam> {
    return this.start(projectId, user, 'project_team.manage', TEAM_MEMBER, async (ctx) => {
      const request = parseBody(addTeamMemberRequestSchema, body);
      return {
        subjectId: request.userId,
        subjectField: 'userId',
        scope: null,
        reason: request.reason,
        key: request.idempotencyKey,
        hash: intentHash({ projectId, userId: request.userId, reason: request.reason }),
        check: async () => {
          if (request.userId === ctx.project.lead_project_engineer_user_id) {
            unprocessable(
              'invalid_recipient',
              'userId',
              'The Lead Project Engineer already leads this project',
            );
          }
        },
        view: (client) => this.teamView(client, ctx.project, ctx.user),
      };
    });
  }

  removeTeamMember(projectId: string, id: string, body: unknown, user: AuthUser) {
    return this.end(projectId, id, body, user, 'project_team.manage', TEAM_MEMBER, (c, p, u) =>
      this.teamView(c, p, u),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Scoped reviewers (D04/D05)
  // -------------------------------------------------------------------------------------------

  assignReviewer(projectId: string, body: unknown, user: AuthUser): Promise<ProjectReviewers> {
    return this.start(
      projectId,
      user,
      'project_reviewer.manage',
      REVIEWER_ASSIGNMENT,
      async (ctx) => {
        const request = parseBody(assignReviewerRequestSchema, body);
        return {
          subjectId: request.reviewerUserId,
          subjectField: 'reviewerUserId',
          scope: request.scopeCode,
          reason: request.reason,
          key: request.idempotencyKey,
          hash: intentHash({
            projectId,
            reviewerUserId: request.reviewerUserId,
            scopeCode: request.scopeCode,
            reason: request.reason,
          }),
          check: async (client) => {
            await requireActiveScope(client, request.scopeCode);
            // MISC-08: any eligibility change commits before or after this assignment, never
            // between the check and the insert.
            await lockReviewEligibility(client);
            const { rows } = await client.query<{ eligible: boolean }>(
              'SELECT reviewer_is_eligible($1, $2) AS eligible',
              [request.reviewerUserId, request.scopeCode],
            );
            if (!rows[0]!.eligible) {
              unprocessable(
                'not_eligible',
                'reviewerUserId',
                'This person isn’t an eligible reviewer for that scope',
              );
            }
          },
          view: (client) => this.reviewersView(client, ctx.project, ctx.user),
        };
      },
    );
  }

  removeReviewer(projectId: string, id: string, body: unknown, user: AuthUser) {
    return this.end(
      projectId,
      id,
      body,
      user,
      'project_reviewer.manage',
      REVIEWER_ASSIGNMENT,
      (c, p, u) => this.reviewersView(c, p, u),
    );
  }

  /**
   * MISC-08: the lead explicitly approves an assigned reviewer for this project and scope. Needs
   * effective eligibility and accepted team membership now; the database refuses anyone but the
   * current lead, an ended assignment or an ineligible reviewer (project_review_approval_check).
   */
  approveReviewer(
    projectId: string,
    assignmentId: string,
    body: unknown,
    user: AuthUser,
  ): Promise<ProjectReviewers> {
    return this.start(projectId, user, 'project_review.approve', REVIEW_APPROVAL, async (ctx) => {
      const request = parseBody(approveReviewerRequestSchema, body);
      const { rows } = UUID_PATTERN.test(assignmentId)
        ? await this.database.pool.query<{ reviewer_user_id: string; scope_code: string }>(
            `SELECT reviewer_user_id, scope_code FROM project_reviewer_assignment
             WHERE id = $1 AND project_id = $2 AND removed_at IS NULL`,
            [assignmentId, projectId],
          )
        : { rows: [] };
      const assignment = rows[0];
      if (!assignment) {
        throw new NotFoundException({ code: 'project_reviewer_assignment_not_found' });
      }
      return {
        subjectId: assignment.reviewer_user_id,
        subjectField: 'reviewerUserId',
        scope: assignment.scope_code,
        reason: request.reason ?? null,
        key: request.idempotencyKey,
        hash: intentHash({ projectId, assignmentId, reason: request.reason ?? null }),
        extra: { reviewer_assignment_id: assignmentId },
        audit: { reviewerAssignmentId: assignmentId },
        check: async (client) => {
          await lockReviewEligibility(client);
          const { rows: state } = await client.query<{
            active: boolean;
            eligible: boolean;
            member: boolean;
          }>(
            `SELECT a.removed_at IS NULL AS active,
                    reviewer_is_eligible(a.reviewer_user_id, a.scope_code) AS eligible,
                    project_team_member_accepted(a.project_id, a.reviewer_user_id) AS member
             FROM project_reviewer_assignment a WHERE a.id = $1 FOR SHARE`,
            [assignmentId],
          );
          if (!state[0]?.active) {
            throw new NotFoundException({ code: 'project_reviewer_assignment_not_found' });
          }
          if (!state[0].eligible) {
            unprocessable(
              'not_eligible',
              'reviewerUserId',
              'This person isn’t an eligible reviewer for that scope',
            );
          }
          if (!state[0].member) {
            unprocessable(
              'not_accepted_member',
              'reviewerUserId',
              'Accept this person onto the project team first',
            );
          }
        },
        view: (client) => this.reviewersView(client, ctx.project, ctx.user),
      };
    });
  }

  /** The lead withdraws an approval, with a reason; the assignment stays (MISC-08). */
  withdrawApproval(projectId: string, id: string, body: unknown, user: AuthUser) {
    return this.end(
      projectId,
      id,
      body,
      user,
      'project_review.approve',
      REVIEW_APPROVAL,
      (c, p, u) => this.reviewersView(c, p, u),
      (raw) => ({
        reason: parseBody(endGrantRequestSchema, raw).reason,
        extra: { end_kind: 'withdrawn' },
        audit: { endKind: 'withdrawn' },
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Authorized report issuers (D06/D07)
  // -------------------------------------------------------------------------------------------

  grantReportIssuer(projectId: string, body: unknown, user: AuthUser) {
    return this.start(projectId, user, 'report_issuer.manage', REPORT_ISSUER_GRANT, async (ctx) => {
      const request = parseBody(grantReportIssuerRequestSchema, body);
      const expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;
      return {
        subjectId: request.issuerUserId,
        subjectField: 'issuerUserId',
        scope: request.scopeCode,
        reason: request.reason,
        key: request.idempotencyKey,
        hash: intentHash({
          projectId,
          issuerUserId: request.issuerUserId,
          scopeCode: request.scopeCode,
          reason: request.reason,
          approvalReference: request.approvalReference ?? null,
          expiresAt: expiresAt?.toISOString() ?? null,
        }),
        extra: { approval_reference: request.approvalReference ?? null, expires_at: expiresAt },
        audit: {
          approvalReference: request.approvalReference ?? null,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
        check: async (client) => {
          await requireActiveScope(client, request.scopeCode);
          if (request.issuerUserId === ctx.project.lead_project_engineer_user_id) {
            unprocessable(
              'invalid_recipient',
              'issuerUserId',
              'The Lead Project Engineer already issues reports on this project',
            );
          }
          if (expiresAt) {
            const { rows } = await client.query<{ future: boolean }>(
              'SELECT $1::timestamptz > now() AS future',
              [expiresAt],
            );
            if (!rows[0]!.future) {
              unprocessable('invalid_expiry', 'expiresAt', 'Expiry must be in the future');
            }
          }
        },
        view: (client) => this.issuersView(client, ctx.project, ctx.user),
      };
    });
  }

  /** Ordinary revocation or emergency suspension (D06); either needs a reason. */
  revokeReportIssuer(projectId: string, id: string, body: unknown, user: AuthUser) {
    return this.end(
      projectId,
      id,
      body,
      user,
      'report_issuer.manage',
      REPORT_ISSUER_GRANT,
      (c, p, u) => this.issuersView(c, p, u),
      (raw) => {
        const request = parseBody(revokeReportIssuerRequestSchema, raw);
        return {
          reason: request.reason,
          extra: { revocation_kind: request.kind },
          audit: { revocationKind: request.kind },
        };
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // The one write path
  // -------------------------------------------------------------------------------------------

  private async start<View>(
    projectId: string,
    user: AuthUser,
    permission: Permission,
    t: GrantTable,
    prepare: (ctx: { project: ProjectFacts; user: AuthUser }) => Promise<{
      subjectId: string;
      subjectField: string;
      scope: string | null;
      reason: string | null;
      key: string;
      hash: string;
      extra?: Record<string, unknown>;
      audit?: Record<string, unknown>;
      check: (client: PoolClient) => Promise<void>;
      view: (client: PoolClient) => Promise<View>;
    }>,
  ): Promise<View> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const project = await findProject(client, projectId, 'FOR UPDATE');
        if (!project) {
          if (!can(user, permission)) throw forbidden();
          throw new NotFoundException({ code: 'project_not_found' });
        }
        if (!can(user, permission, await projectContext(client, project))) throw forbidden();
        const intent = await prepare({ project, user });

        const standing = await lockStanding(client, [user.userId, intent.subjectId]);
        const actor = asLocked(user, standing);
        if (!can(actor, permission, await projectContext(client, project))) throw forbidden();

        const previous = await findByKey(client, t, intent.key);
        if (previous) {
          if (previous.hash !== intent.hash || previous.by !== user.userId) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          return intent.view(client);
        }

        const subject = standing.get(intent.subjectId);
        if (!isActiveStaff(subject)) {
          unprocessable('invalid_recipient', intent.subjectField, 'Choose an active staff member');
        }
        await intent.check(client);
        if (
          await hasActive(client, t, {
            parentId: project.id,
            subjectId: subject.userId,
            scope: intent.scope,
          })
        ) {
          unprocessable('already_assigned', intent.subjectField, 'Already active on this project');
        }
        await insertGrant(client, t, {
          parentId: project.id,
          subject,
          scope: intent.scope,
          by: standing.get(user.userId)!,
          reason: intent.reason,
          key: intent.key,
          hash: intent.hash,
          extra: intent.extra,
          actor: actorOf(actor),
          audit: { projectNumber: project.project_number, ...intent.audit },
        });
        return intent.view(client);
      });
    } catch (error) {
      // Two different keys racing for the same person and scope can't both win: the active-row
      // index refuses the second (the project lock normally serialises them first).
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'already_assigned' });
      }
      throw error;
    }
  }

  private async end<View>(
    projectId: string,
    id: string,
    body: unknown,
    user: AuthUser,
    permission: Permission,
    t: GrantTable,
    view: (client: PoolClient, project: ProjectFacts, user: AuthUser) => Promise<View>,
    parse: (body: unknown) => {
      reason: string;
      extra?: Record<string, unknown>;
      audit?: Record<string, unknown>;
    } = (raw) => ({ reason: parseBody(endGrantRequestSchema, raw).reason }),
  ): Promise<View> {
    return withTransaction(this.database.pool, async (client) => {
      const project = await findProject(client, projectId, 'FOR SHARE');
      if (!project) {
        if (!can(user, permission)) throw forbidden();
        throw new NotFoundException({ code: 'project_not_found' });
      }
      if (!can(user, permission, await projectContext(client, project))) throw forbidden();
      const request = parse(body);
      const standing = await lockStanding(client, [user.userId]);
      const actor = asLocked(user, standing);
      if (!can(actor, permission, await projectContext(client, project))) throw forbidden();
      // Ending a reviewable grant settles its review flag (MTR-25): same lock order as Revoke.
      if (REVIEWABLE_GRANTS.includes(t)) await lockGrantReviews(client, [project.id]);
      const row = UUID_PATTERN.test(id)
        ? await lockGrant(client, t, id, { column: 'project_id', value: project.id })
        : null;
      if (!row) throw new NotFoundException({ code: `${t.table}_not_found` });
      if (!row.endedAt) {
        await endGrant(client, t, row, {
          by: standing.get(user.userId)!,
          reason: request.reason,
          extra: request.extra,
          actor: actorOf(actor),
          audit: { projectNumber: project.project_number, ...request.audit },
        });
      }
      return view(client, project, actor);
    });
  }

  private async mustFind(projectId: string): Promise<ProjectFacts> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    return project;
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  private async teamView(db: Db, project: ProjectFacts, user: AuthUser): Promise<ProjectTeam> {
    const rows = await listGrants(
      db,
      TEAM_MEMBER,
      { column: 'project_id', value: project.id },
      {
        historyLimit: PROJECT_ACCESS_HISTORY_LIMIT,
      },
    );
    const toView = (row: GrantRow) => ({ ...historyView(row), person: row.subject });
    return {
      projectId: project.id,
      canManage: can(user, 'project_team.manage', await projectContext(db, project)),
      active: rows.active.map(toView),
      history: rows.history.map(toView),
      historyTotal: rows.historyTotal,
    };
  }

  private async reviewersView(
    db: Db,
    project: ProjectFacts,
    user: AuthUser,
  ): Promise<ProjectReviewers> {
    const scopes = await allScopes(db);
    const rows = await listGrants(
      db,
      REVIEWER_ASSIGNMENT,
      { column: 'project_id', value: project.id },
      {
        historyLimit: PROJECT_ACCESS_HISTORY_LIMIT,
        extra: `(SELECT u.status = 'active' FROM app_user u WHERE u.id = reviewer_user_id)
                  AS account_active,
                reviewer_is_eligible(reviewer_user_id, scope_code) AS eligible,
                project_team_member_accepted(project_id, reviewer_user_id) AS accepted_member,
                (SELECT row_to_json(ap) FROM project_review_approval ap
                 WHERE ap.reviewer_assignment_id = ${REVIEWER_ASSIGNMENT.table}.id
                   AND ap.ended_at IS NULL) AS approval`,
      },
    );
    const toView = (row: GrantRow): ReviewerAssignment => {
      const approval = row.raw.approval as Record<string, string | null> | null;
      const blockedReason = row.endedAt
        ? null
        : !row.raw.account_active
          ? 'account_not_active'
          : !row.raw.eligible
            ? 'eligibility_revoked'
            : !row.raw.accepted_member
              ? 'not_accepted_member'
              : !approval
                ? 'not_approved'
                : null;
      return {
        ...historyView(row),
        reviewer: row.subject,
        scope: scopes.get(row.scope!)!,
        effective: !row.endedAt && blockedReason === null,
        blockedReason,
        approval:
          approval && !row.endedAt
            ? {
                id: approval.id!,
                approvedBy: {
                  userId: approval.approved_by_user_id!,
                  initials: approval.approved_by_initials_snapshot ?? null,
                  name: approval.approved_by_name_snapshot ?? '',
                },
                approvedAt: new Date(approval.approved_at!).toISOString(),
                reason: approval.approve_reason ?? null,
              }
            : null,
        eligible: Boolean(row.raw.eligible),
        acceptedMember: Boolean(row.raw.accepted_member),
      };
    };
    const approvals = await listGrants(
      db,
      REVIEW_APPROVAL,
      { column: 'project_id', value: project.id },
      { historyLimit: PROJECT_ACCESS_HISTORY_LIMIT, extra: 'reviewer_assignment_id, end_kind' },
    );
    const context = await projectContext(db, project);
    return {
      projectId: project.id,
      canManage: can(user, 'project_reviewer.manage', context),
      canApprove: can(user, 'project_review.approve', context),
      approvalHistory: approvals.history.map((row) => ({
        ...historyView(row),
        reviewer: row.subject,
        scope: scopes.get(row.scope!)!,
        reviewerAssignmentId: row.raw.reviewer_assignment_id as string,
        endKind: row.raw.end_kind as 'withdrawn' | 'eligibility_lost' | 'assignment_ended',
      })),
      active: rows.active.map(toView),
      history: rows.history.map(toView),
      historyTotal: rows.historyTotal,
    };
  }

  private async issuersView(
    db: Db,
    project: ProjectFacts,
    user: AuthUser,
  ): Promise<ProjectReportIssuers> {
    const scopes = await allScopes(db);
    const rows = await listGrants(
      db,
      REPORT_ISSUER_GRANT,
      { column: 'project_id', value: project.id },
      {
        historyLimit: PROJECT_ACCESS_HISTORY_LIMIT,
        extra: `approval_reference, expires_at, revocation_kind,
                (expires_at IS NOT NULL AND expires_at <= now()) AS expired,
                (SELECT u.status = 'active' FROM app_user u WHERE u.id = issuer_user_id)
                  AS account_active`,
      },
    );
    const toView = (row: GrantRow): ReportIssuerGrant => {
      const blockedReason = row.endedAt
        ? null
        : !row.raw.account_active
          ? 'account_not_active'
          : row.raw.expired
            ? 'expired'
            : null;
      return {
        ...historyView(row),
        issuer: row.subject,
        scope: scopes.get(row.scope!)!,
        approvalReference: (row.raw.approval_reference as string | null) ?? null,
        expiresAt: (row.raw.expires_at as Date | null)?.toISOString() ?? null,
        revocationKind: (row.raw.revocation_kind as 'ordinary' | 'emergency' | null) ?? null,
        effective: !row.endedAt && blockedReason === null,
        blockedReason,
      };
    };
    return {
      projectId: project.id,
      canManage: can(user, 'report_issuer.manage', await projectContext(db, project)),
      active: rows.active.map(toView),
      history: rows.history.map(toView),
      historyTotal: rows.historyTotal,
    };
  }
}

async function requireActiveScope(db: Db, code: string): Promise<void> {
  const scopes = await activeScopes(db);
  if (!scopes.has(code)) unprocessable('invalid_scope', 'scopeCode', 'Choose a review scope');
}

export type { ProjectFacts };
