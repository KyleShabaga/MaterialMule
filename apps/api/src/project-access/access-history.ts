import { NotFoundException } from '@nestjs/common';
import {
  PROJECT_ACCESS_HISTORY_PAGE_SIZE,
  accessHistoryQuerySchema,
  type AccessHistoryEvent,
  type AccessHistoryKind,
  type GrantReviewKind,
  type PersonSnapshot,
  type ProjectAccessHistory,
} from '@materialmule/shared';
import type { Pool } from 'pg';
import { parseBody } from '../validation/parse-body.js';
import {
  ACCEPTANCE_DELEGATION,
  REPORT_ISSUER_GRANT,
  REVIEWER_ASSIGNMENT,
  TEAM_MEMBER,
  type GrantTable,
} from './grant-tables.js';
import { findProject } from './project-access.service.js';

// STRATA-85: Team & permissions › History, paged on the server. One newest-first list of every
// start and end of the project's team places, reviewer assignments, report issuer grants and
// acceptance delegations, its lead appointments and removals (the audit), lead nominations
// (made, rejected, withdrawn; a confirmation is the appointment) and the new lead's review of
// inherited grants. Read-only and as recorded: snapshots, never today's names.

/** One event as the union query returns it. */
interface EventRow {
  event_id: string;
  at: Date;
  kind: AccessHistoryKind;
  s_id: string | null;
  s_initials: string | null;
  s_name: string | null;
  b_id: string | null;
  b_initials: string | null;
  b_name: string | null;
  scope_code: string | null;
  grant_kind: GrantReviewKind | null;
  reason: string | null;
  total: number;
}

const subjectId = (t: GrantTable) => (t.subject === 'user' ? 'user_id' : `${t.subject}_user_id`);

/** The start and end events of one grant table, as union branches. */
function grantEdges(
  t: GrantTable,
  started: AccessHistoryKind,
  ended: AccessHistoryKind | { sql: string },
): string {
  const subject = `${subjectId(t)}, ${t.subject}_initials_snapshot, ${t.subject}_name_snapshot`;
  const scope = t.scope ?? 'NULL::text';
  const endKind = typeof ended === 'string' ? `'${ended}'` : ended.sql;
  return `
    SELECT id::text || ':start' AS event_id, ${t.start.at} AS at, '${started}' AS kind, ${subject},
           ${t.start.by}_user_id, ${t.start.by}_initials_snapshot, ${t.start.by}_name_snapshot,
           ${scope} AS scope_code, NULL::text AS grant_kind, ${t.start.reason} AS reason
    FROM ${t.table} WHERE project_id = $1
    UNION ALL
    SELECT id::text || ':end', ${t.end.at}, ${endKind}, ${subject},
           ${t.end.by}_user_id, ${t.end.by}_initials_snapshot, ${t.end.by}_name_snapshot,
           ${scope}, NULL::text, ${t.end.reason}
    FROM ${t.table} WHERE project_id = $1 AND ${t.end.at} IS NOT NULL`;
}

