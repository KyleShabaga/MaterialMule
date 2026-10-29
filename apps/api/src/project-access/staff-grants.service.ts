import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  endGrantRequestSchema,
  grantReviewerEligibilityRequestSchema,
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
import {
  REVIEWER_ELIGIBILITY,
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
      scope: string;
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
      const row = await lockGrant(client, t, id, { column: 'user_id', value: userId });
      if (!row) throw new NotFoundException({ code: `${t.table}_not_found` });
      if (!row.endedAt) {
        await endGrant(client, t, row, {
          by: standing.get(user.userId)!,
          reason,
          actor: actorOf(actor),
        });
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
    return {
      userId,
      canManage: can(user, 'reviewer_eligibility.manage') && can(user, 'staff_capability.manage'),
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
}
