import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ACCESS_SUMMARY_PROJECT_LIMIT,
  effectiveJobTitle,
  type AccessProject,
  type AccessSummary,
  type PersonSnapshot,
  type ReviewScope,
  type StaffRole,
} from '@materialmule/shared';
import { DatabaseService } from '../database/database.service.js';
import type { AuthUser } from '../auth/policy.js';
import { StaffGrantsService } from './staff-grants.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Started {
  project_id: string;
  since: Date;
  by_user_id: string;
  by_initials: string | null;
  by_name: string;
  reason: string | null;
}

const since = (row: Started) => ({
  since: row.since.toISOString(),
  by: { userId: row.by_user_id, initials: row.by_initials, name: row.by_name } as PersonSnapshot,
  reason: row.reason,
});

/** The started-by columns of a grant table, aliased for `Started`. */
const startedColumns = (by: string, at: string, reason: string) =>
  `project_id, ${at} AS since, ${by}_user_id AS by_user_id,
   ${by}_initials_snapshot AS by_initials, ${by}_name_snapshot AS by_name, ${reason} AS reason`;

/**
 * Access summary (MM-AO06): one person's current app roles, per-person grants (reviewer
 * eligibility, "Can create and lead projects") and, per project, their responsibilities (Lead
 * Project Engineer, team member, reviewer by scope) and scoped grants (acceptance delegate,
 * report issuer by scope), each with who started it, when and why. Active rows only; a reviewer
 * assignment or issuer grant that no longer counts is listed with `effective: false` and why.
 * Read-only: it reads the same tables the policy reads, and changes nothing.
 */
