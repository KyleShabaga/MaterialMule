import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { runSeed } from '../db/seed.js';
import { createMigratedSchema, databaseUrlForSchema, type TestSchema } from './database.js';
import {
  insertProject,
  insertReceipt,
  insertSummary,
  insertTestHole,
  receivingLabId,
  type SummaryInput,
} from './fixtures.js';

// Shared set-up for lab catalogue / program / worklist integration tests (MM-T23, MM-T24).
// Fictional data only: DEMO-2601 (A) and DEMO-2602 (B), test holes TH26-01 / TH26-02.

export const LAB_ID = '00000000-0000-4000-8000-000000000001';

export type PersonKey = 'lm' | 'tech' | 'pe' | 'admin' | 'js' | 'jo' | 'noInitials' | 'disabled';

export interface LabHarness {
  db: TestSchema;
  app: INestApplication;
  users: Record<PersonKey | 'lab', string>;
  projects: { a: string; b: string };
  holes: { a1: string; a2: string; b1: string };
  /** A fresh session cookie (each call is a separate "workstation"). */
  cookie(key: PersonKey | 'lab'): Promise<string>;
  http(): ReturnType<typeof request>;
  get(path: string, as: PersonKey | 'lab' | string): Promise<request.Response>;
  send(
    method: 'post' | 'patch',
    path: string,
    body: unknown,
    as: PersonKey | 'lab' | string,
  ): Promise<request.Response>;
  /** An ordinary bucket with one hole summary, received on `receivedDate`. */
  bucket(options: {
    project?: 'a' | 'b';
    hole: string;
    summary?: SummaryInput;
    receivedDate?: string;
  }): Promise<{ id: string; readableId: string; receiptId: string }>;
  /** A Shelby tube with its own source (test hole or standalone text). */
  tube(options: {
    project?: 'a' | 'b';
    holeId?: string;
    location?: string;
    sampleReference?: string;
  }): Promise<{ id: string; readableId: string }>;
  /** A bulk-sample group with `buckets` member buckets. */
  bulkGroup(options: {
    project?: 'a' | 'b';
    holeId?: string;
    location?: string;
    sampleReference: string;
    depthFrom: number;
    buckets: number;
  }): Promise<{ groupId: string; members: { id: string; readableId: string }[] }>;
  /** Adds one more bucket to an existing group (a later receipt joining it). */
  joinGroup(groupId: string, project?: 'a' | 'b'): Promise<{ id: string; readableId: string }>;
  /** A catalogue entry in Soils, made through the API as the Lab Manager. */
  testType(
    code: string,
    description: string,
    name?: string | null,
  ): Promise<{ id: string; version: number }>;
  close(): Promise<void>;
}

