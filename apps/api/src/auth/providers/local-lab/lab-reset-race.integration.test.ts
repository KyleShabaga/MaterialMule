import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditActor } from '../../../audit/audit.js';
import { loadConfig } from '../../../config/env.js';
import { createApp } from '../../../create-app.js';
import { runSeed } from '../../../db/seed.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../../../test-support/database.js';
import { SessionService } from '../../session.service.js';
import { LabAuthService, type LabSignInResult } from './lab-auth.service.js';
import { verifyPassword } from './password-hash.js';

// Generated per run, never committed (card test data rule).
const newPassword = () => `lab-${randomBytes(12).toString('base64url')}`;

/** A promise the test resolves by hand: holds one side of a race at a known point. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Resolves with a value set later (e.g. the backend pid seen inside a paused operation). */
function signal<T>() {
  let fire!: (value: T) => void;
  const fired = new Promise<T>((resolve) => (fire = resolve));
  return { fired, fire };
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
}

// MM-T40: a LAB password reset and an overlapping LAB sign-in are serialized by a row lock on
// LAB's app_user row, so no session made with the old password survives the reset. Barriers
// (not sleeps) hold each side at the dangerous point; pg_blocking_pids proves the other waits.
describe.runIf(testDatabaseUrl)('LAB password reset vs concurrent sign-in (MM-T40)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  let lab: LabAuthService;
  let admin: AuditActor;
  let password: string;

  /**
   * Polls (no fixed sleep) until some backend is waiting on a lock held by `holderPid`, or until
   * `orElse` settles (the other side got past the point it should have waited at).
   */
  async function waitUntilBlockedBy(holderPid: number, orElse?: Promise<unknown>): Promise<void> {
    let done = false;
    void orElse?.then(() => (done = true));
    while (!done) {
      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE $1::int = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      );
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const signIn = (pw: string) =>
    lab.signIn({ username: 'LAB', password: pw, clientAddress: '192.0.2.40', requestId: null });

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Race Admin', 'RA', 'personal', 'active') RETURNING id`,
    );
    await db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'admin')`, [
      rows[0]!.id,
    ]);
    admin = { userId: rows[0]!.id, accountType: 'personal', initials: 'RA', name: 'Race Admin' };
    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(config);
    await app.init();
    sessions = app.get(SessionService);
    lab = app.get(LabAuthService);
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM sign_in_throttle');
    password = newPassword();
    await lab.setPassword(password, admin, null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('AC1: a sign-in that verified the old password before the reset ends with a revoked session', async () => {
    const createSession = sessions.create.bind(sessions);
    const reached = signal<number>();
    const release = gate();
    // Pause sign-in after the password check, just before its session INSERT.
    vi.spyOn(sessions, 'create').mockImplementation(async (...args) => {
      reached.fire(await backendPid(args[3]!));
      await release.opened;
      return createSession(...args);
    });

    const revokeAll = sessions.revokeAllForUser.bind(sessions);
    const revoked = signal<void>();
    vi.spyOn(sessions, 'revokeAllForUser').mockImplementation(async (...args) => {
      const count = await revokeAll(...args);
      revoked.fire();
      return count;
    });

    const signingIn = signIn(password);
    const signInPid = await reached.fired;
    const replacement = newPassword();
    const resetting = lab.setPassword(replacement, admin, null);
    // The reset cannot replace the password or revoke anything while the sign-in holds LAB.
    // (Before MM-T40 it ran its revocation here instead, which the race below then defeated.)
    await waitUntilBlockedBy(signInPid, revoked.fired);
    release.open();

    const [signedIn, reset] = await Promise.all([signingIn, resetting]);
    expect(signedIn.outcome).toBe('signed_in');
    expect(reset.revokedSessions).toBeGreaterThanOrEqual(1);
    const { session } = signedIn as Extract<LabSignInResult, { outcome: 'signed_in' }>;
    // The token issued during the race cannot authenticate once the reset has completed.
    expect(await sessions.authenticate(session.token)).toBeNull();

    vi.restoreAllMocks();
    expect((await signIn(password)).outcome).toBe('invalid');
    const fresh = await signIn(replacement);
    expect(fresh.outcome).toBe('signed_in');
    const freshToken = (fresh as Extract<LabSignInResult, { outcome: 'signed_in' }>).session.token;
    expect(await sessions.authenticate(freshToken)).toMatchObject({ accountType: 'shared_lab' });
  });

  it('AC2: when the reset wins, a sign-in with the old password cannot create a session', async () => {
    const revokeAll = sessions.revokeAllForUser.bind(sessions);
    const reached = signal<number>();
    const release = gate();
    // Pause the reset after it replaced the password and revoked sessions, before it commits.
    vi.spyOn(sessions, 'revokeAllForUser').mockImplementation(async (userId, client) => {
      const revoked = await revokeAll(userId, client);
      reached.fire(await backendPid(client!));
      await release.opened;
      return revoked;
    });
    const create = vi.spyOn(sessions, 'create');

    const replacement = newPassword();
    const resetting = lab.setPassword(replacement, admin, null);
    const resetPid = await reached.fired;
    const signingIn = signIn(password);
    // The old-password sign-in waits for the reset rather than reading the old hash.
    await waitUntilBlockedBy(resetPid, signingIn);
    release.open();

    const [reset, signedIn] = await Promise.all([resetting, signingIn]);
    expect(reset.revokedSessions).toBeGreaterThanOrEqual(0);
    expect(signedIn.outcome).toBe('invalid');
    expect(create).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    expect((await signIn(replacement)).outcome).toBe('signed_in');
  });

  it('AC5: many overlapping sign-ins and resets finish without deadlock; only the final password keeps a session', async () => {
    const passwords = [password, newPassword(), newPassword(), newPassword()];
    const attempts: { pw: string; result: Promise<LabSignInResult> }[] = [];
    const resets: Promise<unknown>[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (const pw of passwords) attempts.push({ pw, result: signIn(pw) });
      resets.push(lab.setPassword(passwords[round + 1]!, admin, null));
    }
    // Any deadlock (40P01) or lock failure would reject one of these.
    await Promise.all([...resets, ...attempts.map((attempt) => attempt.result)]);

    const { rows } = await db.pool.query<{ password_hash: string }>(
      `SELECT c.password_hash FROM local_credential c
       JOIN identity_link l ON l.user_id = c.user_id
       WHERE l.provider = 'local_lab' AND l.subject = 'LAB'`,
    );
    let current: string | undefined;
    for (const pw of passwords) {
      if (await verifyPassword(pw, rows[0]!.password_hash)) current = pw;
    }
    expect(current).toBeDefined();

    for (const attempt of attempts) {
      const result = await attempt.result;
      if (result.outcome !== 'signed_in') continue;
      const user = await sessions.authenticate(result.session.token);
      if (attempt.pw === current) {
        expect(user).toMatchObject({ accountType: 'shared_lab' });
      } else {
        // Signed in with a password that a later reset replaced: revoked by that reset.
        expect(user).toBeNull();
      }
    }
  });
});
