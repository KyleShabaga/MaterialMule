import type { INestApplication } from '@nestjs/common';
import {
  recentlyReceivedQuerySchema,
  recentlyReceivedResponseSchema,
  type RecentlyReceivedQuery,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  insertSummary,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { dashboardDates, queryRecentlyReceived, type DashboardDates } from './recently-received.js';

describe('dashboardDates', () => {
  it('counts the week from Monday and uses the business time zone for today', () => {
    // 05:00 UTC on Monday Oct 26 is still Sunday evening in Edmonton.
    expect(dashboardDates(new Date('2026-10-26T05:00:00Z'), 'America/Edmonton')).toEqual({
      today: '2026-10-25',
      weekStart: '2026-10-19',
      labelsSince: '2026-09-25',
    });
    expect(dashboardDates(new Date('2026-10-26T18:00:00Z'), 'America/Edmonton')).toEqual({
      today: '2026-10-26',
      weekStart: '2026-10-26',
      labelsSince: '2026-09-26',
    });
    // Across a month boundary.
    expect(dashboardDates(new Date('2026-11-01T18:00:00Z'), 'America/Edmonton').weekStart).toBe(
      '2026-10-26',
    );
  });
});

// Fictional data only: projects DEMO-2601 / DEMO-2602, test holes TH26-01 / TH26-02.
describe.runIf(testDatabaseUrl)('GET /api/inventory/recently-received', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  let at: string;
  let pending: string;
  let receiving: string;
  const projects: Record<string, string> = {};
  const holes: Record<string, string> = {};
  let sequence = 0;

  // Today is Tuesday 2026-10-27: the week started Monday 2026-10-26.
  const DATES: DashboardDates = {
    today: '2026-10-27',
    weekStart: '2026-10-26',
    labelsSince: '2026-09-27',
  };

  async function addUnit(
    project: string,
    receivedDate: string,
    options: { confirmedAt?: string; status?: string } = {},
  ): Promise<{ id: string; readableId: string }> {
    sequence += 1;
    const readableId = `BKT-2026-${String(sequence).padStart(6, '0')}`;
    const receiptId = await insertReceipt(db.pool, projects[project]!, at);
    await db.pool.query(`UPDATE receipt SET received_date = $2, confirmed_at = $3 WHERE id = $1`, [
      receiptId,
      receivedDate,
      options.confirmedAt ?? `${receivedDate}T20:00:00Z`,
    ]);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date, status)
       VALUES ($1, 'BKT', 2026, 'bucket', $2, $3, 'bucket', 'bucket', $4, $5, $6) RETURNING id`,
      [
        readableId,
        receiptId,
        projects[project]!,
        receiving,
        receivedDate,
        options.status ?? 'in_stock',
      ],
    );
    const id = rows[0]!.id;
    await insertSummary(
      db.pool,
      { storageUnitId: id, projectId: projects[project]!, testHoleId: holes[project]! },
      { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
    );
    return { id, readableId };
  }

  async function addPrintJob(
    storageUnitId: string,
    status: 'queued' | 'sent' | 'failed' | 'uncertain',
    options: { minutesAgo?: number; confirmed?: boolean; attempts?: number } = {},
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id, status,
                              attempts, sent_at, physically_confirmed_at,
                              physically_confirmed_by_user_id, created_at)
       VALUES ('initial', 'receiving', 'v1', $1, $2, $3,
               CASE WHEN $2 = 'sent' THEN now() END,
               CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN $1::uuid END,
               now() - make_interval(mins => $5))
       RETURNING id`,
      [at, status, options.attempts ?? 1, options.confirmed ?? false, options.minutesAgo ?? 0],
    );
    await db.pool.query(
      `INSERT INTO print_job_item (print_job_id, storage_unit_id, position) VALUES ($1, $2, 1)`,
      [rows[0]!.id, storageUnitId],
    );
  }

  const run = (query: Partial<RecentlyReceivedQuery> = {}) =>
    queryRecentlyReceived(db.pool, recentlyReceivedQuerySchema.parse(query), DATES);

  const units: Record<string, { id: string; readableId: string }> = {};

  beforeAll(async () => {
    db = await createMigratedSchema();
    receiving = await receivingLabId(db.pool);
    at = await insertUser(db.pool, 'AT');
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('New Starter', 'personal', 'pending') RETURNING id`,
    );
    pending = rows[0]!.id;
    projects.p1 = await insertProject(db.pool, 'DEMO-2601', at);
    projects.p2 = await insertProject(db.pool, 'DEMO-2602', at);
    holes.p1 = await insertTestHole(db.pool, projects.p1, 'TH26-01');
    holes.p2 = await insertTestHole(db.pool, projects.p2, 'TH26-02');
    await db.pool.query(
      `INSERT INTO printer (key, name, host, enabled) VALUES ('receiving', 'Receiving', '127.0.0.1', false)`,
    );

    // Oldest first, so readable IDs grow with time like real issue.
    units.old = await addUnit('p1', '2026-09-01'); // sent, unconfirmed, but too old to check
    units.lastWeek = await addUnit('p2', '2026-10-22');
    units.monday = await addUnit('p1', '2026-10-26');
    units.disposed = await addUnit('p1', '2026-10-27', { status: 'disposed' });
    units.today1 = await addUnit('p1', '2026-10-27', { confirmedAt: '2026-10-27T20:32:00Z' });
    units.today2 = await addUnit('p2', '2026-10-27');

    await addPrintJob(units.old.id, 'sent');
    await addPrintJob(units.lastWeek.id, 'uncertain');
    // Monday's unit failed first, then a reprint was sent and confirmed: the newest job counts.
    await addPrintJob(units.monday.id, 'failed', { minutesAgo: 30, attempts: 3 });
    await addPrintJob(units.monday.id, 'sent', { minutesAgo: 5, confirmed: true });
    await addPrintJob(units.disposed.id, 'sent');
    await addPrintJob(units.today1.id, 'sent');
    // today2 has no print job yet.

    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('lists the newest current units first with receiver, summaries and latest print', async () => {
    const result = await run();
    expect(result.items.map((item) => item.readableId)).toEqual([
      units.today2!.readableId,
      units.today1!.readableId,
      units.monday!.readableId,
      units.lastWeek!.readableId,
      units.old!.readableId,
    ]);
    expect(result.total).toBe(5);
    expect(result.receivedThisWeek).toBe(3);
    expect(result.labelsToCheck).toBe(2);

    const today1 = result.items[1]!;
    expect(today1).toMatchObject({
      receivedDate: '2026-10-27',
      receivedAt: '2026-10-27T20:32:00.000Z',
      receiver: { initials: 'AT', name: 'Test AT' },
      project: { projectNumber: 'DEMO-2601' },
      location: { id: receiving },
      holes: [{ testHoleName: 'TH26-01', type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' }],
      latestPrint: { status: 'sent', attempts: 1, physicallyConfirmedAt: null },
    });
    expect(result.items[0]!.latestPrint).toBeNull();
    expect(result.items[2]!.latestPrint).toMatchObject({ status: 'sent' });
    expect(result.items[2]!.latestPrint!.physicallyConfirmedAt).not.toBeNull();
  });

  it('limits the list but not the total', async () => {
    const result = await run({ limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  it('Today shows only units received today', async () => {
    const result = await run({ show: 'today' });
    expect(result.items.map((item) => item.readableId)).toEqual([
      units.today2!.readableId,
      units.today1!.readableId,
    ]);
    expect(result.total).toBe(2);
  });

  it('Labels to check shows recent units whose newest label was sent or uncertain, unconfirmed', async () => {
    const result = await run({ show: 'labels' });
    expect(result.items.map((item) => item.readableId)).toEqual([
      units.today1!.readableId,
      units.lastWeek!.readableId,
    ]);
    expect(result.total).toBe(2);
    expect(result.items[1]!.latestPrint).toMatchObject({ status: 'uncertain' });
  });

  async function cookieFor(userId: string, type: 'personal' | 'shared_lab' = 'personal') {
    const session = await sessions.create(userId, type);
    return `${SESSION_COOKIE}=${session.token}`;
  }

  it('serves the response over HTTP to active staff', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/inventory/recently-received')
      .query({ show: 'all', limit: '3' })
      .set('Cookie', await cookieFor(at));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = recentlyReceivedResponseSchema.parse(response.body);
    expect(body.items).toHaveLength(3);
  });

  it('refuses anonymous and pending sessions and rejects bad parameters', async () => {
    const http = () => request(app.getHttpServer());
    expect((await http().get('/api/inventory/recently-received')).status).toBe(401);
    expect(
      (
        await http()
          .get('/api/inventory/recently-received')
          .set('Cookie', await cookieFor(pending))
      ).status,
    ).toBe(403);
    const cookie = await cookieFor(at);
    for (const query of [{ show: 'mine' }, { limit: '21' }, { limit: '0' }]) {
      const response = await http()
        .get('/api/inventory/recently-received')
        .query(query)
        .set('Cookie', cookie);
      expect(response.status, JSON.stringify(query)).toBe(400);
    }
  });
});
