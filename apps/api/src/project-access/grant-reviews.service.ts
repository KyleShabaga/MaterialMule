import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PROJECT_ACCESS_HISTORY_LIMIT,
  decideGrantReviewRequestSchema,
  type GrantReview,
  type GrantReviewKind,
  type LeadChange,
  type ProjectGrantReviews,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { asLocked, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { announceActionItem } from '../notifications/action-items.js';
import type { Recorder } from '../projects/lead-appointment.js';
import { parseBody } from '../validation/parse-body.js';
import {
  ACCEPTANCE_DELEGATION,
  REPORT_ISSUER_GRANT,
  REVIEWER_ASSIGNMENT,
  endGrant,
  lockGrant,
  lockGrantReviews,
  type GrantTable,
} from './grant-tables.js';
import { activeScopes, findProject, forbidden } from './project-access.service.js';

// MTR-25 (owner decision, Kyle 2026-10-30): a new Lead Project Engineer inherits the project's
// acceptance-delegate, report-issuer and reviewer grants (D08: they survive) flagged "Needs review
// by new lead". The lead or an admin keeps or revokes each one with a reason. One "Review
// inherited grants" action request per project goes to the lead; migration 0009 resolves it once
// no flag is pending, and settles a flag whenever its grant ends by any route.

type Db = Pool | PoolClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GRANTS: Record<GrantReviewKind, { table: GrantTable; column: string }> = {
  acceptance_delegate: { table: ACCEPTANCE_DELEGATION, column: 'acceptance_delegation_id' },
  report_issuer: { table: REPORT_ISSUER_GRANT, column: 'report_issuer_grant_id' },
  reviewer: { table: REVIEWER_ASSIGNMENT, column: 'reviewer_assignment_id' },
};

/**
 * Flags the project's active delegate, issuer and reviewer grants for its new lead and opens the
 * lead's "Review inherited grants" request when any is pending. Called in the transaction that
 * appoints or changes the lead (never on removal: there is nobody to review them yet).
 */
export async function flagInheritedGrants(
  client: PoolClient,
  input: {
    projectId: string;
    projectNumber: string;
    lead: string;
    by: Recorder;
    actor: AuditActor;
  },
): Promise<void> {
  // Before any flag or action item row: an ending settling this project's flags elsewhere then
  // commits wholly before these flags are raised, or sees them (lockGrantReviews).
  await lockGrantReviews(client, [input.projectId]);
  const params = [input.projectId, input.lead];
  const { rowCount: delegates } = await client.query(
    `INSERT INTO project_grant_review (project_id, acceptance_delegation_id, flagged_for_user_id)
     SELECT project_id, id, $2 FROM acceptance_delegation
     WHERE project_id = $1 AND revoked_at IS NULL
     ON CONFLICT (acceptance_delegation_id)
       WHERE status = 'pending' AND acceptance_delegation_id IS NOT NULL DO NOTHING`,
    params,
  );
  const { rowCount: issuers } = await client.query(
    `INSERT INTO project_grant_review (project_id, report_issuer_grant_id, flagged_for_user_id)
     SELECT project_id, id, $2 FROM project_report_issuer_grant
     WHERE project_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ON CONFLICT (report_issuer_grant_id)
       WHERE status = 'pending' AND report_issuer_grant_id IS NOT NULL DO NOTHING`,
    params,
  );
  const { rowCount: reviewers } = await client.query(
    `INSERT INTO project_grant_review (project_id, reviewer_assignment_id, flagged_for_user_id)
     SELECT project_id, id, $2 FROM project_reviewer_assignment
     WHERE project_id = $1 AND removed_at IS NULL
     ON CONFLICT (reviewer_assignment_id)
       WHERE status = 'pending' AND reviewer_assignment_id IS NOT NULL DO NOTHING`,
    params,
  );
  const flagged = (delegates ?? 0) + (issuers ?? 0) + (reviewers ?? 0);
  if (flagged > 0) {
    await recordAudit(client, {
      action: 'project.grants_flagged_for_review',
      entityType: 'project',
      entityId: input.projectId,
      actor: input.actor,
      after: { leadProjectEngineerUserId: input.lead, flagged },
    });
  }
  const { rows: pending } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM project_grant_review
     WHERE project_id = $1 AND status = 'pending'`,
    [input.projectId],
  );
  const count = pending[0]!.count;
  if (count === 0) return;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO action_item (kind, target_user_id, entity_type, entity_id, project_id,
                              created_by_user_id, created_by_initials_snapshot,
                              created_by_name_snapshot, reason)
     VALUES ('grant_review', $2, 'project', $1, $1, $3, $4, $5, $6)
     ON CONFLICT (kind, entity_id) WHERE kind <> 'correction' AND status = 'open' DO NOTHING
     RETURNING id`,
    [
      input.projectId,
      input.lead,
      input.by.userId,
      input.by.initials,
      input.by.displayName,
      `${input.projectNumber}: new Lead Project Engineer; ${count} inherited grant${
        count === 1 ? '' : 's'
      } to keep or revoke`,
    ],
  );
  if (rows[0]) await announceActionItem(client, rows[0].id);
}

