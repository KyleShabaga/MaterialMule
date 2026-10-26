import type { INestApplication } from '@nestjs/common';
import { meResponseSchema, profileResponseSchema } from '@trapezoid/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_TENANT_ID,
  startMockOidc,
  type MockOidc,
} from '../../../test-support/mock-oidc.js';
import { CSRF_HEADER } from '../../auth.guard.js';
import { SESSION_COOKIE } from '../../session-cookie.js';
import { SessionService } from '../../session.service.js';
import { MICROSOFT_SCOPES } from './entra-provider.js';
import { SIGN_IN_BINDING_COOKIE } from './microsoft-auth.controller.js';

const REDIRECT_URI = 'http://localhost:5173/sign-in/microsoft/callback';
const SECRET = 'test-session-secret-0123456789abcdef';

function cookieValue(response: request.Response, name: string): string | undefined {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((value) => value.startsWith(`${name}=`));
  return cookie?.split(';')[0];
}

// TRP-T05 against a mock Entra tenant and mock Graph (fictional identities only).
describe.runIf(testDatabaseUrl)('Microsoft sign-in (TRP-T05)', () => {
  let db: TestSchema;
  let mock: MockOidc;
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  /** Runs the whole browser round trip with the mock choosing `key` (or returning an error). */
  async function signIn(
    key: string | null,
    options: {
      switchUser?: boolean;
      providerError?: { error: string; description?: string; subcode?: string };
      priorCookie?: string;
    } = {},
  ) {
    mock.autoSignIn(key);
    mock.autoError(options.providerError ?? null);
    const start = await http().get(
      `/api/auth/microsoft/start?returnTo=%2Fprojects${options.switchUser ? '&switch=1' : ''}`,
    );
    expect(start.status).toBe(302);
    const binding = cookieValue(start, SIGN_IN_BINDING_COOKIE)!;
    const authorize = await fetch(start.headers.location!, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    const body = {
      state: back.searchParams.get('state')!,
      ...(back.searchParams.get('code') ? { code: back.searchParams.get('code')! } : {}),
      ...(back.searchParams.get('error') ? { error: back.searchParams.get('error')! } : {}),
      ...(back.searchParams.get('error_description')
        ? { errorDescription: back.searchParams.get('error_description')! }
        : {}),
      ...(back.searchParams.get('error_subcode')
        ? { errorSubcode: back.searchParams.get('error_subcode')! }
        : {}),
    };
    const callback = await http()
      .post('/api/auth/microsoft/callback')
      .set('Cookie', [binding, ...(options.priorCookie ? [options.priorCookie] : [])])
      .set(CSRF_HEADER, '1')
      .send(body);
    return { callback, cookie: cookieValue(callback, SESSION_COOKIE), body, binding };
  }

  async function userByOid(oid: string) {
    const { rows } = await db.pool.query<{
      id: string;
      status: string;
      display_name: string;
      work_email: string | null;
      official_initials: string | null;
      roles: string[];
    }>(
      `SELECT u.id, u.status, u.display_name, u.work_email, u.official_initials,
              COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM identity_link l JOIN app_user u ON u.id = l.user_id
       LEFT JOIN role_assignment r ON r.user_id = u.id
       WHERE l.provider = 'microsoft' AND l.subject = $1
       GROUP BY u.id`,
      [oid],
    );
    return rows[0];
  }

  const oidOf = (key: string) => mock.users.get(key)!.oid;
  const me = async (cookie: string) =>
    meResponseSchema.parse((await http().get('/api/me').set('Cookie', cookie)).body);

  beforeAll(async () => {
    mock = await startMockOidc();
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: SECRET,
        LOG_LEVEL: 'silent',
        MICROSOFT_TENANT_ID: MOCK_TENANT_ID,
        MICROSOFT_CLIENT_ID: MOCK_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MICROSOFT_REDIRECT_URI: REDIRECT_URI,
        MICROSOFT_AUTHORITY_HOST: mock.url,
        MICROSOFT_GRAPH_BASE_URL: mock.url,
        BOOTSTRAP_ADMIN_OBJECT_ID: mock.users.get('avery')!.oid,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    for (const user of mock.users.values()) delete user.graphStatus;
    mock.users.get('nograph')!.graphStatus = 503;
  });

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await db?.drop();
  });

  it('reports the provider as available when configured', async () => {
    expect((await http().get('/api/auth/providers')).body).toMatchObject({ microsoft: true });
  });

  it('AC8: asks only for sign-in and User.Read, with PKCE, and reads an explicit Graph $select', async () => {
    const before = mock.authorizeRequests.length;
    await signIn('drew');
    expect(mock.authorizeRequests[before]).toEqual({
      scope: MICROSOFT_SCOPES,
      prompt: null,
      codeChallengeMethod: 'S256',
      responseType: 'code',
    });
    expect(MICROSOFT_SCOPES.split(' ').sort()).toEqual(['User.Read', 'openid', 'profile']);
    expect(mock.graphSelects.at(-1)).toBe(
      'displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation',
    );
  });

  it('switch user forces the Microsoft account picker', async () => {
    const before = mock.authorizeRequests.length;
    await signIn('drew', { switchUser: true });
    expect(mock.authorizeRequests[before]!.prompt).toBe('select_account');
  });

  it('T4/AC1: the bootstrap identity becomes an active admin on first sign-in', async () => {
    const { callback, cookie } = await signIn('avery');
    expect(callback.status).toBe(200);
    expect(callback.body).toEqual({ next: '/onboarding/position' });
    const user = await userByOid(oidOf('avery'));
    expect(user).toMatchObject({ status: 'active', roles: ['admin'] });
    expect(await me(cookie!)).toMatchObject({ status: 'active', positionSetupRequired: true });
    const history = await listAuditForEntity(db.pool, 'app_user', user!.id);
    expect(history.map((e) => e.action)).toContain('user.bootstrap_admin_granted');
  });

  it('T4/AC2: anyone else starts pending with position setup and no data access', async () => {
    const { callback, cookie } = await signIn('riley');
    expect(callback.status).toBe(200);
    expect(callback.body).toEqual({ next: '/onboarding/position' });
    expect(await userByOid(oidOf('riley'))).toMatchObject({ status: 'pending', roles: [] });

    const current = await me(cookie!);
    expect(current).toMatchObject({
      status: 'pending',
      positionSetupRequired: true,
      permissions: [],
    });
    const data = await http().get('/api/activity/recent').set('Cookie', cookie!);
    expect(data.status).toBe(403);
    expect(data.body).toMatchObject({ code: 'access_pending' });
  });

  it('T5 (API): position is saved once and setup is not repeated', async () => {
    const { cookie } = await signIn('riley');
    const save = () =>
      http()
        .post('/api/me/position')
        .set('Cookie', cookie!)
        .set(CSRF_HEADER, '1')
        .send({ position: 'technician' });
    expect((await save()).status).toBe(204);
    expect((await save()).status).toBe(409);
    expect(await me(cookie!)).toMatchObject({
      position: 'technician',
      positionSetupRequired: false,
    });

    // Next sign-in: straight to access-pending, position kept.
    const again = await signIn('riley');
    expect(again.callback.body).toEqual({ next: '/access-pending' });
    const bad = await http()
      .post('/api/me/position')
      .set('Cookie', again.cookie!)
      .set(CSRF_HEADER, '1')
      .send({ position: 'admin' });
    expect(bad.status).toBe(400);
  });

  it('AC7: choosing Lab Manager or PM/PE grants nothing', async () => {
    const results: string[][] = [];
    for (const [key, position] of [
      ['casey', 'lab_manager'],
      ['morgan', 'pm_pe'],
      ['drew', 'technician'],
    ] as const) {
      const { cookie } = await signIn(key);
      await http()
        .post('/api/me/position')
        .set('Cookie', cookie!)
        .set(CSRF_HEADER, '1')
        .send({ position });
      // Approve (TRP-T07 will do this through the admin screen).
      await db.pool.query(`UPDATE app_user SET status = 'active' WHERE id = $1`, [
        (await userByOid(oidOf(key)))!.id,
      ]);
      const current = await me(cookie!);
      expect(current.roles).toEqual([]);
      results.push(current.permissions.sort());
    }
    expect(results[0]).toEqual(results[2]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]).not.toContain('test.cancel');
    expect(results[1]).not.toContain('program.close');
  });

  it('T3/AC4: a changed email updates the same user; past audit attribution stays', async () => {
    const first = await signIn('morgan');
    const user = (await userByOid(oidOf('morgan')))!;
    const history = await listAuditForEntity(db.pool, 'app_user', user.id, { limit: 100 });
    const positionEvent = history.find((e) => e.action === 'user.position_set')!;
    expect(first.callback.status).toBe(200);

    const morgan = mock.users.get('morgan')!;
    morgan.graph = {
      ...morgan.graph,
      mail: 'morgan.renamed@example.test',
      displayName: 'Morgan Renamed',
    };
    morgan.name = 'Morgan Renamed';
    await signIn('morgan');

    const after = (await userByOid(oidOf('morgan')))!;
    expect(after.id).toBe(user.id);
    expect(after).toMatchObject({
      work_email: 'morgan.renamed@example.test',
      display_name: 'Morgan Renamed',
    });
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM identity_link WHERE subject = $1`,
      [oidOf('morgan')],
    );
    expect(rows[0].n).toBe(1);

    const later = await listAuditForEntity(db.pool, 'app_user', user.id, { limit: 100 });
    expect(later.find((e) => e.id === positionEvent.id)!.actorName).toBe('Morgan Example');
    expect(later.find((e) => e.action === 'profile.refreshed')).toMatchObject({
      before: { work_email: 'morgan.mail@example.test', display_name: 'Morgan Example' },
      after: { work_email: 'morgan.renamed@example.test', display_name: 'Morgan Renamed' },
    });
  });

  it('AC3: refuses another tenant, guests, cancellation and denied consent without creating users', async () => {
    const countUsers = async () =>
      (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM app_user')).rows[0]!.n;
    const before = await countUsers();

    const outsider = await signIn('outsider');
    expect(outsider.callback.status).toBe(403);
    expect(outsider.callback.body).toMatchObject({ code: 'wrong_tenant' });
    expect(outsider.cookie).toBeUndefined();

    const guest = await signIn('guest');
    expect(guest.callback.status).toBe(403);
    expect(guest.callback.body).toMatchObject({ code: 'guest_account' });

    const otherTenant = await signIn(null, {
      providerError: {
        error: 'access_denied',
        description: 'AADSTS50020: User account from identity provider does not exist in tenant',
      },
    });
    expect(otherTenant.callback.body).toMatchObject({ code: 'wrong_tenant' });

    const cancelled = await signIn(null, {
      providerError: { error: 'access_denied', subcode: 'cancel' },
    });
    expect(cancelled.callback.status).toBe(401);
    expect(cancelled.callback.body).toMatchObject({ code: 'cancelled' });

    const consent = await signIn(null, {
      providerError: {
        error: 'access_denied',
        description: 'AADSTS65004: User declined to consent',
      },
    });
    expect(consent.callback.body).toMatchObject({ code: 'consent_denied' });

    expect(await countUsers()).toBe(before);
    expect(await userByOid(oidOf('outsider'))).toBeUndefined();
    const { rows } = await db.pool.query(
      `SELECT after_values->>'reason' AS reason FROM audit_event
       WHERE action = 'auth.sign_in_failed' ORDER BY occurred_at`,
    );
    expect(rows.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['wrong_tenant', 'guest_account', 'cancelled', 'consent_denied']),
    );
  });

  it('refuses a replayed or unbound callback', async () => {
    const first = await signIn('drew');
    expect(first.callback.status).toBe(200);
    const replay = await http()
      .post('/api/auth/microsoft/callback')
      .set('Cookie', first.binding)
      .set(CSRF_HEADER, '1')
      .send(first.body);
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ code: 'expired_attempt' });

    mock.autoSignIn('drew');
    const start = await http().get('/api/auth/microsoft/start');
    const authorize = await fetch(start.headers.location!, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);
    const unbound = await http()
      .post('/api/auth/microsoft/callback')
      .set(CSRF_HEADER, '1')
      .send({ state: back.searchParams.get('state'), code: back.searchParams.get('code') });
    expect(unbound.body).toMatchObject({ code: 'expired_attempt' });
    expect((await http().post('/api/auth/microsoft/callback').send(first.body)).status).toBe(403);
  });

  it('signing in replaces the previous session on that browser', async () => {
    const previous = await signIn('drew');
    const next = await signIn('casey', { priorCookie: previous.cookie });
    expect(next.callback.status).toBe(200);
    expect((await http().get('/api/me').set('Cookie', previous.cookie!)).status).toBe(401);
  });

  it('AC5: a Graph failure still signs the person in with the last known profile and a Retry', async () => {
    // First sign-in with Graph down: the ID token supplies the name.
    const first = await signIn('nograph');
    expect(first.callback.status).toBe(200);
    const profile = profileResponseSchema.parse(
      (await http().get('/api/me/profile').set('Cookie', first.cookie!)).body,
    );
    expect(profile).toMatchObject({
      displayName: 'Graph Failure',
      signInUsername: 'nograph@example.test',
      source: 'microsoft_id_token',
      canRefresh: true,
    });
    expect(profile.refreshFailedAt).not.toBeNull();
    expect(await me(first.cookie!)).toMatchObject({ profileRefreshFailed: true });

    // Known user, Graph down: everything known is kept.
    mock.users.get('riley')!.graphStatus = 500;
    const riley = await signIn('riley');
    expect(riley.callback.status).toBe(200);
    const kept = profileResponseSchema.parse(
      (await http().get('/api/me/profile').set('Cookie', riley.cookie!)).body,
    );
    expect(kept).toMatchObject({
      workEmail: 'riley.mail@example.test',
      jobTitle: 'Field Technician',
      source: 'microsoft_graph',
    });
    expect(kept.refreshFailedAt).not.toBeNull();
    const rileyId = (await userByOid(oidOf('riley')))!.id;
    const history = await listAuditForEntity(db.pool, 'app_user', rileyId, { limit: 100 });
    expect(history.map((e) => e.action)).toContain('profile.refresh_failed');

    // Retry succeeds once Graph is back, using the token held for this session.
    delete mock.users.get('riley')!.graphStatus;
    const retry = await http()
      .post('/api/me/profile/refresh')
      .set('Cookie', riley.cookie!)
      .set(CSRF_HEADER, '1');
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ refreshFailedAt: null, source: 'microsoft_graph' });

    // A session without a held token must sign in again to refresh.
    const fresh = await app.get(SessionService).create(rileyId, 'personal');
    const reauth = await http()
      .post('/api/me/profile/refresh')
      .set('Cookie', `${SESSION_COOKIE}=${fresh.token}`)
      .set(CSRF_HEADER, '1');
    expect(reauth.status).toBe(409);
    expect(reauth.body).toMatchObject({ code: 'reauth_required' });
  });

  it('AC6: admin-confirmed initials survive a profile refresh', async () => {
    const admin = (await userByOid(oidOf('avery')))!;
    const riley = (await userByOid(oidOf('riley')))!;
    await db.pool.query(
      `UPDATE app_user SET official_initials = 'KCS', initials_confirmed_by_user_id = $2,
              initials_confirmed_at = now() WHERE id = $1`,
      [riley.id, admin.id],
    );
    const rileyMock = mock.users.get('riley')!;
    rileyMock.graph = { ...rileyMock.graph, givenName: 'Kim', surname: 'Other' };
    const { cookie } = await signIn('riley');
    expect((await userByOid(oidOf('riley')))!.official_initials).toBe('KCS');
    const profile = profileResponseSchema.parse(
      (await http().get('/api/me/profile').set('Cookie', cookie!)).body,
    );
    expect(profile).toMatchObject({ officialInitials: 'KCS', initialsConfirmed: true });
  });

  it('refuses disabled accounts', async () => {
    const drew = (await userByOid(oidOf('drew')))!;
    await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [drew.id]);
    const { callback, cookie } = await signIn('drew');
    expect(callback.status).toBe(403);
    expect(callback.body).toMatchObject({ code: 'account_disabled' });
    expect(cookie).toBeUndefined();
  });

  it('never stores Microsoft tokens or secrets in the database or audit log', async () => {
    const { rows } = await db.pool.query(`SELECT before_values, after_values FROM audit_event`);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('mock-at-');
    expect(text).not.toContain(MOCK_CLIENT_SECRET);
    // Sign-in attempts keep only hashes of the state and browser binding.
    const { rows: attempts } = await db.pool.query<{ state_hash: Buffer }>(
      'SELECT state_hash FROM oidc_sign_in_attempt',
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.state_hash.length === 32)).toBe(true);
  });
});

describe.runIf(testDatabaseUrl)('Microsoft sign-in switched off', () => {
  let db: TestSchema;
  let app: INestApplication;

  beforeAll(async () => {
    db = await createMigratedSchema();
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: SECRET,
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('reports microsoft:false and its routes answer 404 without configuration', async () => {
    const http = () => request(app.getHttpServer());
    expect((await http().get('/api/auth/providers')).body).toMatchObject({ microsoft: false });
    expect((await http().get('/api/auth/microsoft/start')).status).toBe(404);
    expect(
      (
        await http()
          .post('/api/auth/microsoft/callback')
          .set(CSRF_HEADER, '1')
          .send({ state: 'x', code: 'y' })
      ).status,
    ).toBe(404);
  });
});
