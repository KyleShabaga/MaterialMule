import type { PoolClient } from 'pg';
import {
  can,
  type AccountStatus,
  type AccountType,
  type AuthUser,
  type Permission,
  type ProjectContext,
  type Role,
} from './policy.js';

/** A person's account facts as they stand inside the current transaction. */
export interface Standing {
  userId: string;
  accountType: AccountType;
  status: AccountStatus;
  roles: Role[];
  displayName: string;
  initials: string | null;
}

/**
 * Locks the named accounts FOR SHARE, in id order, and returns their current standing (MM-AO03,
 * D09). Disabling, re-enabling and role changes lock the account FOR UPDATE, so once this returns
 * none of them can commit until this transaction does, and one that committed first is seen here.
 * Missing ids are simply absent from the map.
 *
 * Lock order (docs/permissions.md "Lock order"): domain rows (program, test, unit, decision),
 * then the project, then these accounts, then assignment and grant rows.
 */
export async function lockStanding(
  client: PoolClient,
  userIds: readonly string[],
): Promise<Map<string, Standing>> {
  const ids = [...new Set(userIds)].sort();
  const { rows } = await client.query<{
    id: string;
    account_type: AccountType;
    status: AccountStatus;
    display_name: string;
    official_initials: string | null;
  }>(
    `SELECT id, account_type, status, display_name, official_initials FROM app_user
     WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
    [ids],
  );
  const { rows: roles } = await client.query<{ user_id: string; role: Role }>(
    'SELECT user_id, role FROM role_assignment WHERE user_id = ANY($1::uuid[]) ORDER BY role',
    [ids],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        userId: row.id,
        accountType: row.account_type,
        status: row.status,
        roles: roles.filter((role) => role.user_id === row.id).map((role) => role.role),
        displayName: row.display_name,
        initials: row.official_initials,
      },
    ]),
  );
}

/**
 * The request's user with roles and status as they stand under the lock: a role removed or an
 * account disabled by a transaction that committed first is honoured (first commit wins).
 */
export function asLocked(user: AuthUser, standing: Map<string, Standing>): AuthUser {
  const now = standing.get(user.userId);
  if (!now) return { ...user, status: 'disabled', roles: [] };
  return { ...user, accountType: now.accountType, status: now.status, roles: now.roles };
}

/** An active personal (or test) account: the only kind that may hold an assignment or grant. */
export function isActiveStaff(person: Standing | undefined): person is Standing {
  return Boolean(person && person.status === 'active' && person.accountType !== 'shared_lab');
}

/**
 * The project's Lead Project Engineer as it stands (null: none yet, D02), locked FOR SHARE (or
 * stronger) so a lead change (which takes the project FOR UPDATE) commits wholly before or after
 * the caller (D09). Undefined when the project doesn't exist.
 */
export async function lockProjectLead(
  client: PoolClient,
  projectId: string,
  lock: 'FOR SHARE' | 'FOR NO KEY UPDATE' = 'FOR SHARE',
): Promise<string | null | undefined> {
  const { rows } = await client.query<{ lead_project_engineer_user_id: string | null }>(
    `SELECT lead_project_engineer_user_id FROM project WHERE id = $1 ${lock}`,
    [projectId],
  );
  return rows[0] ? rows[0].lead_project_engineer_user_id : undefined;
}

/** The grant-based facts of a project context, read inside the transaction. */
export type GrantContext = Omit<ProjectContext, 'leadProjectEngineerUserId'>;

/**
 * Review fix (#134): locks FOR SHARE, in id order, the project's active grant rows a final
 * check is about to read: report issuer grants for `reportScope`, reviewer assignments and their
 * open review approvals for `reviewScope`, and concrete Lab Manager grants. Every ending (a
 * revocation, a removal, a lost approval through eligibility) locks its row FOR UPDATE, so once
 * this returns none can commit until this transaction does, and one that committed first is no
 * longer selected (PostgreSQL re-checks the row after the wait). Read the context after this.
 *
 * Lock order: after the project and the accounts (`canUnderLock` with a `context` loader calls it
 * at that point), as docs/permissions.md "Lock order" puts assignment and grant rows last.
 */
export async function lockProjectGrants(
  client: PoolClient,
  projectId: string,
  grants: { reportScope?: string; reviewScope?: string; concreteLabManagers?: boolean },
): Promise<void> {
  if (grants.reportScope) {
    await client.query(
      `SELECT id FROM project_report_issuer_grant
       WHERE project_id = $1 AND report_scope_code = $2 AND revoked_at IS NULL
       ORDER BY id FOR SHARE`,
      [projectId, grants.reportScope],
    );
  }
  if (grants.reviewScope) {
    await client.query(
      `SELECT id FROM project_reviewer_assignment
       WHERE project_id = $1 AND scope_code = $2 AND removed_at IS NULL
       ORDER BY id FOR SHARE`,
      [projectId, grants.reviewScope],
    );
    await client.query(
      `SELECT ap.id FROM project_review_approval ap
       JOIN project_reviewer_assignment a ON a.id = ap.reviewer_assignment_id
       WHERE a.project_id = $1 AND a.scope_code = $2 AND a.removed_at IS NULL
         AND ap.ended_at IS NULL
       ORDER BY ap.id FOR SHARE OF ap`,
      [projectId, grants.reviewScope],
    );
  }
  if (grants.concreteLabManagers) {
    await client.query(
      `SELECT id FROM project_concrete_lab_manager_grant
       WHERE project_id = $1 AND revoked_at IS NULL
       ORDER BY id FOR SHARE`,
      [projectId],
    );
  }
}

/**
 * D09's final authority check for a project-scoped action: the project's lead as it stands (the
 * project locked FOR SHARE, or `lock`) and the actor's roles and status as they stand (account
 * locked FOR SHARE). Call it after locking the domain rows, per the lock order above. Whichever of
 * this action and a lead change, role change or disable commits first wins; the loser sees it.
 *
 * A check that depends on grants passes `context` as a loader: it runs after the project and
 * account locks, so it can lock the grant rows (`lockProjectGrants`) and read them as they stand
 * (review fix #134). A context object read earlier would miss a revocation committed meanwhile.
 */
export async function canUnderLock(
  client: PoolClient,
  user: AuthUser,
  permission: Permission,
  projectId: string,
  options: {
    lock?: 'FOR SHARE' | 'FOR NO KEY UPDATE';
    context?: GrantContext | ((client: PoolClient) => Promise<GrantContext>);
  } = {},
): Promise<boolean> {
  const lead = await lockProjectLead(client, projectId, options.lock);
  if (lead === undefined) return false;
  const actor = asLocked(user, await lockStanding(client, [user.userId]));
  const context =
    typeof options.context === 'function' ? await options.context(client) : options.context;
  return can(actor, permission, { ...context, leadProjectEngineerUserId: lead });
}
