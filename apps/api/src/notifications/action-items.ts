import {
  ACTION_REQUEST_ROUTE_LABEL,
  type ActionRequest,
  type ActionRequestKind,
  type ActionRequestResolution,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// MM-T27: reading action items as inbox entries, and writing their email outbox rows. Routing
// lives in the database (action_item_routed_to) so the inbox, the count, eligibility for email
// and reassignment all agree.

type Db = Pool | PoolClient;

interface ItemRow {
  id: string;
  kind: ActionRequestKind;
  status: 'open' | 'resolved';
  resolution: ActionRequestResolution | null;
  project_id: string;
  project_number: string;
  program_id: string | null;
  program_number: string | null;
  entity_type: string;
  entity_id: string;
  test_code: string | null;
  retention_kind: 'hold' | 'extension' | null;
  retention_scope: 'project' | 'units' | null;
  retention_units: number | null;
  target_role: string | null;
  lead_project_engineer_user_id: string | null;
  requester_id: string;
  requester_initials: string | null;
  requester_name: string;
  reason: string;
  created_at: Date;
  assigned_user_id: string | null;
  assigned_initials: string | null;
  assigned_name: string | null;
  resolved_by_user_id: string | null;
  resolved_initials: string | null;
  resolved_name: string | null;
  resolved_at: Date | null;
  assignee_eligible: boolean | null;
  has_recipient: boolean | null;
}

// Corrections take their comment and author from the return event; requests carry their own.
export const ITEM_SELECT = `
  SELECT a.id, a.kind, a.status, a.resolution, a.project_id, p.project_number,
         a.program_id, lp.program_number, a.entity_type, a.entity_id,
         tr.test_code_snapshot AS test_code, a.target_role, p.lead_project_engineer_user_id,
         rr.kind AS retention_kind, rr.scope AS retention_scope,
         (SELECT count(*)::int FROM retention_request_unit ru WHERE ru.request_id = rr.id)
           AS retention_units,
         coalesce(e.user_id, a.created_by_user_id) AS requester_id,
         CASE WHEN e.id IS NULL THEN a.created_by_initials_snapshot
              ELSE e.initials_snapshot END AS requester_initials,
         coalesce(e.name_snapshot, a.created_by_name_snapshot, cu.display_name) AS requester_name,
         coalesce(e.comment, a.reason, '') AS reason,
         a.created_at, a.assigned_user_id,
         au.official_initials AS assigned_initials, au.display_name AS assigned_name,
         a.resolved_by_user_id, ru.official_initials AS resolved_initials,
         ru.display_name AS resolved_name, a.resolved_at,
         CASE WHEN a.assigned_user_id IS NOT NULL
              THEN action_item_person_eligible(a.id, a.assigned_user_id) END AS assignee_eligible,
         __HAS_RECIPIENT__ AS has_recipient
  FROM action_item a
  JOIN project p ON p.id = a.project_id
  JOIN app_user cu ON cu.id = a.created_by_user_id
  LEFT JOIN lab_program lp ON lp.id = a.program_id
  LEFT JOIN test_request tr ON a.entity_type = 'test_request' AND tr.id = a.entity_id
  LEFT JOIN test_request_review_event e ON e.id = a.opened_by_event_id
  LEFT JOIN retention_request rr ON a.entity_type = 'retention_request' AND rr.id = a.entity_id
  LEFT JOIN app_user au ON au.id = a.assigned_user_id
  LEFT JOIN app_user ru ON ru.id = a.resolved_by_user_id`;

export function titleOf(
  row: Pick<
    ItemRow,
    | 'kind'
    | 'program_number'
    | 'test_code'
    | 'project_number'
    | 'retention_kind'
    | 'retention_scope'
    | 'retention_units'
  >,
): string {
  const program = row.program_number ?? 'a program';
  const test = row.test_code ? ` · ${row.test_code}` : '';
  switch (row.kind) {
    case 'correction':
      return `Correction returned for ${program}${test}`;
    case 'cancellation_request':
      return `Cancellation requested for ${program}${test}`;
    case 'closure_request':
      return `Closure requested for ${program}`;
    case 'retention_request': {
      const what = row.retention_kind === 'extension' ? 'Retention extension' : 'Hold';
      const scope =
        row.retention_scope === 'units'
          ? ` · ${row.retention_units} unit${row.retention_units === 1 ? '' : 's'}`
          : ' · whole project';
      return `${what} requested for ${row.project_number}${scope}`;
    }
    case 'lead_appointment':
      return `Lead Project Engineer needed for ${row.project_number}`;
    case 'grant_review':
      return `Review inherited grants on ${row.project_number}`;
    case 'team_join_request':
      return `Team join request on ${row.project_number}`;
    case 'review_approval_lost':
      return `Reviewer lost eligibility on ${row.project_number}`;
  }
}

export function hrefOf(row: Pick<ItemRow, 'kind' | 'program_id' | 'project_id'>): string {
  if (row.kind === 'lead_appointment') return `/projects/${row.project_id}#lead`;
  if (row.kind === 'grant_review') return `/projects/${row.project_id}/team#grant-reviews`;
  if (row.kind === 'team_join_request') return `/projects/${row.project_id}/team#join-requests`;
  if (row.kind === 'review_approval_lost') return `/projects/${row.project_id}/team`;
  return row.program_id
    ? `/lab-testing/programs/${row.program_id}`
    : `/projects/${row.project_id}#retention`;
}

const ROUTE_TAG: Record<ActionRequestKind, string> = {
  correction: 'LM',
  cancellation_request: 'LM · Lead Project Engineer',
  closure_request: 'Lead Project Engineer',
  retention_request: 'LM · Lead Project Engineer',
  lead_appointment: 'Admin',
  grant_review: 'Lead Project Engineer',
  team_join_request: 'Lead Project Engineer',
  review_approval_lost: 'Lead Project Engineer',
};

function person(id: string | null, initials: string | null, name: string | null) {
  return id ? ({ userId: id, initials, name: name ?? '' } satisfies PersonSnapshot) : null;
}

export function toActionRequest(row: ItemRow, canReassign: boolean): ActionRequest {
  const assignedTo = person(row.assigned_user_id, row.assigned_initials, row.assigned_name);
  // D10 (MM-AO07): only an open item's assignment lapses; a resolved one keeps who had it.
  const lapsed = row.status === 'open' && assignedTo !== null && row.assignee_eligible === false;
  const unresolved = row.status === 'open' && row.has_recipient === false;
  const ordinary =
    // D02 (MM-AO04): a closure request on a project with no lead waits for the next lead.
    row.kind === 'closure_request' && !row.lead_project_engineer_user_id
      ? 'Waiting for a Lead Project Engineer'
      : ACTION_REQUEST_ROUTE_LABEL[row.kind];
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    resolution: row.resolution,
    title: titleOf(row),
    routeTag:
      assignedTo && !lapsed ? (assignedTo.initials ?? assignedTo.name) : ROUTE_TAG[row.kind],
    routedTo: !assignedTo
      ? ordinary
      : lapsed
        ? `${ordinary} (${assignedTo.name} can no longer act on it)`
        : `Assigned to ${assignedTo.name}`,
    projectId: row.project_id,
    projectNumber: row.project_number,
    href: hrefOf(row),
    requestedBy: {
      userId: row.requester_id,
      initials: row.requester_initials,
      name: row.requester_name,
    },
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    assignedTo,
    assignmentLapsed: lapsed,
    unresolved,
    resolvedBy: person(row.resolved_by_user_id, row.resolved_initials, row.resolved_name),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    canReassign,
  };
}

