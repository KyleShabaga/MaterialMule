import { randomBytes } from 'node:crypto';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { meResponseSchema } from '@trapezoid/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAuditForEntity } from '../../../audit/audit.js';
import { loadConfig } from '../../../config/env.js';
import { createApp } from '../../../create-app.js';
import { runSeed } from '../../../db/seed.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../../../test-support/database.js';
import { ROUTE_POLICY, type RoutePolicy } from '../../auth.decorators.js';
import { CSRF_HEADER } from '../../auth.guard.js';
import { addCalendarMonth } from '../../calendar-month.js';
import { LAB_PERMISSIONS } from '../../policy.js';
import { SESSION_COOKIE } from '../../session-cookie.js';
import { SessionService } from '../../session.service.js';
import { LabAuthService, MAX_FAILED_ATTEMPTS } from './lab-auth.service.js';

const LAB_ID = '00000000-0000-4000-8000-000000000001';
const EDMONTON = 'America/Edmonton';
// Generated per run, never committed (card test data rule).
const newPassword = () => `lab-${randomBytes(12).toString('base64url')}`;

describe.runIf(testDatabaseUrl)('operational LAB login (TRP-T06)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  let labService: LabAuthService;
  let adminId: string;
  let techId: string;
  let password: string;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  const http = () => request(app.getHttpServer());

  async function addUser(name: string, roles: string[] = []): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', 'active') RETURNING id`,
      [name, name.toUpperCase().slice(0, 5)],
    );
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
    return rows[0]!.id;
  }

  async function cookieFor(userId: string) {
    const session = await sessions.create(userId, 'personal');
    return `${SESSION_COOKIE}=${session.token}`;
  }

  function labSignIn(username: string, pw: string) {
    return http()
      .post('/api/auth/lab/sign-in')
      .set(CSRF_HEADER, '1')
      .send({ username, password: pw });
  }

  function sessionCookieOf(response: request.Response): string {
    const header = response.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = header?.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie) throw new Error('no session cookie');
    return cookie;
  }

  async function resetPassword(pw: string, cookie?: string) {
    return http()
      .post('/api/admin/lab/password')
      .set('Cookie', cookie ?? (await cookieFor(adminId)))
      .set(CSRF_HEADER, '1')
      .send({ newPassword: pw });
  }

  async function auditCount(): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_event',
    );
    return rows[0]!.n;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    adminId = await addUser('Admin', ['admin']);
    techId = await addUser('Tech');
    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      BUSINESS_TIME_ZONE: EDMONTON,
    });
    app = await createApp(config);
    await app.init();
    sessions = app.get(SessionService);
    labService = app.get(LabAuthService);
  });

  beforeEach(async () => {
    // Every request here comes from 127.0.0.1, so start each test with no failures counted.
    await db.pool.query('DELETE FROM sign_in_throttle');
  });

  afterEach(() => {
    // No Microsoft, Graph or any other outbound call during LAB sign-in (AC1).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    await app?.close();
    await db?.drop();
  });

  it('offers LAB sign-in only once an admin has set its password', async () => {
    expect((await http().get('/api/auth/providers')).body).toMatchObject({ lab: false });
    expect((await labSignIn('LAB', 'anything-at-all-123')).status).toBe(401);

    password = newPassword();
    const response = await resetPassword(password);
    expect(response.status).toBe(200);
    expect((await http().get('/api/auth/providers')).body).toMatchObject({ lab: true });
  });

  it('AC1: signs in with a session exactly one calendar month long and a persistent cookie', async () => {
    const before = new Date();
    const response = await labSignIn('lab', password);
    expect(response.status).toBe(204);

    const cookie = sessionCookieOf(response);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const expiresHeader = /Expires=([^;]+)/.exec(cookie)?.[1];
    expect(expiresHeader).toBeDefined();

    const token = /^trapezoid_session=([^;]+)/.exec(cookie)![1]!;
    const me = meResponseSchema.parse(
      (await http().get('/api/me').set('Cookie', `${SESSION_COOKIE}=${token}`)).body,
    );
    expect(me).toMatchObject({ displayName: 'LAB', accountType: 'shared_lab', status: 'active' });
    expect(me.permissions.sort()).toEqual([...LAB_PERMISSIONS].sort());

    const { rows } = await db.pool.query<{ created_at: Date; expires_at: Date; id: string }>(
      `SELECT id, created_at, expires_at FROM session
       WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 1`,
      [LAB_ID, new Date(before.getTime() - 1000)],
    );
    const session = rows[0]!;
    expect(session.expires_at.toISOString()).toBe(
      addCalendarMonth(session.created_at, EDMONTON).toISOString(),
    );
    expect(me.sessionExpiresAt).toBe(session.expires_at.toISOString());
    // Cookie Expires is the session expiry (HTTP dates have whole seconds).
    expect(Math.floor(new Date(expiresHeader!).getTime() / 1000)).toBe(
      Math.floor(session.expires_at.getTime() / 1000),
    );

    const history = await listAuditForEntity(db.pool, 'session', session.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'auth.sign_in',
      actorUserId: LAB_ID,
      actorAccountType: 'shared_lab',
      after: { provider: 'local_lab' },
    });
  });

  it('AC2: a sign-in on Jan 31 expires on Feb 28 at the same local time', async () => {
    const jan31 = new Date('2026-01-31T21:00:00Z'); // 14:00 MST
    const result = await labService.signIn({
      username: 'LAB',
      password,
      clientAddress: null,
      requestId: null,
      now: jan31,
    });
    expect(result.outcome).toBe('signed_in');
    if (result.outcome !== 'signed_in') return;
    expect(result.session.expiresAt.toISOString()).toBe('2026-02-28T21:00:00.000Z');

    const leap = await sessions.create(LAB_ID, 'shared_lab', new Date('2028-01-31T21:00:00Z'));
    expect(leap.expiresAt.toISOString()).toBe('2028-02-29T21:00:00.000Z');
  });

  it('AC3: daily activity never extends the session', async () => {
    const start = new Date('2026-03-01T17:00:00Z');
    const session = await sessions.create(LAB_ID, 'shared_lab', start);
    const expiry = session.expiresAt.getTime();
    for (let day = 0; day < 31; day += 1) {
      const now = new Date(start.getTime() + day * 24 * 3_600_000);
      if (now.getTime() >= expiry) break;
      expect(await sessions.authenticate(session.token, now), `day ${day}`).not.toBeNull();
    }
    const { rows } = await db.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM session WHERE id = $1',
      [session.sessionId],
    );
    expect(rows[0]!.expires_at.getTime()).toBe(expiry);
    expect(await sessions.authenticate(session.token, new Date(expiry - 1))).not.toBeNull();
    expect(await sessions.authenticate(session.token, new Date(expiry))).toBeNull();
  });

  it('T3/AC5: every endpoint outside the LAB allow-list answers 403 and changes nothing', async () => {
    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);
    const denied: { method: string; path: string; permission: string }[] = [];
    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as (...args: unknown[]) => unknown;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) continue;
        const policy = reflector.getAllAndOverride<RoutePolicy>(ROUTE_POLICY, [handler, metatype]);
        if (policy.kind !== 'permission' || LAB_PERMISSIONS.has(policy.permission)) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
        const url = `/api/${[base, path].filter((p) => p && p !== '/').join('/')}`
          .replace(/\/+/g, '/')
          .replace(/:userId/g, LAB_ID)
          .replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-0000000000ff');
        denied.push({ method, path: url, permission: policy.permission });
      }
    }
    // At least the admin endpoints exist today; later cards add more and this test covers them.
    expect(denied.map((d) => d.path)).toEqual(
      expect.arrayContaining(['/api/admin/lab', '/api/admin/lab/password']),
    );

    const response = await labSignIn('LAB', password);
    const cookie = sessionCookieOf(response).split(';')[0]!;
    const before = await auditCount();
    const credential = await db.pool.query('SELECT password_hash FROM local_credential');

    for (const route of denied) {
      const call = http()
        [route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](route.path)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .send({ newPassword: newPassword() });
      const result = await call;
      expect(result.status, `${route.method} ${route.path} (${route.permission})`).toBe(403);
      expect(result.body).toMatchObject({ code: 'forbidden' });
    }

    expect(await auditCount()).toBe(before);
    expect((await db.pool.query('SELECT password_hash FROM local_credential')).rows).toEqual(
      credential.rows,
    );
    // LAB is still signed in: nothing it tried revoked its own sessions.
    expect((await http().get('/api/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('LAB may use allow-listed endpoints', async () => {
    const response = await labSignIn('LAB', password);
    const cookie = sessionCookieOf(response).split(';')[0]!;
    expect((await http().get('/api/activity/recent').set('Cookie', cookie)).status).toBe(200);
  });

  it('T4/AC6: resetting the password ends every LAB session on the next request', async () => {
    const first = sessionCookieOf(await labSignIn('LAB', password)).split(';')[0]!;
    const second = sessionCookieOf(await labSignIn('LAB', password)).split(';')[0]!;
    expect((await http().get('/api/me').set('Cookie', first)).status).toBe(200);

    const oldPassword = password;
    password = newPassword();
    const reset = await resetPassword(password);
    expect(reset.status).toBe(200);
    expect(reset.body.revokedSessions).toBeGreaterThanOrEqual(2);

    expect((await http().get('/api/me').set('Cookie', first)).status).toBe(401);
    expect((await http().get('/api/me').set('Cookie', second)).status).toBe(401);
    expect((await labSignIn('LAB', oldPassword)).status).toBe(401);
    expect((await labSignIn('LAB', password)).status).toBe(204);

    const history = await listAuditForEntity(db.pool, 'app_user', LAB_ID, { limit: 100 });
    const resetEvent = history.find((event) => event.action === 'lab.password_reset');
    expect(resetEvent).toMatchObject({
      actorUserId: adminId,
      before: { passwordSet: true },
      after: { passwordSet: true },
    });
    const everything = JSON.stringify(
      (await db.pool.query('SELECT before_values, after_values FROM audit_event')).rows,
    );
    expect(everything).not.toContain(password);
    expect(everything).not.toContain(oldPassword);
    expect(everything).not.toContain('$argon2id');
  });

  it('enforces the password policy without echoing the password', async () => {
    const short = 'Short-pw-11';
    const response = await resetPassword(short);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'invalid_password' });
    expect(JSON.stringify(response.body)).not.toContain(short);
    expect((await resetPassword(' '.repeat(14))).status).toBe(400);
  });

  it('only admins may set the LAB password or see its state', async () => {
    const tech = await cookieFor(techId);
    expect((await resetPassword(newPassword(), tech)).status).toBe(403);
    expect((await http().get('/api/admin/lab').set('Cookie', tech)).status).toBe(403);

    const admin = await http()
      .get('/api/admin/lab')
      .set('Cookie', await cookieFor(adminId));
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ userId: LAB_ID, passwordSet: true, lockedUntil: null });
  });

  it('admin revocation (T04) signs LAB out everywhere', async () => {
    const lab = sessionCookieOf(await labSignIn('LAB', password)).split(';')[0]!;
    const response = await http()
      .post(`/api/admin/users/${LAB_ID}/sessions/revoke`)
      .set('Cookie', await cookieFor(adminId))
      .set(CSRF_HEADER, '1');
    expect(response.status).toBe(201);
    expect((await http().get('/api/me').set('Cookie', lab)).status).toBe(401);
  });

  it('sign-out ends the LAB session', async () => {
    const lab = sessionCookieOf(await labSignIn('LAB', password)).split(';')[0]!;
    expect(
      (await http().post('/api/auth/sign-out').set('Cookie', lab).set(CSRF_HEADER, '1')).status,
    ).toBe(204);
    expect((await http().get('/api/me').set('Cookie', lab)).status).toBe(401);
  });

  it('answers unknown usernames like a wrong password and requires the CSRF header', async () => {
    const unknown = await labSignIn('someone', password);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(expect.objectContaining({ code: 'invalid_credentials' }));
    const wrong = await labSignIn('LAB', `${password}x`);
    expect(wrong.body.code).toBe(unknown.body.code);

    const noCsrf = await http().post('/api/auth/lab/sign-in').send({ username: 'LAB', password });
    expect(noCsrf.status).toBe(403);
    expect((await labSignIn('', '')).status).toBe(400);
  });

  it('T5/AC7: locks sign-in after 10 failures, audits it, and unlocks later', async () => {
    const auditBefore = await auditCount();
    for (let attempt = 1; attempt <= MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect(
        (await labSignIn('LAB', `wrong-${attempt}-password`)).status,
        `attempt ${attempt}`,
      ).toBe(401);
    }
    // Even the right password is refused while locked.
    const refused = await labSignIn('LAB', password);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'locked_out' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    const { rows } = await db.pool.query<{ action: string; after_values: Record<string, unknown> }>(
      `SELECT action, after_values FROM audit_event ORDER BY occurred_at, id OFFSET $1`,
      [auditBefore],
    );
    const actions = rows.map((row) => row.action);
    expect(actions.filter((a) => a === 'auth.sign_in_failed')).toHaveLength(
      MAX_FAILED_ATTEMPTS + 1,
    );
    // Both the account and the client address reached the limit.
    expect(actions.filter((a) => a === 'auth.lockout')).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({
      action: 'auth.sign_in_failed',
      after_values: { reason: 'locked_out' },
    });
    expect(JSON.stringify(rows)).not.toContain('wrong-');
    expect(JSON.stringify(rows)).not.toContain(password);

    const state = await http()
      .get('/api/admin/lab')
      .set('Cookie', await cookieFor(adminId));
    expect(state.body.lockedUntil).not.toBeNull();

    // Once the lockout has passed, the right password works again.
    await db.pool.query(`UPDATE sign_in_throttle SET locked_until = now() - interval '1 second'`);
    expect((await labSignIn('LAB', password)).status).toBe(204);
  });

  it('a password reset clears the account lockout', async () => {
    for (let attempt = 1; attempt <= MAX_FAILED_ATTEMPTS; attempt += 1) {
      await labSignIn('LAB', `wrong-${attempt}-password`);
    }
    expect((await labSignIn('LAB', password)).status).toBe(429);
    // Clear the address lock the test client also earned; the account lock is the one under test.
    await db.pool.query(`DELETE FROM sign_in_throttle WHERE throttle_key LIKE 'address:%'`);
    password = newPassword();
    await resetPassword(password);
    expect((await labSignIn('LAB', password)).status).toBe(204);
  });
});
