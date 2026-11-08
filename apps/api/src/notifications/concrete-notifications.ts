import {
  concreteNotificationRecipients,
  type ConcreteNotificationFacts,
  type ConcreteNotificationKind,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';

/**
 * MM-V2-C29: concrete notifications, written on the MM-T91 notification table. In-app only: no
 * email outbox rows, no push. Call inside the transaction that records the event, so the notice
 * and the event commit together.
 *
 * Later cards add their producer by calling `notifyConcreteEvent` with their kind, target and a
 * key that names their source row (`<kind>:<source id>`):
 *   concrete_curing.out_of_range    C06/C20 when a pickup's curing min/max falls outside range
 *   concrete_equipment.flagged      C23 when a result snapshot carries equipment flags (C27
 *                                   computes flags on read and stores no event, so nothing is
 *                                   produced before C23 / C14 store them)
 *   concrete_test.failed            C23/C25 when a result is recorded as failed
 *   concrete_report.auto_submitted  C19 when it submits a ready report
 * Recipients come from `concreteNotificationRecipients` (shared), so each person appears once and
 * the actor never notifies themself.
 */

export interface ConcreteNotificationTarget {
  fieldReportId?: string;
  specimenId?: string;
  /** Only for `concrete_report.returned`: the C09 return transition. */
  transitionId?: string;
}

/**
 * Writes one notification per eligible recipient (active personal or test account; never LAB,
 * never disabled) for one event. The (recipient, event_key) key makes a retry add nothing.
 * Returns how many rows were written.
 */
export async function notifyConcreteEvent(
  client: PoolClient,
  kind: ConcreteNotificationKind,
  target: ConcreteNotificationTarget,
  eventKey: string,
  facts: ConcreteNotificationFacts,
): Promise<number> {
  const recipients = concreteNotificationRecipients(kind, facts);
  if (recipients.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO notification (recipient_user_id, kind, concrete_field_report_id,
                               concrete_specimen_id, concrete_report_transition_id, event_key)
     SELECT u.id, $2::text, $3::uuid, $4::uuid, $5::uuid, $6::text
     FROM app_user u
     WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'
       AND u.account_type IN ('personal', 'test')
     ON CONFLICT ON CONSTRAINT notification_one_per_event DO NOTHING`,
    [
      recipients,
      kind,
      target.fieldReportId ?? null,
      target.specimenId ?? null,
      target.transitionId ?? null,
      eventKey,
    ],
  );
  return rowCount ?? 0;
}

/**
 * The Lab Managers a concrete report event notifies (C29 Q1, proposal pending owner
 * confirmation): the Lab Managers holding the project's active concrete Lab Manager grant (C02,
 * D13), or, when the project has none, every active Lab Manager. The grant only counts together
 * with the global lab_manager role, as in policy.ts.
 */
export async function concreteLabManagersFor(
  client: PoolClient,
  projectId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string; granted: boolean }>(
    `SELECT u.id,
            EXISTS (SELECT 1 FROM project_concrete_lab_manager_grant g
                    WHERE g.project_id = $1 AND g.lab_manager_user_id = u.id
                      AND g.revoked_at IS NULL) AS granted
     FROM app_user u
     JOIN role_assignment r ON r.user_id = u.id AND r.role = 'lab_manager'
     WHERE u.status = 'active' AND u.account_type IN ('personal', 'test')
     ORDER BY u.id`,
    [projectId],
  );
  const granted = rows.filter((row) => row.granted);
  return (granted.length > 0 ? granted : rows).map((row) => row.id);
}

/**
 * A reviewer returned a field report (C09 `return`): tell its technician and the Lab Manager(s),
 * never the reviewer who returned it, one row per person. Keyed by the return transition, so a
 * retry adds nothing and a later return of a newer version is a new notice.
 */
export async function notifyConcreteReportReturned(
  client: PoolClient,
  transitionId: string,
): Promise<number> {
  const { rows } = await client.query<{
    field_report_id: string;
    project_id: string;
    actor_user_id: string;
    technician_user_id: string | null;
  }>(
    `SELECT t.field_report_id, t.project_id, t.actor_user_id, r.technician_user_id
     FROM concrete_report_transition t
     JOIN concrete_field_report r ON r.id = t.field_report_id
     WHERE t.id = $1 AND t.action = 'return'`,
    [transitionId],
  );
  const event = rows[0];
  if (!event) return 0;
  return notifyConcreteEvent(
    client,
    'concrete_report.returned',
    { fieldReportId: event.field_report_id, transitionId },
    `concrete_report_transition:${transitionId}:returned`,
    {
      actorUserId: event.actor_user_id,
      technicianUserId: event.technician_user_id,
      labManagerUserIds: await concreteLabManagersFor(client, event.project_id),
    },
  );
}
