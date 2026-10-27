import {
  confirmReceiptResponseSchema,
  printHistoryResponseSchema,
  printJobSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/policy.js';
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
import {
  bootReceivingHarness,
  LAB_ID,
  type ReceivingHarness,
} from '../test-support/receiving-harness.js';
import { confirmPhysicalPrint, getPrintHistory, getPrintJob } from './print-queue.js';

// MM-T65: print history shows the receiver, the requester and the confirmer of each job as they
// were at the time (Kyle, 2026-10-27: "Yes, all three"), like unit history does since MM-T56.
// Fictional data only: DEMO-2601, Alex Tester, Pat Example.

describe.runIf(testDatabaseUrl)('print history people (MM-T65)', () => {
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

  it('T1/AC1: after people are renamed, re-initialled and disabled, jobs keep them as they were', async () => {
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
    const readJob = async () =>
      printJobSchema.parse(
        (await harness.http().get(`/api/print-jobs/${jobId}`).set('Cookie', lab)).body,
      );
    await expect.poll(async () => (await readJob()).status, { timeout: 10_000 }).toBe('sent');

    // Pat Example confirms the labels came out.
    const confirmedPrint = await harness
      .http()
      .post(`/api/print-jobs/${jobId}/confirm-physical`)
      .set('Cookie', await harness.cookieFor('pe'))
      .set(CSRF_HEADER, '1');
    expect(confirmedPrint.status).toBe(200);
    const before = await readJob();
    expect(before.physicallyConfirmedBy).toEqual({
      userId: harness.users.pe,
      initials: 'PE',
      name: 'Pat Example',
    });

    await harness.db.pool.query(
      `UPDATE app_user SET display_name = 'Renamed ' || display_name, official_initials = 'RN'
       WHERE id = ANY($1::uuid[])`,
      [[harness.users.at, harness.users.pe, LAB_ID]],
    );
    await harness.db.pool.query(
      `UPDATE app_user SET status = 'disabled', disabled_reason = 'left the company'
       WHERE id = ANY($1::uuid[])`,
      [[harness.users.at, harness.users.pe]],
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

    const after = await readJob();
    expect(after.receiver).toEqual({
      userId: harness.users.at,
      initials: 'AT',
      name: 'Alex Tester',
    });
    expect(after.requestedBy).toEqual(before.requestedBy);
    expect(after.requestedBy.name).not.toMatch(/Renamed/);
    expect(after.physicallyConfirmedBy).toEqual(before.physicallyConfirmedBy);

    // The snapshots are on the job row itself.
    const { rows } = await harness.db.pool.query(
      `SELECT receiver_initials_snapshot, receiver_name_snapshot, confirmed_by_initials_snapshot,
              confirmed_by_name_snapshot
       FROM print_job WHERE id = $1`,
      [jobId],
    );
    expect(rows).toEqual([
      {
        receiver_initials_snapshot: 'AT',
        receiver_name_snapshot: 'Alex Tester',
        confirmed_by_initials_snapshot: 'PE',
        confirmed_by_name_snapshot: 'Pat Example',
      },
    ]);
  });
});

describe.runIf(testDatabaseUrl)('print jobs from before MM-T65 (T2/AC2)', () => {
  let db: TestSchema;

  beforeAll(async () => {
    // Migrate up to, but not including, the print job snapshot migration, so jobs and events can
    // be written the way the API wrote them before it.
    const migrations = await readMigrations();
    const cut = migrations.findIndex((m) => m.name === 'print_job_people_snapshots');
    expect(cut).toBeGreaterThan(0);
    db = await createMigratedSchema(migrations.slice(0, cut));
    await runSeed(db.pool, 'reference', 'test');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('uses the audit snapshots, then the receipt snapshot, then the live user', async () => {
    const receiver = await insertUser(db.pool, 'AT'); // "Test AT", the receipt's snapshot
    const audited = await insertUser(db.pool, 'AU');
    const other = await insertUser(db.pool, 'OT');
    const requester = await insertUser(db.pool, 'RQ');
    const confirmer = await insertUser(db.pool, 'CF');
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
         VALUES ('initial', 'receiving', 'sticker-v1', $1, $2, $3, 1,
                 CASE WHEN $3 = 'sent' THEN $4::timestamptz END, $4)
         RETURNING id`,
        [requester, receiverId, status, createdAt],
      );
      const jobId = rows[0]!.id;
      await db.pool.query(
        `INSERT INTO print_job_item (print_job_id, storage_unit_id, position) VALUES ($1, $2, 1)`,
        [jobId, unitId],
      );
      return jobId;
    };
    const legacyConfirm = (jobId: string) =>
      db.pool.query(
        `UPDATE print_job SET physically_confirmed_at = now(), physically_confirmed_by_user_id = $2
         WHERE id = $1`,
        [jobId, confirmer],
      );

    // MM-T56 era: the print-requested event has the requester and receiver as they were.
    const fromAudit = await legacyJob(audited, '2026-10-26T12:00:00Z');
    await db.pool.query(
      `INSERT INTO audit_event (action, entity_type, entity_id, actor_user_id, actor_account_type,
                                actor_initials_snapshot, actor_name_snapshot, receiver_user_id,
                                receiver_initials_snapshot, receiver_name_snapshot)
       VALUES ('label.print_requested', 'print_job', $1, $2, 'personal', 'RQ', 'Riley Requester',
               $3, 'AU', 'Audrey Audited')`,
      [fromAudit, requester, audited],
    );
    // Before MM-T56: no event for the request, but the receipt's receiver is credited. Its
    // confirmation event has the confirmer as they were.
    const fromReceipt = await legacyJob(receiver, '2026-10-25T12:00:00Z', 'uncertain');
    await legacyConfirm(fromReceipt);
    await db.pool.query(
      `INSERT INTO audit_event (action, entity_type, entity_id, actor_user_id, actor_account_type,
                                actor_initials_snapshot, actor_name_snapshot)
       VALUES ('label.physically_confirmed', 'print_job', $1, $2, 'personal', 'CF',
               'Casey Confirmer')`,
      [fromReceipt, confirmer],
    );
    // Crediting someone else, with no events: only the people as they are now are known.
    const live = await legacyJob(other, '2026-10-24T12:00:00Z');
    await legacyConfirm(live);

    await migrate(db.pool);
    await db.pool.query(
      `UPDATE app_user SET display_name = 'Renamed ' || display_name, official_initials = 'RN'`,
    );

    const history = (await getPrintHistory(db.pool, 'BKT-2026-000021'))!;
    const people = Object.fromEntries(
      history.jobs.map((job) => [
        job.id,
        {
          receiver: job.receiver,
          requestedBy: job.requestedBy,
          confirmedBy: job.physicallyConfirmedBy,
        },
      ]),
    );
    const renamed = (userId: string, initials: string) => ({
      userId,
      initials: 'RN',
      name: `Renamed Test ${initials}`,
    });
    expect(people).toEqual({
      [fromAudit]: {
        receiver: { userId: audited, initials: 'AU', name: 'Audrey Audited' },
        requestedBy: { userId: requester, initials: 'RQ', name: 'Riley Requester' },
        confirmedBy: null,
      },
      [fromReceipt]: {
        receiver: { userId: receiver, initials: 'AT', name: 'Test AT' },
        requestedBy: renamed(requester, 'RQ'),
        confirmedBy: { userId: confirmer, initials: 'CF', name: 'Casey Confirmer' },
      },
      [live]: {
        receiver: renamed(other, 'OT'),
        requestedBy: renamed(requester, 'RQ'),
        confirmedBy: renamed(confirmer, 'CF'),
      },
    });

    // Older jobs without snapshots can still change, and a new confirmation is snapshotted.
    await expect(
      db.pool.query(`UPDATE print_job SET updated_at = now() WHERE id = ANY($1::uuid[])`, [
        [fromReceipt, live],
      ]),
    ).resolves.toBeTruthy();
    const confirming: AuthUser = {
      userId: other,
      sessionId: 's',
      accountType: 'test',
      status: 'active',
      roles: [],
      displayName: 'Renamed Test OT',
      initials: 'RN',
    };
    await confirmPhysicalPrint(db.pool, confirming, fromAudit, null);
    await db.pool.query(`UPDATE app_user SET display_name = 'Later' WHERE id = $1`, [other]);
    expect((await getPrintJob(db.pool, fromAudit))!.physicallyConfirmedBy).toEqual({
      userId: other,
      initials: 'RN',
      name: 'Renamed Test OT',
    });
  });
});
