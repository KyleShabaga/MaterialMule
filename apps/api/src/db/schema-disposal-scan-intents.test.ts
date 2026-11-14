import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  PG,
  receivingLabId,
} from '../test-support/fixtures.js';

// STRATA-92 (migration 0047): disposal scan intents. One row per intent ID, written once and never
// changed; a personal account only; not_found has no unit and every other result has one; a
// disposed intent needs its disposal_removal row (same key, unit and remover). Fictional data.

const LAB_ID = '00000000-0000-4000-8000-000000000001';

describe.runIf(testDatabaseUrl)('disposal scan intents (0047)', () => {
  let db: TestSchema;
  let alex: string;
  let unit: string;

  const insert = (intentId: string, userId: string, result: string, unitId: string | null) =>
    db.pool.query(
      `INSERT INTO disposal_scan_intent
         (intent_id, user_id, request_hash, storage_unit_id, result, outcome, scanned_at)
       VALUES ($1, $2, 'h', $3, $4, '{}'::jsonb, now())`,
      [intentId, userId, unitId, result],
    );

  beforeAll(async () => {
    db = await createMigratedSchema();
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Alex Tester', 'AT', 'personal', 'active') RETURNING id`,
    );
    alex = rows[0]!.id;
    await db.pool.query(
      `INSERT INTO app_user (id, display_name, account_type, status)
       VALUES ($1, 'LAB', 'shared_lab', 'active') ON CONFLICT (id) DO NOTHING`,
      [LAB_ID],
    );
    const project = await insertProject(db.pool, 'DEMO-2601', alex);
    const receipt = await insertReceipt(db.pool, project, alex, 1);
    unit = await insertStorageUnit(
      db.pool,
      {
        projectId: project,
        receiptId: receipt,
        locationId: await receivingLabId(db.pool),
      },
      { readableId: 'BKT-2026-000001' },
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps one row per intent, never changed or deleted', async () => {
    const id = randomUUID();
    await insert(id, alex, 'blocked', unit);
    await expect(insert(id, alex, 'blocked', unit)).rejects.toMatchObject({
      code: PG.uniqueViolation,
    });
    await expect(
      db.pool.query(
        `UPDATE disposal_scan_intent SET result = 'not_approved' WHERE intent_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(
      db.pool.query('DELETE FROM disposal_scan_intent WHERE intent_id = $1', [id]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('not_found has no unit; every other result has one; results are the four scan results', async () => {
    await expect(insert(randomUUID(), alex, 'not_found', null)).resolves.toBeDefined();
    await expect(insert(randomUUID(), alex, 'not_found', unit)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(insert(randomUUID(), alex, 'not_approved', null)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(insert(randomUUID(), alex, 'other_account', unit)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
  });

  it('is never recorded by the shared LAB account', async () => {
    await expect(insert(randomUUID(), LAB_ID, 'blocked', unit)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
  });

  it('a disposed intent needs its disposal record', async () => {
    await expect(insert(randomUUID(), alex, 'disposed', unit)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
  });
});
