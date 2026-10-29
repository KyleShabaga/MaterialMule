import { storageUnitHistoryPageSchema } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { bootReceivingHarness, type ReceivingHarness } from '../test-support/receiving-harness.js';

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
