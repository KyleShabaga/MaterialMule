import { PROJECT_INVOLVEMENTS, type ProjectInvolvement } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

/**
 * D12 (Kyle, 2026-10-29): the projects a person is actively involved in, one row per project and
 * reason. The one definition used by "My projects", the involvement labels on the projects list and
 * the capabilities endpoint, so they always agree. Relevance only: it grants nothing and hides
 * nothing (All projects is unchanged).
 *
 * `user` is a SQL parameter placeholder such as `$1`; the value always travels as a parameter.
 * A reviewer counts only while effectively eligible for the assignment's scope (D05, MISC-08); an issuer only while
 * the grant is unexpired (D06).
 */
export function involvementSql(user: string): string {
  return `
    SELECT p.id AS project_id, 'lead_project_engineer' AS involvement FROM project p
    WHERE p.lead_project_engineer_user_id = ${user}
    UNION ALL
    SELECT t.project_id, 'team_member' FROM project_team_member t
    WHERE t.user_id = ${user} AND t.removed_at IS NULL
    UNION ALL
    SELECT a.project_id, 'reviewer' FROM project_reviewer_assignment a
    WHERE a.reviewer_user_id = ${user} AND a.removed_at IS NULL
      AND reviewer_is_eligible(a.reviewer_user_id, a.scope_code)
    UNION ALL
    SELECT d.project_id, 'acceptance_delegate' FROM acceptance_delegation d
    WHERE d.delegate_user_id = ${user} AND d.revoked_at IS NULL
    UNION ALL
    SELECT g.project_id, 'report_issuer' FROM project_report_issuer_grant g
    WHERE g.issuer_user_id = ${user} AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > now())`;
}

/** De-duplicated, in PROJECT_INVOLVEMENTS order. */
export function orderInvolvement(values: readonly string[]): ProjectInvolvement[] {
  return PROJECT_INVOLVEMENTS.filter((value) => values.includes(value));
}

/** How `userId` is involved in one project now. */
export async function involvementOf(
  db: Pool | PoolClient,
  projectId: string,
  userId: string,
): Promise<ProjectInvolvement[]> {
  const { rows } = await db.query<{ involvement: string }>(
    `SELECT DISTINCT involvement FROM (${involvementSql('$1')}) i WHERE i.project_id = $2`,
    [userId, projectId],
  );
  return orderInvolvement(rows.map((row) => row.involvement));
}

/**
 * MTR-21: everyone the Team & Permissions people list shows for a project: the lead, active team
 * members, reviewer assignments (eligible or not), and unrevoked delegate and issuer grants
 * (expired or not), so each listed row can expand to its permissions.
 */
export async function projectPeopleIds(
  db: Pool | PoolClient,
  projectId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM (
       SELECT lead_project_engineer_user_id AS user_id FROM project WHERE id = $1
       UNION ALL
       SELECT user_id FROM project_team_member WHERE project_id = $1 AND removed_at IS NULL
       UNION ALL
       SELECT reviewer_user_id FROM project_reviewer_assignment
       WHERE project_id = $1 AND removed_at IS NULL
       UNION ALL
       SELECT delegate_user_id FROM acceptance_delegation
       WHERE project_id = $1 AND revoked_at IS NULL
       UNION ALL
       SELECT issuer_user_id FROM project_report_issuer_grant
       WHERE project_id = $1 AND revoked_at IS NULL
     ) people WHERE user_id IS NOT NULL`,
    [projectId],
  );
  return rows.map((row) => row.user_id);
}
