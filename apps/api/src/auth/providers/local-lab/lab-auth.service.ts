import { Injectable } from '@nestjs/common';
import { LAB_USERNAME, type LabAccountResponse } from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../../../audit/audit.js';
import { DatabaseService } from '../../../database/database.service.js';
import { withTransaction } from '../../../db/transaction.js';
import type { AccountStatus, AccountType } from '../../policy.js';
import { SessionService, type NewSession } from '../../session.service.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password-hash.js';

/** Failures allowed per key inside the window before sign-in is refused (AC7). */
export const MAX_FAILED_ATTEMPTS = 10;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

const ACCOUNT_KEY = `account:${LAB_USERNAME.toLowerCase()}`;
const OTHER_ACCOUNT_KEY = 'account:*';

export type LabSignInResult =
  | { outcome: 'signed_in'; session: NewSession }
  | { outcome: 'invalid' }
  | { outcome: 'locked'; retryAfterSeconds: number };

export interface SignInAttempt {
  username: string;
  password: string;
  clientAddress: string | null;
  requestId: string | null;
  now?: Date;
}

interface LabRow {
  id: string;
  account_type: AccountType;
  status: AccountStatus;
  display_name: string;
  password_hash: string | null;
}

interface ThrottleRow {
  throttle_key: string;
  failed_count: number;
  window_started_at: Date;
  locked_until: Date | null;
}

/** Nobody is signed in yet when a sign-in fails, so failures are attributed to the system. */
const ANONYMOUS: AuditActor = { userId: null, accountType: 'system', initials: null, name: null };

/**
 * The `local_lab` identity provider (MM-T06): username LAB plus an app-managed Argon2id password.
 * It never calls Microsoft or Graph. Brute-force protection counts failures per account and per
 * client address, refuses further attempts for a while once either reaches the limit, and audits
 * every failure and lockout.
 */
