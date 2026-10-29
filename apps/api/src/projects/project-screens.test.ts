import type { INestApplication } from '@nestjs/common';
import {
  PROJECT_NUMBER_LOCKED_MESSAGE,
  messagesByField,
  projectDetailSchema,
  projectListPageSchema,
  projectSummarySchema,
  projectVersionConflictResponseSchema,
  validationErrorResponseSchema,
  type ProjectDetail,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
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
import { receivingLabId } from '../test-support/fixtures.js';

// MM-T35: projects list, detail and edit. Every name and number below is fictional.
describe.runIf(testDatabaseUrl)('projects list and detail (MM-T35)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let locationId: string;
  const users: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  let nextUnit = 0;

  async function addUser(
    key: string,
    accountType: 'personal' | 'shared_lab',
    options: { roles?: string[]; status?: 'active' | 'pending' } = {},
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`User ${key}`, key.toUpperCase().slice(0, 5), accountType, options.status ?? 'active'],
    );
    users[key] = rows[0]!.id;
    for (const role of options.roles ?? []) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
    const session = await app.get(SessionService).create(rows[0]!.id, accountType);
    cookies[key] = `${SESSION_COOKIE}=${session.token}`;
  }

  const get = (path: string, cookie: string) => http().get(path).set('Cookie', cookie);
  const send = (method: 'post' | 'patch', path: string, cookie: string, body: unknown) =>
    http()
      [method](path)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send(body as object);

  async function addProject(
    projectNumber: string,
    name: string,
    client: string,
    leadProjectEngineer: string,
    reviewEngineer: string | null = null,
  ): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id, review_engineer_user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [projectNumber, name, client, leadProjectEngineer, reviewEngineer],
    );
    return rows[0]!.id;
  }

  async function addHole(projectId: string, name: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      'INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id',
      [projectId, name],
    );
    return rows[0]!.id;
  }

  /** A receipt with one bucket per entry of `units` (each listing the holes it holds). */
  async function addReceipt(
    projectId: string,
    receivedDate: string,
    units: { holes: string[]; status?: string }[],
  ): Promise<string> {
    const receipt = await db.pool.query<{ id: string }>(
      `INSERT INTO receipt (project_id, received_date, receiver_user_id,
                            receiver_initials_snapshot, receiver_name_snapshot, account_user_id,
                            quantity, idempotency_key, request_hash)
       VALUES ($1, $2, $3, 'TECH', 'User tech', $3, $4, gen_random_uuid(), 'test')
       RETURNING id`,
      [projectId, receivedDate, users.tech, units.length],
    );
    const receiptId = receipt.rows[0]!.id;
    for (const unit of units) {
      nextUnit += 1;
      const inserted = await db.pool.query<{ id: string }>(
        `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                   receipt_id, project_id, unit_type, holder_kind,
                                   current_location_id, received_date, status)
         VALUES ($1, 'BKT', 2026, 'bucket', $2, $3, 'bucket', 'bucket', $4, $5, $6)
         RETURNING id`,
        [
          `BKT-2026-${String(nextUnit).padStart(6, '0')}`,
          receiptId,
          projectId,
          locationId,
          receivedDate,
          unit.status ?? 'in_stock',
        ],
      );
      for (const hole of unit.holes) {
        await db.pool.query(
          `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                  summary_type)
           VALUES ($1, $2, $3, 'all')`,
          [inserted.rows[0]!.id, projectId, hole],
        );
      }
    }
    return receiptId;
  }

  async function detail(projectId: string, who = 'tech'): Promise<ProjectDetail> {
    const response = await get(`/api/projects/${projectId}`, cookies[who]!);
    expect(response.status).toBe(200);
    return projectDetailSchema.parse(response.body);
  }

  async function listAll(query: string, who = 'tech') {
    const response = await get(`/api/projects?${query}`, cookies[who]!);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return projectListPageSchema.parse(response.body);
  }

  let demo: string;
  let th01: string;
  let th02: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    locationId = await receivingLabId(db.pool);
    await addUser('pe', 'personal');
    await addUser('mine', 'personal');
    await addUser('rev', 'personal');
    await addUser('tech', 'personal');
    await addUser('admin', 'personal', { roles: ['admin'] });
    await addUser('lab', 'shared_lab');
    await addUser('pend', 'personal', { status: 'pending' });

    // AC2/AC3: "mine" is Lead Project Engineer on DEMO-2601 only.
    demo = await addProject('DEMO-2601', 'Riverbank investigation', 'Example Client', users.mine!);
    th01 = await addHole(demo, 'TH26-01');
    th02 = await addHole(demo, 'TH26-02');
    await addReceipt(demo, '2026-10-01', [{ holes: [th01, th02] }, { holes: [th01] }]);
    await addReceipt(demo, '2026-10-20', [{ holes: [th02] }]);

    // AC1: 30 projects in total; 26 more mention "river" in the number, name or client.
    for (let i = 1; i <= 29; i += 1) {
      const n = String(i).padStart(2, '0');
      if (i <= 9) await addProject(`RIVER-${n}`, `Bridge works ${n}`, 'Example Client', users.pe!);
      else if (i <= 18) await addProject(`P-${n}`, `Riverside slope ${n}`, 'Example', users.pe!);
      else if (i <= 26) await addProject(`Q-${n}`, `Culvert ${n}`, 'Rivers Example Ltd', users.pe!);
      else await addProject(`Z-${n}`, `Hillside ${n}`, 'Example Client', users.pe!, users.rev!);
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  describe('list', () => {
    it('AC1: search "river" matches number, name or client, counted and paged at 25', async () => {
      const first = await listAll('search=river');
      expect(first.total).toBe(27);
      expect(first.pageSize).toBe(25);
      expect(first.items).toHaveLength(25);
      const second = await listAll('search=river&page=2');
      expect(second.items).toHaveLength(2);
      const numbers = [...first.items, ...second.items].map((p) => p.projectNumber);
      expect(new Set(numbers).size).toBe(27);
      expect(numbers.some((n) => n.startsWith('Z-'))).toBe(false);
      expect(numbers).toContain('DEMO-2601');

      const all = await listAll('');
      expect(all.total).toBe(30);
      expect((await listAll('search=RIVERS%20example')).total).toBe(8);
      expect((await listAll('search=%25')).total).toBe(0);
    });

    it('AC2: "Only mine" shows only projects where I am Lead Project Engineer or review engineer', async () => {
      const mine = await listAll('mine=true', 'mine');
      expect(mine.total).toBe(1);
      expect(mine.items.map((p) => p.projectNumber)).toEqual(['DEMO-2601']);
      const reviewer = await listAll('mine=true', 'rev');
      expect(reviewer.items.map((p) => p.projectNumber)).toEqual(['Z-27', 'Z-28', 'Z-29']);
      expect((await listAll('mine=true', 'lab')).total).toBe(0);
      expect((await listAll('mine=false', 'mine')).total).toBe(30);
    });

    it('shows initials, hole count, in-stock units and last receipt date', async () => {
      const page = await listAll('search=DEMO-2601');
      expect(page.items[0]).toMatchObject({
        projectNumber: 'DEMO-2601',
        name: 'Riverbank investigation',
        client: 'Example Client',
        leadProjectEngineer: { id: users.mine, initials: 'MINE' },
        testHoleCount: 2,
        inStockUnitCount: 3,
        lastReceiptDate: '2026-10-20',
      });
    });

    it('T2: sorts by number, name and last receipt with stable, complete paging', async () => {
      const byNumber = await listAll('pageSize=100');
      const numbers = byNumber.items.map((p) => p.projectNumber);
      expect(numbers).toEqual([...numbers].sort());
      const desc = await listAll('pageSize=100&dir=desc');
      expect(desc.items.map((p) => p.projectNumber)).toEqual([...numbers].reverse());

      const byName = await listAll('sort=name&pageSize=100');
      const names = byName.items.map((p) => p.name.toLowerCase());
      expect(names).toEqual([...names].sort());

      const byReceipt = await listAll('sort=last_receipt&pageSize=100');
      expect(byReceipt.items[0]!.projectNumber).toBe('DEMO-2601');
      expect(byReceipt.items.slice(1).every((p) => p.lastReceiptDate === null)).toBe(true);
      const ascending = await listAll('sort=last_receipt&dir=asc&pageSize=100');
      expect(ascending.items[0]!.projectNumber).toBe('DEMO-2601');

      for (const sort of ['number', 'name', 'last_receipt']) {
        const seen: string[] = [];
        for (let page = 1; page <= 5; page += 1) {
          const result = await listAll(`sort=${sort}&pageSize=7&page=${page}`);
          expect(result.total).toBe(30);
          seen.push(...result.items.map((p) => p.id));
        }
        expect(seen).toHaveLength(30);
        expect(new Set(seen).size).toBe(30);
      }
    });

    it('rejects a bad query by field and needs an active session', async () => {
      const bad = await get('/api/projects?pageSize=500&sort=client', cookies.tech!);
      expect(bad.status).toBe(400);
      expect(
        Object.keys(messagesByField(validationErrorResponseSchema.parse(bad.body).errors)).sort(),
      ).toEqual(['pageSize', 'sort']);
      expect((await http().get('/api/projects')).status).toBe(401);
      expect((await get('/api/projects', cookies.pend!)).status).toBe(403);
      expect((await get('/api/projects', cookies.lab!)).status).toBe(200);
    });
  });

  describe('detail', () => {
    it('AC3: shows both receipts, three units and per-hole unit counts', async () => {
      const project = await detail(demo, 'lab');
      expect(project).toMatchObject({
        projectNumber: 'DEMO-2601',
        leadProjectEngineer: { id: users.mine },
        reviewEngineer: null,
        serverFolderPath: null,
        numberLocked: true,
        unitCount: 3,
        inStockUnitCount: 3,
        receiptCount: 2,
        canEdit: false,
        canChangeLeadProjectEngineer: false,
      });
      expect(project.receipts.map((r) => [r.receivedDate, r.unitCount, r.receiver])).toEqual([
        ['2026-10-20', 1, { name: 'User tech', initials: 'TECH' }],
        ['2026-10-01', 2, { name: 'User tech', initials: 'TECH' }],
      ]);
      expect(project.testHoles.map((h) => [h.name, h.unitCount])).toEqual([
        ['TH26-01', 2],
        ['TH26-02', 2],
      ]);
      // Still a valid T08 summary for the inventory filter label.
      expect(projectSummarySchema.parse(project).id).toBe(demo);
    });

    it('reports who may edit: the Lead Project Engineer and admins; only admins change the Lead Project Engineer', async () => {
      expect(await detail(demo, 'mine')).toMatchObject({
        canEdit: true,
        canChangeLeadProjectEngineer: false,
      });
      expect(await detail(demo, 'admin')).toMatchObject({
        canEdit: true,
        canChangeLeadProjectEngineer: true,
      });
      expect(await detail(demo, 'tech')).toMatchObject({
        canEdit: false,
        canChangeLeadProjectEngineer: false,
      });
    });

    it('404s for an unknown project', async () => {
      const response = await get(
        '/api/projects/00000000-0000-4000-8000-00000000ffff',
        cookies.tech!,
      );
      expect(response.status).toBe(404);
    });

    it('AC6: adding "th26-01 " when TH26-01 exists is rejected as a duplicate', async () => {
      const duplicate = await send('post', `/api/projects/${demo}/test-holes`, cookies.lab!, {
        name: 'th26-01 ',
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ code: 'test_hole_exists', existing: { id: th01 } });
      const added = await send('post', `/api/projects/${demo}/test-holes`, cookies.lab!, {
        name: ' TH26-03 ',
      });
      expect(added.status).toBe(201);
      const project = await detail(demo);
      expect(project.testHoles.map((h) => [h.name, h.unitCount])).toEqual([
        ['TH26-01', 2],
        ['TH26-02', 2],
        ['TH26-03', 0],
      ]);
    });
  });

  describe('edit (T3, T4)', () => {
    it('T3: permission matrix: Lead Project Engineer and admin 200; technician, reviewer and LAB 403', async () => {
      const project = await addProject(
        'EDIT-1',
        'Edit works',
        'Example Client',
        users.pe!,
        users.rev!,
      );
      let version = (await detail(project)).version;
      for (const who of ['tech', 'rev', 'lab']) {
        const response = await send('patch', `/api/projects/${project}`, cookies[who]!, {
          version,
          name: `Renamed by ${who}`,
        });
        expect(response.status, who).toBe(403);
      }
      for (const who of ['pe', 'admin']) {
        const response = await send('patch', `/api/projects/${project}`, cookies[who]!, {
          version,
          name: `Renamed by ${who}`,
        });
        expect(response.status, who).toBe(200);
        const updated = projectDetailSchema.parse(response.body);
        expect(updated.name).toBe(`Renamed by ${who}`);
        expect(updated.version).toBe(version + 1);
        version = updated.version;
      }
      const noCsrf = await http()
        .patch(`/api/projects/${project}`)
        .set('Cookie', cookies.pe!)
        .send({ version, name: 'No header' });
      expect(noCsrf.status).toBe(403);
    });

    it('AC5: a technician, or the Lead Project Engineer themself, gets 403 for changing the Lead Project Engineer', async () => {
      const project = await addProject('EDIT-2', 'Lead change', 'Example Client', users.pe!);
      const { version } = await detail(project);
      for (const who of ['tech', 'pe']) {
        const response = await send('patch', `/api/projects/${project}`, cookies[who]!, {
          version,
          leadProjectEngineerId: users.mine,
          reason: 'Handover',
        });
        expect(response.status, who).toBe(403);
      }
      expect((await detail(project)).leadProjectEngineer.id).toBe(users.pe);
      // Sending the current Lead Project Engineer unchanged is not a change.
      const same = await send('patch', `/api/projects/${project}`, cookies.pe!, {
        version,
        leadProjectEngineerId: users.pe,
        client: 'New Example Client',
      });
      expect(same.status).toBe(200);
    });

    it('T4: admin changes the Lead Project Engineer only with a reason, audited with before/after', async () => {
      const project = await addProject('EDIT-3', 'Audit works', 'Example Client', users.pe!);
      const { version } = await detail(project);
      const noReason = await send('patch', `/api/projects/${project}`, cookies.admin!, {
        version,
        leadProjectEngineerId: users.mine,
      });
      expect(noReason.status).toBe(400);
      expect(
        messagesByField(validationErrorResponseSchema.parse(noReason.body).errors),
      ).toHaveProperty('reason');

      const notStaff = await send('patch', `/api/projects/${project}`, cookies.admin!, {
        version,
        leadProjectEngineerId: users.lab,
        reviewEngineerId: users.pend,
        reason: 'Handover',
      });
      expect(Object.keys(messagesByField(notStaff.body.errors)).sort()).toEqual([
        'leadProjectEngineerId',
        'reviewEngineerId',
      ]);

      const response = await send('patch', `/api/projects/${project}`, cookies.admin!, {
        version,
        leadProjectEngineerId: users.mine,
        reviewEngineerId: users.rev,
        serverFolderPath: '  P:\\Projects\\EDIT-3  ',
        name: 'Audit works',
        reason: ' Lead Project Engineer on leave ',
      });
      expect(response.status).toBe(200);
      expect(projectDetailSchema.parse(response.body)).toMatchObject({
        leadProjectEngineer: { id: users.mine },
        reviewEngineer: { id: users.rev, initials: 'REV' },
        serverFolderPath: 'P:\\Projects\\EDIT-3',
      });

      const events = await listAuditForEntity(db.pool, 'project', project);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'project.updated',
        actorUserId: users.admin,
        reason: 'Lead Project Engineer on leave',
        // Only changed fields: the unchanged name is left out.
        before: {
          leadProjectEngineerUserId: users.pe,
          reviewEngineerUserId: null,
          serverFolderPath: null,
        },
        after: {
          leadProjectEngineerUserId: users.mine,
          reviewEngineerUserId: users.rev,
          serverFolderPath: 'P:\\Projects\\EDIT-3',
        },
      });

      // Clearing the folder path and review engineer.
      const cleared = await send('patch', `/api/projects/${project}`, cookies.mine!, {
        version: version + 1,
        serverFolderPath: '',
        reviewEngineerId: null,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ serverFolderPath: null, reviewEngineer: null });
    });

    it('AC4: a project with a receipt keeps its number (422, nothing changes)', async () => {
      const before = await detail(demo);
      for (const who of ['admin', 'mine']) {
        const response = await send('patch', `/api/projects/${demo}`, cookies[who]!, {
          version: before.version,
          projectNumber: 'DEMO-2601X',
          name: 'Should not save',
        });
        expect(response.status, who).toBe(422);
        expect(response.body).toMatchObject({
          code: 'project_number_locked',
          message: PROJECT_NUMBER_LOCKED_MESSAGE,
        });
      }
      const after = await detail(demo);
      expect(after).toMatchObject({
        projectNumber: 'DEMO-2601',
        name: before.name,
        version: before.version,
      });
      expect(await listAuditForEntity(db.pool, 'project', demo)).toHaveLength(0);
    });

    it('lets the number change before the first receipt, unless another project has it', async () => {
      const project = await addProject('EDIT-4', 'Number works', 'Example Client', users.pe!);
      const { version } = await detail(project);
      const taken = await send('patch', `/api/projects/${project}`, cookies.pe!, {
        version,
        projectNumber: 'demo-2601',
      });
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'project_exists', existing: { id: demo } });

      const renamed = await send('patch', `/api/projects/${project}`, cookies.pe!, {
        version,
        projectNumber: ' EDIT-4B ',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ projectNumber: 'EDIT-4B', numberLocked: false });
      const [event] = await listAuditForEntity(db.pool, 'project', project);
      expect(event).toMatchObject({
        before: { projectNumber: 'EDIT-4' },
        after: { projectNumber: 'EDIT-4B' },
      });
    });

    it('rejects a stale version with 409 and the current project', async () => {
      const project = await addProject('EDIT-5', 'Version works', 'Example Client', users.pe!);
      const { version } = await detail(project);
      expect(
        (await send('patch', `/api/projects/${project}`, cookies.pe!, { version, name: 'First' }))
          .status,
      ).toBe(200);
      const stale = await send('patch', `/api/projects/${project}`, cookies.admin!, {
        version,
        name: 'Second',
      });
      expect(stale.status).toBe(409);
      const conflict = projectVersionConflictResponseSchema.parse(stale.body);
      expect(conflict.current).toMatchObject({ name: 'First', version: version + 1 });
    });

    it('validates fields by name without echoing values, and 404s for an unknown project', async () => {
      const project = await addProject('EDIT-6', 'Validation works', 'Example Client', users.pe!);
      const response = await send('patch', `/api/projects/${project}`, cookies.pe!, {
        name: '  ',
        serverFolderPath: 'x'.repeat(501),
      });
      expect(response.status).toBe(400);
      const byField = messagesByField(validationErrorResponseSchema.parse(response.body).errors);
      expect(Object.keys(byField).sort()).toEqual(['name', 'serverFolderPath', 'version']);
      expect(JSON.stringify(response.body)).not.toContain('xxxxx');

      const unknown = await send(
        'patch',
        '/api/projects/00000000-0000-4000-8000-00000000ffff',
        cookies.admin!,
        { version: 1, name: 'Nobody' },
      );
      expect(unknown.status).toBe(404);
    });
  });
});
