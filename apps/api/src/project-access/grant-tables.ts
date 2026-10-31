import type { PersonSnapshot } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import type { Standing } from '../auth/standing.js';

type Db = Pool | PoolClient;

/**
 * The append-only assignment and grant tables of MM-AO02, described once so every grant, list and
 * ending is written the same way. Column names follow `<prefix>_user_id` (`user_id` for `user`),
 * `<prefix>_initials_snapshot` and `<prefix>_name_snapshot` for each person; history rows take
 * exactly one change, their ending (assignment_history_guard).
 */
export interface GrantTable {
  table: string;
  /** Who holds it: `user`, `reviewer` or `issuer`. */
  subject: string;
  /** Scope column, when the row has one (a review_scope code or the capability). */
  scope?: string;
  /** Parent column: `project_id`, or null for per-person rows. */
  parent: 'project_id' | null;
  start: { by: string; at: string; reason: string; key: string; hash: string };
  end: { by: string; at: string; reason: string };
  audit: { started: string; ended: string };
}

export const TEAM_MEMBER: GrantTable = {
  table: 'project_team_member',
  subject: 'user',
  parent: 'project_id',
  start: {
    by: 'added_by',
    at: 'added_at',
    reason: 'add_reason',
    key: 'add_idempotency_key',
    hash: 'add_request_hash',
  },
  end: { by: 'removed_by', at: 'removed_at', reason: 'remove_reason' },
  audit: { started: 'project_team_member.added', ended: 'project_team_member.removed' },
};

export const REVIEWER_ASSIGNMENT: GrantTable = {
  table: 'project_reviewer_assignment',
  subject: 'reviewer',
  scope: 'scope_code',
  parent: 'project_id',
  start: {
    by: 'assigned_by',
    at: 'assigned_at',
    reason: 'assign_reason',
    key: 'assign_idempotency_key',
    hash: 'assign_request_hash',
  },
  end: { by: 'removed_by', at: 'removed_at', reason: 'remove_reason' },
  audit: {
    started: 'project_reviewer_assignment.assigned',
    ended: 'project_reviewer_assignment.removed',
  },
};

const GRANTED = {
  by: 'granted_by',
  at: 'granted_at',
  reason: 'grant_reason',
  key: 'grant_idempotency_key',
  hash: 'grant_request_hash',
};
const REVOKED = { by: 'revoked_by', at: 'revoked_at', reason: 'revoke_reason' };

export const REPORT_ISSUER_GRANT: GrantTable = {
  table: 'project_report_issuer_grant',
  subject: 'issuer',
  scope: 'report_scope_code',
  parent: 'project_id',
  start: GRANTED,
  end: REVOKED,
  audit: {
    started: 'project_report_issuer_grant.granted',
    ended: 'project_report_issuer_grant.revoked',
  },
};

export const ACCEPTANCE_DELEGATION: GrantTable = {
  table: 'acceptance_delegation',
  subject: 'delegate',
  parent: 'project_id',
  start: GRANTED,
  end: REVOKED,
  audit: { started: 'acceptance_delegation.granted', ended: 'acceptance_delegation.revoked' },
};

export const REVIEWER_ELIGIBILITY: GrantTable = {
  table: 'reviewer_eligibility',
  subject: 'user',
  scope: 'scope_code',
  parent: null,
  start: GRANTED,
  end: REVOKED,
  audit: { started: 'reviewer_eligibility.granted', ended: 'reviewer_eligibility.revoked' },
};

export const STAFF_CAPABILITY_GRANT: GrantTable = {
  table: 'staff_capability_grant',
  subject: 'user',
  scope: 'capability',
  parent: null,
  start: GRANTED,
  end: REVOKED,
  audit: { started: 'staff_capability_grant.granted', ended: 'staff_capability_grant.revoked' },
};

/** The technical grants D08 revokes when a disabled account is re-enabled (not team membership). */
export const TECHNICAL_GRANTS: readonly GrantTable[] = [
  REVIEWER_ELIGIBILITY,
  REVIEWER_ASSIGNMENT,
  REPORT_ISSUER_GRANT,
  ACCEPTANCE_DELEGATION,
  STAFF_CAPABILITY_GRANT,
];

