import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';

/**
 * Refuses a change that would leave no active admin (TRP-T07 AC7). Locks every admin role row
 * first, so two admins demoting or disabling each other at the same time are serialized and the
 * second one sees the first one's change. Call inside the transaction that makes the change.
 */
export async function assertAnotherActiveAdmin(
  client: PoolClient,
  losingUserId: string,
): Promise<void> {
  await client.query(`SELECT user_id FROM role_assignment WHERE role = 'admin' FOR UPDATE`);
  const { rows } = await client.query<{ is_admin: boolean; others: number }>(
    `SELECT
       EXISTS (SELECT 1 FROM role_assignment r JOIN app_user u ON u.id = r.user_id
               WHERE r.role = 'admin' AND r.user_id = $1 AND u.status = 'active'
                 AND u.account_type <> 'shared_lab') AS is_admin,
       (SELECT count(*)::int FROM role_assignment r JOIN app_user u ON u.id = r.user_id
        WHERE r.role = 'admin' AND r.user_id <> $1 AND u.status = 'active'
          AND u.account_type <> 'shared_lab') AS others`,
    [losingUserId],
  );
  if (rows[0]!.is_admin && rows[0]!.others === 0) {
    throw new UnprocessableEntityException({
      code: 'last_admin',
      message:
        'Trapezoid needs at least one active administrator. Make someone else an admin first.',
    });
  }
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Disables a user and revokes every session in the same transaction, so the next request with
   * any of their cookies fails. History keeps their attribution. Used by staff admin (TRP-T07).
   */
  async disable(
    userId: string,
    reason: string,
    actor: AuditActor,
    requestId: string | null = null,
  ): Promise<void> {
    await withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM app_user WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (rows.length === 0) {
        throw new NotFoundException({ code: 'not_found' });
      }
      if (rows[0]!.status === 'disabled') {
        throw new UnprocessableEntityException({
          code: 'invalid_transition',
          message: 'This account is already disabled.',
        });
      }
      await assertAnotherActiveAdmin(client, userId);
      await client.query(
        `UPDATE app_user SET status = 'disabled', disabled_reason = $2, updated_at = now()
         WHERE id = $1`,
        [userId, reason],
      );
      const revoked = await this.sessions.revokeAllForUser(userId, client);
      await recordAudit(client, {
        action: 'staff.disabled',
        entityType: 'app_user',
        entityId: userId,
        actor,
        reason,
        before: { status: rows[0]!.status },
        after: { status: 'disabled', revokedSessions: revoked },
        requestId,
      });
    });
  }
}
