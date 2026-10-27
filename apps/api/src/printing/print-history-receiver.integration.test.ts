import {
  confirmReceiptResponseSchema,
  printHistoryResponseSchema,
  printJobSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { migrate, readMigrations } from '../db/migrator.js';
import { runSeed } from '../db/seed.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { bootReceivingHarness, type ReceivingHarness } from '../test-support/receiving-harness.js';
import { getPrintHistory, getPrintJob } from './print-queue.js';

// MM-T65: print history shows the receiver credited on each job as they were when the job was
// requested, like unit history does since MM-T56. Fictional data only: DEMO-2601, Alex Tester.

describe.runIf(testDatabaseUrl)('print history receiver (MM-T65)', () => {
  let harness: ReceivingHarness;
  let printer: FakeZebraPrinter;

  beforeAll(async () => {
    printer = await FakeZebraPrinter.start();
    harness = await bootReceivingHarness({
      LABEL_PRINTER_HOST: printer.host,
      LABEL_PRINTER_PORT: String(printer.port),
    });
  });

  afterAll(async () => {
    await harness?.close();
    await printer?.stop();
  });

  it('T1/AC1: after the receiver is renamed, re-initialled and disabled, jobs keep AT · Alex Tester', async () => {
    const lab = await harness.cookieFor('lab');
    const confirmed = await harness.postReceipt(harness.receipt(1), lab);
    expect(confirmed.status).toBe(201);
    const unit = confirmReceiptResponseSchema.parse(confirmed.body).units[0]!;

    const printed = await harness
      .http()
      .post('/api/print-jobs')
      .set('Cookie', lab)
      .set(CSRF_HEADER, '1')
      .send({ storageUnitIds: [unit.storageUnitId], kind: 'initial' });
    expect(printed.status).toBe(201);
    const jobId = printJobSchema.parse(printed.body).id;

    await harness.db.pool.query(
      `UPDATE app_user
       SET display_name = 'Alex Renamed', official_initials = 'AR', status = 'disabled',
           disabled_reason = 'left the company'
       WHERE id = $1`,
      [harness.users.at],
    );

    const history = await harness
      .http()
      .get(`/api/storage-units/${unit.suNumber}/print-history`)
      .set('Cookie', lab);
    expect(history.status).toBe(200);
    expect(printHistoryResponseSchema.parse(history.body).jobs[0]!.receiver).toEqual({
      userId: harness.users.at,
      initials: 'AT',
      name: 'Alex Tester',
    });

    const job = await harness.http().get(`/api/print-jobs/${jobId}`).set('Cookie', lab);
    expect(job.status).toBe(200);
    expect(printJobSchema.parse(job.body).receiver).toEqual({
      userId: harness.users.at,
      initials: 'AT',
      name: 'Alex Tester',
    });

    // The snapshot is on the job row itself.
    const { rows } = await harness.db.pool.query(
      'SELECT receiver_initials_snapshot, receiver_name_snapshot FROM print_job WHERE id = $1',
      [jobId],
    );
    expect(rows).toEqual([
      { receiver_initials_snapshot: 'AT', receiver_name_snapshot: 'Alex Tester' },
    ]);
  });
});

describe.runIf(testDatabaseUrl)('print jobs from before MM-T65 (T2/AC2)', () => {
  let db: TestSchema;

  beforeAll(async () => {
    // Migrate up to, but not including, the print job receiver snapshot migration, so jobs and
    // events can be written the way the API wrote them before it.
    const migrations = await readMigrations();
    const cut = migrations.findIndex((m) => m.name === 'print_job_receiver_snapshot');
    expect(cut).toBeGreaterThan(0);
    db = await createMigratedSchema(migrations.slice(0, cut));
    await runSeed(db.pool, 'reference', 'test');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('uses the print-requested audit snapshot, then the receipt snapshot, then the live user', async () => {
    const receiver = await insertUser(db.pool, 'AT'); // "Test AT", the receipt's snapshot
    const audited = await insertUser(db.pool, 'AU');
    const other = await insertUser(db.pool, 'OT');
    const projectId = await insertProject(db.pool, 'DEMO-2601', receiver);
    const receiptId = await insertReceipt(db.pool, projectId, receiver);
    const unitId = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId: await receivingLabId(db.pool) },
      { readableId: 'BKT-2026-000021' },
    );
    await db.pool.query(
      `INSERT INTO printer (key, name, host) VALUES ('receiving', 'Receiving', '10.0.0.5')`,
    );
    const legacyJob = async (receiverId: string, createdAt: string, status = 'sent') => {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                                receiver_user_id, status, attempts, sent_at, created_at)
         VALUES ('initial', 'receiving', 'sticker-v1', $1, $1, $2, 1,
                 CASE WHEN $2 = 'sent' THEN $3::timestamptz END, $3)
         RETURNING id`,
        [receiverId, status, createdAt],
      );
      const jobId = rows[0]!.id;
      await db.pool.query(
        `INSERT INTO print_job_item (print_job_id, storage_unit_id, position) VALUES ($1, $2, 1)`,
        [jobId, unitId],
      );
      return jobId;
    };
    // MM-T56 era: the print-requested event carries the receiver as they were.
    const fromAudit = await legacyJob(audited, '2026-10-26T12:00:00Z');
    await db.pool.query(
      `INSERT INTO audit_event (action, entity_type, entity_id, actor_account_type,
                                actor_name_snapshot, receiver_user_id,
                                receiver_initials_snapshot, receiver_name_snapshot)
       VALUES ('label.print_requested', 'print_job', $1, 'shared_lab', 'LAB', $2, 'AU',
               'Audrey Audited')`,
      [fromAudit, audited],
    );
    // Before MM-T56: no event snapshot, but the receipt's receiver is credited.
    const fromReceipt = await legacyJob(receiver, '2026-10-25T12:00:00Z', 'uncertain');
    // Before MM-T56, crediting someone else: only the live user is known.
    const live = await legacyJob(other, '2026-10-24T12:00:00Z');

    await migrate(db.pool);
    await db.pool.query(
      `UPDATE app_user SET display_name = 'Renamed ' || display_name, official_initials = 'RN'`,
    );

    const history = (await getPrintHistory(db.pool, 'BKT-2026-000021'))!;
    const receivers = Object.fromEntries(history.jobs.map((job) => [job.id, job.receiver]));
    expect(receivers).toEqual({
      [fromAudit]: { userId: audited, initials: 'AU', name: 'Audrey Audited' },
      [fromReceipt]: { userId: receiver, initials: 'AT', name: 'Test AT' },
      [live]: { userId: other, initials: 'RN', name: 'Renamed Test OT' },
    });

    // An older job without any snapshot can still be updated, e.g. marked as printed.
    await expect(
      db.pool.query(
        `UPDATE print_job SET physically_confirmed_at = now(), physically_confirmed_by_user_id = $2
         WHERE id = $1`,
        [live, other],
      ),
    ).resolves.toBeTruthy();
    expect((await getPrintJob(db.pool, live))!.receiver).toMatchObject({ initials: 'RN' });
  });
});