/**
 * `recipients`: also work out whether anyone can act on each open item (the D10 unresolved flag).
 * It costs a routing check per active account, so only lists that show other people's items ask
 * for it; an item in someone's own inbox has a recipient by definition.
 */
export async function loadItemRows(
  db: Db,
  where: string,
  params: unknown[],
  suffix = 'ORDER BY a.created_at DESC, a.id',
  recipients = false,
): Promise<ItemRow[]> {
  const select = ITEM_SELECT.replace(
    '__HAS_RECIPIENT__',
    recipients ? "CASE WHEN a.status = 'open' THEN action_item_has_recipient(a.id) END" : 'NULL',
  );
  const { rows } = await db.query<ItemRow>(`${select} WHERE ${where} ${suffix}`, params);
  return rows;
}

/** Active people (personal or fixture accounts, never LAB) the item is currently routed to. */
export const ROUTED_PEOPLE = `
  SELECT u.id, u.work_email, u.official_initials, u.display_name
  FROM app_user u
  WHERE u.status = 'active' AND u.account_type IN ('personal', 'test')
    AND action_item_routed_to($1, u.id)`;

/**
 * Writes one outbox row for each person the item is routed to who has turned on email for action
 * requests and has a work email. Runs inside the transaction that created or reassigned the item;
 * the unique (item, recipient) key means a retry or second call adds nothing.
 */
