import type { Pool, PoolClient } from 'pg';
import { involvementSql } from '../project-access/involvement.js';

export type ActorAccountType = 'personal' | 'shared_lab' | 'test' | 'system';

/** Who did something, copied at the time it happened so later profile edits can't rewrite it. */
export interface AuditActor {
  userId: string | null;
  accountType: ActorAccountType;
  initials: string | null;
  name: string | null;
}

/**
 * Staff member credited with the physical work when different from the account (e.g. LAB),
 * copied at the time like the actor (MM-T56). Initials are null for staff without confirmed ones.
 */
export interface AuditReceiver {
  userId: string;
  initials: string | null;
  name: string;
}

export interface AuditEventInput {
  /** `entity.verb`, e.g. `receipt.confirmed`, `storage_unit.corrected`. */
  action: string;
  entityType: string;
  entityId: string | null;
  actor: AuditActor;
  receiver?: AuditReceiver | null;
  reason?: string | null;
  /** Only the changed business fields. Never secrets, tokens or session IDs. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId?: string | null;
}

export interface AuditEvent {
  id: string;
  occurredAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorAccountType: ActorAccountType | null;
  actorInitials: string | null;
  actorName: string | null;
  receiverUserId: string | null;
  receiverInitials: string | null;
  receiverName: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId: string | null;
}

const ACTION_PATTERN = /^[a-z_]+\.[a-z_]+$/;

/**
 * Appends an audit event. Pass the client of the transaction that makes the change, so the
 * event commits or rolls back together with it.
 */
export async function recordAudit(client: PoolClient, event: AuditEventInput): Promise<string> {
  if (!ACTION_PATTERN.test(event.action)) {
    throw new TypeError(`Audit action "${event.action}" must look like entity.verb`);
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO audit_event (action, entity_type, entity_id, actor_user_id, actor_account_type,
                              actor_initials_snapshot, actor_name_snapshot, receiver_user_id,
                              receiver_initials_snapshot, receiver_name_snapshot, reason,
                              before_values, after_values, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      event.action,
      event.entityType,
      event.entityId,
      event.actor.userId,
      event.actor.accountType,
      event.actor.initials,
      event.actor.name,
      event.receiver?.userId ?? null,
      event.receiver?.initials ?? null,
      event.receiver?.name ?? null,
      event.reason ?? null,
      event.before ?? null,
      event.after ?? null,
      event.requestId ?? null,
    ],
  );
  return rows[0]!.id;
}

const SELECT_EVENT = `
  SELECT id, occurred_at, action, entity_type, entity_id, actor_user_id, actor_account_type,
         actor_initials_snapshot, actor_name_snapshot, receiver_user_id, receiver_initials_snapshot,
         receiver_name_snapshot, reason, before_values, after_values, request_id
  FROM audit_event`;

interface AuditRow {
  id: string;
  occurred_at: Date;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_account_type: ActorAccountType | null;
  actor_initials_snapshot: string | null;
  actor_name_snapshot: string | null;
  receiver_user_id: string | null;
  receiver_initials_snapshot: string | null;
  receiver_name_snapshot: string | null;
  reason: string | null;
  before_values: Record<string, unknown> | null;
  after_values: Record<string, unknown> | null;
  request_id: string | null;
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    actorAccountType: row.actor_account_type,
    actorInitials: row.actor_initials_snapshot,
    actorName: row.actor_name_snapshot,
    receiverUserId: row.receiver_user_id,
    receiverInitials: row.receiver_initials_snapshot,
    receiverName: row.receiver_name_snapshot,
    reason: row.reason,
    before: row.before_values,
    after: row.after_values,
    requestId: row.request_id,
  };
}

const MAX_PAGE = 100;

/** History of one entity, newest first, paged by `limit` / `offset`. */
export async function listAuditForEntity(
  pool: Pool,
  entityType: string,
  entityId: string,
  page: { limit?: number; offset?: number } = {},
): Promise<AuditEvent[]> {
  const limit = Math.min(page.limit ?? 25, MAX_PAGE);
  const { rows } = await pool.query<AuditRow>(
    `${SELECT_EVENT}
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY occurred_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [entityType, entityId, limit, page.offset ?? 0],
  );
  return rows.map(toEvent);
}

/**
 * Most recent events with one of `actions`, newest first (used by the dashboard, T34), only
 * those at or after `since` when given (Today's 24-hour ledger).
 */
export async function listRecentAudit(
  pool: Pool,
  actions: string[],
  limit = 20,
  since: Date | null = null,
  scope: RecentAuditScope = {},
): Promise<AuditEvent[]> {
  const { rows } = await pool.query<AuditRow>(
    `${SELECT_EVENT}
     WHERE action = ANY($1::text[])
       AND ($3::timestamptz IS NULL OR occurred_at >= $3)
       AND ($4::uuid IS NULL OR actor_user_id = $4)
       AND ($5::uuid IS NULL OR ${EVENT_PROJECT_SQL} IN (
             SELECT i.project_id FROM (${involvementSql('$5::uuid')}) i))
     ORDER BY occurred_at DESC, id DESC
     LIMIT $2`,
    [
      actions,
      Math.min(limit, MAX_PAGE),
      since,
      scope.actorUserId ?? null,
      scope.projectsOfUserId ?? null,
    ],
  );
  return rows.map(toEvent);
}

/**
 * Narrowing for `listRecentAudit` (STRATA-23). Applied in SQL before the limit, so a narrowed
 * ledger is still the newest `limit` matching events.
 */
export interface RecentAuditScope {
  /** Only events this account performed (the recorded actor, never a credited receiver). */
  actorUserId?: string;
  /** Only events on projects this person is involved in (D12 "My projects"). */
  projectsOfUserId?: string;
}

/**
 * The project an audit event is about, for the dashboard event types: a receipt's project, a
 * storage unit's current project, or a print job's units' project. Location label jobs and other
 * events name no project (NULL), so a project-narrowed ledger leaves them out.
 */
const EVENT_PROJECT_SQL = `(CASE entity_type
    WHEN 'receipt' THEN (SELECT r.project_id FROM receipt r WHERE r.id = entity_id)
    WHEN 'storage_unit' THEN (SELECT su.project_id FROM storage_unit su WHERE su.id = entity_id)
    WHEN 'print_job' THEN (SELECT su.project_id FROM print_job_item i
                           JOIN storage_unit su ON su.id = i.storage_unit_id
                           WHERE i.print_job_id = entity_id ORDER BY i.position LIMIT 1)
  END)`;