const EVENTS = `
  ${grantEdges(TEAM_MEMBER, 'team_member_added', 'team_member_removed')}
  UNION ALL
  ${grantEdges(REVIEWER_ASSIGNMENT, 'reviewer_assigned', 'reviewer_removed')}
  UNION ALL
  ${grantEdges(REPORT_ISSUER_GRANT, 'issuer_granted', {
    sql: `CASE WHEN revocation_kind = 'emergency' THEN 'issuer_suspended' ELSE 'issuer_revoked' END`,
  })}
  UNION ALL
  ${grantEdges(ACCEPTANCE_DELEGATION, 'delegate_granted', 'delegate_revoked')}
  UNION ALL
  SELECT e.id::text, e.occurred_at,
         CASE WHEN l.id IS NULL THEN 'lead_removed' ELSE 'lead_appointed' END,
         l.id, l.official_initials, l.display_name,
         e.actor_user_id, e.actor_initials_snapshot, e.actor_name_snapshot,
         NULL::text, NULL::text, e.reason
  FROM audit_event e
  LEFT JOIN app_user l ON l.id = (e.after_values ->> 'leadProjectEngineerUserId')::uuid
  WHERE e.entity_type = 'project' AND e.entity_id = $1
    AND (e.action = 'project.lead_appointed'
         OR (e.action = 'project.updated' AND e.after_values ? 'leadProjectEngineerUserId'))
  UNION ALL
  SELECT id::text || ':start', nominated_at, 'lead_nominated',
         nominee_user_id, nominee_initials_snapshot, nominee_name_snapshot,
         nominated_by_user_id, nominated_by_initials_snapshot, nominated_by_name_snapshot,
         NULL::text, NULL::text, nomination_note
  FROM project_lead_nomination WHERE project_id = $1
  UNION ALL
  SELECT id::text || ':end', decided_at,
         CASE WHEN status = 'rejected' THEN 'nomination_rejected' ELSE 'nomination_withdrawn' END,
         nominee_user_id, nominee_initials_snapshot, nominee_name_snapshot,
         decided_by_user_id, decided_by_initials_snapshot, decided_by_name_snapshot,
         NULL::text, NULL::text, decision_reason
  FROM project_lead_nomination WHERE project_id = $1 AND status IN ('rejected', 'withdrawn')
  UNION ALL
  SELECT r.id::text, r.decided_at,
         CASE WHEN r.status = 'kept' THEN 'grant_kept' ELSE 'grant_revoked' END,
         COALESCE(d.delegate_user_id, i.issuer_user_id, a.reviewer_user_id),
         COALESCE(d.delegate_initials_snapshot, i.issuer_initials_snapshot,
                  a.reviewer_initials_snapshot),
         COALESCE(d.delegate_name_snapshot, i.issuer_name_snapshot, a.reviewer_name_snapshot),
         r.decided_by_user_id, r.decided_by_initials_snapshot, r.decided_by_name_snapshot,
         COALESCE(i.report_scope_code, a.scope_code),
         CASE WHEN r.acceptance_delegation_id IS NOT NULL THEN 'acceptance_delegate'
              WHEN r.report_issuer_grant_id IS NOT NULL THEN 'report_issuer'
              ELSE 'reviewer' END,
         r.decision_reason
  FROM project_grant_review r
  LEFT JOIN acceptance_delegation d ON d.id = r.acceptance_delegation_id
  LEFT JOIN project_report_issuer_grant i ON i.id = r.report_issuer_grant_id
  LEFT JOIN project_reviewer_assignment a ON a.id = r.reviewer_assignment_id
  WHERE r.project_id = $1 AND r.status <> 'pending' AND r.decided_at IS NOT NULL`;

const QUERY = `
  SELECT ev.*, count(*) OVER ()::int AS total
  FROM (${EVENTS}) AS ev (event_id, at, kind, s_id, s_initials, s_name, b_id, b_initials, b_name,
                          scope_code, grant_kind, reason)
  WHERE $2::uuid IS NULL OR ev.s_id = $2::uuid OR ev.b_id = $2::uuid
  ORDER BY ev.at DESC, ev.event_id
  LIMIT $3 OFFSET $4`;

function person(id: string | null, initials: string | null, name: string | null) {
  return id ? ({ userId: id, initials, name: name ?? '' } satisfies PersonSnapshot) : null;
}

/**
 * One page of the project's Team & permissions history. With `userId`, only events about that
 * person or recorded by them (the person drawer's "History on this project").
 */
export async function listAccessHistory(
  db: Pool,
  projectId: string,
  query: unknown,
): Promise<ProjectAccessHistory> {
  const { page, userId } = parseBody(accessHistoryQuerySchema, query);
  const project = await findProject(db, projectId);
  if (!project) throw new NotFoundException({ code: 'project_not_found' });
  const size = PROJECT_ACCESS_HISTORY_PAGE_SIZE;
  const [{ rows }, scopes] = await Promise.all([
    db.query<EventRow>(QUERY, [project.id, userId ?? null, size, (page - 1) * size]),
    db.query<{ code: string; label: string }>('SELECT code, label FROM review_scope'),
  ]);
  const label = new Map(scopes.rows.map((s) => [s.code, s.label]));
  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && page > 1) {
    // Past the end: still say how many there are.
    const { rows: count } = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM (${EVENTS}) AS ev (event_id, at, kind, s_id, s_initials,
           s_name, b_id, b_initials, b_name, scope_code, grant_kind, reason)
         WHERE $2::uuid IS NULL OR ev.s_id = $2::uuid OR ev.b_id = $2::uuid`,
      [project.id, userId ?? null],
    );
    total = count[0]?.total ?? 0;
  }
  return {
    projectId: project.id,
    page,
    pageSize: size,
    total,
    events: rows.map((row): AccessHistoryEvent => ({
      id: row.event_id,
      at: row.at.toISOString(),
      kind: row.kind,
      subject: person(row.s_id, row.s_initials, row.s_name),
      by: person(row.b_id, row.b_initials, row.b_name),
      scope: row.scope_code ? (label.get(row.scope_code) ?? row.scope_code) : null,
      grantKind: row.grant_kind,
      reason: row.reason,
    })),
  };
}
