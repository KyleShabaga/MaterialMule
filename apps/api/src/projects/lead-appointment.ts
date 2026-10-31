import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { enqueueActionItemEmails } from '../notifications/action-items.js';

// MM-AO04 (D01, D02): the facts around a project's one effective Lead Project Engineer
// (project.lead_project_engineer_user_id). A nomination is a suggestion an admin confirms or
// rejects; it never fills the column. A project with no lead has one open "Lead appointment"
// action request for admins; appointing a lead resolves it in the same transaction.

/** Who recorded something, with the snapshots stored on the row. */
export interface Recorder {
  userId: string;
  initials: string | null;
  displayName: string;
}

/**
 * Opens the project's admin "Lead appointment" request unless one is already open (one per
 * project, by `action_item_open_request_key`), and queues email for admins who want it.
 */
export async function openLeadAppointment(
  client: PoolClient,
  projectId: string,
  by: Recorder,
  reason: string,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO action_item (kind, target_role, entity_type, entity_id, project_id,
                              created_by_user_id, created_by_initials_snapshot,
                              created_by_name_snapshot, reason)
     VALUES ('lead_appointment', 'admin', 'project', $1, $1, $2, $3, $4, $5)
     ON CONFLICT (kind, entity_id) WHERE kind <> 'correction' AND status = 'open' DO NOTHING
     RETURNING id`,
    [projectId, by.userId, by.initials, by.displayName, reason.slice(0, 2000)],
  );
  if (rows[0]) await enqueueActionItemEmails(client, rows[0].id);
}

/** Resolves the open "Lead appointment" request, if any, as appointed by `by`. */
export async function resolveLeadAppointment(
  client: PoolClient,
  projectId: string,
  by: Recorder,
): Promise<void> {
  await client.query(
    `UPDATE action_item SET status = 'resolved', resolution = 'appointed', resolved_at = now(),
            resolved_by_user_id = $2
     WHERE kind = 'lead_appointment' AND entity_id = $1 AND status = 'open'`,
    [projectId, by.userId],
  );
}

export interface PendingNomination {
  id: string;
  nominee_user_id: string;
  nominee_name_snapshot: string;
  nominated_by_user_id: string;
}

/** The project's pending nomination, locked FOR UPDATE for its decision. */
export async function lockPendingNomination(
  client: PoolClient,
  projectId: string,
): Promise<PendingNomination | null> {
  const { rows } = await client.query<PendingNomination>(
    `SELECT id, nominee_user_id, nominee_name_snapshot, nominated_by_user_id
     FROM project_lead_nomination WHERE project_id = $1 AND status = 'pending' FOR UPDATE`,
    [projectId],
  );
  return rows[0] ?? null;
}

/**
 * Records the decision on a nomination once (assignment_history_guard), with its audit event.
 * Only a confirmation may have no reason (MISC-03).
 */
export async function decideNomination(
  client: PoolClient,
  nomination: PendingNomination,
  decision: 'confirmed' | 'rejected' | 'withdrawn',
  input: {
    by: Recorder;
    reason: string | null;
    actor: AuditActor;
    projectId: string;
    extra?: object;
  },
): Promise<void> {
  await client.query(
    `UPDATE project_lead_nomination
     SET status = $2, decided_at = now(), decided_by_user_id = $3,
         decided_by_initials_snapshot = $4, decided_by_name_snapshot = $5, decision_reason = $6
     WHERE id = $1`,
    [
      nomination.id,
      decision,
      input.by.userId,
      input.by.initials,
      input.by.displayName,
      input.reason,
    ],
  );
  await recordAudit(client, {
    action: `project_lead_nomination.${decision}`,
    entityType: 'project_lead_nomination',
    entityId: nomination.id,
    actor: input.actor,
    reason: input.reason,
    before: { status: 'pending' },
    after: {
      status: decision,
      projectId: input.projectId,
      nomineeUserId: nomination.nominee_user_id,
      nomineeName: nomination.nominee_name_snapshot,
      ...input.extra,
    },
  });
}

/** Inserts a pending nomination with its audit event; the caller has checked the rules. */
export async function insertNomination(
  client: PoolClient,
  input: {
    projectId: string;
    nominee: Recorder;
    by: Recorder;
    note: string | null;
    idempotencyKey?: string;
    actor: AuditActor;
    receiver?: { userId: string; initials: string | null; name: string } | null;
  },
): Promise<string> {
  const hash = nominationHash(input.projectId, input.nominee.userId, input.note);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO project_lead_nomination
       (project_id, nominee_user_id, nominee_initials_snapshot, nominee_name_snapshot,
        nominated_by_user_id, nominated_by_initials_snapshot, nominated_by_name_snapshot,
        nomination_note, nomination_idempotency_key, nomination_request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      input.projectId,
      input.nominee.userId,
      input.nominee.initials,
      input.nominee.displayName,
      input.by.userId,
      input.by.initials,
      input.by.displayName,
      input.note,
      input.idempotencyKey ?? randomUUID(),
      hash,
    ],
  );
  const id = rows[0]!.id;
  await recordAudit(client, {
    action: 'project_lead_nomination.nominated',
    entityType: 'project_lead_nomination',
    entityId: id,
    actor: input.actor,
    receiver: input.receiver ?? null,
    reason: input.note,
    after: {
      projectId: input.projectId,
      nomineeUserId: input.nominee.userId,
      nomineeName: input.nominee.displayName,
    },
  });
  return id;
}

/** The request hash a nomination retry must match. */
export function nominationHash(projectId: string, nomineeUserId: string, note: string | null) {
  return createHash('sha256')
    .update(JSON.stringify({ projectId, nominee: nomineeUserId, note }))
    .digest('hex');
}