/** Only the project's current lead or an admin, on an active personal account (MTR-25). */
function mayDecide(user: AuthUser, lead: string | null): boolean {
  return (
    user.status === 'active' &&
    user.accountType !== 'shared_lab' &&
    (user.userId === lead || user.roles.includes('admin'))
  );
}

interface ReviewRow {
  id: string;
  acceptance_delegation_id: string | null;
  report_issuer_grant_id: string | null;
  reviewer_assignment_id: string | null;
  holder_user_id: string;
  holder_initials: string | null;
  holder_name: string;
  scope_code: string | null;
  flagged_for_user_id: string;
  flagged_for_initials: string | null;
  flagged_for_name: string;
  flagged_at: Date;
  status: GrantReview['status'];
  decided_by_user_id: string | null;
  decided_by_initials_snapshot: string | null;
  decided_by_name_snapshot: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

const SELECT_REVIEWS = `
  SELECT r.id, r.acceptance_delegation_id, r.report_issuer_grant_id, r.reviewer_assignment_id,
         COALESCE(d.delegate_user_id, i.issuer_user_id, a.reviewer_user_id) AS holder_user_id,
         COALESCE(d.delegate_initials_snapshot, i.issuer_initials_snapshot,
                  a.reviewer_initials_snapshot) AS holder_initials,
         COALESCE(d.delegate_name_snapshot, i.issuer_name_snapshot,
                  a.reviewer_name_snapshot) AS holder_name,
         COALESCE(i.report_scope_code, a.scope_code) AS scope_code,
         r.flagged_for_user_id, f.official_initials AS flagged_for_initials,
         f.display_name AS flagged_for_name, r.flagged_at, r.status, r.decided_by_user_id,
         r.decided_by_initials_snapshot, r.decided_by_name_snapshot, r.decided_at,
         r.decision_reason
  FROM project_grant_review r
  JOIN app_user f ON f.id = r.flagged_for_user_id
  LEFT JOIN acceptance_delegation d ON d.id = r.acceptance_delegation_id
  LEFT JOIN project_report_issuer_grant i ON i.id = r.report_issuer_grant_id
  LEFT JOIN project_reviewer_assignment a ON a.id = r.reviewer_assignment_id`;

function kindOf(row: ReviewRow): GrantReviewKind {
  if (row.acceptance_delegation_id) return 'acceptance_delegate';
  return row.report_issuer_grant_id ? 'report_issuer' : 'reviewer';
}

@Injectable()
export class GrantReviewsService {
  constructor(private readonly database: DatabaseService) {}

  async list(projectId: string, user: AuthUser): Promise<ProjectGrantReviews> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    return this.view(this.database.pool, project.id, project.lead_project_engineer_user_id, user);
  }

