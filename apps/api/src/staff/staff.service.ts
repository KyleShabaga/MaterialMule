import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  effectiveJobTitle,
  type ReceiverOption,
  type StaffListQuery,
  type StaffMember,
  type StaffPosition,
  type StaffRole,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { revokeTechnicalGrants } from '../project-access/grant-tables.js';
import { UsersService, assertAnotherActiveAdmin } from '../users/users.service.js';
import { findPreprovisionedMatch, normalizeUpn } from './first-sign-in.js';

const RECEIVER_LIMIT = 20;
const LIST_LIMIT = 500;

interface StaffRow {
  id: string;
  display_name: string;
  official_initials: string | null;
  initials_confirmed: boolean;
  position: StaffPosition | null;
  account_type: StaffMember['accountType'];
  status: StaffMember['status'];
  roles: StaffRole[];
  work_email: string | null;
  sign_in_username: string | null;
  expected_upn: string | null;
  linked: boolean;
  last_sign_in_at: Date | null;
  approved_at: Date | null;
  disabled_reason: string | null;
  created_at: Date;
  job_title: string | null;
  job_title_override: string | null;
  job_title_override_set_by: string | null;
  job_title_override_set_at: Date | null;
}

const SELECT_STAFF = `
  SELECT u.id, u.display_name, u.official_initials,
         u.initials_confirmed_at IS NOT NULL AS initials_confirmed,
         u.position, u.account_type, u.status, u.work_email, u.sign_in_username, u.expected_upn, u.approved_at, u.disabled_reason,
         u.created_at, u.job_title, u.job_title_override, u.job_title_override_set_at,
         (SELECT b.display_name FROM app_user b WHERE b.id = u.job_title_override_set_by_user_id)
           AS job_title_override_set_by,
         COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM role_assignment r
                   WHERE r.user_id = u.id), '{}') AS roles,
         EXISTS (SELECT 1 FROM identity_link l WHERE l.user_id = u.id) AS linked,
         (SELECT max(s.created_at) FROM session s WHERE s.user_id = u.id) AS last_sign_in_at
  FROM app_user u`;

function toMember(row: StaffRow): StaffMember {
  return {
    id: row.id,
    displayName: row.display_name,
    officialInitials: row.official_initials,
    initialsConfirmed: row.initials_confirmed,
    position: row.position,
    accountType: row.account_type,
    status: row.status,
    roles: row.roles,
    workEmail: row.work_email,
    signInUsername: row.sign_in_username,
    expectedUpn: row.expected_upn,
    linked: row.linked,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
    approvedAt: row.approved_at?.toISOString() ?? null,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at.toISOString(),
    jobTitle: row.job_title,
    jobTitleOverride: row.job_title_override,
    jobTitleOverrideSetBy: row.job_title_override_set_by,
    jobTitleOverrideSetAt: row.job_title_override_set_at?.toISOString() ?? null,
    effectiveJobTitle: effectiveJobTitle(row.job_title, row.job_title_override),
  };
}

