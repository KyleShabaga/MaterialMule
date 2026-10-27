import { storageUnitHistoryPageSchema } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, readMigrations } from '../db/migrator.js';
import { runSeed } from '../db/seed.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { bootReceivingHarness, type ReceivingHarness } from '../test-support/receiving-harness.js';
import { getStorageUnitHistory } from './storage-units.service.js';

// MM-T56: a unit's history shows the receiver as they were at the time of each event, like the
// receipt and unit detail do. Fictional data only: DEMO-2601, TH26-01, Alex Tester (AT).

describe.runIf(testDatabaseUrl)('storage unit history receiver (MM-T56)', () => {
  let harness: ReceivingHarness;

  beforeAll(async () => {
    harness = await bootReceivingHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('T1/AC1: after the receiver is renamed, re-initialled and disabled, history keeps AT · Alex Tester', async () => {
    const lab = await harness.cookieFor('lab');
    const confirmed = await harness.postReceipt(harness.receipt(1), lab);
    expect(confirmed.status).toBe(201);
    const suNumber = (confirmed.body as { units: { suNumber: string }[] }).units[0]!.suNumber;

    const detailBefore = await harness
      .http()
      .get(`/api/storage-units/${suNumber}`)
      .set('Cookie', lab);

    await harness.db.pool.query(
      `UPDATE app_user
       SET display_name = 'Alex Renamed', official_initials = 'AR', status = 'disabled',
           disabled_reason = 'left the company'
       WHERE id = $1`,
      [harness.users.at],
    );

    const response = await harness
      .http()
      .get(`/api/storage-units/${suNumber}/history`)
      .set('Cookie', lab);
    expect(response.status).toBe(200);
    const history = storageUnitHistoryPageSchema.parse(response.body);
    expect(history.items.map((event) => event.action).sort()).toEqual([
      'receipt.confirmed',
      'storage_unit.created',
    ]);
    for (const event of history.items) {
      expect(event.receiver).toEqual({ initials: 'AT', name: 'Alex Tester' });
    }

    // Receipt and unit detail output doesn't change.
    const detailAfter = await harness
      .http()
      .get(`/api/storage-units/${suNumber}`)
      .set('Cookie', lab);
    expect(detailAfter.body).toEqual(detailBefore.body);
    expect(detailAfter.body).toMatchObject({
      receipt: { receiver: { initials: 'AT', name: 'Alex Tester' } },
    });

    // The snapshots are on the audit rows themselves.
    const { rows } = await harness.db.pool.query(
      `SELECT action, receiver_initials_snapshot, receiver_name_snapshot FROM audit_event
       WHERE receiver_user_id = $1 ORDER BY action`,
      [harness.users.at],
    );
    expect(rows).toEqual([
      {
        action: 'receipt.confirmed',
        receiver_initials_snapshot: 'AT',
        receiver_name_snapshot: 'Alex Tester',
      },
      {
        action: 'storage_unit.created',
        receiver_initials_snapshot: 'AT',
        receiver_name_snapshot: 'Alex Tester',
      },
    ]);
  });
});

describe.runIf(testDatabaseUrl)('storage unit history before MM-T56 (T2/AC2)', () => {
  let db: TestSchema;

  beforeAll(async () => {
    // Migrate up to, but not including, the receiver snapshot migration, so events can be
    // written the way the API wrote them before it.
    const migrations = await readMigrations();
    const cut = migrations.findIndex((m) => m.name === 'audit_receiver_snapshot');
    expect(cut).toBeGreaterThan(0);
    db = await createMigratedSchema(migrations.slice(0, cut));
    await runSeed(db.pool, 'reference', 'test');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('falls back to the receipt snapshot, then to the live user for another receiver', async () => {
    const receiver = await insertUser(db.pool, 'AT'); // "Test AT", the receipt's snapshot
    const other = await insertUser(db.pool, 'OT');
    const projectId = await insertProject(db.pool, 'DEMO-2601', receiver);
    const receiptId = await insertReceipt(db.pool, projectId, receiver);
    const unitId = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId: await receivingLabId(db.pool) },
      { readableId: 'BKT-2026-000018' },
    );
    const legacy = (action: string, entityType: string, entityId: string, receiverId: string) =>
      db.pool.query(
        `INSERT INTO audit_event (occurred_at, action, entity_type, entity_id, actor_account_type,
                                  actor_name_snapshot, receiver_user_id)
         VALUES ($1, $2, $3, $4, 'shared_lab', 'LAB', $5)`,
        [
          action === 'storage_unit.flagged' ? '2026-10-25T12:00:00Z' : '2026-10-23T12:00:00Z',
          action,
          entityType,
          entityId,
          receiverId,
        ],
      );
    await legacy('receipt.confirmed', 'receipt', receiptId, receiver);
    await legacy('storage_unit.created', 'storage_unit', unitId, receiver);
    // An older event crediting someone other than the receipt's receiver.
    await legacy('storage_unit.flagged', 'storage_unit', unitId, other);

    await migrate(db.pool);
    await db.pool.query(
      `UPDATE app_user SET display_name = 'Casey Renamed QA-B', official_initials = 'CR'
       WHERE id = $1`,
      [receiver],
    );

    const history = (await getStorageUnitHistory(db.pool, 'BKT-2026-000018', 1))!;
    const receivers = Object.fromEntries(history.items.map((e) => [e.action, e.receiver]));
    expect(receivers).toEqual({
      'receipt.confirmed': { initials: 'AT', name: 'Test AT' },
      'storage_unit.created': { initials: 'AT', name: 'Test AT' },
      'storage_unit.flagged': { initials: 'OT', name: 'Test OT' },
    });
  });
});

describe.runIf(testDatabaseUrl)('storage unit history order (MM-T61)', () => {
  let harness: ReceivingHarness;

  beforeAll(async () => {
    harness = await bootReceivingHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('MM-T61: events of the same instant come out in the same order on every unit', async () => {
    const lab = await harness.cookieFor('lab');
    const confirmed = await harness.postReceipt(harness.receipt(3), lab);
    expect(confirmed.status).toBe(201);
    const units = (confirmed.body as { units: { suNumber: string }[] }).units;
    expect(units).toHaveLength(3);
    for (const unit of units) {
      const response = await harness
        .http()
        .get(`/api/storage-units/${unit.suNumber}/history`)
        .set('Cookie', lab);
      const history = storageUnitHistoryPageSchema.parse(response.body);
      // Newest first: the confirmation, then the unit's creation in the same transaction.
      expect(history.items.map((event) => event.action)).toEqual([
        'receipt.confirmed',
        'storage_unit.created',
      ]);
    }
  });
});