/** One row as read back, before the caller adds its own fields. */
export interface GrantRow {
  id: string;
  parentId: string | null;
  subject: PersonSnapshot;
  scope: string | null;
  startedBy: PersonSnapshot;
  startedAt: Date;
  startReason: string | null;
  endedBy: PersonSnapshot | null;
  endedAt: Date | null;
  endReason: string | null;
  raw: Record<string, unknown>;
}

/** `user_id` for the `user` prefix, `<prefix>_user_id` otherwise (`reviewer_user_id`, …). */
function idColumn(prefix: string): string {
  return prefix === 'user' ? 'user_id' : `${prefix}_user_id`;
}

function columns(t: GrantTable): string {
  const person = (prefix: string) =>
    `${idColumn(prefix)}, ${prefix}_initials_snapshot, ${prefix}_name_snapshot`;
  return [
    'id',
    t.parent ?? 'NULL::uuid',
    person(t.subject),
    t.scope ?? 'NULL::text',
    person(t.start.by),
    t.start.at,
    t.start.reason,
    person(t.end.by),
    t.end.at,
    t.end.reason,
  ].join(', ');
}

function toRow(t: GrantTable, row: Record<string, unknown>): GrantRow {
  const person = (prefix: string): PersonSnapshot => ({
    userId: row[idColumn(prefix)] as string,
    initials: (row[`${prefix}_initials_snapshot`] as string | null) ?? null,
    name: (row[`${prefix}_name_snapshot`] as string | null) ?? '',
  });
  return {
    id: row.id as string,
    parentId: t.parent ? (row[t.parent] as string) : null,
    subject: person(t.subject),
    scope: t.scope ? (row[t.scope] as string) : null,
    startedBy: person(t.start.by),
    startedAt: row[t.start.at] as Date,
    startReason: (row[t.start.reason] as string | null) ?? null,
    endedBy: row[`${t.end.by}_user_id`] ? person(t.end.by) : null,
    endedAt: (row[t.end.at] as Date | null) ?? null,
    endReason: (row[t.end.reason] as string | null) ?? null,
    raw: row,
  };
}

/** Shared response fields of one row (`historyFields` in packages/shared project-access). */
export function historyView(row: GrantRow) {
  return {
    id: row.id,
    startedBy: row.startedBy,
    startedAt: row.startedAt.toISOString(),
    startReason: row.startReason,
    endedBy: row.endedBy,
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
  };
}

/**
 * Active rows, then the newest `historyLimit` ended rows, of one project or person, plus the
 * total number of ended rows. `extra` adds table-specific columns to the select.
 */