/** Escapes LIKE wildcards so a search for "J_S" means those three characters. */
export function likePattern(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Identity details a Microsoft sign-in (MM-T05) passes after validating the token. */
export interface MicrosoftIdentity {
  tenantId: string;
  /** Immutable object ID (oid): the identity key. */
  subject: string;
  /** userPrincipalName, used only to find a pre-provisioned entry on the first sign-in. */
  upn: string;
  displayName: string;
  givenName?: string | null;
  surname?: string | null;
  workEmail?: string | null;
}

export type FirstSignInOutcome = 'existing' | 'linked' | 'created';

const systemActor = (userId: string, name: string): AuditActor => ({
  userId,
  accountType: 'personal',
  initials: null,
  name,
});

/**
 * Links a first Microsoft sign-in to a pre-provisioned staff entry (AC6) and returns that
 * entry's id, or null when nothing matches. Matches only an exact (case-insensitive) expected UPN
 * on an entry with no identity attached; initials and names are never compared. Call it inside
 * the sign-in transaction, after checking that the identity isn't already linked.
 */
export async function linkPreprovisionedStaff(
  client: PoolClient,
  identity: MicrosoftIdentity,
  requestId?: string | null,
): Promise<string | null> {
  const { rows: candidates } = await client.query<{
    id: string;
    expected_upn: string | null;
    linked: boolean;
  }>(
    `SELECT u.id, u.expected_upn,
            EXISTS (SELECT 1 FROM identity_link l WHERE l.user_id = u.id) AS linked
     FROM app_user u
     WHERE lower(u.expected_upn) = $1
     FOR UPDATE OF u`,
    [normalizeUpn(identity.upn)],
  );
  const matchId = findPreprovisionedMatch(
    identity.upn,
    candidates.map((row) => ({
      userId: row.id,
      expectedUpn: row.expected_upn,
      linked: row.linked,
    })),
  );
  if (!matchId) {
    return null;
  }
  await client.query(
    `INSERT INTO identity_link (user_id, provider, tenant_id, subject)
     VALUES ($1, 'microsoft', $2, $3)`,
    [matchId, identity.tenantId, identity.subject],
  );
  await client.query(
    `UPDATE app_user
     SET sign_in_username = $2, work_email = COALESCE(work_email, $3),
         given_name = COALESCE(given_name, $4), surname = COALESCE(surname, $5),
         updated_at = now()
     WHERE id = $1`,
    [
      matchId,
      identity.upn,
      identity.workEmail ?? null,
      identity.givenName ?? null,
      identity.surname ?? null,
    ],
  );
  await recordAudit(client, {
    action: 'staff.linked_on_first_sign_in',
    entityType: 'app_user',
    entityId: matchId,
    actor: systemActor(matchId, identity.displayName),
    after: { provider: 'microsoft', signInUsername: identity.upn },
    requestId,
  });
  return matchId;
}

/** What a receipt stores about its receiver at selection time (MM-T09 snapshots). */
export interface ReceiverSnapshot {
  userId: string;
  initials: string;
  name: string;
}

interface Change {
  actor: AuditActor;
  requestId: string | null;
}

@Injectable()
export class StaffService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersService,
  ) {}

  /** Staff list, pending first (they need an admin), then by name. */
  async list(query: StaffListQuery): Promise<StaffMember[]> {
    const search = query.search?.trim() ?? '';
    const { rows } = await this.database.pool.query<StaffRow>(
      `${SELECT_STAFF}
       WHERE ($1::text IS NULL OR u.status = $1)
         AND ($2 = '' OR u.display_name ILIKE '%' || $2 || '%'
              OR u.official_initials ILIKE $2 || '%'
              OR u.expected_upn ILIKE '%' || $2 || '%'
              OR u.work_email ILIKE '%' || $2 || '%'
              OR u.sign_in_username ILIKE '%' || $2 || '%')
       ORDER BY (u.status = 'pending') DESC, (u.status = 'disabled'), lower(u.display_name), u.id
       LIMIT ${LIST_LIMIT}`,
      [query.status ?? null, likePattern(search)],
    );
    return rows.map(toMember);
  }

  async get(id: string, db: Pool | PoolClient = this.database.pool): Promise<StaffMember> {
    const { rows } = await db.query<StaffRow>(`${SELECT_STAFF} WHERE u.id = $1`, [id]);
    if (rows.length === 0) {
      throw new NotFoundException({ code: 'not_found' });
    }
    return toMember(rows[0]!);
  }

  /**
   * Receiver selector options: active people with official initials. The shared LAB account is
   * a station, not a person, so it never appears. Exact initials first, then initials prefix,
   * then name matches.
   */
  async receivers(search: string | undefined): Promise<ReceiverOption[]> {
    const text = likePattern(search?.trim() ?? '');
    const { rows } = await this.database.pool.query<{
      id: string;
      official_initials: string;
      display_name: string;
      position: StaffPosition | null;
    }>(
      `SELECT id, official_initials, display_name, position
       FROM app_user
       WHERE status = 'active' AND account_type <> 'shared_lab' AND official_initials IS NOT NULL
         AND ($1 = '' OR official_initials ILIKE $1 || '%' OR display_name ILIKE '%' || $1 || '%')
       ORDER BY (upper(official_initials) = upper($1)) DESC,
                (official_initials ILIKE $1 || '%') DESC,
                official_initials, lower(display_name), id
       LIMIT ${RECEIVER_LIMIT}`,
      [text],
    );
    return rows.map((row) => ({
      id: row.id,
      initials: row.official_initials,
      displayName: row.display_name,
      position: row.position,
    }));
  }

  /**
   * Snapshot of an active receiver for a receipt (MM-T09/T10). Refuses anyone the selector
   * wouldn't offer, so free-text or disabled receivers can't be stored.
   */
  async receiverSnapshot(client: PoolClient, userId: string): Promise<ReceiverSnapshot> {
    const { rows } = await client.query<{ official_initials: string; display_name: string }>(
      `SELECT official_initials, display_name FROM app_user
       WHERE id = $1 AND status = 'active' AND account_type <> 'shared_lab'
         AND official_initials IS NOT NULL`,
      [userId],
    );
    if (rows.length === 0) {
      throw new UnprocessableEntityException({
        code: 'receiver_not_available',
        message: 'Choose an active staff member as the receiver.',
      });
    }
    return { userId, initials: rows[0]!.official_initials, name: rows[0]!.display_name };
  }

  /** Adds a person before their first Microsoft sign-in. The admin creating it approves it. */
  async preprovision(
    input: {
      displayName: string;
      officialInitials: string;
      expectedUpn: string;
      position?: StaffPosition | null;
    },
    change: Change,
  ): Promise<StaffMember> {
    return withTransaction(this.database.pool, async (client) => {
      const upn = input.expectedUpn.trim();
      const { rows: clashes } = await client.query(
        `SELECT 1 FROM app_user
         WHERE lower(expected_upn) = $1 OR lower(sign_in_username) = $1 OR lower(work_email) = $1`,
        [normalizeUpn(upn)],
      );
      if (clashes.length > 0) {
        throw new ConflictException({
          code: 'upn_taken',
          message: 'Someone with that work email is already in the staff list.',
        });
      }
      // The admin adding the entry assigns its official initials, so they are confirmed by that
      // admin in the same statement (MM-T44).
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, position, account_type, status,
                               expected_upn, approved_by, approved_at,
                               initials_confirmed_by_user_id, initials_confirmed_at)
         VALUES ($1, $2, $3, 'personal', 'active', $4, $5, now(),
                 $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [
          input.displayName,
          input.officialInitials,
          input.position ?? null,
          upn,
          change.actor.userId,
        ],
      );
      const id = rows[0]!.id;
      await recordAudit(client, {
        action: 'staff.preprovisioned',
        entityType: 'app_user',
        entityId: id,
        actor: change.actor,
        after: {
          displayName: input.displayName,
          officialInitials: input.officialInitials,
          position: input.position ?? null,
          expectedUpn: upn,
        },
        requestId: change.requestId,
      });
      return this.get(id, client);
    });
  }

  async approve(id: string, change: Change): Promise<StaffMember> {
    return withTransaction(this.database.pool, async (client) => {
      const status = await this.lockStatus(client, id);
      if (status !== 'pending') {
        throw new UnprocessableEntityException({
          code: 'invalid_transition',
          message: 'Only pending accounts can be approved.',
        });
      }
      await client.query(
        `UPDATE app_user SET status = 'active', approved_by = $2, approved_at = now(),
                             updated_at = now()
         WHERE id = $1`,
        [id, change.actor.userId],
      );
      await recordAudit(client, {
        action: 'staff.approved',
        entityType: 'app_user',
        entityId: id,
        actor: change.actor,
        before: { status },
        after: { status: 'active' },
        requestId: change.requestId,
      });
      return this.get(id, client);
    });
  }

  /** Disables and revokes every session (UsersService keeps the one implementation). */
  async disable(id: string, reason: string, change: Change): Promise<StaffMember> {
    await this.users.disable(id, reason, change.actor, change.requestId);
    return this.get(id);
  }

  /**
   * Re-enables a disabled account. Old sessions stay revoked, and every technical grant the person
   * still holds is revoked in the same transaction for revalidation (D08, MM-AO03).
   */
  async enable(id: string, change: Change): Promise<StaffMember> {
    return withTransaction(this.database.pool, async (client) => {
      const status = await this.lockStatus(client, id);
      if (status !== 'disabled') {
        throw new UnprocessableEntityException({
          code: 'invalid_transition',
          message: 'Only disabled accounts can be re-enabled.',
        });
      }
      await client.query(
        `UPDATE app_user
         SET status = 'active', disabled_reason = NULL, updated_at = now(),
             approved_by = COALESCE(approved_by, $2),
             approved_at = COALESCE(approved_at, now())
         WHERE id = $1`,
        [id, change.actor.userId],
      );
      // D08: old technical grants don't come back with the account; each needs revalidation.
      const revokedGrants = await revokeTechnicalGrants(
        client,
        id,
        {
          userId: change.actor.userId!,
          initials: change.actor.initials,
          displayName: change.actor.name ?? '',
        },
        change.actor,
      );
      await recordAudit(client, {
        action: 'staff.enabled',
        entityType: 'app_user',
        entityId: id,
        actor: change.actor,
        before: { status },
        after: { status: 'active', revokedGrants },
        requestId: change.requestId,
      });
      return this.get(id, client);
    });
  }

  /** Replaces the role set. Removing the last active admin's admin role is refused (AC7). */
  async setRoles(
    id: string,
    roles: StaffRole[],
    reason: string | null,
    change: Change,
  ): Promise<StaffMember> {
    const wanted = [...new Set(roles)].sort();
    return withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{ account_type: string }>(
        'SELECT account_type FROM app_user WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (rows.length === 0) {
        throw new NotFoundException({ code: 'not_found' });
      }
      if (rows[0]!.account_type === 'shared_lab' && wanted.length > 0) {
        throw new UnprocessableEntityException({
          code: 'roles_not_allowed',
          message: 'The shared LAB account cannot hold admin or Lab Manager roles.',
        });
      }
      const { rows: current } = await client.query<{ role: StaffRole }>(
        'SELECT role FROM role_assignment WHERE user_id = $1 ORDER BY role',
        [id],
      );
      const before = current.map((row) => row.role);
      if (before.join(',') === wanted.join(',')) {
        return this.get(id, client);
      }
      if (before.includes('admin') && !wanted.includes('admin')) {
        await assertAnotherActiveAdmin(client, id);
      }
      await client.query(
        'DELETE FROM role_assignment WHERE user_id = $1 AND NOT (role = ANY($2::text[]))',
        [id, wanted],
      );
      await client.query(
        `INSERT INTO role_assignment (user_id, role)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [id, wanted],
      );
      await recordAudit(client, {
        action: 'staff.roles_changed',
        entityType: 'app_user',
        entityId: id,
        actor: change.actor,
        reason,
        before: { roles: before },
        after: { roles: wanted },
        requestId: change.requestId,
      });
      return this.get(id, client);
    });
  }

  /**
   * Edits official initials, position or display name on a user's behalf. History keeps the old
   * values: receipts and audit events hold their own snapshots (AC4).
   *
   * Official initials (MM-T44): submitting them assigns them, so the confirmation pair records
   * this admin and time whenever the value changes or was not confirmed yet (submitting the same,
   * unconfirmed value is an explicit confirmation). Already-confirmed, unchanged initials keep
   * their original confirmation, and an edit that omits initials never touches it.
   *
   * Position (MM-T43): "Not set" (null) also clears position_set_at, so the person is asked to
   * choose a position again at their next sign-in or page load (GET /api/me then reports
   * positionSetupRequired). A non-null position leaves position_set_at as it was.
   */
  async update(
    id: string,
    patch: { officialInitials?: string; position?: StaffPosition | null; displayName?: string },
    change: Change,
  ): Promise<StaffMember> {
    return withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{
        official_initials: string | null;
        initials_confirmed_at: Date | null;
        position: StaffPosition | null;
        position_set_at: Date | null;
        display_name: string;
      }>(
        `SELECT official_initials, initials_confirmed_at, position, position_set_at, display_name
         FROM app_user WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (rows.length === 0) {
        throw new NotFoundException({ code: 'not_found' });
      }
      const old = rows[0]!;
      const next = {
        official_initials: patch.officialInitials ?? old.official_initials,
        position: patch.position === undefined ? old.position : patch.position,
        display_name: patch.displayName ?? old.display_name,
      };
      const initialsChanged = next.official_initials !== old.official_initials;
      const confirmInitials =
        patch.officialInitials !== undefined &&
        change.actor.userId !== null &&
        (initialsChanged || old.initials_confirmed_at === null);
      // The CHECK app_user_position_set_has_position needs both cleared together.
      const reopenPosition = next.position === null && old.position_set_at !== null;
      await client.query(
        `UPDATE app_user
         SET official_initials = $2, position = $3, display_name = $4,
             position_set_at = CASE WHEN $5 THEN NULL ELSE position_set_at END,
             initials_confirmed_by_user_id =
               CASE WHEN $6 THEN $7::uuid ELSE initials_confirmed_by_user_id END,
             initials_confirmed_at = CASE WHEN $6 THEN now() ELSE initials_confirmed_at END,
             updated_at = now()
         WHERE id = $1`,
        [
          id,
          next.official_initials,
          next.position,
          next.display_name,
          reopenPosition,
          confirmInitials,
          change.actor.userId,
        ],
      );
      if (initialsChanged) {
        await recordAudit(client, {
          action: 'staff.initials_changed',
          entityType: 'app_user',
          entityId: id,
          actor: change.actor,
          before: { officialInitials: old.official_initials },
          after: { officialInitials: next.official_initials },
          requestId: change.requestId,
        });
      } else if (confirmInitials) {
        await recordAudit(client, {
          action: 'staff.initials_confirmed',
          entityType: 'app_user',
          entityId: id,
          actor: change.actor,
          before: { officialInitials: old.official_initials, initialsConfirmed: false },
          after: { officialInitials: next.official_initials, initialsConfirmed: true },
          requestId: change.requestId,
        });
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (next.position !== old.position) {
        before.position = old.position;
        after.position = next.position;
      }
      if (reopenPosition) {
        before.positionSetAt = old.position_set_at!.toISOString();
        after.positionSetAt = null;
      }
      if (next.display_name !== old.display_name) {
        before.displayName = old.display_name;
        after.displayName = next.display_name;
      }
      if (Object.keys(after).length > 0) {
        await recordAudit(client, {
          action: 'staff.profile_changed',
          entityType: 'app_user',
          entityId: id,
          actor: change.actor,
          before,
          after,
          requestId: change.requestId,
        });
      }
      return this.get(id, client);
    });
  }

  /**
   * D16 (MM-AO06): set or clear an administrator's job-title override, with a reason (owner
   * decision 2026-10-29). It's display metadata only: no role, eligibility, capability or project
   * grant reads it, and the Microsoft title is kept beside it. Setting the same value again is a
   * no-op. The shared LAB account has no personal title (422 `not_personal_account`).
   */
  async setJobTitleOverride(
    id: string,
    override: string | null,
    reason: string,
    change: Change,
  ): Promise<StaffMember> {
    return withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{
        account_type: StaffMember['accountType'];
        job_title: string | null;
        job_title_override: string | null;
      }>(
        `SELECT account_type, job_title, job_title_override FROM app_user WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const old = rows[0];
      if (!old) throw new NotFoundException({ code: 'not_found' });
      if (old.account_type === 'shared_lab') {
        throw new UnprocessableEntityException({
          code: 'not_personal_account',
          message: 'The shared LAB account has no personal job title',
        });
      }
      if (old.job_title_override === override) return this.get(id, client);
      await client.query(
        `UPDATE app_user
         SET job_title_override = $2,
             job_title_override_set_by_user_id = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END,
             job_title_override_set_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
             updated_at = now()
         WHERE id = $1`,
        [id, override, change.actor.userId],
      );
      await recordAudit(client, {
        action:
          override === null ? 'staff.job_title_override_cleared' : 'staff.job_title_override_set',
        entityType: 'app_user',
        entityId: id,
        actor: change.actor,
        reason,
        before: { jobTitleOverride: old.job_title_override, jobTitle: old.job_title },
        after: { jobTitleOverride: override, jobTitle: old.job_title },
        requestId: change.requestId,
      });
      return this.get(id, client);
    });
  }

  /**
   * First-sign-in resolution for Microsoft (MM-T05 calls this inside its sign-in transaction
   * after validating the token). A known identity returns its user. Otherwise a pre-provisioned
   * entry is linked only on an exact (case-insensitive) UPN match with no identity attached;
   * anything else becomes a new pending user. Initials and names are never compared.
   */
  async resolveMicrosoftSignIn(
    client: PoolClient,
    identity: MicrosoftIdentity,
  ): Promise<{ userId: string; outcome: FirstSignInOutcome }> {
    const { rows: known } = await client.query<{ user_id: string }>(
      `SELECT user_id FROM identity_link
       WHERE provider = 'microsoft' AND tenant_id = $1 AND subject = $2`,
      [identity.tenantId, identity.subject],
    );
    if (known.length > 0) {
      return { userId: known[0]!.user_id, outcome: 'existing' };
    }

    const matchId = await linkPreprovisionedStaff(client, identity);
    if (matchId) {
      return { userId: matchId, outcome: 'linked' };
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app_user (display_name, given_name, surname, work_email, sign_in_username,
                             account_type, status)
       VALUES ($1, $2, $3, $4, $5, 'personal', 'pending')
       RETURNING id`,
      [
        identity.displayName,
        identity.givenName ?? null,
        identity.surname ?? null,
        identity.workEmail ?? null,
        identity.upn,
      ],
    );
    const userId = rows[0]!.id;
    await client.query(
      `INSERT INTO identity_link (user_id, provider, tenant_id, subject)
       VALUES ($1, 'microsoft', $2, $3)`,
      [userId, identity.tenantId, identity.subject],
    );
    await recordAudit(client, {
      action: 'staff.pending_created',
      entityType: 'app_user',
      entityId: userId,
      actor: systemActor(userId, identity.displayName),
      after: { status: 'pending', signInUsername: identity.upn },
    });
    return { userId, outcome: 'created' };
  }

  private async lockStatus(client: PoolClient, id: string): Promise<StaffMember['status']> {
    const { rows } = await client.query<{ status: StaffMember['status'] }>(
      'SELECT status FROM app_user WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (rows.length === 0) {
      throw new NotFoundException({ code: 'not_found' });
    }
    return rows[0]!.status;
  }
}
