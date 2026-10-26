import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { AccountStatus, AccountType, AuthUser, Role } from './policy.js';

export interface NewSession {
  /** Raw token for the cookie. Only its SHA-256 is stored. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

// last_seen_at is a hint for admins, so it's written at most this often per session.
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * One calendar month later at the same time of day, clamped to the month's last day.
 * Calculated in UTC; TRP-T06 (the only user of month-long sessions) makes it business-time-zone
 * aware for sign-ins near midnight at month end.
 */
export function addCalendarMonth(from: Date): Date {
  const result = new Date(from);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

interface SessionRow {
  session_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
  user_id: string;
  account_type: AccountType;
  status: AccountStatus;
  display_name: string;
  official_initials: string | null;
  roles: Role[];
}

/** Server-side, revocable sessions (TRP-T04). Expiry is absolute: sessions never slide. */
@Injectable()
export class SessionService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Expiry for a new session: LAB one calendar month (App Idea §8), others a fixed number of hours. */
  expiryFor(accountType: AccountType, issuedAt: Date): Date {
    if (accountType === 'shared_lab') {
      return addCalendarMonth(issuedAt);
    }
    return new Date(issuedAt.getTime() + this.config.PERSONAL_SESSION_HOURS * 60 * 60 * 1000);
  }

  async create(
    userId: string,
    accountType: AccountType,
    issuedAt = new Date(),
  ): Promise<NewSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.expiryFor(accountType, issuedAt);
    const { rows } = await this.database.pool.query<{ id: string }>(
      `INSERT INTO session (user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, hashToken(token), issuedAt, expiresAt],
    );
    return { token, sessionId: rows[0]!.id, expiresAt };
  }

  /**
   * Resolves a cookie token to the signed-in user, or null when the session is unknown, revoked
   * or expired. Disabled users resolve to null too. Pending users resolve (status 'pending') so
   * they can reach /api/me and sign out, and nothing else.
   */
  async authenticate(token: string, now = new Date()): Promise<AuthUser | null> {
    const { rows } = await this.database.pool.query<SessionRow>(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at, s.last_seen_at,
              u.id AS user_id, u.account_type, u.status, u.display_name, u.official_initials,
              COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM session s
       JOIN app_user u ON u.id = s.user_id
       LEFT JOIN role_assignment r ON r.user_id = u.id
       WHERE s.token_hash = $1
       GROUP BY s.id, u.id`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row || row.revoked_at || row.expires_at <= now || row.status === 'disabled') {
      return null;
    }
    if (!row.last_seen_at || now.getTime() - row.last_seen_at.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.database.pool.query('UPDATE session SET last_seen_at = $2 WHERE id = $1', [
        row.session_id,
        now,
      ]);
    }
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      accountType: row.account_type,
      status: row.status,
      roles: row.roles,
      displayName: row.display_name,
      initials: row.official_initials,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.database.pool.query(
      'UPDATE session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  /** Revokes every live session of a user. Pass `client` to join the caller's transaction. */
  async revokeAllForUser(userId: string, client?: PoolClient): Promise<number> {
    const result = await (client ?? this.database.pool).query(
      'UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return result.rowCount ?? 0;
  }
}