export async function listGrants(
  db: Db,
  t: GrantTable,
  where: { column: string; value: string },
  options: { historyLimit: number; extra?: string },
): Promise<{ active: GrantRow[]; history: GrantRow[]; historyTotal: number }> {
  const select = `SELECT ${columns(t)}${options.extra ? `, ${options.extra}` : ''} FROM ${t.table}`;
  const { rows: active } = await db.query(
    `${select} WHERE ${where.column} = $1 AND ${t.end.at} IS NULL ORDER BY ${t.start.at} DESC, id`,
    [where.value],
  );
  const { rows: history } = await db.query(
    `${select} WHERE ${where.column} = $1 AND ${t.end.at} IS NOT NULL
     ORDER BY ${t.end.at} DESC, id LIMIT ${options.historyLimit}`,
    [where.value],
  );
  const { rows: total } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${t.table} WHERE ${where.column} = $1 AND ${t.end.at} IS NOT NULL`,
    [where.value],
  );
  return {
    active: active.map((row) => toRow(t, row)),
    history: history.map((row) => toRow(t, row)),
    historyTotal: total[0]!.n,
  };
}

/** The row with `id` (under `parent` when given), locked FOR UPDATE for its ending. */
export async function lockGrant(
  client: PoolClient,
  t: GrantTable,
  id: string,
  parent?: { column: string; value: string },
): Promise<GrantRow | null> {
  const { rows } = await client.query(
    `SELECT ${columns(t)} FROM ${t.table} WHERE id = $1
     ${parent ? `AND ${parent.column} = $2` : ''} FOR UPDATE`,
    parent ? [id, parent.value] : [id],
  );
  return rows[0] ? toRow(t, rows[0]) : null;
}

/** The earlier row written with this idempotency key, if any. */
export async function findByKey(
  db: Db,
  t: GrantTable,
  key: string,
): Promise<{ id: string; hash: string; by: string } | null> {
  const { rows } = await db.query<{ id: string; hash: string; by: string }>(
    `SELECT id, ${t.start.hash} AS hash, ${t.start.by}_user_id AS by FROM ${t.table}
     WHERE ${t.start.key} = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/** True when `subject` already holds an active row here (same parent and scope). */
export async function hasActive(
  db: Db,
  t: GrantTable,
  match: { parentId: string | null; subjectId: string; scope: string | null },
): Promise<boolean> {
  const params: unknown[] = [match.subjectId];
  const where = [`${idColumn(t.subject)} = $1`, `${t.end.at} IS NULL`];
  if (t.parent) {
    params.push(match.parentId);
    where.push(`${t.parent} = $${params.length}`);
  }
  if (t.scope) {
    params.push(match.scope);
    where.push(`${t.scope} = $${params.length}`);
  }
  const { rows } = await db.query(`SELECT 1 FROM ${t.table} WHERE ${where.join(' AND ')}`, params);
  return rows.length > 0;
}

/** Inserts one new row with its reason, snapshots and key, and audits it in the same transaction. */
export async function insertGrant(
  client: PoolClient,
  t: GrantTable,
  input: {
    parentId: string | null;
    subject: Standing;
    scope: string | null;
    by: Standing;
    reason: string;
    key: string;
    hash: string;
    extra?: Record<string, unknown>;
    actor: AuditActor;
    audit: Record<string, unknown>;
  },
): Promise<string> {
  const values: Record<string, unknown> = {
    [idColumn(t.subject)]: input.subject.userId,
    [`${t.subject}_initials_snapshot`]: input.subject.initials,
    [`${t.subject}_name_snapshot`]: input.subject.displayName,
    [`${t.start.by}_user_id`]: input.by.userId,
    [`${t.start.by}_initials_snapshot`]: input.by.initials,
    [`${t.start.by}_name_snapshot`]: input.by.displayName,
    [t.start.reason]: input.reason,
    [t.start.key]: input.key,
    [t.start.hash]: input.hash,
    ...(t.parent ? { [t.parent]: input.parentId } : {}),
    ...(t.scope ? { [t.scope]: input.scope } : {}),
    ...input.extra,
  };
  const names = Object.keys(values);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ${t.table} (${names.join(', ')})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(values),
  );
  const id = rows[0]!.id;
  await recordAudit(client, {
    action: t.audit.started,
    entityType: t.table,
    entityId: id,
    actor: input.actor,
    reason: input.reason,
    after: {
      ...(t.parent ? { [t.parent === 'project_id' ? 'projectId' : t.parent]: input.parentId } : {}),
      userId: input.subject.userId,
      userName: input.subject.displayName,
      ...(t.scope ? { scope: input.scope } : {}),
      ...input.audit,
    },
  });
  return id;
}

/** Ends an active row once, with its reason, and audits it in the same transaction. */
export async function endGrant(
  client: PoolClient,
  t: GrantTable,
  row: GrantRow,
  input: {
    by: { userId: string; initials: string | null; displayName: string };
    reason: string;
    extra?: Record<string, unknown>;
    actor: AuditActor;
    audit?: Record<string, unknown>;
  },
): Promise<void> {
  const values: Record<string, unknown> = {
    [`${t.end.by}_user_id`]: input.by.userId,
    [`${t.end.by}_initials_snapshot`]: input.by.initials,
    [`${t.end.by}_name_snapshot`]: input.by.displayName,
    [t.end.reason]: input.reason,
    ...input.extra,
  };
  const names = Object.keys(values);
  // The ending is the transaction time, not the API host's clock.
  await client.query(
    `UPDATE ${t.table} SET ${t.end.at} = now(), ${names
      .map((name, i) => `${name} = $${i + 2}`)
      .join(', ')} WHERE id = $1`,
    [row.id, ...Object.values(values)],
  );
  await recordAudit(client, {
    action: t.audit.ended,
    entityType: t.table,
    entityId: row.id,
    actor: input.actor,
    reason: input.reason,
    before: { active: true },
    after: {
      active: false,
      ...(row.parentId ? { projectId: row.parentId } : {}),
      userId: row.subject.userId,
      userName: row.subject.name,
      ...(row.scope ? { scope: row.scope } : {}),
      ...input.audit,
    },
  });
}

