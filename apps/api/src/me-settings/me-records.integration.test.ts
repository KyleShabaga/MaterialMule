import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SIDEBAR_PINS_MAX, sidebarRecordListSchema } from '@materialmule/shared';
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
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  receivingLabId,
} from '../test-support/fixtures.js';

// Strata 1C: pins (STRATA-11) and recents (STRATA-40). Fictional records and people only.

type Who = 'pat' | 'alex' | 'lab' | 'pend';

describe.runIf(testDatabaseUrl)('pins and recents API (Strata 1C)', () => {
  let db: TestSchema;
  let app: INestApplication;
  const users = {} as Record<Who, string>;
  const cookies = {} as Record<Who, string>;
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const get = (who: Who, path: string) => http().get(path).set('Cookie', cookies[who]);
  const write = (who: Who, verb: 'put' | 'delete' | 'post', path: string, body?: object) => {
    const test = http()[verb](path).set('Cookie', cookies[who]).set(CSRF_HEADER, '1');
    return body ? test.send(body) : test;
  };
  const pin = (who: Who, kind: string, id: string) =>
    write(who, 'put', `/api/me/pins/${kind}/${id}`);
  const unpin = (who: Who, kind: string, id: string) =>
    write(who, 'delete', `/api/me/pins/${kind}/${id}`);
  const open = (who: Who, kind: string, id: string) =>
    write(who, 'post', '/api/me/recents', { kind, id });

  async function addUser(key: Who, accountType: 'personal' | 'shared_lab', status = 'active') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`${key} Example`, key.toUpperCase().slice(0, 5), accountType, status],
    );
    users[key] = rows[0]!.id;
  }

  async function addProgram(
    projectId: string,
    owner: string,
    submitted: { number: string } | null,
  ): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      submitted
        ? `INSERT INTO lab_program (project_id, created_by_account_user_id, created_by_account_type,
                                   requested_by_user_id, requested_by_name_snapshot,
                                   create_idempotency_key, status, program_number, submitted_at,
                                   submitted_by_account_user_id, submitted_by_account_type,
                                   submitted_by_name_snapshot, submitted_for_user_id,
                                   submitted_for_name_snapshot, submit_idempotency_key)
           VALUES ($1, $2, 'personal', $2, 'Pat Example', gen_random_uuid(), 'submitted', $3,
                   now(), $2, 'personal', 'Pat Example', $2, 'Pat Example', gen_random_uuid())
           RETURNING id`
        : `INSERT INTO lab_program (project_id, created_by_account_user_id, created_by_account_type,
                                   requested_by_user_id, requested_by_name_snapshot,
                                   create_idempotency_key)
           VALUES ($1, $2, 'personal', $2, 'Alex Example', gen_random_uuid()) RETURNING id`,
      submitted ? [projectId, owner, submitted.number] : [projectId, owner],
    );
    return rows[0]!.id;
  }

  async function rowsOf(table: 'person_pin' | 'person_recent') {
    const { rows } = await db.pool.query(
      `SELECT * FROM ${table} ORDER BY user_id, record_kind, record_id`,
    );
    return rows;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await addUser('pat', 'personal');
    await addUser('alex', 'personal');
    await addUser('lab', 'shared_lab');
    await addUser('pend', 'personal', 'pending');

    ids.project = await insertProject(db.pool, 'DEMO-2601', users.pat);
    await db.pool.query(`UPDATE project SET name = 'Fictional Ridge' WHERE id = $1`, [ids.project]);
    const hole1 = await insertTestHole(db.pool, ids.project, 'TH26-01');
    const hole2 = await insertTestHole(db.pool, ids.project, 'TH26-02');
    const receivingLab = await receivingLabId(db.pool);
    const receipt = await insertReceipt(db.pool, ids.project, users.pat, 2);
    ids.unit = await insertStorageUnit(
      db.pool,
      { projectId: ids.project, receiptId: receipt, locationId: receivingLab },
      { readableId: 'BKT-2026-000014' },
    );
    for (const hole of [hole2, hole1]) {
      await insertSummary(
        db.pool,
        { storageUnitId: ids.unit, projectId: ids.project, testHoleId: hole },
        { type: 'all' },
      );
    }
    // A unit with no hole summary, disposed: its name is the project name.
    ids.disposed = await insertStorageUnit(
      db.pool,
      { projectId: ids.project, receiptId: receipt, locationId: receivingLab },
      { readableId: 'BKT-2026-000015' },
    );
    await db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [
      ids.disposed,
    ]);
    ids.program = await addProgram(ids.project, users.pat, { number: 'LP-2026-0001' });
    ids.alexDraft = await addProgram(ids.project, users.alex, null);
    const report = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
       RETURNING id`,
      [ids.project, users.pat],
    );
    const set = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_specimen_set (project_id, field_report_id, temporary_id)
       VALUES ($1, $2, 'TMP-D07-001') RETURNING id`,
      [ids.project, report.rows[0]!.id],
    );
    ids.set = set.rows[0]!.id;

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
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  describe('pins', () => {
    it('starts empty', async () => {
      const response = await get('pat', '/api/me/pins');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [] });
    });

    it('pins each kind of record with its label, name, stage and link, oldest first', async () => {
      for (const [kind, id] of [
        ['storage_unit', ids.unit],
        ['project', ids.project],
        ['lab_program', ids.program],
        ['specimen_set', ids.set],
        ['storage_unit', ids.disposed],
      ] as const) {
        const response = await pin('pat', kind, id!);
        expect(response.status, kind).toBe(200);
      }
      const response = await get('pat', '/api/me/pins');
      const list = sidebarRecordListSchema.parse(response.body);
      expect(list.items.map(({ at: _at, ...rest }) => rest)).toEqual([
        {
          kind: 'storage_unit',
          id: ids.unit,
          available: true,
          label: 'BKT-2026-000014',
          name: 'DEMO-2601 · TH26-01, TH26-02',
          stage: 'draft',
          href: '/sample-storage/BKT-2026-000014',
        },
        {
          kind: 'project',
          id: ids.project,
          available: true,
          label: 'DEMO-2601',
          name: 'Fictional Ridge',
          stage: 'storage',
          href: `/projects/${ids.project}`,
        },
        {
          kind: 'lab_program',
          id: ids.program,
          available: true,
          label: 'LP-2026-0001',
          name: 'DEMO-2601',
          stage: 'lab',
          href: `/lab-testing/programs/${ids.program}`,
        },
        {
          kind: 'specimen_set',
          id: ids.set,
          available: true,
          label: 'TMP-D07-001',
          name: 'DEMO-2601',
          stage: 'draft',
          href: `/concrete/specimens/${ids.set}`,
        },
        {
          kind: 'storage_unit',
          id: ids.disposed,
          available: true,
          label: 'BKT-2026-000015',
          name: 'Fictional Ridge',
          stage: 'closed',
          href: '/sample-storage/BKT-2026-000015',
        },
      ]);
      const times = list.items.map((item) => Date.parse(item.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it('pinning again is idempotent and keeps the original place', async () => {
      const before = await rowsOf('person_pin');
      const response = await pin('pat', 'storage_unit', ids.unit!);
      expect(response.status).toBe(200);
      expect(response.body.items[0].id).toBe(ids.unit);
      expect(await rowsOf('person_pin')).toEqual(before);
    });

    it('a record that does not exist, or that the person cannot open, is 404 and not pinned', async () => {
      const before = await rowsOf('person_pin');
      for (const [kind, id] of [
        ['project', randomUUID()],
        ['storage_unit', ids.project],
        ['specimen_set', randomUUID()],
        // Alex's draft program is seen only by Alex.
        ['lab_program', ids.alexDraft],
      ] as const) {
        const response = await pin('pat', kind, id!);
        expect(response.status, kind).toBe(404);
        expect(response.body).toEqual(expect.objectContaining({ code: 'record_not_found' }));
      }
      expect(await rowsOf('person_pin')).toEqual(before);
      // Its owner may pin it; the draft has no number yet.
      const own = await pin('alex', 'lab_program', ids.alexDraft!);
      expect(own.body.items[0]).toMatchObject({ label: 'Draft program', stage: 'draft' });
    });

    it('bad kinds and IDs are 400', async () => {
      expect((await pin('pat', 'test_hole', ids.project!)).status).toBe(400);
      expect((await pin('pat', 'project', 'DEMO-2601')).status).toBe(400);
      expect((await unpin('pat', 'project', 'DEMO-2601')).status).toBe(400);
    });

    it('a pin the person can no longer open, or whose record is gone, reads as unavailable', async () => {
      const missing = randomUUID();
      await db.pool.query(
        `INSERT INTO person_pin (user_id, record_kind, record_id) VALUES
           ($1, 'lab_program', $2), ($1, 'project', $3)`,
        [users.pat, ids.alexDraft, missing],
      );
      const { items } = (await get('pat', '/api/me/pins')).body as {
        items: Array<Record<string, unknown>>;
      };
      for (const id of [ids.alexDraft, missing]) {
        const item = items.find((i) => i.id === id)!;
        expect(item).toMatchObject({
          available: false,
          label: null,
          name: null,
          stage: null,
          href: null,
        });
      }
      // ...and can still be unpinned.
      const removed = await unpin('pat', 'lab_program', ids.alexDraft!);
      expect(removed.status).toBe(200);
      expect(removed.body.items.some((i: { id: string }) => i.id === ids.alexDraft)).toBe(false);
      await unpin('pat', 'project', missing);
    });

    it('unpinning is idempotent', async () => {
      expect((await unpin('pat', 'specimen_set', ids.set!)).status).toBe(200);
      const before = await rowsOf('person_pin');
      const again = await unpin('pat', 'specimen_set', ids.set!);
      expect(again.status).toBe(200);
      expect(await rowsOf('person_pin')).toEqual(before);
    });

    it(`stops at ${SIDEBAR_PINS_MAX} pins with 409 pin_limit, pinning nothing more`, async () => {
      const current = (await get('pat', '/api/me/pins')).body.items.length as number;
      for (let n = current; n < SIDEBAR_PINS_MAX; n += 1) {
        const project = await insertProject(
          db.pool,
          `DEMO-27${String(n).padStart(2, '0')}`,
          users.pat,
        );
        expect((await pin('pat', 'project', project)).status).toBe(200);
      }
      const before = await rowsOf('person_pin');
      const response = await pin('pat', 'specimen_set', ids.set!);
      expect(response.status).toBe(409);
      expect(response.body).toEqual(expect.objectContaining({ code: 'pin_limit' }));
      expect(await rowsOf('person_pin')).toEqual(before);
      // Re-pinning one already pinned is still fine at the limit.
      expect((await pin('pat', 'project', ids.project!)).status).toBe(200);
      // Another person's pins are their own.
      expect((await get('alex', '/api/me/pins')).body.items).toHaveLength(1);
    });

    it('LAB and pending accounts are refused and nothing changes', async () => {
      const before = await rowsOf('person_pin');
      for (const who of ['lab', 'pend'] as const) {
        const code = who === 'lab' ? 'forbidden' : 'access_pending';
        expect((await get(who, '/api/me/pins')).body.code).toBe(code);
        const put = await pin(who, 'project', ids.project!);
        expect(put.status).toBe(403);
        expect(put.body.code).toBe(code);
        expect((await unpin(who, 'project', ids.project!)).status).toBe(403);
      }
      expect(await rowsOf('person_pin')).toEqual(before);
    });
  });

  describe('recents', () => {
    it('starts empty and records an opened record at the top', async () => {
      expect((await get('pat', '/api/me/recents')).body).toEqual({ items: [] });
      const response = await open('pat', 'storage_unit', ids.unit!);
      expect(response.status).toBe(200);
      expect(sidebarRecordListSchema.parse(response.body).items).toEqual([
        expect.objectContaining({ kind: 'storage_unit', id: ids.unit, label: 'BKT-2026-000014' }),
      ]);
    });

    it('keeps the newest eight, newest first, and moves a reopened record to the top', async () => {
      const projects: string[] = [];
      for (let n = 0; n < 9; n += 1) {
        projects.push(
          await insertProject(db.pool, `DEMO-28${String(n).padStart(2, '0')}`, users.pat),
        );
      }
      for (const id of projects) await open('pat', 'project', id);
      let items = (await get('pat', '/api/me/recents')).body.items as Array<{ id: string }>;
      expect(items.map((i) => i.id)).toEqual([...projects].reverse().slice(0, 8));
      // Trimmed in the same transaction: the table itself keeps eight.
      const count = async () =>
        (
          await db.pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM person_recent WHERE user_id = $1',
            [users.pat],
          )
        ).rows[0]!.n;
      expect(await count()).toBe(8);
      // Reopening the oldest kept one moves it up without a duplicate.
      const response = await open('pat', 'project', projects[1]!);
      items = response.body.items;
      expect(items.map((i) => i.id)).toEqual([projects[1], ...[...projects].reverse().slice(0, 7)]);
      expect(await count()).toBe(8);
    });

    it('a record that does not exist or cannot be opened is 404 and recorded nowhere', async () => {
      const before = await rowsOf('person_recent');
      expect((await open('pat', 'project', randomUUID())).status).toBe(404);
      expect((await open('pat', 'lab_program', ids.alexDraft!)).status).toBe(404);
      for (const body of [
        { kind: 'test_hole', id: ids.project },
        { kind: 'project', id: 'DEMO-2601' },
        { kind: 'project', id: ids.project, userId: users.alex },
        {},
      ]) {
        expect((await write('pat', 'post', '/api/me/recents', body)).status).toBe(400);
      }
      expect(await rowsOf('person_recent')).toEqual(before);
    });

    it('a recent record that is gone reads as unavailable', async () => {
      const gone = randomUUID();
      await db.pool.query(
        `INSERT INTO person_recent (user_id, record_kind, record_id, opened_at)
         VALUES ($1, 'specimen_set', $2, now() + interval '1 minute')`,
        [users.alex, gone],
      );
      const { items } = (await get('alex', '/api/me/recents')).body;
      expect(items[0]).toMatchObject({ id: gone, available: false, label: null, href: null });
    });

    it("one person's recents never show for or change another's", async () => {
      const patBefore = (await get('pat', '/api/me/recents')).body;
      await open('alex', 'project', ids.project!);
      expect((await get('pat', '/api/me/recents')).body).toEqual(patBefore);
      const alex = (await get('alex', '/api/me/recents')).body.items as Array<{ id: string }>;
      expect(alex.map((i) => i.id)).not.toContain(ids.unit);
    });

    it('LAB and pending accounts are refused and nothing changes', async () => {
      const before = await rowsOf('person_recent');
      for (const who of ['lab', 'pend'] as const) {
        expect((await get(who, '/api/me/recents')).status).toBe(403);
        expect((await open(who, 'project', ids.project!)).status).toBe(403);
      }
      expect(await rowsOf('person_recent')).toEqual(before);
    });
  });
});
