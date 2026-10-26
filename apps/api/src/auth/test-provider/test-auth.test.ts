import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../../audit/audit.js';
import { ConfigError, loadConfig, type AppConfig } from '../../config/env.js';
import { createApp } from '../../create-app.js';
import { runSeed } from '../../db/seed.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../../test-support/database.js';
import { CSRF_HEADER } from '../auth.guard.js';
import { SESSION_COOKIE } from '../session-cookie.js';
import { TEST_FIXTURES } from './fixtures.js';
import { testAuthEnabled } from './test-auth.controller.js';

const SECRET = 'test-session-secret-0123456789abcdef';

function config(overrides: Record<string, string>): AppConfig {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/x',
    SESSION_SECRET: SECRET,
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

describe('test auth gating (AC3, AC4)', () => {
  it('is enabled only for development/test with the flag on', () => {
    expect(testAuthEnabled(config({ APP_ENV: 'development', ENABLE_TEST_AUTH: 'true' }))).toBe(
      true,
    );
    expect(testAuthEnabled(config({ APP_ENV: 'test', ENABLE_TEST_AUTH: 'true' }))).toBe(true);
    expect(testAuthEnabled(config({ APP_ENV: 'test' }))).toBe(false);
    // Production needs a certificate setting (TRP-T20); loadConfig doesn't read the file.
    expect(
      testAuthEnabled(config({ APP_ENV: 'production', TLS_PFX_FILE: 'C:/fictional/app.pfx' })),
    ).toBe(false);
  });

  it('refuses to load a production config with ENABLE_TEST_AUTH=true', () => {
    expect(() => config({ APP_ENV: 'production', ENABLE_TEST_AUTH: 'true' })).toThrowError(
      ConfigError,
    );
    expect(() => config({ APP_ENV: 'production', ENABLE_TEST_AUTH: 'true' })).toThrowError(
      /ENABLE_TEST_AUTH must not be true/,
    );
  });

  it('rejects values other than true/false', () => {
    expect(() => config({ ENABLE_TEST_AUTH: 'yes' })).toThrowError(
      /ENABLE_TEST_AUTH must be true or false/,
    );
  });
});

describe.runIf(testDatabaseUrl)('test sign-in (TRP-T33)', () => {
  let db: TestSchema;
  let enabledApp: INestApplication;
  let disabledApp: INestApplication;

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    await runSeed(db.pool, 'dev', 'test');
    const databaseUrl = databaseUrlForSchema(db.schema);
    enabledApp = await createApp(config({ DATABASE_URL: databaseUrl, ENABLE_TEST_AUTH: 'true' }));
    await enabledApp.init();
    disabledApp = await createApp(config({ DATABASE_URL: databaseUrl }));
    await disabledApp.init();
  });

  afterAll(async () => {
    await enabledApp?.close();
    await disabledApp?.close();
    await db?.drop();
  });

  async function signIn(app: INestApplication, fixtureKey: string) {
    const response = await request(app.getHttpServer())
      .post('/api/auth/test/sign-in')
      .set(CSRF_HEADER, '1')
      .send({ fixtureKey });
    const cookie = (response.headers['set-cookie'] as unknown as string[] | undefined)?.[0];
    return { response, cookie: cookie?.split(';')[0] };
  }

  it('lists every seeded fixture with its roles', async () => {
    const response = await request(enabledApp.getHttpServer()).get('/api/auth/test/fixtures');
    expect(response.status).toBe(200);
    expect(response.body.map((f: { key: string }) => f.key)).toEqual(
      TEST_FIXTURES.map((f) => f.key),
    );
    expect(response.body.find((f: { key: string }) => f.key === 'admin')).toMatchObject({
      displayName: 'Admin (test)',
      roles: ['admin'],
    });
  });

  it('AC1: Admin (test) signs in and can use admin endpoints', async () => {
    const { response, cookie } = await signIn(enabledApp, 'admin');
    expect(response.status).toBe(204);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));

    const me = await request(enabledApp.getHttpServer()).get('/api/me').set('Cookie', cookie!);
    expect(me.body).toMatchObject({ displayName: 'Admin (test)', accountType: 'test' });
    expect(me.body.permissions).toContain('staff.manage');

    const revoke = await request(enabledApp.getHttpServer())
      .post('/api/admin/users/00000000-0000-4000-8000-000000000102/sessions/revoke')
      .set('Cookie', cookie!)
      .set(CSRF_HEADER, '1');
    expect(revoke.status).toBe(201);
  });

  it('AC2: Lab (test) has Lab Manager rights but not admin rights', async () => {
    const { cookie } = await signIn(enabledApp, 'lab');
    const me = await request(enabledApp.getHttpServer()).get('/api/me').set('Cookie', cookie!);
    expect(me.body.roles).toEqual(['lab_manager']);
    expect(me.body.permissions).toContain('test.cancel');

    const revoke = await request(enabledApp.getHttpServer())
      .post('/api/admin/users/00000000-0000-4000-8000-000000000102/sessions/revoke')
      .set('Cookie', cookie!)
      .set(CSRF_HEADER, '1');
    expect(revoke.status).toBe(403);
  });

  it('AC6: test sign-ins are audited as test accounts', async () => {
    const { cookie } = await signIn(enabledApp, 'at');
    const me = await request(enabledApp.getHttpServer()).get('/api/me').set('Cookie', cookie!);
    const { rows } = await db.pool.query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_event WHERE action = 'auth.test_sign_in'
       ORDER BY occurred_at DESC LIMIT 1`,
    );
    const [event] = await listAuditForEntity(db.pool, 'session', rows[0]!.entity_id);
    expect(event).toMatchObject({
      actorAccountType: 'test',
      actorInitials: 'AT',
      actorUserId: me.body.id,
    });
  });

  it('AC7: the two "JS" staff stay separate users', async () => {
    const tech = await signIn(enabledApp, 'js-tech');
    const eng = await signIn(enabledApp, 'js-eng');
    const a = await request(enabledApp.getHttpServer()).get('/api/me').set('Cookie', tech.cookie!);
    const b = await request(enabledApp.getHttpServer()).get('/api/me').set('Cookie', eng.cookie!);
    expect(a.body.initials).toBe('JS');
    expect(b.body.initials).toBe('JS');
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('rejects unknown fixtures and missing CSRF header', async () => {
    expect((await signIn(enabledApp, 'nobody')).response.status).toBe(404);
    const noCsrf = await request(enabledApp.getHttpServer())
      .post('/api/auth/test/sign-in')
      .send({ fixtureKey: 'admin' });
    expect(noCsrf.status).toBe(403);
  });

  it('AC3: without the flag the routes don’t exist and no session is created', async () => {
    const before = await db.pool.query('SELECT count(*)::int AS n FROM session');
    expect((await request(disabledApp.getHttpServer()).get('/api/auth/test/fixtures')).status).toBe(
      404,
    );
    expect((await signIn(disabledApp, 'admin')).response.status).toBe(404);
    const after = await db.pool.query('SELECT count(*)::int AS n FROM session');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('AC5: re-seeding keeps IDs and audit attribution', async () => {
    const { rows: before } = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id = '00000000-0000-4000-8000-000000000104'`,
    );
    await db.pool.query(
      `UPDATE app_user SET display_name = 'Changed in a test' WHERE id = '00000000-0000-4000-8000-000000000104'`,
    );
    await runSeed(db.pool, 'dev', 'test');
    const { rows } = await db.pool.query(
      `SELECT display_name, (SELECT count(*)::int FROM app_user WHERE account_type = 'test') AS users FROM app_user
       WHERE id = '00000000-0000-4000-8000-000000000104'`,
    );
    expect(rows[0]).toEqual({ display_name: 'Lab (test)', users: 9 }); // 7 sign-in fixtures + 2 pending applicants (T07)
    const { rows: after } = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id = '00000000-0000-4000-8000-000000000104'`,
    );
    expect(after).toEqual(before);
  });
});
