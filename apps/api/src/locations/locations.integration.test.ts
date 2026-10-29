import type { INestApplication } from '@nestjs/common';
import {
  locationDetailSchema,
  locationListSchema,
  locationSchema,
  printHistoryResponseSchema,
  printJobSchema,
  scanResolveResponseSchema,
  type PrintJob,
  type StorageLocation,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { PrintWorkerService } from '../printing/print-worker.service.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  receivingLabId,
} from '../test-support/fixtures.js';

// MM-T37 section 8: T2–T6 and T9 at the API, plus the pre-coding review regressions (queue
// integration, snapshots, code lock, retirement races). Fictional data only.

describe.runIf(testDatabaseUrl)('storage locations API (MM-T37)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let printer: FakeZebraPrinter;
  const users: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let receivingLab: string;
  let projectId: string;
  let receiptId: string;
  let unitSeq = 100;

  const http = () => request(app.getHttpServer());
  const get = (path: string, who: string) => http().get(path).set('Cookie', cookies[who]!);
  const send = (method: 'post' | 'patch', path: string, who: string, body?: object) =>
    http()[method](path).set('Cookie', cookies[who]!).set(CSRF_HEADER, '1').send(body);
  const post = (path: string, who: string, body?: object) => send('post', path, who, body);
  const patch = (path: string, who: string, body?: object) => send('patch', path, who, body);
  const drain = () => app.get(PrintWorkerService).worker.drain();

  async function addUser(
    key: string,
    accountType: 'personal' | 'shared_lab',
    roles: string[] = [],
    status: 'active' | 'pending' | 'disabled' = 'active',
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        `User ${key}`,
        key
          .toUpperCase()
          .replace(/[^A-Z]/g, '')
          .slice(0, 5),
        accountType,
        status,
      ],
    );
    users[key] = rows[0]!.id;
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
  }

  async function create(code: string, name: string, who = 'lm'): Promise<StorageLocation> {
    const response = await post('/api/locations', who, { code, name, kind: 'warehouse' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return locationSchema.parse(response.body);
  }

  async function locationRow(id: string) {
    const { rows } = await db.pool.query(
      `SELECT code, name, active, code_locked_at, label_printed_at, version FROM location
       WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function addUnit(locationId: string, status = 'in_stock') {
    unitSeq++;
    const id = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId },
      { readableId: `BKT-2026-000${unitSeq}` },
    );
    if (status !== 'in_stock') {
      await db.pool.query('UPDATE storage_unit SET status = $2 WHERE id = $1', [id, status]);
    }
    return id;
  }

  async function settled(jobId: string): Promise<PrintJob> {
    await drain();
    return vi.waitFor(
      async () => {
        const job = printJobSchema.parse((await get(`/api/print-jobs/${jobId}`, 'lm')).body);
        if (job.status === 'queued' || job.status === 'sending') throw new Error(job.status);
        return job;
      },
      { timeout: 10_000, interval: 50 },
    );
  }

  async function auditCount(action: string) {
    const { rows } = await db.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_event WHERE action = $1',
      [action],
    );
    return rows[0]!.count;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    printer = await FakeZebraPrinter.start();
    await addUser('admin', 'personal', ['admin']);
    await addUser('lm', 'personal', ['lab_manager']);
    await addUser('tech', 'personal');
    await addUser('pend', 'personal', [], 'pending');
    await addUser('lab', 'shared_lab');
    await addUser('jordan', 'personal');
    await addUser('gone', 'personal', [], 'disabled');
    receivingLab = await receivingLabId(db.pool);
    projectId = await insertProject(db.pool, 'DEMO-2601', users.tech!);
    receiptId = await insertReceipt(db.pool, projectId, users.tech!, 50);

    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        LABEL_PRINTER_HOST: printer.host,
        LABEL_PRINTER_PORT: String(printer.port),
      }),
    );
    await app.init();
    const sessions = app.get(SessionService);
    for (const [key, id] of Object.entries(users)) {
      if (key === 'gone') continue;
      const accountType = key === 'lab' ? 'shared_lab' : 'personal';
      cookies[key] = `${SESSION_COOKIE}=${(await sessions.create(id, accountType)).token}`;
    }
    // A second, independently signed-in LAB station (T9).
    cookies.lab2 = `${SESSION_COOKIE}=${(await sessions.create(users.lab!, 'shared_lab')).token}`;
  });

  afterAll(async () => {
    await app?.close();
    await printer?.stop();
    await db?.drop();
  });

  it('AC1: a Lab Manager adds WH-C1 "Warehouse C1"; it is listed and resolves as a location', async () => {
    const location = await create('WH-C1', 'Warehouse C1');
    expect(location).toMatchObject({
      code: 'WH-C1',
      name: 'Warehouse C1',
      kind: 'warehouse',
      area: null,
      active: true,
      isSystem: false,
      codeLocked: false,
      labelPrintedAt: null,
      inStockCount: 0,
      version: 1,
    });
    const list = locationListSchema.parse((await get('/api/locations', 'tech')).body);
    expect(list.map((item) => item.code)).toEqual(expect.arrayContaining(['WH-C1', 'RECEIVING']));
    const resolved = scanResolveResponseSchema.parse(
      (await get('/api/scan/resolve?payload=LOC-WH-C1', 'lab')).body,
    );
    expect(resolved).toEqual({
      type: 'location',
      location: {
        id: location.id,
        code: 'WH-C1',
        name: 'Warehouse C1',
        kind: 'warehouse',
        area: null,
        active: true,
      },
    });
    // T6: audit with the values created, by whom.
    const [event] = await listAuditForEntity(db.pool, 'location', location.id);
    expect(event).toMatchObject({
      action: 'location.created',
      actorUserId: users.lm,
      after: { code: 'WH-C1', name: 'Warehouse C1', kind: 'warehouse', area: null },
    });
  });

  it('T2: trims and upper-cases codes, keeps an optional area, and validates input', async () => {
    const response = await post('/api/locations', 'admin', {
      code: '  lab-b1 ',
      name: ' Lab Bench 1 ',
      kind: 'lab',
      area: ' Lab ',
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ code: 'LAB-B1', name: 'Lab Bench 1', area: 'Lab' });
    for (const body of [
      { code: 'A', name: 'Too short', kind: 'lab' },
      { code: 'WH C9', name: 'Space', kind: 'lab' },
      { code: 'WH_C9', name: 'Underscore', kind: 'lab' },
      { code: 'X'.repeat(21), name: 'Too long', kind: 'lab' },
      { code: 'WH-C9', name: '   ', kind: 'lab' },
      { code: 'WH-C9', name: 'Kind', kind: 'receiving_lab' },
      { code: 'WH-C9', name: 'Extra', kind: 'lab', host: '10.0.0.1' },
    ]) {
      const bad = await post('/api/locations', 'lm', body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.body.code).toBe('validation_failed');
    }
  });

  it('AC2/T3: a duplicate code in any case is 409 and nothing is created', async () => {
    const before = (await db.pool.query('SELECT count(*)::int AS n FROM location')).rows[0].n;
    const response = await post('/api/locations', 'admin', {
      code: 'wh-c1',
      name: 'Another',
      kind: 'warehouse',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'location_code_exists',
      message: 'A location with code WH-C1 already exists.',
    });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM location')).rows[0].n).toBe(before);

    // Editing another location's code onto WH-C1 is refused the same way.
    const other = await create('WH-C3', 'Warehouse C3');
    const edit = await patch(`/api/locations/${other.id}`, 'lm', { code: 'Wh-C1', version: 1 });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('location_code_exists');
  });

  it('AC5/T5: Technician, LAB and pending sessions get 403 on every write and nothing changes', async () => {
    const target = await create('WH-P1', 'Permission test');
    const before = await locationRow(target.id);
    const auditBefore = await listAuditForEntity(db.pool, 'location', target.id);
    for (const who of ['tech', 'lab', 'lab2', 'pend']) {
      const attempts = [
        await post('/api/locations', who, { code: 'NOPE-1', name: 'No', kind: 'lab' }),
        await patch(`/api/locations/${target.id}`, who, { name: 'Hijacked', version: 1 }),
        await post(`/api/locations/${target.id}/retire`, who, { reason: 'No', version: 1 }),
      ];
      for (const response of attempts) expect(response.status, who).toBe(403);
    }
    expect((await http().post('/api/locations').set(CSRF_HEADER, '1')).status).toBe(401);
    expect(await locationRow(target.id)).toEqual(before);
    expect(await listAuditForEntity(db.pool, 'location', target.id)).toEqual(auditBefore);
    expect(
      (await db.pool.query(`SELECT 1 FROM location WHERE code_normalized = 'NOPE-1'`)).rows,
    ).toEqual([]);
    // Readers: every active session, LAB included; pending users can't read.
    for (const who of ['tech', 'lab', 'lab2', 'admin', 'lm']) {
      expect((await get('/api/locations', who)).status, who).toBe(200);
      expect((await get(`/api/locations/${target.id}`, who)).status, who).toBe(200);
    }
    expect((await get('/api/locations', 'pend')).status).toBe(403);
    // /api/me only offers management to admins and Lab Managers.
    expect((await get('/api/me', 'lm')).body.permissions).toContain('location.manage');
    expect((await get('/api/me', 'admin')).body.permissions).toContain('location.manage');
    expect((await get('/api/me', 'lab')).body.permissions).not.toContain('location.manage');
  });

  it('AC8/T9: a LAB station with a privileged person selected still can’t administer locations', async () => {
    const target = await create('WH-P2', 'Station test');
    for (const who of ['lab', 'lab2']) {
      // receiverUserId is attribution for printing only; it never lends the admin's rights.
      const responses = [
        await post('/api/locations', who, {
          code: 'LAB-X1',
          name: 'Borrowed',
          kind: 'lab',
          receiverUserId: users.admin,
        }),
        await patch(`/api/locations/${target.id}`, who, {
          name: 'Borrowed',
          version: 1,
          receiverUserId: users.lm,
        }),
        await post(`/api/locations/${target.id}/retire`, who, {
          reason: 'Borrowed',
          version: 1,
          receiverUserId: users.lm,
        }),
      ];
      for (const response of responses) expect(response.status, who).toBe(403);
    }
    // Both stations read and resolve independently; neither signs the other out.
    for (const who of ['lab', 'lab2', 'lab', 'lab2']) {
      expect((await get('/api/scan/resolve?payload=LOC-WH-P2', who)).body).toMatchObject({
        type: 'location',
        location: { code: 'WH-P2' },
      });
    }
    // Stations print with different staff credited, without sharing an operator.
    const one = await post(`/api/locations/${target.id}/labels`, 'lab', {
      receiverUserId: users.jordan,
    });
    const two = await post(`/api/locations/${target.id}/labels`, 'lab2', {
      receiverUserId: users.tech,
    });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(one.body.receiver.userId).toBe(users.jordan);
    expect(two.body.receiver.userId).toBe(users.tech);
    expect((await get('/api/locations', 'lab')).status).toBe(200);
    expect((await get('/api/locations', 'lab2')).status).toBe(200);
    expect((await locationRow(target.id)).name).toBe('Station test');
  });

  it('AC3/AC4/T4: occupied 409 with the count, system 422, empty 200', async () => {
    const occupied = await create('WH-C2', 'Warehouse C2');
    for (let i = 0; i < 3; i++) await addUnit(occupied.id);
    // Disposed units have left the shelf and don't block retirement.
    await addUnit(occupied.id, 'disposed');

    const list = locationListSchema.parse((await get('/api/locations?search=wh-c2', 'lm')).body);
    expect(list).toHaveLength(1);
    expect(list[0]!.inStockCount).toBe(3);

    const blocked = await post(`/api/locations/${occupied.id}/retire`, 'lm', {
      reason: 'Rack removed',
      version: 1,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'location_occupied', inStockCount: 3 });
    expect(blocked.body.message).toContain('3 storage units');
    expect((await locationRow(occupied.id)).active).toBe(true);

    for (const who of ['lm', 'admin']) {
      const system = await post(`/api/locations/${receivingLab}/retire`, who, {
        reason: 'Try',
        version: 1,
      });
      expect(system.status).toBe(422);
      expect(system.body.code).toBe('system_location');
    }

    const empty = await create('WH-E1', 'Empty bay');
    const retired = await post(`/api/locations/${empty.id}/retire`, 'lm', {
      reason: 'Bay demolished',
      version: 1,
    });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ active: false, retiredReason: 'Bay demolished' });
    expect(retired.body.retiredAt).toEqual(expect.any(String));
    const [event] = await listAuditForEntity(db.pool, 'location', empty.id);
    expect(event).toMatchObject({ action: 'location.retired', reason: 'Bay demolished' });

    // Hidden unless asked for; still resolves (inactive) so a scanner can explain.
    const active = locationListSchema.parse((await get('/api/locations', 'lm')).body);
    expect(active.map((item) => item.code)).not.toContain('WH-E1');
    const all = locationListSchema.parse(
      (await get('/api/locations?includeRetired=true', 'lm')).body,
    );
    expect(all.find((item) => item.code === 'WH-E1')).toMatchObject({ active: false });
    expect((await get('/api/scan/resolve?payload=LOC-WH-E1', 'lab')).body).toMatchObject({
      type: 'location',
      location: { active: false },
    });
    // Retiring twice, editing or printing a retired location is refused.
    expect(
      (await post(`/api/locations/${empty.id}/retire`, 'lm', { reason: 'Again', version: 2 }))
        .status,
    ).toBe(409);
    expect(
      (await patch(`/api/locations/${empty.id}`, 'lm', { name: 'Back', version: 2 })).status,
    ).toBe(422);
    const print = await post(`/api/locations/${empty.id}/labels`, 'lm', {});
    expect(print.status).toBe(409);
    expect(print.body.code).toBe('location_retired');
    // No unit can be placed there any more (database rule storage_unit_location_active).
    await expect(addUnit(empty.id)).rejects.toMatchObject({
      constraint: 'storage_unit_location_active',
    });
  });

  it('Receiving lab can be renamed for display but its code and kind stay', async () => {
    const current = locationSchema.parse(
      (await get(`/api/locations/${receivingLab}`, 'lm')).body.location,
    );
    const renamed = await patch(`/api/locations/${receivingLab}`, 'lm', {
      name: 'Receiving lab (front)',
      version: current.version,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Receiving lab (front)', isSystem: true });
    for (const change of [{ code: 'RCV' }, { kind: 'lab' }]) {
      const refused = await patch(`/api/locations/${receivingLab}`, 'lm', {
        ...change,
        version: renamed.body.version,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('system_location');
    }
  });

  it('optimistic concurrency: a stale version gets 409 with the current location', async () => {
    const location = await create('WH-V1', 'Version test');
    const first = await patch(`/api/locations/${location.id}`, 'lm', {
      name: 'First edit',
      version: 1,
    });
    expect(first.status).toBe(200);
    const stale = await patch(`/api/locations/${location.id}`, 'admin', {
      name: 'Second edit',
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'version_conflict',
      current: { name: 'First edit', version: 2 },
    });
    const staleRetire = await post(`/api/locations/${location.id}/retire`, 'lm', {
      reason: 'Stale',
      version: 1,
    });
    expect(staleRetire.status).toBe(409);
    expect(staleRetire.body.code).toBe('version_conflict');
    // T6: the update audit has only the changed field, before and after.
    const [event] = await listAuditForEntity(db.pool, 'location', location.id);
    expect(event).toMatchObject({
      action: 'location.updated',
      before: { name: 'Version test' },
      after: { name: 'First edit' },
    });
  });

  it('AC6/T1: scans tell location labels from storage-unit stickers', async () => {
    const unitId = await addUnit(receivingLab);
    const { rows } = await db.pool.query<{ readable_id: string }>(
      'SELECT readable_id FROM storage_unit WHERE id = $1',
      [unitId],
    );
    const readableId = rows[0]!.readable_id;
    // A location whose code happens to look like a storage unit ID still can't be confused.
    const lookalike = await create(readableId, 'Look-alike shelf');
    const resolve = async (payload: string) =>
      scanResolveResponseSchema.parse(
        (await get(`/api/scan/resolve?payload=${encodeURIComponent(payload)}`, 'lab')).body,
      );
    expect(await resolve(readableId)).toEqual({
      type: 'storage_unit',
      storageUnit: { id: unitId, readableId },
    });
    expect(await resolve(` ${readableId.toLowerCase()}\r\n`)).toMatchObject({
      type: 'storage_unit',
    });
    expect(await resolve(`LOC-${readableId}`)).toMatchObject({
      type: 'location',
      location: { id: lookalike.id },
    });
    expect(await resolve('loc-wh-c1')).toMatchObject({
      type: 'location',
      location: { code: 'WH-C1' },
    });
    expect(await resolve('LOC-NOPE-1')).toEqual({ type: 'unknown', reason: 'location_not_found' });
    expect(await resolve('BKT-2026-999999')).toEqual({
      type: 'unknown',
      reason: 'storage_unit_not_found',
    });
    for (const garbage of ['WH-C1', 'https://example.test/LOC-WH-C1', 'LOC-', 'SU-2026-000001']) {
      expect(await resolve(garbage), garbage).toEqual({
        type: 'unknown',
        reason: 'not_recognised',
      });
    }
    expect((await get('/api/scan/resolve', 'lab')).status).toBe(400);
    expect((await http().get('/api/scan/resolve?payload=LOC-WH-C1')).status).toBe(401);
  });

  describe('location labels on the print queue', () => {
    let location: StorageLocation;
    let firstJob: PrintJob;

    it('queues a label: code locked, "sent" is not a physical print, payload LOC-WH-L1', async () => {
      location = await create('WH-L1', 'Warehouse L1');
      const before = printer.labels.length;
      const response = await post(`/api/locations/${location.id}/labels`, 'lm', {});
      expect(response.status).toBe(201);
      firstJob = printJobSchema.parse(response.body);
      expect(firstJob).toMatchObject({
        kind: 'initial',
        target: 'location',
        templateVersion: 'location-v1',
        items: [],
        locations: [
          {
            locationId: location.id,
            code: 'WH-L1',
            name: 'Warehouse L1',
            payload: 'LOC-WH-L1',
            position: 1,
          },
        ],
        receiver: null,
        requestedBy: { userId: users.lm, name: 'User lm', initials: 'LM' },
      });
      const queued = await locationRow(location.id);
      expect(queued.code_locked_at).not.toBeNull();
      expect(queued.label_printed_at).toBeNull();

      const sent = await settled(firstJob.id);
      expect(sent.status).toBe('sent');
      expect(sent.physicallyConfirmedAt).toBeNull();
      // Sending is not proof of a physical label.
      expect((await locationRow(location.id)).label_printed_at).toBeNull();
      expect(
        (
          await db.pool.query(
            `SELECT 1 FROM audit_event WHERE action = 'location.label_printed' AND entity_id = $1`,
            [location.id],
          )
        ).rows,
      ).toEqual([]);

      const labels = printer.labels.slice(before);
      expect(labels).toHaveLength(1);
      const zpl = labels[0]!;
      expect(zpl).toContain('^FX Material Mule location-v1^FS');
      // Both symbols carry exactly the approved payload; no URL, no storage-unit data.
      expect(zpl).toContain('^BCN,110,N,N,N,A^FDLOC-WH-L1^FS');
      expect(zpl).toContain('^FDMA,LOC-WH-L1^FS');
      expect(zpl).toContain('^FDWarehouse L1^FS');
      expect(zpl).toContain('^FDWH-L1^FS');
      expect(zpl).not.toMatch(/https?:|BKT-|DEMO-2601/);
    });

    it('locks the code after the first request but still allows renaming', async () => {
      const current = await locationRow(location.id);
      const locked = await patch(`/api/locations/${location.id}`, 'lm', {
        code: 'WH-L9',
        version: current.version,
      });
      expect(locked.status).toBe(422);
      expect(locked.body.code).toBe('location_code_locked');
      const renamed = await patch(`/api/locations/${location.id}`, 'lm', {
        name: 'Warehouse L1 (north)',
        version: current.version,
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ code: 'WH-L1', codeLocked: true });
    });

    it('confirms the physical label once and only then records label_printed', async () => {
      const confirmed = await post(`/api/print-jobs/${firstJob.id}/confirm-physical`, 'tech');
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.physicallyConfirmedBy).toMatchObject({ userId: users.tech });
      const row = await locationRow(location.id);
      expect(row.label_printed_at).not.toBeNull();
      const events = await listAuditForEntity(db.pool, 'location', location.id);
      expect(events.filter((event) => event.action === 'location.label_printed')).toHaveLength(1);
      expect(events.find((event) => event.action === 'location.label_printed')).toMatchObject({
        actorUserId: users.tech,
        after: { printJobId: firstJob.id, payload: 'LOC-WH-L1', firstConfirmation: true },
      });
      // Confirming twice changes nothing.
      await post(`/api/print-jobs/${firstJob.id}/confirm-physical`, 'tech');
      expect(
        (await listAuditForEntity(db.pool, 'location', location.id)).filter(
          (event) => event.action === 'location.label_printed',
        ),
      ).toHaveLength(1);
    });

    it('reprints with the current name and keeps the first job’s history as printed', async () => {
      const reprint = await post(`/api/locations/${location.id}/labels`, 'admin', {});
      expect(reprint.status).toBe(201);
      expect(reprint.body).toMatchObject({
        kind: 'reprint',
        locations: [{ code: 'WH-L1', name: 'Warehouse L1 (north)', payload: 'LOC-WH-L1' }],
      });
      await settled(reprint.body.id);
      const detail = locationDetailSchema.parse(
        (await get(`/api/locations/${location.id}`, 'lab')).body,
      );
      expect(detail.printJobs.map((job) => job.kind)).toEqual(['reprint', 'initial']);
      expect(detail.printJobs[1]!.locations[0]!.name).toBe('Warehouse L1');
      expect(detail.location.labelPrintedAt).not.toBeNull();
      // Storage-unit print history never shows location jobs.
      const unitId = await addUnit(receivingLab);
      const history = printHistoryResponseSchema.parse(
        (await get(`/api/storage-units/${unitId}/print-history`, 'lm')).body,
      );
      expect(history.jobs).toEqual([]);
    });

    it('LAB must choose valid staff; there is no receipt receiver to fall back on', async () => {
      const target = await create('LAB-B2', 'Lab Bench 2');
      const none = await post(`/api/locations/${target.id}/labels`, 'lab', {});
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('receiver_required');
      const disabled = await post(`/api/locations/${target.id}/labels`, 'lab', {
        receiverUserId: users.gone,
      });
      expect(disabled.status).toBe(400);
      expect(disabled.body.code).toBe('unknown_receiver');
      const lab = await post(`/api/locations/${target.id}/labels`, 'lab', {
        receiverUserId: users.lab,
      });
      expect(lab.body.code).toBe('unknown_receiver');
      // Refusals queued nothing and left the code unlocked.
      expect((await locationRow(target.id)).code_locked_at).toBeNull();

      const ok = await post(`/api/locations/${target.id}/labels`, 'lab', {
        receiverUserId: users.jordan,
      });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({
        requestedBy: { userId: users.lab },
        receiver: { userId: users.jordan, initials: 'JORDA', name: 'User jordan' },
      });
      const [requested] = await listAuditForEntity(db.pool, 'print_job', ok.body.id);
      expect(requested).toMatchObject({
        action: 'label.print_requested',
        actorUserId: users.lab,
        receiverUserId: users.jordan,
        receiverName: 'User jordan',
        after: { target: 'location', locationCode: 'LAB-B2', payload: 'LOC-LAB-B2' },
      });
      await settled(ok.body.id);
      const confirmed = await post(`/api/print-jobs/${ok.body.id}/confirm-physical`, 'lab2');
      expect(confirmed.status).toBe(200);

      // Renaming or disabling people later never rewrites who was on the job (MM-T65).
      await db.pool.query(
        `UPDATE app_user SET display_name = 'Renamed Jordan', official_initials = 'RJ'
         WHERE id = $1`,
        [users.jordan],
      );
      await db.pool.query(`UPDATE app_user SET display_name = 'Renamed LAB' WHERE id = $1`, [
        users.lab,
      ]);
      const detail = locationDetailSchema.parse(
        (await get(`/api/locations/${target.id}`, 'lm')).body,
      );
      expect(detail.printJobs[0]).toMatchObject({
        requestedBy: { name: 'User lab' },
        receiver: { initials: 'JORDA', name: 'User jordan' },
        physicallyConfirmedBy: { name: 'User lab' },
      });
      await db.pool.query(
        `UPDATE app_user SET display_name = 'User jordan', official_initials = 'JORDA'
         WHERE id = $1`,
        [users.jordan],
      );
      await db.pool.query(`UPDATE app_user SET display_name = 'User lab' WHERE id = $1`, [
        users.lab,
      ]);
    });

    it('never resends an uncertain location job; a person decides', async () => {
      const target = await create('STG-U1', 'Staging U1');
      printer.mode = 'drop';
      printer.dropAfterBytes = 8;
      try {
        const job = await post(`/api/locations/${target.id}/labels`, 'lm', {});
        const uncertain = await settled(job.body.id);
        expect(uncertain.status).toBe('uncertain');
        const connections = printer.connections;
        await drain();
        await drain();
        expect(printer.connections).toBe(connections);
        expect((await locationRow(target.id)).label_printed_at).toBeNull();
        expect(await auditCount('label.print_uncertain')).toBeGreaterThan(0);
        const marked = await post(`/api/print-jobs/${job.body.id}/confirm-physical`, 'lm');
        expect(marked.body).toMatchObject({ status: 'uncertain' });
        expect((await locationRow(target.id)).label_printed_at).not.toBeNull();
      } finally {
        printer.mode = 'accept';
      }
    });

    it('recovers a location job interrupted mid-send as uncertain, like stickers', async () => {
      const target = await create('STG-R1', 'Staging R1');
      const job = await post(`/api/locations/${target.id}/labels`, 'lm', {});
      // Simulate a crash after the claim: the job is left `sending` (whatever the running worker
      // already did with it).
      await settled(job.body.id);
      await db.pool.query(
        `UPDATE print_job SET status = 'sending', sent_at = NULL, attempts = 1 WHERE id = $1`,
        [job.body.id],
      );
      expect(await app.get(PrintWorkerService).worker.recoverInterrupted()).toBeGreaterThanOrEqual(
        1,
      );
      const recovered = printJobSchema.parse(
        (await get(`/api/print-jobs/${job.body.id}`, 'lm')).body,
      );
      expect(recovered.status).toBe('uncertain');
      expect(recovered.lastError).toMatch(/restarted/);
    });

    it('code-lock boundary: a code edit racing the first label never invalidates the payload', async () => {
      for (let round = 0; round < 6; round++) {
        const target = await create(`RACE-${round}`, `Race ${round}`);
        const [edit, print] = await Promise.all([
          patch(`/api/locations/${target.id}`, 'lm', { code: `RACE-${round}X`, version: 1 }),
          post(`/api/locations/${target.id}/labels`, 'admin', {}),
        ]);
        expect(print.status).toBe(201);
        const finalCode = (await locationRow(target.id)).code;
        // Whichever committed first, the queued label carries the location's lasting code.
        expect(print.body.locations[0].code).toBe(finalCode);
        if (edit.status === 200) {
          expect(finalCode).toBe(`RACE-${round}X`);
        } else {
          expect(edit.status).toBe(422);
          expect(edit.body.code).toBe('location_code_locked');
          expect(finalCode).toBe(`RACE-${round}`);
        }
      }
    });

    it('a retirement racing a label request either prints first or refuses the print', async () => {
      const target = await create('RACE-RT', 'Race retire');
      const [retire, print] = await Promise.all([
        post(`/api/locations/${target.id}/retire`, 'lm', { reason: 'Race', version: 1 }),
        post(`/api/locations/${target.id}/labels`, 'admin', {}),
      ]);
      expect([200, 409]).toContain(retire.status);
      if (print.status === 201) {
        // Printed first: the retirement saw a new version and asked for a reload, or retired after.
        expect([200, 409]).toContain(retire.status);
      } else {
        expect(print.body.code).toBe('location_retired');
        expect(retire.status).toBe(200);
      }
    });
  });

  it('storage-unit printing is unchanged: target storage_unit, receipt receiver fallback for LAB', async () => {
    const unitId = await addUnit(receivingLab);
    const response = await post('/api/print-jobs', 'lab', {
      storageUnitIds: [unitId],
      kind: 'initial',
    });
    expect(response.status).toBe(201);
    const job = printJobSchema.parse(response.body);
    expect(job).toMatchObject({
      target: 'storage_unit',
      locations: [],
      receiver: { userId: users.tech },
      items: [{ storageUnitId: unitId }],
    });
    const sent = await settled(job.id);
    expect(sent.status).toBe('sent');
    const history = printHistoryResponseSchema.parse(
      (await get(`/api/storage-units/${unitId}/print-history`, 'lab')).body,
    );
    expect(history.jobs.map((item) => item.id)).toEqual([job.id]);
  });

  it('AC7: a renamed or retired location keeps its name on history and audit records', async () => {
    const shelf = await create('WH-H1', 'Old shelf');
    const unitId = await addUnit(shelf.id);
    const print = await post(`/api/locations/${shelf.id}/labels`, 'lm', {});
    await settled(print.body.id);
    // The unit leaves (T28 will record moves; here the saved location changes directly).
    await db.pool.query('UPDATE storage_unit SET current_location_id = $2 WHERE id = $1', [
      unitId,
      receivingLab,
    ]);
    const renamed = await patch(`/api/locations/${shelf.id}`, 'lm', {
      name: 'Shelf H1',
      version: 1,
    });
    expect(renamed.status).toBe(200);
    expect(
      (await post(`/api/locations/${shelf.id}/retire`, 'lm', { reason: 'Gone', version: 2 }))
        .status,
    ).toBe(200);

    const detail = locationDetailSchema.parse(
      (await get(`/api/locations/${shelf.id}`, 'tech')).body,
    );
    expect(detail.location).toMatchObject({ name: 'Shelf H1', active: false });
    expect(detail.events.map((event) => event.action)).toEqual([
      'location.retired',
      'location.updated',
      'location.created',
    ]);
    expect(detail.events[2]!.after).toMatchObject({ name: 'Old shelf' });
    expect(detail.printJobs[0]!.locations[0]).toMatchObject({ name: 'Old shelf', code: 'WH-H1' });
    // The inventory filter can still find it by asking for retired locations.
    const all = locationListSchema.parse(
      (await get('/api/locations?includeRetired=true&search=shelf h1', 'lab')).body,
    );
    expect(all.map((item) => item.id)).toEqual([shelf.id]);
    // Audit is append-only (T6).
    await expect(
      db.pool.query(`UPDATE audit_event SET reason = 'x' WHERE entity_id = $1`, [shelf.id]),
    ).rejects.toBeTruthy();
  });
});