/** Every active row `userId` holds in `t`, locked FOR UPDATE for ending (in id order). */
export async function lockActiveFor(
  client: PoolClient,
  t: GrantTable,
  userId: string,
): Promise<GrantRow[]> {
  const { rows } = await client.query(
    `SELECT ${columns(t)} FROM ${t.table}
     WHERE ${idColumn(t.subject)} = $1 AND ${t.end.at} IS NULL ORDER BY id FOR UPDATE`,
    [userId],
  );
  return rows.map((row) => toRow(t, row));
}

/** The project grants a new lead reviews (MTR-25), whose ending settles a review flag. */
export const REVIEWABLE_GRANTS: readonly GrantTable[] = [
  ACCEPTANCE_DELEGATION,
  REPORT_ISSUER_GRANT,
  REVIEWER_ASSIGNMENT,
];

/**
 * MTR-25: serialises every change to these projects' grant review flags until commit (migration
 * 0009, `project_grant_review_lock`). Lock order: the project row, then the accounts, then this
 * (each project once, in id order), then the grant, its flag and the action item. Taking it
 * before re-reading a flag's state is what makes "last flag decided" visible to the next writer.
 */
export async function lockGrantReviews(client: PoolClient, projectIds: readonly string[]) {
  for (const id of [...new Set(projectIds)].sort()) {
    await client.query('SELECT project_grant_review_lock($1)', [id]);
  }
}

/** D08: the reason recorded on every technical grant a re-enable revokes. */
export const REENABLE_REVOKE_REASON =
  'Account re-enabled: technical grants need revalidation (D08)';

/**
 * D08 (Kyle, 2026-10-29): re-enabling a disabled account revokes every technical grant the person
 * still holds (reviewer eligibility and assignments, report issuer grants, acceptance delegations,
 * the create-and-lead capability), each with its own audit event, in the re-enable transaction.
 * A lead or admin re-grants what still applies. Team membership carries no authority and stays.
 */
export async function revokeTechnicalGrants(
  client: PoolClient,
  userId: string,
  by: { userId: string; initials: string | null; displayName: string },
  actor: AuditActor,
): Promise<number> {
  // The caller holds the account FOR UPDATE, so no grant for this person can start meanwhile;
  // every project whose review flags these endings settle is locked first, in id order (MTR-25).
  const { rows: projects } = await client.query<{ project_id: string }>(
    `SELECT project_id FROM acceptance_delegation WHERE delegate_user_id = $1 AND revoked_at IS NULL
     UNION SELECT project_id FROM project_report_issuer_grant
           WHERE issuer_user_id = $1 AND revoked_at IS NULL
     UNION SELECT project_id FROM project_reviewer_assignment
           WHERE reviewer_user_id = $1 AND removed_at IS NULL`,
    [userId],
  );
  await lockGrantReviews(
    client,
    projects.map((p) => p.project_id),
  );
  let revoked = 0;
  for (const t of TECHNICAL_GRANTS) {
    for (const row of await lockActiveFor(client, t, userId)) {
      await endGrant(client, t, row, {
        by,
        reason: REENABLE_REVOKE_REASON,
        extra: t === REPORT_ISSUER_GRANT ? { revocation_kind: 'ordinary' } : undefined,
        actor,
        audit: { reEnabled: true },
      });
      revoked += 1;
    }
  }
  return revoked;
}
