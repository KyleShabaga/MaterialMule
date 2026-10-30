import type { INestApplication } from '@nestjs/common';
import {
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  type LabRequestLink,
  type StorageUnitDetail,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '../../auth/auth.guard.js';
import { SESSION_COOKIE } from '../../auth/session-cookie.js';
import { SessionService } from '../../auth/session.service.js';
import { loadConfig } from '../../config/env.js';
import { createApp } from '../../create-app.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertSummary,
  insertTestHole,
  receivingLabId,
} from '../../test-support/fixtures.js';
import { LAB_REQUEST_LINK_CHECKER, type LabRequestLinkChecker } from './lab-request-links.js';

// Fictional data only: projects DEMO-2601 (A) and DEMO-2602 (B), test holes TH26-01 / TH26-02.
describe.runIf(testDatabaseUrl)('storage unit corrections API (MM-T13)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  let warehouseId: string;
  const users: Record<string, string> = {};
  const projects: Record<string, string> = {};
  const holes: Record<string, string> = {};
  let sequence = 100;

  async function addUser(key: string, name: string, initials: string | null, lab = false) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [name, initials, lab ? 'shared_lab' : 'personal'],
    );
    users[key] = rows[0]!.id;
  }

  async function cookieFor(key: string) {
    const session = await sessions.create(users[key]!, key === 'lab' ? 'shared_lab' : 'personal');
    return `${SESSION_COOKIE}=${session.token}`;
  }

  /** A confirmed bucket in project A (received 2026-10-23) in Warehouse C2. */
  async function addUnit(
    options: { readableId?: string; unitType?: 'bucket' | 'shelby_tube' } = {},
  ): Promise<{ id: string; readableId: string }> {
    sequence += 1;
    const unitType = options.unitType ?? 'bucket';
    const prefix = unitType === 'bucket' ? 'BKT' : 'ST';
    const readableId = options.readableId ?? `${prefix}-2026-${String(sequence).padStart(6, '0')}`;
    const receiptId = await insertReceipt(db.pool, projects.a!, users.kcs!);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date, note, receipt_line)
       VALUES ($1, $2, 2026, $3, $4, $5, $3, $3, $6, '2026-10-23', 'Lid taped', 1)
       RETURNING id`,
      [readableId, prefix, unitType, receiptId, projects.a, warehouseId],
    );
    const id = rows[0]!.id;
    await insertSummary(
      db.pool,
      { storageUnitId: id, projectId: projects.a!, testHoleId: holes.a1! },
      { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
    );
    return { id, readableId };
  }

  const http = () => request(app.getHttpServer());

  async function patch(id: string, body: unknown, as = 'kcs') {
    return http()
      .patch(`/api/storage-units/${id}`)
      .set('Cookie', await cookieFor(as))
      .set(CSRF_HEADER, '1')
      .send(body as object);
  }

  async function detail(id: string): Promise<StorageUnitDetail> {
    const response = await http()
      .get(`/api/storage-units/${id}`)
      .set('Cookie', await cookieFor('kcs'));
    expect(response.status).toBe(200);
    return storageUnitDetailSchema.parse(response.body);
  }

  async function history(id: string) {
    const response = await http()
      .get(`/api/storage-units/${id}/history`)
      .set('Cookie', await cookieFor('kcs'));
    expect(response.status).toBe(200);
    return storageUnitHistoryPageSchema.parse(response.body);
  }

  async function correctedEvents(id: string): Promise<number> {
    const { rows } = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_event
       WHERE action = 'storage_unit.corrected' AND entity_id = $1`,
      [id],
    );
    return rows[0]!.count;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await receivingLabId(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ('WH-C2', 'Warehouse C2', 'warehouse')
       RETURNING id`,
    );
    warehouseId = rows[0]!.id;
    await addUser('kcs', 'Kim Example', 'KCS');
    await addUser('pe', 'Pat Example', 'PE');
    await addUser('lab', 'LAB', null, true);
    projects.a = await insertProject(db.pool, 'DEMO-2601', users.pe!);
    projects.b = await insertProject(db.pool, 'DEMO-2602', users.pe!);
    holes.a1 = await insertTestHole(db.pool, projects.a, 'TH26-01');
    holes.a2 = await insertTestHole(db.pool, projects.a, 'TH26-02');
    holes.b1 = await insertTestHole(db.pool, projects.b, 'TH26-01');
    holes.b2 = await insertTestHole(db.pool, projects.b, 'TH26-02');

    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(config);
    await app.init();
    // Listen once: parallel supertest requests on a non-listening server each call listen(0)
    // on the same server and can see a null address (flaky 'server.address() null').
    await app.listen(0, '127.0.0.1');
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('T2/AC1: a received-date correction keeps the ID and location and records history', async () => {
    const unit = await addUnit({ readableId: 'BKT-2026-000014' });
    const before = await detail(unit.readableId);
    expect(before).toMatchObject({ receivedDate: '2026-10-23', minimumRetainUntil: '2027-10-23' });

    const response = await patch(unit.readableId, {
      version: before.version,
      reason: 'wrong date on tag',
      changes: { receivedDate: '2026-10-21' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const corrected = storageUnitDetailSchema.parse(response.body);
    expect(corrected).toMatchObject({
      id: unit.id,
      readableId: 'BKT-2026-000014',
      receivedDate: '2026-10-21',
      minimumRetainUntil: '2027-10-21',
      version: before.version + 1,
      location: { code: 'WH-C2', name: 'Warehouse C2' },
      // The original receipt header is kept as recorded.
      receipt: { receivedDate: '2026-10-23', project: { projectNumber: 'DEMO-2601' } },
    });
    expect(await detail(unit.readableId)).toEqual(corrected);

    const events = await history(unit.id);
    const event = events.items[0]!;
    expect(event).toMatchObject({
      action: 'storage_unit.corrected',
      actor: { initials: 'KCS', name: 'Kim Example', accountType: 'personal' },
      reason: 'wrong date on tag',
      before: { receivedDate: '2026-10-23' },
      after: { receivedDate: '2026-10-21' },
    });
    expect(Object.keys(event.after!)).toEqual(['receivedDate']);
    expect(Date.parse(event.occurredAt)).not.toBeNaN();
  });

  it('T3/AC2: LAB gets 403 for any correction and nothing changes', async () => {
    const unit = await addUnit();
    const before = await detail(unit.id);
    for (const changes of [
      { receivedDate: '2026-10-21' },
      { note: 'Changed by LAB' },
      { projectId: projects.b, holeSummaries: [{ testHoleId: holes.b1, type: 'all' }] },
    ]) {
      const response = await patch(
        unit.id,
        { version: before.version, reason: 'LAB try', changes },
        'lab',
      );
      expect(response.status).toBe(403);
    }
    expect(await detail(unit.id)).toEqual(before);
    expect(await correctedEvents(unit.id)).toBe(0);
  });

  it('AC3: a save without a reason (or a too-short one) is rejected with a field error', async () => {
    const unit = await addUnit();
    const before = await detail(unit.id);
    const missing = await patch(unit.id, { version: before.version, changes: { note: 'x' } });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ field: 'reason' })],
    });
    const short = await patch(unit.id, {
      version: before.version,
      reason: '  ab  ',
      changes: { note: 'x' },
    });
    expect(short.status).toBe(400);
    expect(short.body.errors).toEqual([
      expect.objectContaining({ field: 'reason', message: 'must be at least 5 characters' }),
    ]);
    expect(await detail(unit.id)).toEqual(before);
    expect(await correctedEvents(unit.id)).toBe(0);
  });

  it('T4/AC4: a stale version gets 409 and the first change stays intact', async () => {
    const unit = await addUnit();
    const opened = await detail(unit.id);
    const first = await patch(unit.id, {
      version: opened.version,
      reason: 'note was for another bucket',
      changes: { note: 'First user note' },
    });
    expect(first.status).toBe(200);
    const second = await patch(
      unit.id,
      {
        version: opened.version,
        reason: 'second user edit',
        changes: { note: 'Second user note' },
      },
      'pe',
    );
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: 'version_conflict',
      currentVersion: opened.version + 1,
    });
    expect(await detail(unit.id)).toMatchObject({
      note: 'First user note',
      version: opened.version + 1,
    });
    expect(await correctedEvents(unit.id)).toBe(1);

    // Two saves racing on the same version: exactly one wins.
    const latest = await detail(unit.id);
    const results = await Promise.all(
      ['Race A', 'Race B'].map((note) =>
        patch(unit.id, { version: latest.version, reason: 'racing saves', changes: { note } }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await correctedEvents(unit.id)).toBe(2);
  });

  it('T5/AC5: unresolved lab-request links block a project change and are listed', async () => {
    const unit = await addUnit();
    const before = await detail(unit.id);
    const links: LabRequestLink[] = [{ id: 'lr-1', label: 'LR-2026-0012', status: 'in_progress' }];
    const checker = app.get<LabRequestLinkChecker>(LAB_REQUEST_LINK_CHECKER);
    const spy = vi.spyOn(checker, 'unresolvedLinks').mockResolvedValue(links);
    try {
      const blocked = await patch(unit.id, {
        version: before.version,
        reason: 'wrong project chosen',
        changes: { projectId: projects.b, holeSummaries: [{ testHoleId: holes.b1, type: 'all' }] },
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body).toEqual({ code: 'unresolved_lab_links', links });
      expect(spy).toHaveBeenCalledWith(expect.anything(), unit.id);
      expect(await detail(unit.id)).toEqual(before);

      // Other corrections don't depend on lab-request links.
      spy.mockClear();
      const note = await patch(unit.id, {
        version: before.version,
        reason: 'clarify the note',
        changes: { note: 'Lid taped twice' },
      });
      expect(note.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('T6/AC6: a project correction moves the summaries to project B and keeps the receipt header', async () => {
    const unit = await addUnit();
    const before = await detail(unit.id);
    const response = await patch(unit.id, {
      version: before.version,
      reason: 'received under the wrong project',
      changes: {
        projectId: projects.b,
        holeSummaries: [
          { testHoleId: holes.b2, type: 'depth_range', depthFrom: 0, depthTo: 1.5, depthUnit: 'm' },
          { testHoleId: holes.b1, type: 'all', note: 'Bag 2' },
        ],
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const corrected = storageUnitDetailSchema.parse(response.body);
    expect(corrected).toMatchObject({
      readableId: unit.readableId,
      project: { id: projects.b, projectNumber: 'DEMO-2602' },
      receipt: { project: { id: projects.a, projectNumber: 'DEMO-2601' } },
      location: { code: 'WH-C2' },
      holes: [
        { testHoleId: holes.b1, testHoleName: 'TH26-01', type: 'all', note: 'Bag 2' },
        {
          testHoleId: holes.b2,
          testHoleName: 'TH26-02',
          depthFrom: 0,
          depthTo: 1.5,
          depthUnit: 'm',
        },
      ],
    });
    const { rows } = await db.pool.query<{ project_id: string; hole_project_id: string }>(
      `SELECT h.project_id, th.project_id AS hole_project_id
       FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id
       WHERE h.storage_unit_id = $1`,
      [unit.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.project_id === projects.b && r.hole_project_id === projects.b)).toBe(
      true,
    );

    const event = (await history(unit.id)).items[0]!;
    expect(Object.keys(event.after!).sort()).toEqual(['holeSummaries', 'project']);
    expect(event.before).toMatchObject({
      project: { projectNumber: 'DEMO-2601' },
      holeSummaries: [{ testHoleName: 'TH26-01', type: 'sample_range' }],
    });

    // Inventory search follows the corrected project.
    const search = await http()
      .get('/api/inventory')
      .query({ search: `${unit.readableId} DEMO-2602` })
      .set('Cookie', await cookieFor('kcs'));
    expect(search.body.total).toBe(1);
  });

  it('refuses holes from another project, a project change without holes and future dates', async () => {
    const unit = await addUnit();
    const before = await detail(unit.id);
    const wrongHoles = await patch(unit.id, {
      version: before.version,
      reason: 'wrong project chosen',
      changes: { projectId: projects.b, holeSummaries: [{ testHoleId: holes.a2, type: 'all' }] },
    });
    expect(wrongHoles.status).toBe(422);
    expect(wrongHoles.body).toMatchObject({
      code: 'test_hole_not_in_project',
      errors: [{ field: 'changes.holeSummaries.0.testHoleId', code: 'test_hole_not_in_project' }],
    });
    const noHoles = await patch(unit.id, {
      version: before.version,
      reason: 'wrong project chosen',
      changes: { projectId: projects.b },
    });
    expect(noHoles.status).toBe(400);
    expect(noHoles.body.errors).toEqual([
      expect.objectContaining({ field: 'changes.holeSummaries', code: 'required' }),
    ]);
    const future = await patch(unit.id, {
      version: before.version,
      reason: 'typo in the date',
      changes: { receivedDate: '2999-01-01' },
    });
    expect(future.status).toBe(400);
    expect(future.body.errors).toEqual([
      expect.objectContaining({ field: 'changes.receivedDate', code: 'in_future' }),
    ]);
    const badSummary = await patch(unit.id, {
      version: before.version,
      reason: 'fix the depth range',
      changes: {
        holeSummaries: [
          { testHoleId: holes.a1, type: 'depth_range', depthFrom: 3, depthTo: 1, depthUnit: 'ft' },
        ],
      },
    });
    expect(badSummary.status).toBe(400);
    expect(badSummary.body.errors).toEqual([
      expect.objectContaining({
        field: 'changes.holeSummaries.0.depthTo',
        code: 'depth_range_reversed',
      }),
    ]);
    expect(await detail(unit.id)).toEqual(before);
  });

  it('never changes the ID, location or receipt: such fields are rejected, and no-op saves too', async () => {
    const unit = await addUnit();
    const before = await detail(unit.id);
    const identity = await patch(unit.id, {
      version: before.version,
      reason: 'try to rename it',
      changes: { readableId: 'BKT-2026-999999', locationId: before.location.id },
    });
    expect(identity.status).toBe(400);
    expect(identity.body.errors[0]).toMatchObject({ field: 'changes', code: 'unrecognized_keys' });

    const same = await patch(unit.id, {
      version: before.version,
      reason: 'nothing really',
      changes: { note: 'Lid taped', receivedDate: '2026-10-23' },
    });
    expect(same.status).toBe(400);
    expect(same.body.errors).toEqual([
      expect.objectContaining({ field: 'changes', code: 'no_changes' }),
    ]);
    expect(await detail(unit.id)).toEqual(before);
    expect(await correctedEvents(unit.id)).toBe(0);
  });

  it('a type correction keeps the issued ST- ID; clearing the note works; unknown units 404', async () => {
    const tube = await addUnit({ unitType: 'shelby_tube' });
    const before = await detail(tube.id);
    expect(before.unitType).toBe('shelby_tube');
    const response = await patch(tube.id, {
      version: before.version,
      reason: 'it is a bucket of tube cuttings',
      changes: { unitType: 'bucket', note: '   ' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      readableId: tube.readableId,
      unitType: 'bucket',
      note: null,
    });
    const { rows } = await db.pool.query(
      'SELECT id_prefix, issued_holder_kind, holder_kind FROM storage_unit WHERE id = $1',
      [tube.id],
    );
    expect(rows[0]).toEqual({
      id_prefix: 'ST',
      issued_holder_kind: 'shelby_tube',
      holder_kind: 'bucket',
    });

    const missing = await patch('BKT-2026-999998', {
      version: 1,
      reason: 'does not exist',
      changes: { note: 'x' },
    });
    expect(missing.status).toBe(404);
  });

  it('BUG-014: a disposed unit refuses project, type and test-hole corrections; note and date still save', async () => {
    const unit = await addUnit();
    const tube = await addUnit({ unitType: 'shelby_tube' });
    await db.pool.query(
      `UPDATE storage_unit SET status = 'disposed', disposed_at = now(), version = version + 1
       WHERE id = ANY($1)`,
      [[unit.id, tube.id]],
    );
    const before = await detail(unit.id);
    const tubeBefore = await detail(tube.id);
    const eventsBefore = await correctedEvents(unit.id);
    const refused: [StorageUnitDetail, Record<string, unknown>][] = [
      [tubeBefore, { unitType: 'bucket' }],
      [before, { projectId: projects.b, holeSummaries: [{ testHoleId: holes.b1, type: 'all' }] }],
      [before, { holeSummaries: [{ testHoleId: holes.a2, type: 'all' }] }],
    ];
    for (const [target, changes] of refused) {
      const response = await patch(target.id, {
        version: target.version,
        reason: 'wrong details at receiving',
        changes: { ...changes, note: 'Lid replaced' },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body).toMatchObject({ code: 'storage_unit_disposed' });
      expect(response.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(
        Object.keys(changes)
          .map((field) => `changes.${field}`)
          .sort(),
      );
    }
    expect(await detail(unit.id)).toEqual(before);
    expect(await detail(tube.id)).toEqual(tubeBefore);
    expect(await correctedEvents(unit.id)).toBe(eventsBefore);

    // Received date and note keep today's rules until the owner decides them (BUG-014).
    const allowed = await patch(unit.id, {
      version: before.version,
      reason: 'wrong date on tag',
      changes: { receivedDate: '2026-10-21', note: 'Lid replaced' },
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body).toMatchObject({
      receivedDate: '2026-10-21',
      note: 'Lid replaced',
      unitType: 'bucket',
      project: { id: projects.a },
    });
    const { rows } = await db.pool.query(
      'SELECT test_hole_id FROM storage_unit_hole_summary WHERE storage_unit_id = $1',
      [unit.id],
    );
    expect(rows).toEqual([{ test_hole_id: holes.a1 }]);
  });
});
