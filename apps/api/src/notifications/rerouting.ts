import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { enqueueActionItemEmails } from './action-items.js';

/**
 * D10 (MM-AO07, Kyle 2026-10-29): after someone's eligibility changes, their open action items
 * follow it. Routing itself is computed when read (`action_item_routed_to`), so an item assigned
 * to a person who can no longer act on it already shows to its ordinary recipients; this records
 * that the assignment lapsed (once per assignment, with the cause) and emails the people the item
 * now goes to (only those currently routed and opted in; a recipient is never emailed twice for
 * one item). Called inside the transaction that made the change, after the change.
 *
 * - `userId`: the person whose roles changed or who was disabled. Their lapsed assignments.
 * - `projectId`: the project whose Lead Project Engineer changed. Its open lead-routed items and
 *   any assignment that lapsed with it.
 */
export async function rerouteOpenItems(
  client: PoolClient,
  scope: { userId?: string; projectId?: string },
  cause: { actor: AuditActor; reason: string; requestId?: string | null },
): Promise<{ lapsed: number; notified: number }> {
  const { rows } = await client.query<{
    id: string;
    kind: string;
    assigned_user_id: string | null;
    assigned_at: Date | null;
    lapsed: boolean;
  }>(
    `SELECT a.id, a.kind, a.assigned_user_id, a.assigned_at,
            (a.assigned_user_id IS NOT NULL
             AND NOT action_item_person_eligible(a.id, a.assigned_user_id)) AS lapsed
     FROM action_item a
     WHERE a.status = 'open'
       AND (($1::uuid IS NOT NULL AND a.assigned_user_id = $1)
            OR ($2::uuid IS NOT NULL AND a.project_id = $2
                AND (action_item_routes_to_lead_project_engineer(a.kind)
                     OR a.assigned_user_id IS NOT NULL)))
     ORDER BY a.created_at, a.id`,
    [scope.userId ?? null, scope.projectId ?? null],
  );
  let lapsed = 0;
  let notified = 0;
  for (const row of rows) {
    if (row.lapsed) {
      // Once per assignment: a later change (e.g. disabled after losing the role) adds nothing.
      const { rows: recorded } = await client.query(
        `SELECT 1 FROM audit_event
         WHERE entity_type = 'action_item' AND entity_id = $1
           AND action = 'action_item.assignment_lapsed' AND occurred_at >= $2`,
        [row.id, row.assigned_at],
      );
      if (recorded.length === 0) {
        await recordAudit(client, {
          action: 'action_item.assignment_lapsed',
          entityType: 'action_item',
          entityId: row.id,
          actor: cause.actor,
          reason: cause.reason,
          before: { assignedUserId: row.assigned_user_id },
          after: { assignedUserId: row.assigned_user_id, routing: 'ordinary', kind: row.kind },
          requestId: cause.requestId ?? null,
        });
        lapsed += 1;
      }
    } else if (row.assigned_user_id !== null) {
      // Still assigned and still eligible: nothing changed for this item.
      continue;
    }
    notified += await enqueueActionItemEmails(client, row.id);
  }
  return { lapsed, notified };
}