@Injectable()
export class AccessSummaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly grants: StaffGrantsService,
  ) {}

  async summary(userId: string, caller: AuthUser): Promise<AccessSummary> {
    if (!UUID_PATTERN.test(userId)) throw new NotFoundException({ code: 'not_found' });
    const db = this.database.pool;
    const { rows: people } = await db.query<{
      display_name: string;
      official_initials: string | null;
      account_type: string;
      status: string;
      job_title: string | null;
      job_title_override: string | null;
      roles: StaffRole[];
    }>(
      `SELECT display_name, official_initials, account_type, status, job_title,
              job_title_override,
              COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM role_assignment r
                        WHERE r.user_id = u.id), '{}') AS roles
       FROM app_user u WHERE id = $1`,
      [userId],
    );
    const person = people[0];
    if (!person) throw new NotFoundException({ code: 'not_found' });

    const grants = await this.grants.grants(userId, caller);
    const { rows: scopeRows } = await db.query<ReviewScope>('SELECT code, label FROM review_scope');
    const scopes = new Map(scopeRows.map((row) => [row.code, row]));

    const { rows: projectRows } = await db.query<{
      id: string;
      project_number: string;
      name: string;
      lead: boolean;
      total: number;
    }>(
      `WITH involved AS (
         SELECT id AS project_id FROM project WHERE lead_project_engineer_user_id = $1
         UNION SELECT project_id FROM project_team_member WHERE user_id = $1 AND removed_at IS NULL
         UNION SELECT project_id FROM project_reviewer_assignment
               WHERE reviewer_user_id = $1 AND removed_at IS NULL
         UNION SELECT project_id FROM acceptance_delegation
               WHERE delegate_user_id = $1 AND revoked_at IS NULL
         UNION SELECT project_id FROM project_report_issuer_grant
               WHERE issuer_user_id = $1 AND revoked_at IS NULL
         UNION SELECT project_id FROM project_lead_nomination
               WHERE nominee_user_id = $1 AND status = 'pending'
       )
       SELECT p.id, p.project_number, p.name,
              p.lead_project_engineer_user_id IS NOT DISTINCT FROM $1::uuid AS lead,
              (count(*) OVER ())::int AS total
       FROM project p JOIN involved i ON i.project_id = p.id
       ORDER BY p.project_number, p.id
       LIMIT ${ACCESS_SUMMARY_PROJECT_LIMIT}`,
      [userId],
    );
    const ids = projectRows.map((row) => row.id);
    const active = person.status === 'active';

    const [team, reviewers, delegates, issuers, nominations] = await Promise.all([
      db.query<Started>(
        `SELECT ${startedColumns('added_by', 'added_at', 'add_reason')}
         FROM project_team_member
         WHERE user_id = $1 AND removed_at IS NULL AND project_id = ANY($2::uuid[])`,
        [userId, ids],
      ),
      db.query<Started & { scope_code: string; eligible: boolean }>(
        `SELECT ${startedColumns('assigned_by', 'assigned_at', 'assign_reason')}, a.scope_code,
                EXISTS (SELECT 1 FROM reviewer_eligibility e
                        WHERE e.user_id = a.reviewer_user_id AND e.scope_code = a.scope_code
                          AND e.revoked_at IS NULL) AS eligible
         FROM project_reviewer_assignment a
         WHERE reviewer_user_id = $1 AND removed_at IS NULL AND project_id = ANY($2::uuid[])
         ORDER BY assigned_at, id`,
        [userId, ids],
      ),
      db.query<Started>(
        `SELECT ${startedColumns('granted_by', 'granted_at', 'grant_reason')}
         FROM acceptance_delegation
         WHERE delegate_user_id = $1 AND revoked_at IS NULL AND project_id = ANY($2::uuid[])`,
        [userId, ids],
      ),
      db.query<Started & { report_scope_code: string; expires_at: Date | null; expired: boolean }>(
        `SELECT ${startedColumns('granted_by', 'granted_at', 'grant_reason')}, report_scope_code,
                expires_at, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
         FROM project_report_issuer_grant
         WHERE issuer_user_id = $1 AND revoked_at IS NULL AND project_id = ANY($2::uuid[])
         ORDER BY granted_at, id`,
        [userId, ids],
      ),
      db.query<{ project_id: string }>(
        `SELECT project_id FROM project_lead_nomination
         WHERE nominee_user_id = $1 AND status = 'pending' AND project_id = ANY($2::uuid[])`,
        [userId, ids],
      ),
    ]);

    const projects: AccessProject[] = projectRows.map((row) => {
      const teamRow = team.rows.find((t) => t.project_id === row.id);
      const delegateRow = delegates.rows.find((d) => d.project_id === row.id);
      return {
        project: { id: row.id, projectNumber: row.project_number, name: row.name },
        lead: row.lead,
        teamMember: teamRow ? since(teamRow) : null,
        reviewer: reviewers.rows
          .filter((r) => r.project_id === row.id)
          .map((r) => {
            const blockedReason = !active
              ? ('account_not_active' as const)
              : !r.eligible
                ? ('eligibility_revoked' as const)
                : null;
            return {
              ...since(r),
              scope: scopes.get(r.scope_code)!,
              effective: blockedReason === null,
              blockedReason,
            };
          }),
        acceptanceDelegate: delegateRow ? since(delegateRow) : null,
        reportIssuer: issuers.rows
          .filter((g) => g.project_id === row.id)
          .map((g) => {
            const blockedReason = !active
              ? ('account_not_active' as const)
              : g.expired
                ? ('expired' as const)
                : null;
            return {
              ...since(g),
              scope: scopes.get(g.report_scope_code)!,
              expiresAt: g.expires_at?.toISOString() ?? null,
              effective: blockedReason === null,
              blockedReason,
            };
          }),
        pendingLeadNomination: nominations.rows.some((n) => n.project_id === row.id),
      };
    });

    return {
      userId,
      displayName: person.display_name,
      initials: person.official_initials,
      accountType: person.account_type,
      status: person.status,
      effectiveJobTitle: effectiveJobTitle(person.job_title, person.job_title_override),
      roles: person.roles,
      reviewerEligibility: grants.reviewerEligibility.active,
      capabilities: grants.capabilities.active,
      projects,
      projectsTotal: projectRows[0]?.total ?? 0,
    };
  }
}