  keep(projectId: string, reviewId: string, body: unknown, user: AuthUser) {
    return this.decide(projectId, reviewId, body, user, 'kept');
  }

  revoke(projectId: string, reviewId: string, body: unknown, user: AuthUser) {
    return this.decide(projectId, reviewId, body, user, 'revoked');
  }

  private decide(
    projectId: string,
    reviewId: string,
    body: unknown,
    user: AuthUser,
    decision: 'kept' | 'revoked',
  ): Promise<ProjectGrantReviews> {
    return withTransaction(this.database.pool, async (client) => {
      // The project row lock orders this after (or before) any lead change (D09).
      const project = await findProject(client, projectId, 'FOR SHARE');
      if (!project) throw new NotFoundException({ code: 'project_not_found' });
      const lead = project.lead_project_engineer_user_id;
      if (!mayDecide(user, lead)) throw forbidden();
      const { reason } = parseBody(decideGrantReviewRequestSchema, body);
      // Unlocked: only to find the flag and its grant (neither ever changes).
      const { rows } = UUID_PATTERN.test(reviewId)
        ? await client.query<ReviewRow>(`${SELECT_REVIEWS} WHERE r.id = $1 AND r.project_id = $2`, [
            reviewId,
            project.id,
          ])
        : { rows: [] };
      const review = rows[0];
      if (!review) throw new NotFoundException({ code: 'grant_review_not_found' });
      const standing = await lockStanding(client, [user.userId]);
      const actor = asLocked(user, standing);
      if (!mayDecide(actor, lead)) throw forbidden();
      const kind = kindOf(review);
      const grantId =
        review.acceptance_delegation_id ??
        review.report_issuer_grant_id ??
        review.reviewer_assignment_id!;
      // Lock order as every grant ending (lockGrantReviews): this project's flags, the grant, then
      // the flag, re-read under the locks so the first committed decision wins.
      await lockGrantReviews(client, [project.id]);
      const { table } = GRANTS[kind];
      const grant =
        decision === 'revoked'
          ? await lockGrant(client, table, grantId, { column: 'project_id', value: project.id })
          : null;
      const { rows: locked } = await client.query<{
        status: GrantReview['status'];
        decided_by_user_id: string | null;
      }>(`SELECT status, decided_by_user_id FROM project_grant_review WHERE id = $1 FOR UPDATE`, [
        review.id,
      ]);
      const now = locked[0]!;
      if (now.status !== 'pending') {
        // An exact retry of this decision by this person returns the current state.
        if (now.status === decision && now.decided_by_user_id === user.userId) {
          return this.view(client, project.id, lead, actor);
        }
        throw new ConflictException({ code: 'grant_review_decided', status: now.status });
      }
      const by = { userId: user.userId, initials: user.initials, displayName: user.displayName };
      if (decision === 'kept') {
        await client.query(
          `UPDATE project_grant_review
           SET status = 'kept', decided_at = now(), decided_by_user_id = $2,
               decided_by_initials_snapshot = $3, decided_by_name_snapshot = $4,
               decision_reason = $5
           WHERE id = $1`,
          [review.id, by.userId, by.initials, by.displayName, reason],
        );
        await client.query('SELECT project_grant_review_settle($1, $2)', [project.id, by.userId]);
      } else {
        if (!grant) throw new NotFoundException({ code: 'grant_review_not_found' });
        // Ending the grant settles its flag and, with the last one, the request (0009 trigger).
        await endGrant(client, table, grant, {
          by,
          reason,
          actor: actorOf(actor),
          extra: table === REPORT_ISSUER_GRANT ? { revocation_kind: 'ordinary' } : undefined,
          audit: { via: 'grant_review', grantReviewId: review.id },
        });
      }
      await recordAudit(client, {
        action: `project_grant_review.${decision}`,
        entityType: 'project_grant_review',
        entityId: review.id,
        actor: actorOf(actor),
        reason,
        before: { status: 'pending' },
        after: { status: decision, projectId: project.id, kind, grantId },
      });
      return this.view(client, project.id, lead, actor);
    });
  }

