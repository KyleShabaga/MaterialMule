import type { INestApplication } from '@nestjs/common';
import { draftSettingsSchema } from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { insertProject } from '../test-support/fixtures.js';

describe.runIf(testDatabaseUrl)('draft auto-delete setting API (MM-T45)', () => {
  let db: TestSchema;
  let app: INestApplication;
  const users: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const get = (who: string) => http().get('/api/settings/drafts').set('Cookie', cookies[who]!);
  const put = (who: string, body: object) =>
    http()
      .put('/api/settings/drafts')
      .set('Cookie', cookies[who]!)
      .set(CSRF_HEADER, '1')
      .send(body);
  const change = (enabled: boolean, afterDays: number, version: number) => ({
    draftAutoDelete: { enabled, afterDays },
    version,
  });

  async function addUser(
    key: string,
    accountType: 'personal' | 'shared_lab',
    roles: string[] = [],
    status: 'active' | 'pending' = 'active',
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`User ${key}`, key.toUpperCase().slice(0, 5), accountType, status],
    );
    users[key] = rows[0]!.id;
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
  }

  async function row() {
    const { rows } = await db.pool.query(
      'SELECT enabled, after_days, version FROM draft_auto_delete_setting',
    );
    return rows;
  }

  async function auditEvents() {
    const { rows } = await db.pool.query(
      `SELECT actor_user_id, actor_initials_snapshot, entity_type, before_values, after_values
       FROM audit_event WHERE action = 'settings.drafts_changed' ORDER BY occurred_at, id`,
    );
    return rows;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await addUser('admin', 'personal', ['admin']);
    await addUser('lm', 'personal', ['lab_manager']);
    await addUser('tech', 'personal');
    await addUser('pe', 'personal');
    await addUser('pend', 'personal', [], 'pending');
    await addUser('lab', 'shared_lab');
    // "pe" is the PM/PE of a project: project authority doesn't extend to this setting.
    await insertProject(db.pool, 'DEMO-2601', users.pe!);

    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    const sessions = app.get(SessionService);
    for (const [key, id] of Object.entries(users)) {
      const accountType = key === 'lab' ? 'shared_lab' : 'personal';
      cookies[key] = `${SESSION_COOKIE}=${(await sessions.create(id, accountType)).token}`;
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('AC1/AC4: is off with 90 days by default and readable by every active session', async () => {
    for (const who of ['admin', 'lm', 'tech', 'pe', 'lab']) {
      const response = await get(who);
      expect(response.status, who).toBe(200);
      expect(draftSettingsSchema.parse(response.body)).toEqual({
        draftAutoDelete: { enabled: false, afterDays: 90 },
        version: 1,
      });
    }
    expect((await get('pend')).status).toBe(403);
    expect((await http().get('/api/settings/drafts')).status).toBe(401);
  });

  it('AC4: Technician, PM/PE and LAB get 403 on PUT and nothing changes', async () => {
    for (const who of ['tech', 'pe', 'lab', 'pend']) {
      const response = await put(who, change(true, 30, 1));
      expect(response.status, who).toBe(403);
    }
    expect(await row()).toEqual([{ enabled: false, after_days: 90, version: 1 }]);
    expect(await auditEvents()).toEqual([]);
  });

  it('AC5: refuses days outside 30–365 with a field error and changes nothing', async () => {
    for (const afterDays of [29, 366, 90.5]) {
      const response = await put('admin', change(true, afterDays, 1));
      expect(response.status, String(afterDays)).toBe(400);
      expect(response.body).toEqual({
        code: 'validation_failed',
        errors: [
          expect.objectContaining({
            field: 'draftAutoDelete.afterDays',
            message: 'Enter a whole number of days from 30 to 365',
          }),
        ],
      });
    }
    expect((await put('admin', { draftAutoDelete: { enabled: true } })).status).toBe(400);
    expect(await row()).toEqual([{ enabled: false, after_days: 90, version: 1 }]);
  });

  it('AC2/AC6: an admin turns it on; the change is audited with before/after and actor', async () => {
    const response = await put('admin', change(true, 90, 1));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      draftAutoDelete: { enabled: true, afterDays: 90 },
      version: 2,
    });
    expect((await get('lab')).body).toEqual(response.body);
    expect(await auditEvents()).toEqual([
      {
        actor_user_id: users.admin,
        actor_initials_snapshot: 'ADMIN',
        entity_type: 'app_setting',
        before_values: { draftAutoDelete: { enabled: false, afterDays: 90 } },
        after_values: { draftAutoDelete: { enabled: true, afterDays: 90 } },
      },
    ]);
  });

  it('refuses a stale version with 409 and the current value', async () => {
    const response = await put('lm', change(true, 30, 1));
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'version_conflict',
      current: { draftAutoDelete: { enabled: true, afterDays: 90 }, version: 2 },
    });
    expect(await row()).toEqual([{ enabled: true, after_days: 90, version: 2 }]);
  });

  it('a Lab Manager changes it; saving the same values again records nothing', async () => {
    const response = await put('lm', change(true, 30, 2));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      draftAutoDelete: { enabled: true, afterDays: 30 },
      version: 3,
    });
    const again = await put('lm', change(true, 30, 3));
    expect(again.body).toEqual(response.body);
    const events = await auditEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      actor_user_id: users.lm,
      before_values: { draftAutoDelete: { enabled: true, afterDays: 90 } },
      after_values: { draftAutoDelete: { enabled: true, afterDays: 30 } },
    });
  });

  it('needs the CSRF header like every other change', async () => {
    const response = await http()
      .put('/api/settings/drafts')
      .set('Cookie', cookies.admin!)
      .send(change(false, 90, 3));
    expect(response.status).toBe(403);
    expect(await row()).toEqual([{ enabled: true, after_days: 30, version: 3 }]);
  });
});