async function enqueueActionItemEmails(client: PoolClient, actionItemId: string): Promise<number> {
  const [row] = await loadItemRows(client, 'a.id = $1', [actionItemId], '');
  if (!row || row.status !== 'open') return 0;
  const title = titleOf(row);
  const subject = `Material Mule: ${title}`.slice(0, 300);
  const body = [
    `${row.requester_name} asked for this: ${title}.`,
    row.reason ? `Reason: ${row.reason}` : null,
    `Project: ${row.project_number}`,
    `Open it in Material Mule: ${hrefOf(row)}`,
    '',
    'You get this email because you turned on email for action requests in Settings → My profile.',
  ]
    .filter((line) => line !== null)
    .join('\n')
    .slice(0, 10000);
  const { rowCount } = await client.query(
    `INSERT INTO email_outbox (action_item_id, recipient_user_id, to_address, subject, body)
     SELECT $1, routed.id, routed.work_email, $2, $3
     FROM (${ROUTED_PEOPLE}) routed
     JOIN notification_preference np ON np.user_id = routed.id AND np.email_action_requests
     WHERE routed.work_email IS NOT NULL AND length(routed.work_email) >= 3
     ON CONFLICT ON CONSTRAINT email_outbox_one_per_recipient DO NOTHING`,
    [actionItemId, subject, body],
  );
  return rowCount ?? 0;
}

/**
 * MM-T91: one `action_request.opened` notification for each person the item is routed to now
 * (the same people as ROUTED_PEOPLE), whatever their email preference and whether or not email
 * sending is enabled. The unique (recipient, event key) means at most one per item per person:
 * a retry, a second call, or the item coming back to someone after a reroute adds nothing.
 */
export async function notifyActionItem(client: PoolClient, actionItemId: string): Promise<number> {
  const { rowCount } = await client.query(
    `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
     SELECT routed.id, 'action_request.opened', a.id, 'action_item:' || a.id::text || ':opened'
     FROM action_item a
     CROSS JOIN LATERAL (${ROUTED_PEOPLE}) routed
     WHERE a.id = $1 AND a.status = 'open'
     ON CONFLICT ON CONSTRAINT notification_one_per_event DO NOTHING`,
    [actionItemId],
  );
  return rowCount ?? 0;
}

/**
 * Tells the people an item is routed to now: an in-app notification for each, and an outbox
 * email for those who opted in. Call it inside the transaction that created, reassigned or
 * rerouted the item. Returns the number of emails queued (as enqueueActionItemEmails does).
 */
export async function announceActionItem(
  client: PoolClient,
  actionItemId: string,
): Promise<number> {
  await notifyActionItem(client, actionItemId);
  return enqueueActionItemEmails(client, actionItemId);
}
