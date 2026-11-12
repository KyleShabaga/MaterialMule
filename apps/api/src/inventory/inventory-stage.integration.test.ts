import { inventoryQuerySchema, type InventoryItem } from '@materialmule/shared';
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
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { queryInventory } from './inventory.service.js';

// STRATA-58: every inventory row carries its record status and stage, derived from the database.
// Fictional data only (DEMO-2601). Units are received 2026-10-23, so retain-until is 2027-10-23.
describe.runIf(testDatabaseUrl)('inventory rows: record status and stage (STRATA-58)', () => {
  let db: TestSchema;
  const unit: Record<string, string> = {};

  async function addLocation(code: string, kind: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $1, $2) RETURNING id`,
      [code, kind],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    const user = await insertUser(db.pool, 'PE');
    const projectId = await insertProject(db.pool, 'DEMO-2601', user);
    const receiptId = await insertReceipt(db.pool, projectId, user, 6);
    const receiving = await receivingLabId(db.pool);
    const lab = await addLocation('LAB-01', 'lab');
    const shelf = await addLocation('A-01', 'warehouse');
    const add = async (key: string, n: number, locationId: string) => {
      unit[key] = await insertStorageUnit(
        db.pool,
        { projectId, receiptId, locationId },
        { readableId: `BKT-2026-00000${n}` },
      );
    };
    await add('received', 1, receiving);
    await add('lab', 2, lab);
    await add('shelf', 3, shelf);
    await add('disposed', 4, shelf);
    await add('conflict', 5, shelf);
    await add('held', 6, shelf);

    await db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [
      unit.disposed,
    ]);
    await db.pool.query(
      `INSERT INTO location_conflict (storage_unit_id, saved_location_id, saved_version)
       VALUES ($1, $2, 1)`,
      [unit.conflict, shelf],
    );
    const { rows: hold } = await db.pool.query<{ id: string }>(
      `INSERT INTO retention_hold (project_id, scope, reason, placed_by_user_id,
                                   placed_by_name_snapshot, idempotency_key, request_hash)
       VALUES ($1, 'units', 'Fictional dispute', $2, 'Test PE', gen_random_uuid(), 'hash')
       RETURNING id`,
      [projectId, user],
    );
    await db.pool.query(
      'INSERT INTO retention_hold_unit (hold_id, storage_unit_id) VALUES ($1, $2)',
      [hold[0]!.id, unit.held],
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function rowsAsOf(asOf: string): Promise<Map<string, InventoryItem>> {
    const page = await queryInventory(
      db.pool,
      inventoryQuerySchema.parse({ status: 'all', pageSize: '100' }),
      asOf,
    );
    return new Map(page.items.map((item) => [item.id, item]));
  }

  function statusOf(rows: Map<string, InventoryItem>, key: string) {
    const row = rows.get(unit[key]!)!;
    return { recordStatus: row.recordStatus, stage: row.stage };
  }

  it('derives the status from location kind, conflicts and disposal before retention ends', async () => {
    const rows = await rowsAsOf('2026-11-12');
    expect(statusOf(rows, 'received')).toEqual({ recordStatus: 'received', stage: 'draft' });
    expect(statusOf(rows, 'lab')).toEqual({ recordStatus: 'in_lab', stage: 'lab' });
    // Locations have no storage term yet: a stored unit reads Short-term.
    expect(statusOf(rows, 'shelf')).toEqual({ recordStatus: 'short_term', stage: 'storage' });
    expect(statusOf(rows, 'disposed')).toEqual({ recordStatus: 'disposed', stage: 'closed' });
    expect(statusOf(rows, 'conflict')).toEqual({
      recordStatus: 'location_conflict',
      stage: 'danger',
    });
    expect(statusOf(rows, 'held')).toEqual({ recordStatus: 'short_term', stage: 'storage' });
  });

  it('marks retention due on the retain-until date and overdue after it', async () => {
    const due = await rowsAsOf('2027-10-23');
    expect(statusOf(due, 'shelf')).toEqual({ recordStatus: 'retention_due', stage: 'due' });
    expect(statusOf(due, 'lab')).toEqual({ recordStatus: 'retention_due', stage: 'due' });
    const overdue = await rowsAsOf('2027-10-24');
    expect(statusOf(overdue, 'shelf')).toEqual({
      recordStatus: 'retention_overdue',
      stage: 'danger',
    });
    // A day earlier it is still on the shelf.
    expect(statusOf(await rowsAsOf('2027-10-22'), 'shelf')).toEqual({
      recordStatus: 'short_term',
      stage: 'storage',
    });
  });

  it('keeps disposal and open conflicts ahead of retention, and holds pause it', async () => {
    const overdue = await rowsAsOf('2027-10-24');
    expect(statusOf(overdue, 'disposed').recordStatus).toBe('disposed');
    expect(statusOf(overdue, 'conflict').recordStatus).toBe('location_conflict');
    expect(statusOf(overdue, 'held')).toEqual({ recordStatus: 'short_term', stage: 'storage' });
  });

  it('sends a status on every row', async () => {
    const rows = await rowsAsOf('2026-11-12');
    expect(rows.size).toBe(6);
    for (const row of rows.values()) {
      expect(row.recordStatus).toBeDefined();
      expect(row.stage).toBeDefined();
    }
  });
});
