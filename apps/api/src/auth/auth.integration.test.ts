import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { meResponseSchema } from '@trapezoid/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { UsersService } from '../users/users.service.js';
import { ROUTE_POLICY } from './auth.decorators.js';
import { CSRF_HEADER } from './auth.guard.js';
import { SESSION_COOKIE } from './session-cookie.js';
import { SessionService } from './session.service.js';

describe.runIf(testDatabaseUrl)('authorization and sessions (TRP-T04)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  const users: Record<string, string> = {};

  async function addUser(
    key: string,
    accountType: 'personal' | 'shared_lab' | 'test',
    status: 'pending' | 'active' | 'disabled',
    roles: string[] = [],
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`User ${key}`, key.toUpperCase().slice(0, 5), accountType, status],
    );
    users[key] = rows[0]!.id;
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        users[key],
        role,
      ]);
    }
  }

  async function cookieFor(
    key: string,
    accountType: 'personal' | 'shared_lab' | 'test' = 'personal',
  ) {
    const session = await sessions.create(users[key]!, accountType);
    return `${SESSION_COOKIE}=${session.token}`;
  }

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    db = await createMigratedSchema();
    await addUser('admin', 'personal', 'active', ['admin']);
    await addUser('lm', 'personal', 'active', ['lab_manager']);
    await addUser('tech', 'personal', 'active');
    await addUser('pend', 'personal', 'pending');
    await addUser('lab', 'shared_lab', 'active');
    await addUser('victim', 'personal', 'active');

    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(config);
    await app.init();
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('AC1: every route declares an access policy', () => {
    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);
    const missing: string[] = [];
    let routes = 0;
    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const method of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method] as (...args: unknown[]) => unknown;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        routes += 1;
        const policy = reflector.getAllAndOverride(ROUTE_POLICY, [handler, metatype]);
        if (!policy) missing.push(`${metatype.name}.${method}`);
      }
    }
    expect(routes).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('keeps /api/health public', async () => {
    const response = await http().get('/api/health');
    expect([200, 503]).toContain(response.status);
  });

  it('AC2: rejects protected routes without a session, with no data in the body', async () => {
    const response = await http().get('/api/me');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'unauthenticated' });
    expect(JSON.stringify(response.body)).not.toContain('displayName');
  });

  it('rejects an unknown or tampered cookie', async () => {
    const response = await http().get('/api/me').set('Cookie', `${SESSION_COOKIE}=forged-token`);
    expect(response.status).toBe(401);
  });

  it('returns /api/me for an active user with role-based permissions', async () => {
    const response = await http()
      .get('/api/me')
      .set('Cookie', await cookieFor('lm'));
    expect(response.status).toBe(200);
    const me = meResponseSchema.parse(response.body);
    expect(me).toMatchObject({ displayName: 'User lm', status: 'active', roles: ['lab_manager'] });
    expect(me.permissions).toContain('test.cancel');
    expect(me.permissions).not.toContain('staff.manage');
    expect(me.permissions).not.toContain('program.close');
  });

  it('AC3: pending users can read /api/me but nothing that needs approval', async () => {
    const cookie = await cookieFor('pend');
    const me = await http().get('/api/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ status: 'pending', permissions: [] });

    const admin = await http()
      .post(`/api/admin/users/${users.victim}/sessions/revoke`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1');
    expect(admin.status).toBe(403);
    expect(admin.body).toMatchObject({ code: 'access_pending' });
  });

  it('AC7: LAB and non-admins can’t revoke sessions; admins can', async () => {
    for (const key of ['lab', 'tech', 'lm']) {
      const accountType = key === 'lab' ? 'shared_lab' : 'personal';
      const response = await http()
        .post(`/api/admin/users/${users.victim}/sessions/revoke`)
        .set('Cookie', await cookieFor(key, accountType))
        .set(CSRF_HEADER, '1');
      expect(response.status, key).toBe(403);
    }

    const victimCookie = await cookieFor('victim');
    const ok = await http()
      .post(`/api/admin/users/${users.victim}/sessions/revoke`)
      .set('Cookie', await cookieFor('admin'))
      .set(CSRF_HEADER, '1');
    expect(ok.status).toBe(201);
    expect(ok.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await http().get('/api/me').set('Cookie', victimCookie)).status).toBe(401);

    const history = await listAuditForEntity(db.pool, 'app_user', users.victim!);
    expect(history[0]).toMatchObject({ action: 'auth.sessions_revoked', actorInitials: 'ADMIN' });
  });

  it('AC5: disabling a user revokes their sessions immediately', async () => {
    await addUser('leaver', 'personal', 'active');
    const cookie = await cookieFor('leaver');
    expect((await http().get('/api/me').set('Cookie', cookie)).status).toBe(200);

    await app.get(UsersService).disable(users.leaver!, 'left the company', {
      userId: users.admin!,
      accountType: 'personal',
      initials: 'ADMIN',
      name: 'User admin',
    });

    expect((await http().get('/api/me').set('Cookie', cookie)).status).toBe(401);
    const history = await listAuditForEntity(db.pool, 'app_user', users.leaver!);
    expect(history[0]).toMatchObject({
      action: 'staff.disabled',
      reason: 'left the company',
      before: { status: 'active' },
    });
  });

  it('expired sessions no longer authenticate', async () => {
    const issuedAt = new Date(Date.now() - 13 * 60 * 60 * 1000);
    const session = await sessions.create(users.tech!, 'personal', issuedAt);
    const response = await http()
      .get('/api/me')
      .set('Cookie', `${SESSION_COOKIE}=${session.token}`);
    expect(response.status).toBe(401);
  });

  it('sign-out revokes the session, clears the cookie and is audited', async () => {
    const session = await sessions.create(users.tech!, 'personal');
    const cookie = `${SESSION_COOKIE}=${session.token}`;
    const response = await http()
      .post('/api/auth/sign-out')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1');
    expect(response.status).toBe(204);
    expect(response.headers['set-cookie']?.[0]).toMatch(/^trapezoid_session=;/);
    expect((await http().get('/api/me').set('Cookie', cookie)).status).toBe(401);
    expect(await listAuditForEntity(db.pool, 'session', session.sessionId)).toHaveLength(1);
  });

  describe('AC6: CSRF', () => {
    it('rejects a state change without the CSRF header', async () => {
      const response = await http()
        .post('/api/auth/sign-out')
        .set('Cookie', await cookieFor('tech'));
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'csrf_header_missing' });
    });

    it('rejects a state change from another origin', async () => {
      const response = await http()
        .post('/api/auth/sign-out')
        .set('Cookie', await cookieFor('tech'))
        .set(CSRF_HEADER, '1')
        .set('Origin', 'https://evil.example');
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'cross_origin' });
    });

    it('allows a same-origin state change', async () => {
      const server = http();
      const cookie = await cookieFor('tech');
      const response = await server
        .post('/api/auth/sign-out')
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .set('Host', 'trapezoid.local')
        .set('Origin', 'https://trapezoid.local');
      expect(response.status).toBe(204);
    });
  });
});
