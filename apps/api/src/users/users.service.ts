import { Injectable, NotFoundException } from '@nestjs/common';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';

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
  async disable(userId: string, reason: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM app_user WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (rows.length === 0) {
        throw new NotFoundException({ code: 'not_found' });
      }
      await client.query(
        `UPDATE app_user SET status = 'disabled', updated_at = now() WHERE id = $1`,
        [userId],
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
      });
    });
  }
}