@Injectable()
export class LabAuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  /** The LAB account row (seeded by reference data), with its password hash if one is set. */
  private async findLab(client: PoolClient | DatabaseService['pool']): Promise<LabRow | null> {
    const { rows } = await client.query<LabRow>(
      `SELECT u.id, u.account_type, u.status, u.display_name, c.password_hash
       FROM identity_link l
       JOIN app_user u ON u.id = l.user_id
       LEFT JOIN local_credential c ON c.user_id = u.id
       WHERE l.provider = 'local_lab' AND l.tenant_id = '' AND l.subject = $1`,
      [LAB_USERNAME],
    );
    return rows[0] ?? null;
  }

  /** True when LAB can sign in at all (it exists, is active and has a password). */
  async isAvailable(): Promise<boolean> {
    const lab = await this.findLab(this.database.pool);
    return Boolean(lab && lab.status === 'active' && lab.password_hash);
  }

  async signIn(attempt: SignInAttempt): Promise<LabSignInResult> {
    const now = attempt.now ?? new Date();
    const usernameMatches = attempt.username.trim().toUpperCase() === LAB_USERNAME;
    const keys = [
      usernameMatches ? ACCOUNT_KEY : OTHER_ACCOUNT_KEY,
      ...(attempt.clientAddress ? [`address:${attempt.clientAddress}`.slice(0, 200)] : []),
    ];

    return withTransaction(this.database.pool, async (client) => {
      // Lock the throttle rows so concurrent attempts are counted one after another.
      for (const key of keys) {
        await client.query(
          `INSERT INTO sign_in_throttle (throttle_key, window_started_at) VALUES ($1, $2)
           ON CONFLICT (throttle_key) DO NOTHING`,
          [key, now],
        );
      }
      const { rows: throttles } = await client.query<ThrottleRow>(
        `SELECT throttle_key, failed_count, window_started_at, locked_until
         FROM sign_in_throttle WHERE throttle_key = ANY($1::text[])
         ORDER BY throttle_key FOR UPDATE`,
        [keys],
      );
      const lab = await this.findLab(client);
      const entity = usernameMatches && lab ? { type: 'app_user', id: lab.id } : null;
      const auditFailure = (reason: string, extra: Record<string, unknown> = {}) =>
        recordAudit(client, {
          action: 'auth.sign_in_failed',
          entityType: entity?.type ?? 'auth',
          entityId: entity?.id ?? null,
          actor: ANONYMOUS,
          // Never the password, and never an unrecognised username (it may be a mistyped password).
          after: {
            provider: 'local_lab',
            reason,
            usernameMatched: usernameMatches,
            clientAddress: attempt.clientAddress,
            ...extra,
          },
          requestId: attempt.requestId,
        });

      const lockedUntil = throttles
        .map((row) => row.locked_until)
        .filter((until): until is Date => until !== null && until > now)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      if (lockedUntil) {
        await auditFailure('locked_out', { lockedUntil: lockedUntil.toISOString() });
        return {
          outcome: 'locked',
          retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000),
        };
      }

      const usable =
        usernameMatches && lab?.password_hash && lab.status === 'active' ? lab.password_hash : null;
      const valid = usable
        ? await verifyPassword(attempt.password, usable)
        : await verifyAgainstDummy(attempt.password);

      if (!valid || !lab || lab.account_type !== 'shared_lab') {
        await auditFailure(usable ? 'wrong_password' : 'unknown_or_unavailable');
        for (const row of throttles) {
          const windowExpired = now.getTime() - row.window_started_at.getTime() > FAILURE_WINDOW_MS;
          const failedCount = windowExpired ? 1 : row.failed_count + 1;
          const lockNow = failedCount >= MAX_FAILED_ATTEMPTS;
          const until = lockNow ? new Date(now.getTime() + LOCKOUT_MS) : null;
          await client.query(
            `UPDATE sign_in_throttle
             SET failed_count = $2, window_started_at = $3, locked_until = $4
             WHERE throttle_key = $1`,
            [
              row.throttle_key,
              lockNow ? 0 : failedCount,
              windowExpired ? now : row.window_started_at,
              until,
            ],
          );
          if (lockNow) {
            await recordAudit(client, {
              action: 'auth.lockout',
              entityType: entity?.type ?? 'auth',
              entityId: entity?.id ?? null,
              actor: ANONYMOUS,
              after: {
                provider: 'local_lab',
                scope: row.throttle_key.startsWith('address:') ? 'client_address' : 'account',
                clientAddress: attempt.clientAddress,
                failedAttempts: failedCount,
                lockedUntil: until!.toISOString(),
              },
              requestId: attempt.requestId,
            });
          }
        }
        return { outcome: 'invalid' };
      }

      await client.query('DELETE FROM sign_in_throttle WHERE throttle_key = ANY($1::text[])', [
        keys,
      ]);
      const session = await this.sessions.create(lab.id, 'shared_lab', now, client);
      await recordAudit(client, {
        action: 'auth.sign_in',
        entityType: 'session',
        entityId: session.sessionId,
        actor: {
          userId: lab.id,
          accountType: 'shared_lab',
          initials: null,
          name: lab.display_name,
        },
        after: {
          provider: 'local_lab',
          expiresAt: session.expiresAt.toISOString(),
          clientAddress: attempt.clientAddress,
        },
        requestId: attempt.requestId,
      });
      return { outcome: 'signed_in', session };
    });
  }

  /**
   * Sets or resets the LAB password and revokes every LAB session in the same transaction, so
   * stations signed in with the old password stop working on their next request (AC6). Also
   * clears the account lockout.
   */
  async setPassword(
    newPassword: string,
    admin: AuditActor,
    requestId: string | null,
  ): Promise<{ revokedSessions: number }> {
    const hash = await hashPassword(newPassword);
    return withTransaction(this.database.pool, async (client) => {
      const lab = await this.findLab(client);
      if (!lab) {
        throw new Error('The LAB account is missing; run npm run db:migrate to seed it.');
      }
      await client.query(
        `INSERT INTO local_credential (user_id, password_hash, updated_at, updated_by_user_id)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, updated_at = now(),
               updated_by_user_id = EXCLUDED.updated_by_user_id`,
        [lab.id, hash, admin.userId],
      );
      const revokedSessions = await this.sessions.revokeAllForUser(lab.id, client);
      await client.query('DELETE FROM sign_in_throttle WHERE throttle_key = $1', [ACCOUNT_KEY]);
      await recordAudit(client, {
        action: 'lab.password_reset',
        entityType: 'app_user',
        entityId: lab.id,
        actor: admin,
        // The password and its hash never appear in audit values.
        before: { passwordSet: lab.password_hash !== null },
        after: { passwordSet: true, revokedSessions },
        requestId,
      });
      return { revokedSessions };
    });
  }

  async account(now = new Date()): Promise<LabAccountResponse> {
    const { rows } = await this.database.pool.query<{
      id: string;
      updated_at: Date | null;
      has_password: boolean;
      active_sessions: number;
      locked_until: Date | null;
    }>(
      `SELECT u.id, c.updated_at, c.user_id IS NOT NULL AS has_password,
              (SELECT count(*)::int FROM session s
               WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > $2) AS active_sessions,
              (SELECT t.locked_until FROM sign_in_throttle t
               WHERE t.throttle_key = $3 AND t.locked_until > $2) AS locked_until
       FROM identity_link l
       JOIN app_user u ON u.id = l.user_id
       LEFT JOIN local_credential c ON c.user_id = u.id
       WHERE l.provider = 'local_lab' AND l.tenant_id = '' AND l.subject = $1`,
      [LAB_USERNAME, now, ACCOUNT_KEY],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('The LAB account is missing; run npm run db:migrate to seed it.');
    }
    return {
      userId: row.id,
      passwordSet: row.has_password,
      passwordUpdatedAt: row.updated_at?.toISOString() ?? null,
      activeSessions: row.active_sessions,
      lockedUntil: row.locked_until?.toISOString() ?? null,
    };
  }
}
