import type { INestApplication } from '@nestjs/common';
import {
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_USER_PREFERENCES,
  sidebarLayoutResponseSchema,
  sidebarLayoutVersionConflictSchema,
  tableColumnsResponseSchema,
  tableColumnsVersionConflictSchema,
  userPreferencesResponseSchema,
  userPreferencesVersionConflictSchema,
} from '@materialmule/shared';
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

// Strata 1C: sidebar layout (STRATA-41), preferences (STRATA-29) and table columns (STRATA-51).
// Fictional people only. Every refused call is proven to change nothing.

type Who = 'pat' | 'alex' | 'tess' | 'lab' | 'pend' | 'gone';

describe.runIf(testDatabaseUrl)('personal settings API (Strata 1C)', () => {
  let db: TestSchema;
  let app: INestApplication;
  const users = {} as Record<Who, string>;
  const cookies = {} as Record<Who, string>;

  const http = () => request(app.getHttpServer());
  const get = (who: Who, path: string) => http().get(path).set('Cookie', cookies[who]);
  const send = (who: Who, verb: 'put' | 'patch', path: string, body: object) =>
    http()[verb](path).set('Cookie', cookies[who]).set(CSRF_HEADER, '1').send(body);

  async function addUser(
    key: Who,
    accountType: 'personal' | 'shared_lab' | 'test',
    status: 'active' | 'pending' | 'disabled' = 'active',
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`${key} Example`, key.toUpperCase().slice(0, 5), accountType, status],
    );
    users[key] = rows[0]!.id;
  }

  /** Every person_setting row, for "nothing changed" checks. */
  async function settingsSnapshot() {
    const { rows } = await db.pool.query(
      'SELECT user_id, area, value, version, updated_at FROM person_setting ORDER BY user_id, area',
    );
    return rows;
  }

  async function storedValue(who: Who, area: string) {
    const { rows } = await db.pool.query<{ value: unknown; version: number }>(
      'SELECT value, version FROM person_setting WHERE user_id = $1 AND area = $2',
      [users[who], area],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await addUser('pat', 'personal');
    await addUser('alex', 'personal');
    await addUser('tess', 'test');
    await addUser('lab', 'shared_lab');
    await addUser('pend', 'personal', 'pending');
    await addUser('gone', 'personal');
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
    for (const key of Object.keys(users) as Who[]) {
      const type = key === 'lab' ? 'shared_lab' : 'personal';
      cookies[key] = `${SESSION_COOKIE}=${(await sessions.create(users[key], type)).token}`;
    }
    await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [users.gone]);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  describe('sidebar layout', () => {
    const path = '/api/me/sidebar-layout';
    const layout = (version: number, extra: object = {}) => ({
      order: ['concrete', 'soils', 'pinned', 'recent', 'storage_units'],
      hidden: ['soils'],
      folded: ['retention'],
      version,
      ...extra,
    });

    it('starts as the default layout, editable, version 0', async () => {
      const response = await get('pat', path);
      expect(response.status).toBe(200);
      expect(sidebarLayoutResponseSchema.parse(response.body)).toEqual({
        ...DEFAULT_SIDEBAR_LAYOUT,
        version: 0,
        source: 'default',
        readOnly: false,
      });
    });

    it('saves a layout, normalizing it, and returns it on any later read', async () => {
      const saved = await send('pat', 'put', path, {
        order: ['concrete', 'concrete', 'soils'],
        hidden: ['soils', 'soils'],
        folded: [],
        version: 0,
      });
      expect(saved.status).toBe(200);
      const expected = {
        order: ['concrete', 'soils', 'pinned', 'recent', 'storage_units'],
        hidden: ['soils'],
        folded: [],
        version: 1,
        source: 'own',
        readOnly: false,
      };
      expect(saved.body).toEqual(expected);
      expect((await get('pat', path)).body).toEqual(expected);
    });

    it('a stored layout with unknown ids is normalized on read', async () => {
      await db.pool.query(
        `UPDATE person_setting SET value = $2 WHERE user_id = $1 AND area = 'sidebar_layout'`,
        [users.pat, JSON.stringify({ order: ['gone', 'recent'], hidden: 'x', folded: ['old'] })],
      );
      const response = await get('pat', path);
      expect(response.body).toMatchObject({
        order: ['recent', 'pinned', 'storage_units', 'soils', 'concrete'],
        hidden: [],
        folded: [],
        version: 1,
      });
    });

    it('a stale version is 409 version_conflict with the current layout, and saves nothing', async () => {
      const before = await settingsSnapshot();
      for (const version of [0, 2, 7]) {
        const response = await send('pat', 'put', path, layout(version));
        expect(response.status, String(version)).toBe(409);
        const body = sidebarLayoutVersionConflictSchema.parse(response.body);
        expect(body.current).toMatchObject({ version: 1, source: 'own', readOnly: false });
      }
      // A first save from someone with nothing saved, sending a non-zero version, is stale too.
      const fresh = await send('alex', 'put', path, layout(3));
      expect(fresh.status).toBe(409);
      expect(fresh.body.current).toMatchObject({ version: 0, source: 'default' });
      expect(await settingsSnapshot()).toEqual(before);
      const ok = await send('pat', 'put', path, layout(1));
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(2);
    });

    it('refuses unknown ids and extra keys (a user ID in the body) with 400, changing nothing', async () => {
      const before = await settingsSnapshot();
      for (const body of [
        layout(2, { userId: users.alex }),
        layout(2, { personId: users.alex }),
        { ...layout(2), order: ['inbox'] },
        { ...layout(2), folded: ['projects'] },
        { order: [], hidden: [], folded: [] },
      ]) {
        const response = await send('pat', 'put', path, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body.code).toBe('validation_failed');
      }
      expect(await settingsSnapshot()).toEqual(before);
      expect(await storedValue('alex', 'sidebar_layout')).toBeNull();
    });

    it("one person's save never touches another's", async () => {
      const alex = await send('alex', 'put', path, layout(0));
      expect(alex.status).toBe(200);
      const patBefore = await storedValue('pat', 'sidebar_layout');
      await send('alex', 'put', path, { ...layout(1), hidden: [] });
      expect(await storedValue('pat', 'sidebar_layout')).toEqual(patBefore);
      expect((await get('pat', path)).body.hidden).toEqual(['soils']);
    });

    it('test accounts save their own layout', async () => {
      const response = await send('tess', 'put', path, layout(0));
      expect(response.status).toBe(200);
      expect(response.body.source).toBe('own');
    });

    it('personal accounts may not pass ?personId= (400), nor unknown query keys', async () => {
      const response = await get('pat', `${path}?personId=${users.alex}`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(expect.objectContaining({ code: 'person_id_not_allowed' }));
      expect(JSON.stringify(response.body)).not.toContain('soils');
      expect((await get('pat', `${path}?userId=${users.alex}`)).status).toBe(400);
    });

    it('LAB reads the default layout read-only, or a picked person read-only', async () => {
      const own = await get('lab', path);
      expect(own.status).toBe(200);
      expect(own.body).toEqual({
        ...DEFAULT_SIDEBAR_LAYOUT,
        version: 0,
        source: 'default',
        readOnly: true,
      });
      const picked = await get('lab', `${path}?personId=${users.pat}`);
      expect(picked.status).toBe(200);
      expect(picked.body).toEqual({
        order: ['concrete', 'soils', 'pinned', 'recent', 'storage_units'],
        hidden: ['soils'],
        folded: ['retention'],
        version: 2,
        source: 'station_person',
        readOnly: true,
      });
      // Someone with nothing saved: defaults, still read-only.
      await db.pool.query(
        `INSERT INTO app_user (id, display_name, account_type, status)
         VALUES ('00000000-0000-4000-8000-0000000000b1', 'Sam Example', 'personal', 'active')`,
      );
      const blank = await get('lab', `${path}?personId=00000000-0000-4000-8000-0000000000b1`);
      expect(blank.body).toMatchObject({ ...DEFAULT_SIDEBAR_LAYOUT, source: 'station_person' });
    });

    it('LAB ?personId= is 404 unless it names an active personal account', async () => {
      for (const id of [
        users.pend,
        users.gone,
        users.lab,
        '00000000-0000-4000-8000-0000000000ee',
      ]) {
        const response = await get('lab', `${path}?personId=${id}`);
        expect(response.status, id).toBe(404);
        expect(response.body.code).toBe('person_not_found');
      }
      expect((await get('lab', `${path}?personId=not-a-uuid`)).status).toBe(400);
    });

    it('LAB, pending and disabled accounts never save, and nothing changes', async () => {
      const before = await settingsSnapshot();
      const lab = await send('lab', 'put', path, layout(0));
      expect(lab.status).toBe(403);
      expect(lab.body.code).toBe('forbidden');
      const pending = await send('pend', 'put', path, layout(0));
      expect(pending.status).toBe(403);
      expect(pending.body.code).toBe('access_pending');
      expect((await get('pend', path)).body.code).toBe('access_pending');
      expect((await send('gone', 'put', path, layout(0))).status).toBe(401);
      expect((await http().get(path)).status).toBe(401);
      expect(await settingsSnapshot()).toEqual(before);
    });
  });

  describe('preferences', () => {
    const path = '/api/me/preferences';

    it('starts as the defaults, version 0, with the lab time zone', async () => {
      const response = await get('pat', path);
      expect(response.status).toBe(200);
      expect(userPreferencesResponseSchema.parse(response.body)).toEqual({
        preferences: DEFAULT_USER_PREFERENCES,
        version: 0,
        labTimeZone: 'America/Edmonton',
        readOnly: false,
      });
    });

    it('PATCH merges only the changed fields, then later changes keep earlier ones', async () => {
      const first = await send('pat', 'patch', path, { theme: 'dark', version: 0 });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: 'dark' },
        version: 1,
      });
      const second = await send('pat', 'patch', path, {
        tableDensity: 'compact',
        badgeUpdates: false,
        version: 1,
      });
      expect(second.body).toEqual({
        preferences: {
          ...DEFAULT_USER_PREFERENCES,
          theme: 'dark',
          tableDensity: 'compact',
          badgeUpdates: false,
        },
        version: 2,
        labTimeZone: 'America/Edmonton',
        readOnly: false,
      });
      expect((await get('pat', path)).body).toEqual(second.body);
    });

    it('a stored field from another release falls back to its default alone', async () => {
      await db.pool.query(
        `UPDATE person_setting SET value = value || '{"theme": "neon", "retired": 1}'
         WHERE user_id = $1 AND area = 'preferences'`,
        [users.pat],
      );
      const response = await get('pat', path);
      expect(response.body.preferences).toEqual({
        ...DEFAULT_USER_PREFERENCES,
        tableDensity: 'compact',
        badgeUpdates: false,
      });
      // The next save writes the normalized document.
      await send('pat', 'patch', path, { theme: 'light', version: 2 });
      expect((await storedValue('pat', 'preferences'))!.value).not.toHaveProperty('retired');
    });

    it('a stale version is 409 with the current preferences, and saves nothing', async () => {
      const before = await settingsSnapshot();
      const response = await send('pat', 'patch', path, { theme: 'system', version: 1 });
      expect(response.status).toBe(409);
      const body = userPreferencesVersionConflictSchema.parse(response.body);
      expect(body.current).toMatchObject({ version: 3, preferences: { theme: 'light' } });
      expect(await settingsSnapshot()).toEqual(before);
    });

    it('refuses empty changes, unknown fields, bad values and extra keys with 400', async () => {
      const before = await settingsSnapshot();
      for (const body of [
        { version: 3 },
        { theme: 'neon', version: 3 },
        { colour: 'red', version: 3 },
        { theme: 'dark' },
        { theme: 'dark', version: 3, userId: users.alex },
      ]) {
        const response = await send('pat', 'patch', path, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(await settingsSnapshot()).toEqual(before);
      expect(await storedValue('alex', 'preferences')).toBeNull();
    });

    it("one person's preferences never show for another", async () => {
      const alex = await get('alex', path);
      expect(alex.body).toMatchObject({ preferences: DEFAULT_USER_PREFERENCES, version: 0 });
    });

    it('LAB reads defaults read-only and may not PATCH; pending is refused', async () => {
      const lab = await get('lab', path);
      expect(lab.status).toBe(200);
      expect(lab.body).toEqual({
        preferences: DEFAULT_USER_PREFERENCES,
        version: 0,
        labTimeZone: 'America/Edmonton',
        readOnly: true,
      });
      const before = await settingsSnapshot();
      const patch = await send('lab', 'patch', path, { theme: 'dark', version: 0 });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('forbidden');
      expect((await get('pend', path)).body.code).toBe('access_pending');
      expect((await send('pend', 'patch', path, { theme: 'dark', version: 0 })).status).toBe(403);
      expect(await settingsSnapshot()).toEqual(before);
    });

    it('leaves /api/me/notification-preferences as it was (its own email switch)', async () => {
      const response = await get('pat', '/api/me/notification-preferences');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('emailActionRequests');
    });
  });

  describe('table columns', () => {
    const path = '/api/me/table-columns';
    const defaults = { inbox: { hidden: [] }, inventory: { hidden: ['retain_until'] } };

    it('starts with the registry defaults for every table, version 0', async () => {
      const response = await get('pat', path);
      expect(response.status).toBe(200);
      expect(tableColumnsResponseSchema.parse(response.body)).toEqual({
        tables: defaults,
        version: 0,
        readOnly: false,
      });
    });

    it('saves one table at a time under one version across tables', async () => {
      const first = await send('pat', 'put', `${path}/inventory`, {
        hidden: ['type', 'type', 'location'],
        version: 0,
      });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        tables: { inbox: { hidden: [] }, inventory: { hidden: ['type', 'location'] } },
        version: 1,
        readOnly: false,
      });
      const second = await send('pat', 'put', `${path}/inbox`, { hidden: ['from'], version: 1 });
      expect(second.body).toEqual({
        tables: { inbox: { hidden: ['from'] }, inventory: { hidden: ['type', 'location'] } },
        version: 2,
        readOnly: false,
      });
      // Showing every column of a table is an empty list.
      const shown = await send('pat', 'put', `${path}/inventory`, { hidden: [], version: 2 });
      expect(shown.body.tables.inventory).toEqual({ hidden: [] });
      expect((await get('pat', path)).body).toEqual(shown.body);
    });

    it('a stale version (from any table) is 409 with every table, and saves nothing', async () => {
      const before = await settingsSnapshot();
      const response = await send('pat', 'put', `${path}/inbox`, { hidden: [], version: 1 });
      expect(response.status).toBe(409);
      const body = tableColumnsVersionConflictSchema.parse(response.body);
      expect(body.current).toMatchObject({ version: 3, tables: { inbox: { hidden: ['from'] } } });
      expect(await settingsSnapshot()).toEqual(before);
    });

    it('unknown table is 400 unknown_table; required or unknown column is 400 invalid_column', async () => {
      const before = await settingsSnapshot();
      const unknown = await send('pat', 'put', `${path}/receipts`, { hidden: [], version: 3 });
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('unknown_table');
      for (const hidden of [['id'], ['stage'], ['colour'], ['type', 'project']]) {
        const response = await send('pat', 'put', `${path}/inventory`, { hidden, version: 3 });
        expect(response.status, hidden.join()).toBe(400);
        expect(response.body.code).toBe('invalid_column');
      }
      const extra = await send('pat', 'put', `${path}/inbox`, {
        hidden: [],
        version: 3,
        userId: users.alex,
      });
      expect(extra.status).toBe(400);
      expect(await settingsSnapshot()).toEqual(before);
      expect(await storedValue('alex', 'table_columns')).toBeNull();
    });

    it('a stored table that is no longer registered, or a bad column, is dropped on read', async () => {
      await db.pool.query(
        `UPDATE person_setting SET value = value || '{"old_table": ["x"], "inbox": ["task", "from"]}'
         WHERE user_id = $1 AND area = 'table_columns'`,
        [users.pat],
      );
      const response = await get('pat', path);
      expect(response.body.tables).toEqual({
        inbox: { hidden: ['from'] },
        inventory: { hidden: [] },
      });
    });

    it('LAB reads defaults read-only and may not save; pending is refused', async () => {
      const lab = await get('lab', path);
      expect(lab.status).toBe(200);
      expect(lab.body).toEqual({ tables: defaults, version: 0, readOnly: true });
      const before = await settingsSnapshot();
      const put = await send('lab', 'put', `${path}/inbox`, { hidden: [], version: 0 });
      expect(put.status).toBe(403);
      expect((await get('pend', path)).body.code).toBe('access_pending');
      expect((await send('pend', 'put', `${path}/inbox`, { hidden: [], version: 0 })).status).toBe(
        403,
      );
      expect(await settingsSnapshot()).toEqual(before);
    });
  });
});
