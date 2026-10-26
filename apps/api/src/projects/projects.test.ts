import type { INestApplication } from '@nestjs/common';
import {
  projectConflictResponseSchema,
  projectSearchResponseSchema,
  projectSummarySchema,
  staffOptionsResponseSchema,
  testHoleConflictResponseSchema,
  testHoleListResponseSchema,
  testHoleSchema,
  validationErrorResponseSchema,
  messagesByField,
} from '@trapezoid/shared';
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
import { likeEscape } from './projects.service.js';

describe('likeEscape', () => {
  it('makes LIKE wildcards literal', () => {
    expect(likeEscape('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});

// Every name and number below is fictional.
describe.runIf(testDatabaseUrl)('projects and test holes (TRP-T08)', () => {
  let db: TestSchema;
  let app: INestApplication;
  const users: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const http = () => request(app.getHttpServer());

  async function addUser(
    key: string,
    accountType: 'personal' | 'shared_lab',
    status: 'active' | 'pending' | 'disabled' = 'active',
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`User ${key}`, key.toUpperCase().slice(0, 5), accountType, status],
    );
    users[key] = rows[0]!.id;
    if (status !== 'disabled') {
      const session = await app.get(SessionService).create(rows[0]!.id, accountType);
      cookies[key] = `${SESSION_COOKIE}=${session.token}`;
    }
  }

  const post = (path: string, cookie: string, body: unknown) =>
    http()
      .post(path)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send(body as object);
  const get = (path: string, cookie: string) => http().get(path).set('Cookie', cookie);

  function newProject(projectNumber: string, overrides: Record<string, unknown> = {}) {
    return {
      projectNumber,
      name: `Example works ${projectNumber}`,
      client: 'Example Client',
      pmPeUserId: users.pe,
      ...overrides,
    };
  }

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
    await addUser('pe', 'personal');
    await addUser('tech', 'personal');
    await addUser('lab', 'shared_lab');
    await addUser('pend', 'personal', 'pending');
    await addUser('gone', 'personal', 'disabled');

    const created = await post(
      '/api/projects',
      cookies.tech!,
      newProject('67997', { name: 'West Pine Creek Ph.3', client: 'Jacobs Example' }),
    );
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  describe('search (AC1)', () => {
    it.each(['67997', '679', 'west pine', 'PINE', '997'])('finds 67997 by "%s"', async (q) => {
      const response = await get(`/api/projects/search?q=${encodeURIComponent(q)}`, cookies.lab!);
      expect(response.status).toBe(200);
      const results = projectSearchResponseSchema.parse(response.body);
      expect(results[0]).toMatchObject({
        projectNumber: '67997',
        name: 'West Pine Creek Ph.3',
        client: 'Jacobs Example',
        pmPe: { id: users.pe, displayName: 'User pe', initials: 'PE' },
      });
    });

    it('returns nothing for blank or unmatched text and treats wildcards literally', async () => {
      for (const q of ['', '   ', 'nothing-like-this', '%', '_']) {
        const response = await get(
          `/api/projects/search?q=${encodeURIComponent(q)}`,
          cookies.tech!,
        );
        expect(response.body).toEqual([]);
      }
    });

    it('lists number matches before name matches and caps results at 10', async () => {
      for (let i = 0; i < 12; i += 1) {
        await post('/api/projects', cookies.tech!, newProject(`88${String(i).padStart(3, '0')}`));
      }
      await post('/api/projects', cookies.tech!, newProject('X-1', { name: 'Lot 88 works' }));
      const response = await get('/api/projects/search?q=88&limit=50', cookies.tech!);
      const results = projectSearchResponseSchema.parse(response.body);
      expect(results).toHaveLength(10);
      expect(results.every((p) => p.projectNumber.startsWith('88'))).toBe(true);
    });

    it('needs an active session', async () => {
      expect((await http().get('/api/projects/search?q=679')).status).toBe(401);
      expect((await get('/api/projects/search?q=679', cookies.pend!)).status).toBe(403);
    });
  });

  describe('create project', () => {
    it('AC4: LAB can create a project, audited with the LAB account and the selected receiver', async () => {
      const response = await post(
        '/api/projects',
        cookies.lab!,
        newProject('  LAB-7001 ', { name: ' Lab works ', receiverUserId: users.tech }),
      );
      expect(response.status).toBe(201);
      const project = projectSummarySchema.parse(response.body);
      expect(project.projectNumber).toBe('LAB-7001');

      const [event] = await listAuditForEntity(db.pool, 'project', project.id);
      expect(event).toMatchObject({
        action: 'project.created',
        actorUserId: users.lab,
        actorAccountType: 'shared_lab',
        receiverUserId: users.tech,
        after: {
          projectNumber: 'LAB-7001',
          name: 'Lab works',
          client: 'Example Client',
          pmPeUserId: users.pe,
        },
      });
    });

    it('AC2/T2: of two simultaneous creates for 70001, exactly one succeeds', async () => {
      const responses = await Promise.all([
        post('/api/projects', cookies.tech!, newProject('70001', { name: 'First' })),
        post('/api/projects', cookies.lab!, newProject('70001', { name: 'Second' })),
      ]);
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      const winner = projectSummarySchema.parse(responses.find((r) => r.status === 201)!.body);
      const loser = projectConflictResponseSchema.parse(
        responses.find((r) => r.status === 409)!.body,
      );
      expect(loser.existing).toEqual(winner);
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n FROM audit_event WHERE action = 'project.created' AND entity_id = $1`,
        [winner.id],
      );
      expect(rows[0]).toEqual({ n: 1 });
    });

    it('returns the existing project for a number differing only in case or spaces', async () => {
      await post('/api/projects', cookies.tech!, newProject('Demo-Case'));
      const response = await post('/api/projects', cookies.tech!, newProject(' demo-case '));
      expect(response.status).toBe(409);
      expect(projectConflictResponseSchema.parse(response.body).existing.projectNumber).toBe(
        'Demo-Case',
      );
    });

    it('AC5/T4: missing client or PM/PE fails with field-level errors', async () => {
      const response = await post('/api/projects', cookies.tech!, {
        projectNumber: '70002',
        name: 'Example',
        client: '  ',
      });
      expect(response.status).toBe(400);
      const body = validationErrorResponseSchema.parse(response.body);
      const byField = messagesByField(body.errors);
      expect(Object.keys(byField).sort()).toEqual(['client', 'pmPeUserId']);
      expect(byField.client).toEqual(['Client is required']);
      expect(JSON.stringify(body)).not.toContain('70002');
    });

    it('T4: rejects a PM/PE who is not active staff', async () => {
      for (const pmPeUserId of [users.lab, users.pend, users.gone]) {
        const response = await post(
          '/api/projects',
          cookies.tech!,
          newProject('70003', { pmPeUserId }),
        );
        expect(response.status).toBe(400);
        expect(
          messagesByField(validationErrorResponseSchema.parse(response.body).errors),
        ).toHaveProperty('pmPeUserId');
      }
      const { rows } = await db.pool.query(`SELECT 1 FROM project WHERE project_number = '70003'`);
      expect(rows).toHaveLength(0);
    });

    it('rejects pending users and requests without the CSRF header', async () => {
      expect((await post('/api/projects', cookies.pend!, newProject('70004'))).status).toBe(403);
      const noCsrf = await http()
        .post('/api/projects')
        .set('Cookie', cookies.tech!)
        .send(newProject('70004'));
      expect(noCsrf.status).toBe(403);
    });
  });

  describe('test holes', () => {
    let projectA: string;
    let projectB: string;

    beforeAll(async () => {
      projectA = projectSummarySchema.parse(
        (await post('/api/projects', cookies.tech!, newProject('HOLE-A'))).body,
      ).id;
      projectB = projectSummarySchema.parse(
        (await post('/api/projects', cookies.tech!, newProject('HOLE-B'))).body,
      ).id;
      expect(
        (await post(`/api/projects/${projectA}/test-holes`, cookies.tech!, { name: 'TH26-01' }))
          .status,
      ).toBe(201);
    });

    it('AC3/T3: duplicate in the same project is rejected; same name in another project is fine', async () => {
      const duplicate = await post(`/api/projects/${projectA}/test-holes`, cookies.lab!, {
        name: 'th26-01 ',
      });
      expect(duplicate.status).toBe(409);
      expect(testHoleConflictResponseSchema.parse(duplicate.body).existing).toMatchObject({
        projectId: projectA,
        name: 'TH26-01',
      });

      const other = await post(`/api/projects/${projectB}/test-holes`, cookies.lab!, {
        name: 'TH26-01',
      });
      expect(other.status).toBe(201);
      expect(testHoleSchema.parse(other.body)).toMatchObject({
        projectId: projectB,
        name: 'TH26-01',
      });
    });

    it('AC6: keeps the name exactly as entered (no year rewrite), audited with the receiver', async () => {
      const response = await post(`/api/projects/${projectA}/test-holes`, cookies.lab!, {
        name: '  TH26-05 ',
        receiverUserId: users.tech,
      });
      expect(response.status).toBe(201);
      const hole = testHoleSchema.parse(response.body);
      expect(hole.name).toBe('TH26-05');
      const { rows } = await db.pool.query<{ name: string }>(
        'SELECT name FROM test_hole WHERE id = $1',
        [hole.id],
      );
      expect(rows[0]!.name).toBe('TH26-05');
      const [event] = await listAuditForEntity(db.pool, 'test_hole', hole.id);
      expect(event).toMatchObject({
        action: 'test_hole.created',
        actorUserId: users.lab,
        receiverUserId: users.tech,
        after: { projectId: projectA, projectNumber: 'HOLE-A', name: 'TH26-05' },
      });
    });

    it('accepts flexible names and rejects bad ones by field', async () => {
      for (const name of ['BH-01', 'TP-03']) {
        expect(
          (await post(`/api/projects/${projectA}/test-holes`, cookies.tech!, { name })).status,
        ).toBe(201);
      }
      for (const name of ['', 'x'.repeat(41), 'TH\u000126', 42]) {
        const response = await post(`/api/projects/${projectA}/test-holes`, cookies.tech!, {
          name,
        });
        expect(response.status).toBe(400);
        expect(
          messagesByField(validationErrorResponseSchema.parse(response.body).errors),
        ).toHaveProperty('name');
      }
    });

    it('T2: of two simultaneous creates for one hole, exactly one succeeds', async () => {
      const responses = await Promise.all([
        post(`/api/projects/${projectB}/test-holes`, cookies.tech!, { name: 'TH26-09' }),
        post(`/api/projects/${projectB}/test-holes`, cookies.lab!, { name: 'th26-09' }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      const winner = testHoleSchema.parse(responses.find((r) => r.status === 201)!.body);
      expect(
        testHoleConflictResponseSchema.parse(responses.find((r) => r.status === 409)!.body)
          .existing,
      ).toEqual(winner);
    });

    it('searches within the project only', async () => {
      const all = testHoleListResponseSchema.parse(
        (await get(`/api/projects/${projectA}/test-holes`, cookies.lab!)).body,
      );
      expect(all.map((h) => h.name)).toEqual(['BH-01', 'TH26-01', 'TH26-05', 'TP-03']);
      const filtered = testHoleListResponseSchema.parse(
        (await get(`/api/projects/${projectA}/test-holes?q=th26`, cookies.lab!)).body,
      );
      expect(filtered.map((h) => h.name)).toEqual(['TH26-01', 'TH26-05']);
      const inB = testHoleListResponseSchema.parse(
        (await get(`/api/projects/${projectB}/test-holes?q=th26`, cookies.lab!)).body,
      );
      // Either spelling may have won the simultaneous-create race above.
      expect(inB.map((h) => h.name.toUpperCase())).toEqual(['TH26-01', 'TH26-09']);
    });

    it('404s for an unknown project and 400s for a malformed ID', async () => {
      const unknown = '00000000-0000-4000-8000-00000000ffff';
      expect((await get(`/api/projects/${unknown}/test-holes`, cookies.tech!)).status).toBe(404);
      expect(
        (await post(`/api/projects/${unknown}/test-holes`, cookies.tech!, { name: 'TH-1' })).status,
      ).toBe(404);
      expect((await get('/api/projects/not-a-uuid/test-holes', cookies.tech!)).status).toBe(400);
    });
  });

  it('lists active staff (not LAB, pending or disabled) for PM/PE and receiver pickers', async () => {
    const response = await get('/api/staff/active', cookies.lab!);
    expect(response.status).toBe(200);
    const ids = staffOptionsResponseSchema.parse(response.body).map((s) => s.id);
    expect(ids.sort()).toEqual([users.pe, users.tech].sort());
  });
});
