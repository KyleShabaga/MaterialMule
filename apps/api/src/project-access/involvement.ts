import { PROJECT_INVOLVEMENTS, type ProjectInvolvement } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

/**
 * D12 (Kyle, 2026-10-29): the projects a person is actively involved in, one row per project and
 * reason. The one definition used by "My projects", the involvement labels on the projects list and
 * the capabilities endpoint, so they always agree. Relevance only: it grants nothing and hides
 * nothing (All projects is unchanged).
 *
 * `user` is a SQL parameter placeholder such as `$1`; the value always travels as a parameter.
 * A reviewer counts only while eligible for the assignment's scope (D05); an issuer only while
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
    JOIN reviewer_eligibility e ON e.user_id = a.reviewer_user_id AND e.scope_code = a.scope_code
     AND e.revoked_at IS NULL
    WHERE a.reviewer_user_id = ${user} AND a.removed_at IS NULL
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
