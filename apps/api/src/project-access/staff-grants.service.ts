import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  addReviewerExclusionRequestSchema,
  enablePositionRuleRequestSchema,
  endGrantRequestSchema,
  grantReviewerEligibilityRequestSchema,
  type Position,
  type PositionRules,
  grantStaffCapabilityRequestSchema,
  type ReviewScope,
  type StaffCapability,
  type StaffGrants,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { can, type AuthUser, type Permission } from '../auth/policy.js';
import { asLocked, isActiveStaff, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { parseBody } from '../validation/parse-body.js';
import { recordAudit } from '../audit/audit.js';
import {
  REVIEWER_ELIGIBILITY,
  REVIEWER_EXCLUSION,
  STAFF_CAPABILITY_GRANT,
  endGrant,
  findByKey,
  hasActive,
  historyView,
  insertGrant,
  listGrants,
  lockGrant,
  type GrantTable,
} from './grant-tables.js';
import { activeScopes, forbidden, intentHash, unprocessable } from './project-access.service.js';
import {
  effectiveEligibility,
  lockReviewEligibility,
  settleEligibilityLoss,
} from './review-eligibility.js';

/** The rows whose changes move effective review eligibility (MISC-08). */
const ELIGIBILITY_SOURCES: readonly GrantTable[] = [REVIEWER_ELIGIBILITY, REVIEWER_EXCLUSION];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-person history kept in one response; an admin sees the newest. */
const STAFF_GRANT_HISTORY_LIMIT = 50;

type Db = Pool | PoolClient;

/**
 * Reviewer eligibility (D05) and the "Can create and lead projects" capability (D01), granted and
 * revoked by an admin with a reason (D15). Neither is ever derived from a job title or position.
 * Eligibility only makes a person assignable as a scoped reviewer; the capability is consumed by
 * project creation (MM-AO04). Each write locks the admin's and the person's accounts (FOR SHARE,
 * in id order) and rechecks the admin role and both statuses under the lock (D09).
 */
@Injectable()
export class StaffGrantsService {
  constructor(private readonly database: DatabaseService) {}

  async grants(userId: string, user: AuthUser): Promise<StaffGrants> {
    if (!UUID_PATTERN.test(userId)) throw new NotFoundException({ code: 'not_found' });
    const { rows } = await this.database.pool.query('SELECT 1 FROM app_user WHERE id = $1', [
      userId,
    ]);
    if (rows.length === 0) throw new NotFoundException({ code: 'not_found' });
    return this.view(this.database.pool, userId, user);
  }

  grantEligibility(userId: string, body: unknown, user: AuthUser): Promise<StaffGrants> {
    return this.start(userId, user, 'reviewer_eligibility.manage', REVIEWER_ELIGIBILITY, () => {
      const request = parseBody(grantReviewerEligibilityRequestSchema, body);
      return {
        scope: request.scopeCode,
        reason: request.reason,
        key: request.idempotencyKey,
        hash: intentHash({ userId, scopeCode: request.scopeCode, reason: request.reason }),
        check: async (client) => {
          if (!(await activeScopes(client)).has(request.scopeCode)) {
            unprocessable('invalid_scope', 'scopeCode', 'Choose a review scope');
          }
        },
      };
    });
  }

  revokeEligibility(userId: string, id: string, body: unknown, user: AuthUser) {
    return this.end(userId, id, body, user, 'reviewer_eligibility.manage', REVIEWER_ELIGIBILITY);
  }

  /**
   * MISC-08: exclude a person from one review scope, or (`scopeCode: null`) from all scopes. It
   * overrides position rules and individual grants; an actual loss ends affected approvals.
   */
  addExclusion(userId: string, body: unknown, user: AuthUser): Promise<StaffGrants> {
    return this.start(userId, user, 'reviewer_eligibility.manage', REVIEWER_EXCLUSION, () => {
      const request = parseBody(addReviewerExclusionRequestSchema, body);
      return {
        scope: request.scopeCode,
        reason: request.reason,
        key: request.idempotencyKey,
        hash: intentHash({ userId, exclude: request.scopeCode, reason: request.reason }),
        check: async (client) => {
          if (request.scopeCode !== null && !(await activeScopes(client)).has(request.scopeCode)) {
            unprocessable('invalid_scope', 'scopeCode', 'Choose a review scope');
          }
        },
      };
    });
  }

  /** Removing an exclusion recalculates eligibility; it approves no project review work. */
  removeExclusion(userId: string, id: string, body: unknown, user: AuthUser) {
    return this.end(userId, id, body, user, 'reviewer_eligibility.manage', REVIEWER_EXCLUSION);
  }

  async positionRules(user: AuthUser): Promise<PositionRules> {
    if (!can(user, 'reviewer_eligibility.manage')) throw forbidden();
    return this.rulesView(this.database.pool);
  }

  /** MISC-08: everyone with `position` becomes eligible for the scope, now and later. */
  async enablePositionRule(body: unknown, user: AuthUser): Promise<PositionRules> {
    if (!can(user, 'reviewer_eligibility.manage')) throw forbidden();
    const request = parseBody(enablePositionRuleRequestSchema, body);
    const hash = intentHash({
      position: request.position,
      scopeCode: request.scopeCode,
      reason: request.reason,
    });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const standing = await lockStanding(client, [user.userId]);
        const actor = asLocked(user, standing);
        if (!can(actor, 'reviewer_eligibility.manage')) throw forbidden();
        await lockReviewEligibility(client);
        const { rows: previous } = await client.query<{ hash: string; by: string }>(
          `SELECT grant_request_hash AS hash, granted_by_user_id AS by FROM review_position_rule
           WHERE grant_idempotency_key = $1`,
          [request.idempotencyKey],
        );
        if (previous[0]) {
          if (previous[0].hash !== hash || previous[0].by !== user.userId) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          return this.rulesView(client);
        }
        if (!(await activeScopes(client)).has(request.scopeCode)) {
          unprocessable('invalid_scope', 'scopeCode', 'Choose a review scope');
        }
        const by = standing.get(user.userId)!;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO review_position_rule (position, scope_code, granted_by_user_id,
             granted_by_initials_snapshot, granted_by_name_snapshot, grant_reason,
             grant_idempotency_key, grant_request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            request.position,
            request.scopeCode,
            by.userId,
            by.initials,
            by.displayName,
            request.reason,
            request.idempotencyKey,
            hash,
          ],
        );
        await recordAudit(client, {
          action: 'review_position_rule.enabled',
          entityType: 'review_position_rule',
          entityId: rows[0]!.id,
          actor: actorOf(actor),
          reason: request.reason,
          before: { enabled: false },
          after: { enabled: true, position: request.position, scope: request.scopeCode },
        });
        return this.rulesView(client);
      });
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== '23505') throw error;
      if (failure.constraint?.endsWith('idempotency_key_key')) {
        return this.enablePositionRule(body, user);
      }
      throw new ConflictException({ code: 'already_granted' });
    }
  }

  /** Disabling a rule ends approvals only for people it leaves with no other source. */
  async disablePositionRule(id: string, body: unknown, user: AuthUser): Promise<PositionRules> {
    if (!can(user, 'reviewer_eligibility.manage')) throw forbidden();
    const { reason } = parseBody(endGrantRequestSchema, body);
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException({ code: 'review_position_rule_not_found' });
    }
    return withTransaction(this.database.pool, async (client) => {
      const standing = await lockStanding(client, [user.userId]);
      const actor = asLocked(user, standing);
      if (!can(actor, 'reviewer_eligibility.manage')) throw forbidden();
      await lockReviewEligibility(client);
      const { rows } = await client.query<{
        position: Position;
        scope_code: string;
        ended: boolean;
      }>(
        `SELECT position, scope_code, revoked_at IS NOT NULL AS ended FROM review_position_rule
         WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const rule = rows[0];
      if (!rule) throw new NotFoundException({ code: 'review_position_rule_not_found' });
      if (!rule.ended) {
        const by = standing.get(user.userId)!;
        await client.query(
          `UPDATE review_position_rule
           SET revoked_at = now(), revoked_by_user_id = $2, revoked_by_initials_snapshot = $3,
               revoked_by_name_snapshot = $4, revoke_reason = $5
           WHERE id = $1`,
          [id, by.userId, by.initials, by.displayName, reason],
        );
        await recordAudit(client, {
          action: 'review_position_rule.disabled',
          entityType: 'review_position_rule',
          entityId: id,
          actor: actorOf(actor),
          reason,
          before: { enabled: true, position: rule.position, scope: rule.scope_code },
          after: { enabled: false, position: rule.position, scope: rule.scope_code },
        });
        await settleEligibilityLoss(client, { by, actor: actorOf(actor), reason });
      }
      return this.rulesView(client);
    });
  }

  grantCapability(userId: string, body: unknown, user: AuthUser): Promise<StaffGrants> {
    return this.start(userId, user, 'staff_capability.manage', STAFF_CAPABILITY_GRANT, () => {
      const request = parseBody(grantStaffCapabilityRequestSchema, body);
      return {
        scope: request.capability,
        reason: request.reason,
        key: request.idempotencyKey,
        hash: intentHash({ userId, capability: request.capability, reason: request.reason }),
        check: async () => {},
      };
    });
  }

  revokeCapability(userId: string, id: string, body: unknown, user: AuthUser) {
    return this.end(userId, id, body, user, 'staff_capability.manage', STAFF_CAPABILITY_GRANT);
  }

  private async start(
    userId: string,
    user: AuthUser,
    permission: Permission,
    t: GrantTable,
    prepare: () => {
      scope: string | null;
      reason: string;
      key: string;
      hash: string;
      check: (client: PoolClient) => Promise<void>;
    },
  ): Promise<StaffGrants> {
    if (!can(user, permission)) throw forbidden();
    if (!UUID_PATTERN.test(userId)) throw new NotFoundException({ code: 'not_found' });
    const intent = prepare();
    const run = () =>
      withTransaction(this.database.pool, async (client) => {
        const standing = await lockStanding(client, [user.userId, userId]);
        const actor = asLocked(user, standing);
        if (!can(actor, permission)) throw forbidden();
        const subject = standing.get(userId);
        if (!subject) throw new NotFoundException({ code: 'not_found' });
        const source = ELIGIBILITY_SOURCES.includes(t);
        if (source) await lockReviewEligibility(client);

        const previous = await findByKey(client, t, intent.key);
        if (previous) {
          if (previous.hash !== intent.hash || previous.by !== user.userId) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          return this.view(client, userId, actor);
        }
        if (!isActiveStaff(subject)) {
          unprocessable('invalid_recipient', 'userId', 'Choose an active staff member');
        }
        await intent.check(client);
        if (
          await hasActive(client, t, { parentId: null, subjectId: userId, scope: intent.scope })
        ) {
          unprocessable('already_granted', 'scopeCode', 'Already granted');
        }
        await insertGrant(client, t, {
          parentId: null,
          subject,
          scope: intent.scope,
          by: standing.get(user.userId)!,
          reason: intent.reason,
          key: intent.key,
          hash: intent.hash,
          actor: actorOf(actor),
          audit: {},
        });
        // An exclusion can be an actual loss; a new grant never is.
        if (source) {
          await settleEligibilityLoss(client, {
            by: standing.get(user.userId)!,
            actor: actorOf(actor),
            reason: intent.reason,
          });
        }
        return this.view(client, userId, actor);
      });
    try {
      return await run();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== '23505') throw error;
      // A concurrent exact retry committed first: return what it wrote (or refuse a reused key).
      if (failure.constraint?.endsWith('idempotency_key_key')) return run();
      throw new ConflictException({ code: 'already_granted' });
    }
  }

  private async end(
    userId: string,
    id: string,
    body: unknown,
    user: AuthUser,
    permission: Permission,
    t: GrantTable,
  ): Promise<StaffGrants> {
    if (!can(user, permission)) throw forbidden();
    const { reason } = parseBody(endGrantRequestSchema, body);
    if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(id)) {
      throw new NotFoundException({ code: `${t.table}_not_found` });
    }
    return withTransaction(this.database.pool, async (client) => {
      const standing = await lockStanding(client, [user.userId]);
      const actor = asLocked(user, standing);
      if (!can(actor, permission)) throw forbidden();
      const source = ELIGIBILITY_SOURCES.includes(t);
      if (source) await lockReviewEligibility(client);
      const row = await lockGrant(client, t, id, { column: 'user_id', value: userId });
      if (!row) throw new NotFoundException({ code: `${t.table}_not_found` });
      if (!row.endedAt) {
        const by = standing.get(user.userId)!;
        await endGrant(client, t, row, { by, reason, actor: actorOf(actor) });
        // Revoking a grant may be an actual loss; removing an exclusion never is, and it never
        // brings an ended approval back (MISC-08).
        if (source) await settleEligibilityLoss(client, { by, actor: actorOf(actor), reason });
      }
      return this.view(client, userId, actor);
    });
  }

  private async view(db: Db, userId: string, user: AuthUser): Promise<StaffGrants> {
    const { rows: scopeRows } = await db.query<ReviewScope>('SELECT code, label FROM review_scope');
    const scopes = new Map(scopeRows.map((row) => [row.code, row]));
    const options = { historyLimit: STAFF_GRANT_HISTORY_LIMIT };
    const eligibility = await listGrants(
      db,
      REVIEWER_ELIGIBILITY,
      { column: 'user_id', value: userId },
      options,
    );
    const capabilities = await listGrants(
      db,
      STAFF_CAPABILITY_GRANT,
      { column: 'user_id', value: userId },
      options,
    );
    const toEligibility = (row: (typeof eligibility.active)[number]) => ({
      ...historyView(row),
      scope: scopes.get(row.scope!)!,
    });
    const toCapability = (row: (typeof capabilities.active)[number]) => ({
      ...historyView(row),
      capability: row.scope as StaffCapability,
    });
    const exclusions = await listGrants(
      db,
      REVIEWER_EXCLUSION,
      { column: 'user_id', value: userId },
      options,
    );
    const toExclusion = (row: (typeof exclusions.active)[number]) => ({
      ...historyView(row),
      scope: row.scope ? scopes.get(row.scope)! : null,
    });
    const { rows: person } = await db.query<{ position: Position | null }>(
      'SELECT position FROM app_user WHERE id = $1',
      [userId],
    );
    return {
      userId,
      canManage: can(user, 'reviewer_eligibility.manage') && can(user, 'staff_capability.manage'),
      // Positions show only to admins, in Settings > Staff & access (MISC-06).
      position: can(user, 'staff.manage') ? (person[0]?.position ?? null) : null,
      effectiveEligibility: await effectiveEligibility(db, userId),
      exclusions: {
        active: exclusions.active.map(toExclusion),
        history: exclusions.history.map(toExclusion),
      },
      reviewerEligibility: {
        active: eligibility.active.map(toEligibility),
        history: eligibility.history.map(toEligibility),
      },
      capabilities: {
        active: capabilities.active.map(toCapability),
        history: capabilities.history.map(toCapability),
      },
    };
  }

  private async rulesView(db: Db): Promise<PositionRules> {
    const { rows: scopeRows } = await db.query<ReviewScope>('SELECT code, label FROM review_scope');
    const scopes = new Map(scopeRows.map((row) => [row.code, row]));
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT * FROM review_position_rule
       ORDER BY revoked_at IS NOT NULL, coalesce(revoked_at, granted_at) DESC, id
       LIMIT 200`,
    );
    const person = (row: Record<string, unknown>, prefix: string) => ({
      userId: row[`${prefix}_user_id`] as string,
      initials: (row[`${prefix}_initials_snapshot`] as string | null) ?? null,
      name: (row[`${prefix}_name_snapshot`] as string | null) ?? '',
    });
    const view = (row: Record<string, unknown>) => ({
      id: row.id as string,
      position: row.position as Position,
      scope: scopes.get(row.scope_code as string)!,
      startedBy: person(row, 'granted_by'),
      startedAt: (row.granted_at as Date).toISOString(),
      startReason: row.grant_reason as string,
      endedBy: row.revoked_by_user_id ? person(row, 'revoked_by') : null,
      endedAt: (row.revoked_at as Date | null)?.toISOString() ?? null,
      endReason: (row.revoke_reason as string | null) ?? null,
    });
    return {
      active: rows.filter((row) => !row.revoked_at).map(view),
      history: rows.filter((row) => row.revoked_at).map(view),
    };
  }
}