  private async view(
    db: Db,
    projectId: string,
    lead: string | null,
    user: AuthUser,
  ): Promise<ProjectGrantReviews> {
    const scopes = await activeScopes(db);
    const { rows } = await db.query<ReviewRow>(
      `${SELECT_REVIEWS} WHERE r.project_id = $1
       ORDER BY (r.status = 'pending') DESC, COALESCE(r.decided_at, r.flagged_at) DESC, r.id
       LIMIT ${PROJECT_ACCESS_HISTORY_LIMIT}`,
      [projectId],
    );
    const reviews = rows.map((row): GrantReview => {
      const decided = row.decided_by_user_id
        ? {
            userId: row.decided_by_user_id,
            initials: row.decided_by_initials_snapshot,
            name: row.decided_by_name_snapshot ?? '',
          }
        : null;
      return {
        id: row.id,
        kind: kindOf(row),
        grantId:
          row.acceptance_delegation_id ?? row.report_issuer_grant_id ?? row.reviewer_assignment_id!,
        holder: {
          userId: row.holder_user_id,
          initials: row.holder_initials,
          name: row.holder_name,
        },
        scope: row.scope_code ? (scopes.get(row.scope_code)?.label ?? row.scope_code) : null,
        flaggedFor: {
          userId: row.flagged_for_user_id,
          initials: row.flagged_for_initials,
          name: row.flagged_for_name,
        },
        flaggedAt: row.flagged_at.toISOString(),
        status: row.status,
        decidedBy: decided,
        decidedAt: row.decided_at?.toISOString() ?? null,
        reason: row.decision_reason,
      };
    });
    return {
      projectId,
      canDecide: mayDecide(user, lead),
      pending: reviews.filter((r) => r.status === 'pending'),
      history: reviews.filter((r) => r.status !== 'pending'),
      leadChanges: await leadChanges(db, projectId),
    };
  }
}

/**
 * The project's lead appointments, changes and removals, newest first, from the audit: a direct
 * change is `project.updated` with the lead in its after-values; a confirmed nomination is
 * `project.lead_appointed`.
 */
async function leadChanges(db: Db, projectId: string): Promise<LeadChange[]> {
  const { rows } = await db.query<{
    occurred_at: Date;
    lead_id: string | null;
    lead_initials: string | null;
    lead_name: string | null;
    actor_user_id: string | null;
    actor_initials_snapshot: string | null;
    actor_name_snapshot: string | null;
    reason: string | null;
  }>(
    `SELECT e.occurred_at, l.id AS lead_id, l.official_initials AS lead_initials,
            l.display_name AS lead_name, e.actor_user_id, e.actor_initials_snapshot,
            e.actor_name_snapshot, e.reason
     FROM audit_event e
     LEFT JOIN app_user l ON l.id = (e.after_values ->> 'leadProjectEngineerUserId')::uuid
     WHERE e.entity_type = 'project' AND e.entity_id = $1
       AND (e.action = 'project.lead_appointed'
            OR (e.action = 'project.updated' AND e.after_values ? 'leadProjectEngineerUserId'))
     ORDER BY e.occurred_at DESC, e.id
     LIMIT ${PROJECT_ACCESS_HISTORY_LIMIT}`,
    [projectId],
  );
  return rows.map((row) => ({
    at: row.occurred_at.toISOString(),
    lead: row.lead_id
      ? { userId: row.lead_id, initials: row.lead_initials, name: row.lead_name ?? '' }
      : null,
    by: row.actor_user_id
      ? {
          userId: row.actor_user_id,
          initials: row.actor_initials_snapshot,
          name: row.actor_name_snapshot ?? '',
        }
      : null,
    reason: row.reason,
  }));
}
