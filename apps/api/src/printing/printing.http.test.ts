import type { INestApplication } from '@nestjs/common';
import {
  printHistoryResponseSchema,
  printJobSchema,
  printersResponseSchema,
  type PrintJob,
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
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertTestHole,
  insertSummary,
  receivingLabId,
} from '../test-support/fixtures.js';
import { PrintWorkerService } from './print-worker.service.js';

describe.runIf(testDatabaseUrl)('printing API (MM-T15)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let printer: FakeZebraPrinter;
  const users: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let units: { id: string; readableId: string }[];

  const http = () => request(app.getHttpServer());
  const post = (path: string, who: string, body?: object) =>
    http().post(path).set('Cookie', cookies[who]!).set(CSRF_HEADER, '1').send(body);
  const get = (path: string, who: string) => http().get(path).set('Cookie', cookies[who]!);
  const drain = () => app.get(PrintWorkerService).worker.drain();

  async function addUser(
    key: string,
    accountType: 'personal' | 'shared_lab',
    status: 'active' | 'pending' = 'active',
    roles: string[] = [],
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

  async function inventorySnapshot() {
    const { rows } = await db.pool.query(
      `SELECT su.*, r.received_date AS receipt_date, r.quantity
       FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id ORDER BY su.readable_id`,
    );
    return rows;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    printer = await FakeZebraPrinter.start();
    await addUser('tech', 'personal');
    await addUser('admin', 'personal', 'active', ['admin']);
    await addUser('pend', 'personal', 'pending');
    await addUser('lab', 'shared_lab');

    const locationId = await receivingLabId(db.pool);
    const projectId = await insertProject(db.pool, 'DEMO-2601', users.tech!);
    const holeId = await insertTestHole(db.pool, projectId, 'TH26-01');
    const receiptId = await insertReceipt(db.pool, projectId, users.tech!, 2);
    units = [];
    for (const readableId of ['BKT-2026-000014', 'BKT-2026-000015']) {
      const id = await insertStorageUnit(
        db.pool,
        { projectId, receiptId, locationId },
        { readableId },
      );
      await insertSummary(
        db.pool,
        { storageUnitId: id, projectId, testHoleId: holeId },
        { type: 'all' },
      );
      units.push({ id, readableId });
    }

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
      const accountType = key === 'lab' ? 'shared_lab' : 'personal';
      cookies[key] = `${SESSION_COOKIE}=${(await sessions.create(id, accountType)).token}`;
    }
  });

  afterAll(async () => {
    await app?.close();
    await printer?.stop();
    await db?.drop();
  });

  it('creates the receiving printer from LABEL_PRINTER_HOST; only admins see printer config', async () => {
    const response = await get('/api/admin/printers', 'admin');
    expect(response.status).toBe(200);
    expect(printersResponseSchema.parse(response.body)).toEqual([
      {
        id: 'receiving',
        name: 'Receiving ZD621',
        host: '127.0.0.1',
        port: printer.port,
        enabled: true,
        isDefault: true,
        checkStatus: true,
      },
    ]);
    expect((await get('/api/admin/printers', 'tech')).status).toBe(403);
    expect((await get('/api/admin/printers', 'lab')).status).toBe(403);
  });

  it('AC1: Print all queues one job that reaches sent with both labels in order', async () => {
    const response = await post('/api/print-jobs', 'tech', {
      storageUnitIds: units.map((u) => u.id),
      kind: 'initial',
    });
    expect(response.status).toBe(201);
    const job = printJobSchema.parse(response.body);
    expect(job).toMatchObject({ kind: 'initial', printerId: 'receiving', receiver: null });
    await drain();
    const done = printJobSchema.parse((await get(`/api/print-jobs/${job.id}`, 'tech')).body);
    expect(done.status).toBe('sent');
    expect(printer.labels.slice(-2).map((l) => l.match(/BKT-2026-\d+/)![0])).toEqual([
      'BKT-2026-000014',
      'BKT-2026-000015',
    ]);
  });

  it('AC6: rejects an unknown printer ID or a host address from the client', async () => {
    const storageUnitIds = [units[0]!.id];
    const unknown = await post('/api/print-jobs', 'tech', {
      storageUnitIds,
      kind: 'initial',
      printerId: 'nope',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('unknown_printer');

    for (const body of [
      { storageUnitIds, kind: 'initial', host: '10.0.0.5' },
      { storageUnitIds, kind: 'initial', port: 9100 },
      { storageUnitIds, kind: 'initial', printerId: '10.0.0.5:9100' },
      { storageUnitIds, kind: 'initial', printer: { host: '10.0.0.5', port: 9100 } },
    ]) {
      const response = await post('/api/print-jobs', 'tech', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const { rows } = await db.pool.query(`SELECT DISTINCT printer_key FROM print_job`);
    expect(rows).toEqual([{ printer_key: 'receiving' }]);
  });

  it('rejects unknown storage units, duplicates and missing CSRF header', async () => {
    const unknown = await post('/api/print-jobs', 'tech', {
      storageUnitIds: ['00000000-0000-4000-8000-000000000999'],
      kind: 'initial',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('unknown_storage_unit');
    const duplicate = await post('/api/print-jobs', 'tech', {
      storageUnitIds: [units[0]!.id, units[0]!.id],
      kind: 'initial',
    });
    expect(duplicate.status).toBe(400);
    const noCsrf = await http()
      .post('/api/print-jobs')
      .set('Cookie', cookies.tech!)
      .send({ storageUnitIds: [units[0]!.id], kind: 'initial' });
    expect(noCsrf.status).toBe(403);
    const pending = await post('/api/print-jobs', 'pend', {
      storageUnitIds: [units[0]!.id],
      kind: 'initial',
    });
    expect(pending.status).toBe(403);
  });

  it('AC7: a LAB session may print and reprint; the receipt receiver is credited', async () => {
    const initial = await post('/api/print-jobs', 'lab', {
      storageUnitIds: units.map((u) => u.id),
      kind: 'initial',
    });
    expect(initial.status).toBe(201);
    expect(printJobSchema.parse(initial.body)).toMatchObject({
      requestedBy: { userId: users.lab },
      receiver: { userId: users.tech },
    });
    const reprint = await post('/api/print-jobs', 'lab', {
      storageUnitIds: [units[0]!.id],
      kind: 'reprint',
      receiverUserId: users.admin,
    });
    expect(reprint.status).toBe(201);
    expect(reprint.body.receiver.userId).toBe(users.admin);

    // The receiver must be a real staff member, not the shared account itself.
    const badReceiver = await post('/api/print-jobs', 'lab', {
      storageUnitIds: [units[0]!.id],
      kind: 'reprint',
      receiverUserId: users.lab,
    });
    expect(badReceiver.status).toBe(400);
    expect(badReceiver.body.code).toBe('unknown_receiver');
    await drain();

    const audit = await listAuditForEntity(db.pool, 'print_job', reprint.body.id);
    expect(audit[0]).toMatchObject({
      action: 'label.reprint_requested',
      actorAccountType: 'shared_lab',
      receiverUserId: users.admin,
      // MM-T56: the receiver as they were when the job was requested.
      receiverInitials: 'ADMIN',
      receiverName: 'User admin',
    });
  });

  it('AC5: a reprint of BKT-2026-000014 is a new job; identity, location and units unchanged', async () => {
    const before = await inventorySnapshot();
    const response = await post('/api/print-jobs', 'tech', {
      storageUnitIds: [units[0]!.id],
      kind: 'reprint',
    });
    expect(response.status).toBe(201);
    const reprint = printJobSchema.parse(response.body);
    await drain();

    expect(await inventorySnapshot()).toEqual(before);
    const history = printHistoryResponseSchema.parse(
      (await get('/api/storage-units/BKT-2026-000014/print-history', 'tech')).body,
    );
    expect(history.storageUnit).toEqual(units[0]);
    expect(history.jobs[0]).toMatchObject({ id: reprint.id, kind: 'reprint', status: 'sent' });
    expect(history.jobs.filter((j) => j.kind === 'initial').length).toBeGreaterThan(0);
    expect(printer.labels.at(-1)).toContain('BKT-2026-000014');

    const audit = await listAuditForEntity(db.pool, 'print_job', reprint.id);
    expect(audit[0]).toMatchObject({
      action: 'label.reprint_requested',
      after: expect.objectContaining({ readableId: 'BKT-2026-000014', projectNumber: 'DEMO-2601' }),
    });
  });

  it('print history accepts the UUID too, is readable by LAB and 404s for unknown units', async () => {
    const byUuid = await get(`/api/storage-units/${units[1]!.id}/print-history`, 'lab');
    expect(byUuid.status).toBe(200);
    expect(byUuid.body.storageUnit.readableId).toBe('BKT-2026-000015');
    expect((await get('/api/storage-units/BKT-2026-999999/print-history', 'tech')).status).toBe(
      404,
    );
    expect((await get('/api/print-jobs/not-a-uuid', 'tech')).status).toBe(404);
  });

  it('records "Labels came out OK" only for sent or uncertain jobs', async () => {
    const history = printHistoryResponseSchema.parse(
      (await get(`/api/storage-units/${units[0]!.id}/print-history`, 'tech')).body,
    );
    const sent = history.jobs.find((j) => j.status === 'sent')!;

    const confirmed = await post(`/api/print-jobs/${sent.id}/confirm-physical`, 'lab');
    expect(confirmed.status).toBe(200);
    const job: PrintJob = printJobSchema.parse(confirmed.body);
    expect(job.physicallyConfirmedAt).not.toBeNull();
    expect(job.physicallyConfirmedBy?.userId).toBe(users.lab);
    // Idempotent: a second confirmation keeps the first.
    const again = await post(`/api/print-jobs/${sent.id}/confirm-physical`, 'tech');
    expect(again.body.physicallyConfirmedAt).toBe(job.physicallyConfirmedAt);
    const audit = await listAuditForEntity(db.pool, 'print_job', sent.id);
    expect(audit.filter((e) => e.action === 'label.physically_confirmed')).toHaveLength(1);

    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id, status)
       VALUES ('initial', 'receiving', 'sticker-v1', $1, 'failed') RETURNING id`,
      [users.tech],
    );
    const failed = await post(`/api/print-jobs/${rows[0]!.id}/confirm-physical`, 'tech');
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe('not_confirmable');
    expect(
      (await post('/api/print-jobs/00000000-0000-4000-8000-000000000999/confirm-physical', 'tech'))
        .status,
    ).toBe(404);
  });

  it('lets an admin add a printer and change the default; invalid config is rejected', async () => {
    const response = await http()
      .put('/api/admin/printers')
      .set('Cookie', cookies.admin!)
      .set(CSRF_HEADER, '1')
      .send({
        printers: [
          {
            id: 'office',
            name: 'Office ZD621',
            host: 'zebra-office.example.test',
            isDefault: true,
          },
        ],
      });
    expect(response.status).toBe(200);
    const printers = printersResponseSchema.parse(response.body);
    expect(printers.find((p) => p.id === 'office')).toMatchObject({ port: 9100, isDefault: true });
    expect(printers.find((p) => p.id === 'receiving')).toMatchObject({ isDefault: false });

    const bad = await http()
      .put('/api/admin/printers')
      .set('Cookie', cookies.admin!)
      .set(CSRF_HEADER, '1')
      .send({ printers: [{ id: 'x', name: 'X', host: 'http://evil/' }] });
    expect(bad.status).toBe(400);
    const notAdmin = await http()
      .put('/api/admin/printers')
      .set('Cookie', cookies.tech!)
      .set(CSRF_HEADER, '1')
      .send({ printers: [{ id: 'x', name: 'X', host: '10.0.0.9' }] });
    expect(notAdmin.status).toBe(403);

    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE action = 'printer.configured'`,
    );
    expect(rows[0].n).toBe(2);

    // Put the receiving printer back as the default for anything after this.
    await http()
      .put('/api/admin/printers')
      .set('Cookie', cookies.admin!)
      .set(CSRF_HEADER, '1')
      .send({
        printers: [
          {
            id: 'receiving',
            name: 'Receiving ZD621',
            host: printer.host,
            port: printer.port,
            isDefault: true,
          },
        ],
      });
  });

  it('refuses to queue when no default printer is configured', async () => {
    await db.pool.query('UPDATE printer SET is_default = false');
    const response = await post('/api/print-jobs', 'tech', {
      storageUnitIds: [units[0]!.id],
      kind: 'reprint',
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('no_printer_configured');
    await db.pool.query(`UPDATE printer SET is_default = true WHERE key = 'receiving'`);
  });
});
