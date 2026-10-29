import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  confirmReceiptResponseSchema,
  formatStorageUnitHoleSummary,
  inventoryPageSchema,
  meResponseSchema,
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  type InventoryPage,
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
import {
  insertProject,
  insertReceipt,
  insertSummary,
  insertTestHole,
  receivingLabId,
  type SummaryInput,
} from '../test-support/fixtures.js';

// Fictional data only: projects DEMO-2601 / DEMO-2602, test holes TH26-01 / TH26-02.
describe.runIf(testDatabaseUrl)('inventory, lookup and detail API (MM-T12)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  const users: Record<string, string> = {};
  const locations: Record<string, string> = {};
  const projects: Record<string, string> = {};
  const holes: Record<string, string> = {};
  let sequence = 0;

  async function addUser(
    key: string,
    name: string,
    initials: string | null,
    accountType: 'personal' | 'shared_lab',
    status: 'active' | 'pending' = 'active',
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, initials, accountType, status],
    );
    users[key] = rows[0]!.id;
  }

  async function cookieFor(key: string) {
    const session = await sessions.create(users[key]!, key === 'lab' ? 'shared_lab' : 'personal');
    return `${SESSION_COOKIE}=${session.token}`;
  }

  async function addLocation(key: string, code: string, name: string) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [code, name],
    );
    locations[key] = rows[0]!.id;
  }

  interface UnitSpec {
    project: string;
    holes: [string, SummaryInput & { note?: string }][];
    location?: string;
    receivedDate?: string;
    status?: 'in_stock' | 'approved_for_disposal' | 'disposed';
    note?: string;
    readableId?: string;
    unitType?: 'bucket' | 'shelby_tube';
    /** Defaults to a new receipt for this unit alone. */
    receiptId?: string;
  }

  /** Inserts one unit directly (the receipt API is exercised separately in AC7). */
  async function addUnit(spec: UnitSpec): Promise<string> {
    sequence += 1;
    const unitType = spec.unitType ?? 'bucket';
    const prefix = unitType === 'bucket' ? 'BKT' : 'ST';
    const readableId = spec.readableId ?? `${prefix}-2025-${String(sequence).padStart(6, '0')}`;
    const projectId = projects[spec.project]!;
    const receiptId = spec.receiptId ?? (await insertReceipt(db.pool, projectId, users.at!));
    await db.pool.query(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date, status, note)
       VALUES ($1, $2, $3, $4, $5, $6, $4, $4, $7, $8, $9, $10)`,
      [
        readableId,
        prefix,
        Number(readableId.split('-')[1]),
        unitType,
        receiptId,
        projectId,
        locations[spec.location ?? 'receiving']!,
        spec.receivedDate ?? '2026-10-15',
        spec.status ?? 'in_stock',
        spec.note ?? null,
      ],
    );
    const { rows } = await db.pool.query<{ id: string }>(
      'SELECT id FROM storage_unit WHERE readable_id = $1',
      [readableId],
    );
    const storageUnitId = rows[0]!.id;
    for (const [hole, summary] of spec.holes) {
      const summaryId = await insertSummary(
        db.pool,
        { storageUnitId, projectId, testHoleId: holes[hole]! },
        summary,
      );
      if (summary.note) {
        await db.pool.query('UPDATE storage_unit_hole_summary SET note = $1 WHERE id = $2', [
          summary.note,
          summaryId,
        ]);
      }
    }
    return readableId;
  }

  const http = () => request(app.getHttpServer());

  async function inventory(query: Record<string, string>, as = 'at'): Promise<InventoryPage> {
    const response = await http()
      .get('/api/inventory')
      .query(query)
      .set('Cookie', await cookieFor(as));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return inventoryPageSchema.parse(response.body);
  }

  const ids = (page: InventoryPage) => page.items.map((item) => item.readableId);

  const ALL: SummaryInput = { type: 'all' };
  let warehouseA: string;
  let warehouseB: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    locations.receiving = await receivingLabId(db.pool);
    await addLocation('wh', 'WH-C2', 'Warehouse C2');
    await addLocation('bench', 'LB-1', 'Lab Bench 1');
    await addUser('lab', 'LAB', null, 'shared_lab');
    await addUser('at', 'Alex Tester', 'AT', 'personal');
    await addUser('pe', 'Pat Example', 'PE', 'personal');
    await addUser('pend', 'New Starter', null, 'personal', 'pending');

    projects.p1 = await insertProject(db.pool, 'DEMO-2601', users.pe!);
    projects.p2 = await insertProject(db.pool, 'DEMO-2602', users.pe!);
    await db.pool.query(
      `UPDATE project SET name = 'Hillside bridge', client = 'Sample Roads Ltd' WHERE id = $1`,
      [projects.p2],
    );
    projects.dates = await insertProject(db.pool, 'DEMO-2603', users.pe!);
    projects.paging = await insertProject(db.pool, 'DEMO-2690', users.pe!);
    holes.p1th1 = await insertTestHole(db.pool, projects.p1, 'TH26-01');
    holes.p1th2 = await insertTestHole(db.pool, projects.p1, 'TH26-02');
    holes.p2th1 = await insertTestHole(db.pool, projects.p2, 'TH26-01');
    holes.p2th2 = await insertTestHole(db.pool, projects.p2, 'TH26-02');
    holes.dates = await insertTestHole(db.pool, projects.dates, 'TH26-05');
    holes.paging = await insertTestHole(db.pool, projects.paging, 'TH26-09');

    // AC1 dataset: only A and C hold TH26-01 material in a warehouse.
    warehouseA = await addUnit({
      project: 'p1',
      holes: [['p1th1', { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' }]],
      location: 'wh',
    });
    await addUnit({ project: 'p1', holes: [['p1th1', ALL]] });
    warehouseB = await addUnit({ project: 'p2', holes: [['p2th1', ALL]], location: 'wh' });
    await addUnit({ project: 'p1', holes: [['p1th2', ALL]], location: 'wh' });
    await addUnit({
      project: 'p2',
      holes: [['p2th2', ALL]],
      note: 'Move to warehouse later',
    });

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

  it('AC1: "TH26-01 warehouse" returns only units matching both words, with the right count', async () => {
    for (const search of ['TH26-01 warehouse', 'th26-01 WAREHOUSE', 'warehouse   TH26-01']) {
      const page = await inventory({ search, sort: 'id' });
      expect(ids(page)).toEqual([warehouseA, warehouseB]);
      expect(page.total).toBe(2);
    }
    const page = await inventory({ search: 'TH26-01 warehouse', projectId: projects.p1! });
    expect(ids(page)).toEqual([warehouseA]);
    expect(page.items[0]).toMatchObject({
      readableId: warehouseA,
      unitType: 'bucket',
      status: 'in_stock',
      project: { projectNumber: 'DEMO-2601', client: 'Example Client' },
      location: { code: 'WH-C2', name: 'Warehouse C2' },
      receivedDate: '2026-10-15',
      holes: [{ testHoleName: 'TH26-01', type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' }],
    });
  });

  it('T2: finds units by each searchable field', async () => {
    const unit = await addUnit({
      project: 'p2',
      holes: [
        ['p2th1', { type: 'custom', customText: 'Bag of fines', note: 'Seal checked' }],
        ['p2th2', { type: 'depth_range', depthFrom: 1.5, depthTo: 3, depthUnit: 'm' }],
      ],
      location: 'bench',
      note: 'Cracked lid',
    });
    const expectations: [string, boolean][] = [
      [unit.toLowerCase(), true], // storage unit ID
      ['demo-2602 cracked', true], // project number + unit note
      ['hillside cracked', true], // project name
      ['sample roads cracked', true], // client
      ['th26-02 cracked', true], // test-hole name
      ['fines', true], // Custom summary text
      ['seal checked', true], // summary note
      ['1.5 cracked', true], // depth summary
      ['bench cracked', true], // location name
      ['lb-1 cracked', true], // location code
      ['cracked warehouse', false], // every word must match
    ];
    for (const [search, matches] of expectations) {
      const page = await inventory({ search, status: 'all' });
      expect(ids(page).includes(unit), search).toBe(matches);
    }
    // Sample ranges match by either end or the typed range.
    expect(ids(await inventory({ search: 'g1-s12' }))).toEqual([warehouseA]);
    expect(ids(await inventory({ search: 's12' }))).toEqual([warehouseA]);
    // LIKE wildcards are literal.
    expect((await inventory({ search: '%' })).total).toBe(0);
  });

  it('MM-T59 T1/T2: finds a summary as displayed, with an en dash, hyphen, minus sign or spaces', async () => {
    projects.dash = await insertProject(db.pool, 'DEMO-2604', users.pe!);
    holes.dash1 = await insertTestHole(db.pool, projects.dash, 'TH26-01');
    holes.dash2 = await insertTestHole(db.pool, projects.dash, 'TH26-02');
    const sampleUnit = await addUnit({
      project: 'dash',
      holes: [['dash1', { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S10' }]],
    });
    const depthUnit = await addUnit({
      project: 'dash',
      holes: [['dash1', { type: 'depth_range', depthFrom: 3, depthTo: 5, depthUnit: 'ft' }]],
    });
    const customUnit = await addUnit({
      project: 'dash',
      holes: [['dash2', { type: 'custom', customText: 'Lot A–B fines' }]],
    });
    const search = async (text: string) =>
      ids(await inventory({ search: text, projectId: projects.dash!, sort: 'id' }));

    // Exactly as the table shows it, the summary alone and with its test hole (AC1).
    const page = await inventory({ search: 'G1', projectId: projects.dash! });
    const shown = page.items.flatMap((item) =>
      item.holes.map((hole) => `${hole.testHoleName}: ${formatStorageUnitHoleSummary(hole)}`),
    );
    expect(shown).toEqual(['TH26-01: G1–S10']);
    for (const text of ['G1–S10', 'TH26-01: G1–S10', 'G1-S10', 'G1−S10', 'G1 S10', 'G1 – S10']) {
      expect(await search(text), text).toEqual([sampleUnit]);
    }
    for (const text of ['3–5 ft', 'TH26-01: 3–5 ft', '3-5 ft', '3−5 ft', '3 5 ft', '3 – 5 ft']) {
      expect(await search(text), text).toEqual([depthUnit]);
    }
    // Custom text keeps whichever dash was typed; any dash finds it.
    for (const text of ['Lot A–B', 'a-b fines', 'TH26-02: Lot A—B fines']) {
      expect(await search(text), text).toEqual([customUnit]);
    }
    // Ranges still match by either end, and other ranges don't match.
    expect(await search('S10')).toEqual([sampleUnit]);
    expect(await search('G1–S12')).toEqual([]);
    expect(await search('3–6 ft')).toEqual([]);
  });

  it('keeps search current when a project, test hole or location is renamed', async () => {
    const unit = await addUnit({ project: 'p1', holes: [['p1th2', ALL]], note: 'rename-check' });
    await db.pool.query(`UPDATE location SET name = 'Receiving bay' WHERE id = $1`, [
      locations.receiving,
    ]);
    expect(ids(await inventory({ search: 'rename-check bay' }))).toEqual([unit]);
    await db.pool.query(`UPDATE location SET name = 'Receiving lab' WHERE id = $1`, [
      locations.receiving,
    ]);
    expect((await inventory({ search: 'rename-check bay' })).total).toBe(0);
  });

  it('AC2 (T3): received-date filter includes both boundary dates', async () => {
    const dates = ['2026-09-30', '2026-10-01', '2026-10-12', '2026-10-23', '2026-10-24'];
    const byDate: Record<string, string> = {};
    for (const receivedDate of dates) {
      byDate[receivedDate] = await addUnit({
        project: 'dates',
        holes: [['dates', ALL]],
        receivedDate,
      });
    }
    const page = await inventory({
      projectId: projects.dates!,
      receivedFrom: '2026-10-01',
      receivedTo: '2026-10-23',
      sort: 'received',
      dir: 'asc',
    });
    expect(ids(page)).toEqual([byDate['2026-10-01'], byDate['2026-10-12'], byDate['2026-10-23']]);
    expect(page.total).toBe(3);
    // Test hole within the project combines too.
    expect(
      (
        await inventory({
          projectId: projects.dates!,
          testHoleId: holes.dates!,
          receivedTo: '2026-09-30',
        })
      ).total,
    ).toBe(1);
  });

  it('AC3: a disposed unit is hidden from Current stock but shown under Disposed and All', async () => {
    const disposed = await addUnit({
      project: 'p1',
      holes: [['p1th1', ALL]],
      status: 'disposed',
      note: 'gone-unit',
    });
    const approved = await addUnit({
      project: 'p1',
      holes: [['p1th1', ALL]],
      status: 'approved_for_disposal',
      note: 'gone-unit',
    });
    expect(ids(await inventory({ search: 'gone-unit' }))).toEqual([approved]);
    expect(ids(await inventory({ search: 'gone-unit', status: 'current' }))).toEqual([approved]);
    expect(ids(await inventory({ search: 'gone-unit', status: 'disposed' }))).toEqual([disposed]);
    const all = await inventory({ search: 'gone-unit', status: 'all', sort: 'id' });
    expect(ids(all).sort()).toEqual([approved, disposed].sort());
    expect(all.items.find((item) => item.readableId === disposed)?.status).toBe('disposed');
  });

  it('filters by type and location', async () => {
    const tube = await addUnit({
      project: 'p2',
      holes: [['p2th1', ALL]],
      unitType: 'shelby_tube',
      location: 'bench',
    });
    expect(ids(await inventory({ type: 'shelby_tube' }))).toEqual([tube]);
    const atBench = await inventory({ locationId: locations.bench!, type: 'shelby_tube' });
    expect(ids(atBench)).toEqual([tube]);
    expect((await inventory({ locationId: locations.wh!, type: 'shelby_tube' })).total).toBe(0);
  });

  it('filters by receipt, including disposed units under All statuses', async () => {
    const receiptId = await insertReceipt(db.pool, projects.p2!, users.at!);
    const kept = await addUnit({ project: 'p2', holes: [['p2th1', ALL]], receiptId });
    const gone = await addUnit({
      project: 'p2',
      holes: [['p2th1', ALL]],
      receiptId,
      status: 'disposed',
    });
    await addUnit({ project: 'p2', holes: [['p2th1', ALL]] });
    const all = await inventory({ receiptId, status: 'all', sort: 'id' });
    expect(ids(all)).toEqual([kept, gone].sort());
    expect(ids(await inventory({ receiptId }))).toEqual([kept]);
    expect(ids(await inventory({ receiptId, status: 'all' }, 'lab')).sort()).toEqual(
      [kept, gone].sort(),
    );

    const bad = await http()
      .get('/api/inventory?receiptId=not-a-uuid')
      .set('Cookie', await cookieFor('at'));
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ field: 'receiptId' })],
    });
    expect(JSON.stringify(bad.body)).not.toContain('not-a-uuid');

    const path = `/api/inventory?receiptId=${receiptId}&status=all`;
    expect((await http().get(path)).status).toBe(401);
    expect(
      (
        await http()
          .get(path)
          .set('Cookie', await cookieFor('pend'))
      ).status,
    ).toBe(403);
  });

  it('AC5 (T4): 120 units with equal received dates page at 25 without overlap or gaps', async () => {
    const created: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      created.push(
        await addUnit({ project: 'paging', holes: [['paging', ALL]], receivedDate: '2026-10-20' }),
      );
    }
    for (const sort of [
      { sort: 'received', dir: 'desc' },
      { sort: 'received', dir: 'asc' },
      { sort: 'id', dir: 'asc' },
    ]) {
      const seen: string[] = [];
      for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
        const page = await inventory({
          projectId: projects.paging!,
          ...sort,
          page: String(pageNumber),
          pageSize: '25',
        });
        expect(page.total).toBe(120);
        expect(page.items.length).toBe(pageNumber === 5 ? 20 : 25);
        seen.push(...ids(page));
      }
      expect(new Set(seen).size).toBe(120);
      const expected = [...created].sort();
      expect(seen).toEqual(sort.dir === 'desc' ? expected.reverse() : expected);
    }
    // Past the end: empty page, same total.
    const beyond = await inventory({ projectId: projects.paging!, page: '6' });
    expect(beyond).toMatchObject({ items: [], total: 120, page: 6 });
    // 120 serial inserts plus 16 page reads: ~2–3 s on CI, over 5 s on a slow runner.
  }, 30_000);

  it('never returns more than 100 rows and rejects bad parameters with field errors', async () => {
    const cookie = await cookieFor('at');
    const tooBig = await http().get('/api/inventory?pageSize=500').set('Cookie', cookie);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body).toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ field: 'pageSize' })],
    });
    const badDate = await http().get('/api/inventory?receivedFrom=yesterday').set('Cookie', cookie);
    expect(badDate.status).toBe(400);
    expect(JSON.stringify(badDate.body)).not.toContain('yesterday');
    expect((await inventory({ pageSize: '100', status: 'all' })).items.length).toBeLessThanOrEqual(
      100,
    );
  });

  it('AC4 (T5): lookup trims and upper-cases; unknown IDs are 404', async () => {
    const known = await addUnit({
      project: 'p1',
      holes: [['p1th1', ALL]],
      readableId: 'BKT-2026-000014',
    });
    const cookie = await cookieFor('at');
    const found = await http()
      .get('/api/storage-units/lookup')
      .query({ code: 'bkt-2026-000014 ' })
      .set('Cookie', cookie);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ readableId: known });

    for (const code of ['BKT-2026-999999', '', 'not an id']) {
      const missing = await http()
        .get('/api/storage-units/lookup')
        .query({ code })
        .set('Cookie', cookie);
      expect(missing.status, code).toBe(404);
      expect(missing.body).toMatchObject({ code: 'storage_unit_not_found' });
    }
    const noCode = await http().get('/api/storage-units/lookup').set('Cookie', cookie);
    expect(noCode.status).toBe(400);

    const detail = await http().get('/api/storage-units/bkt-2026-000014').set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.readableId).toBe('BKT-2026-000014');
    const unknown = await http().get('/api/storage-units/BKT-2026-999999').set('Cookie', cookie);
    expect(unknown.status).toBe(404);
  });

  it('AC7: detail shows the receiver snapshot, account, every summary and the audit history', async () => {
    const lab = await cookieFor('lab');
    const confirm = await http()
      .post('/api/receipts')
      .set('Cookie', lab)
      .set(CSRF_HEADER, '1')
      .send({
        idempotencyKey: randomUUID(),
        projectId: projects.p1,
        receivedDate: '2026-01-15',
        receiverUserId: users.at,
        description: 'Mixed-hole bucket',
        units: [
          {
            clientRowId: 'row-a',
            unitType: 'bucket',
            note: 'Lid taped',
            holeSummaries: [
              { testHoleId: holes.p1th1, type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
              {
                testHoleId: holes.p1th2,
                type: 'depth_range',
                depthFrom: 0,
                depthTo: 1.5,
                depthUnit: 'm',
                note: 'Wet',
              },
            ],
          },
        ],
      });
    expect(confirm.status).toBe(201);
    const suNumber = confirmReceiptResponseSchema.parse(confirm.body).units[0]!.suNumber;

    // Renaming the receiver later never changes the snapshot.
    await db.pool.query(`UPDATE app_user SET display_name = 'Alex Renamed' WHERE id = $1`, [
      users.at,
    ]);

    const response = await http().get(`/api/storage-units/${suNumber}`).set('Cookie', lab);
    expect(response.status).toBe(200);
    const detail = storageUnitDetailSchema.parse(response.body);
    expect(detail).toMatchObject({
      readableId: suNumber,
      unitType: 'bucket',
      status: 'in_stock',
      note: 'Lid taped',
      receivedDate: '2026-01-15',
      project: { projectNumber: 'DEMO-2601', name: 'Fictional project', client: 'Example Client' },
      location: { name: 'Receiving lab' },
      receipt: {
        receivedDate: '2026-01-15',
        receiver: { initials: 'AT', name: 'Alex Tester' },
        account: { name: 'LAB' },
        description: 'Mixed-hole bucket',
        quantity: 1,
      },
    });
    expect(detail.holes).toEqual([
      expect.objectContaining({ testHoleName: 'TH26-01', sampleFrom: 'G1', sampleTo: 'S12' }),
      expect.objectContaining({
        testHoleName: 'TH26-02',
        depthFrom: 0,
        depthTo: 1.5,
        depthUnit: 'm',
        note: 'Wet',
      }),
    ]);

    const history = await http().get(`/api/storage-units/${detail.id}/history`).set('Cookie', lab);
    expect(history.status).toBe(200);
    const events = storageUnitHistoryPageSchema.parse(history.body);
    expect(events).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(events.items.map((event) => event.action).sort()).toEqual([
      'receipt.confirmed',
      'storage_unit.created',
    ]);
    for (const event of events.items) {
      expect(event.actor).toMatchObject({ name: 'LAB', accountType: 'shared_lab' });
      expect(event.receiver).toMatchObject({ initials: 'AT' });
    }
    const page2 = await http()
      .get(`/api/storage-units/${suNumber}/history?page=2`)
      .set('Cookie', lab);
    expect(page2.body).toMatchObject({ items: [], total: 2, page: 2 });
  });

  it('AC6: LAB can search, filter and read details but holds no edit permission', async () => {
    const lab = await cookieFor('lab');
    expect((await inventory({ search: 'TH26-01 warehouse', type: 'bucket' }, 'lab')).total).toBe(2);
    expect((await http().get(`/api/storage-units/${warehouseA}`).set('Cookie', lab)).status).toBe(
      200,
    );
    expect(
      (await http().get(`/api/storage-units/${warehouseA}/history`).set('Cookie', lab)).status,
    ).toBe(200);
    const locationList = await http().get('/api/locations').set('Cookie', lab);
    expect(locationList.status).toBe(200);
    expect(locationList.body.map((l: { code: string }) => l.code)).toEqual(
      expect.arrayContaining(['RECEIVING', 'WH-C2', 'LB-1']),
    );
    const me = meResponseSchema.parse((await http().get('/api/me').set('Cookie', lab)).body);
    expect(me.permissions).toContain('inventory.read');
    expect(me.permissions).not.toContain('storage_unit.correct');
  });

  it('requires an active session', async () => {
    expect((await http().get('/api/inventory')).status).toBe(401);
    const pending = await cookieFor('pend');
    expect((await http().get('/api/inventory').set('Cookie', pending)).status).toBe(403);
    expect(
      (await http().get('/api/storage-units/lookup?code=x').set('Cookie', pending)).status,
    ).toBe(403);
  });
});