export async function createLabHarness(): Promise<LabHarness> {
  const db = await createMigratedSchema();
  await runSeed(db.pool, 'reference', 'test');
  const locationId = await receivingLabId(db.pool);

  const users = { lab: LAB_ID } as LabHarness['users'];
  const people: [PersonKey, string, string | null, string, string[]][] = [
    ['lm', 'Lee Manager', 'LM', 'active', ['lab_manager']],
    ['tech', 'Alex Tester', 'AT', 'active', []],
    ['pe', 'Pat Example', 'PE', 'active', []],
    ['admin', 'Admin Example', 'ADM', 'active', ['admin']],
    ['js', 'Jordan Smith', 'JS', 'active', []],
    ['jo', 'Jamie Song', 'JSO', 'active', []],
    ['noInitials', 'No Initials', null, 'active', []],
    ['disabled', 'Former Staff', 'FS', 'disabled', []],
  ];
  for (const [key, name, initials, status, roles] of people) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', $3) RETURNING id`,
      [name, initials, status],
    );
    users[key] = rows[0]!.id;
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        users[key],
        role,
      ]);
    }
  }

  const projects = {
    a: await insertProject(db.pool, 'DEMO-2601', users.pe),
    b: await insertProject(db.pool, 'DEMO-2602', users.pe),
  };
  const holes = {
    a1: await insertTestHole(db.pool, projects.a, 'TH26-01'),
    a2: await insertTestHole(db.pool, projects.a, 'TH26-02'),
    b1: await insertTestHole(db.pool, projects.b, 'TH26-01'),
  };

  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: databaseUrlForSchema(db.schema),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const sessions = app.get(SessionService);

  let sequence = 0;
  const nextId = (prefix: string) => {
    sequence += 1;
    return `${prefix}-2026-${String(sequence).padStart(6, '0')}`;
  };

  async function newUnit(
    project: 'a' | 'b',
    kind: 'bucket' | 'shelby_tube' | 'bulk',
    receivedDate = '2026-10-23',
    extra: Record<string, unknown> = {},
  ) {
    const prefix = kind === 'shelby_tube' ? 'ST' : 'BKT';
    const holder = kind === 'shelby_tube' ? 'shelby_tube' : 'bucket';
    const unitType = kind === 'bulk' ? 'bulk_container' : kind;
    const readableId = nextId(prefix);
    const receiptId = await insertReceipt(db.pool, projects[project], users.tech);
    const columns = Object.keys(extra);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date, receipt_line
                                 ${columns.map((c) => `, ${c}`).join('')})
       VALUES ($1, $2, 2026, $3, $4, $5, $6, $3, $7, $8, 1
               ${columns.map((_, i) => `, $${i + 9}`).join('')})
       RETURNING id`,
      [
        readableId,
        prefix,
        holder,
        receiptId,
        projects[project],
        unitType,
        locationId,
        receivedDate,
        ...Object.values(extra),
      ],
    );
    return { id: rows[0]!.id, readableId, receiptId };
  }

  const harness: LabHarness = {
    db,
    app,
    users,
    projects,
    holes,
    async cookie(key) {
      const session = await sessions.create(users[key], key === 'lab' ? 'shared_lab' : 'personal');
      return `${SESSION_COOKIE}=${session.token}`;
    },
    http: () => request(app.getHttpServer()),
    async get(path, as) {
      const cookie = as.startsWith(SESSION_COOKIE) ? as : await harness.cookie(as as PersonKey);
      return request(app.getHttpServer()).get(path).set('Cookie', cookie);
    },
    async send(method, path, body, as) {
      const cookie = as.startsWith(SESSION_COOKIE) ? as : await harness.cookie(as as PersonKey);
      return request(app.getHttpServer())
        [method](path)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .send(body as object);
    },
    async bucket({ project = 'a', hole, summary = { type: 'all' }, receivedDate }) {
      const unit = await newUnit(project, 'bucket', receivedDate);
      await insertSummary(
        db.pool,
        { storageUnitId: unit.id, projectId: projects[project], testHoleId: hole },
        summary,
      );
      return unit;
    },
    async tube({ project = 'a', holeId, location, sampleReference }) {
      return newUnit(project, 'shelby_tube', undefined, {
        source_type: holeId ? 'test_hole' : 'standalone_location',
        source_test_hole_id: holeId ?? null,
        source_location_reference: holeId ? null : (location ?? 'Embankment Location 03'),
        sample_reference: sampleReference ?? null,
      });
    },
    async bulkGroup({ project = 'a', holeId, location, sampleReference, depthFrom, buckets }) {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO bulk_group (project_id, source_type, test_hole_id, source_location_reference,
                                 sample_reference, depth_from, depth_unit, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'm', $7) RETURNING id`,
        [
          projects[project],
          holeId ? 'test_hole' : 'standalone_location',
          holeId ?? null,
          holeId ? null : (location ?? 'Stockpile 2'),
          sampleReference,
          depthFrom,
          users.tech,
        ],
      );
      const groupId = rows[0]!.id;
      const members = [];
      for (let i = 0; i < buckets; i += 1) members.push(await harness.joinGroup(groupId, project));
      return { groupId, members };
    },
    async joinGroup(groupId, project = 'a') {
      return newUnit(project, 'bulk', undefined, { bulk_group_id: groupId });
    },
    async testType(code, description, name = null) {
      const response = await harness.send(
        'post',
        '/api/test-types',
        { groupId: '00000000-0000-4000-8000-00000000c101', code, description, name },
        'lm',
      );
      if (response.status !== 201) {
        throw new Error(`test type ${code}: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return { id: response.body.id as string, version: response.body.version as number };
    },
    async close() {
      await app.close();
      await db.drop();
    },
  };
  return harness;
}

/** A draft line body. */
export function line(
  source: { kind: 'test_hole' | 'standalone_unit' | 'standalone_bulk_group'; id: string } | null,
  scope: 'all' | 'grabs' | 'spt' | 'specific',
  testTypeIds: string[],
  extra: Record<string, unknown> = {},
) {
  return { source, scope, testTypeIds, ...extra };
}

export const newKey = () => randomUUID();
