import { inventoryListQuerySchema, type InventoryStageCounts } from '@materialmule/shared';
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
  insertSummary,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { queryInventory } from './inventory.service.js';

// STRATA-79: stage tabs, their counts under the same filters, the new heading sorts and paging,
// all on the server. Fictional data only (DEMO-2601, DEMO-2602, TH26-01). Today is 2026-11-13.
const TODAY = '2026-11-13';

describe.runIf(testDatabaseUrl)('inventory list: stage tabs and counts (STRATA-79)', () => {
  let db: TestSchema;
  const unit: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function addLocation(
    code: string,
    kind: string,
    extra: { parent?: string; term?: string } = {},
  ): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind, parent_location_id, storage_term)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [code, `Place ${code}`, kind, extra.parent ?? null, extra.term ?? null],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    const user = await insertUser(db.pool, 'PE');
    const p1 = await insertProject(db.pool, 'DEMO-2601', user);
    const p2 = await insertProject(db.pool, 'DEMO-2602', user);
    const r1 = await insertReceipt(db.pool, p1, user, 6);
    const r2 = await insertReceipt(db.pool, p2, user, 3);
    const receiving = await receivingLabId(db.pool);
    const lab = await addLocation('LAB-01', 'lab');
    // Short-term warehouse with a shelf that inherits; long-term warehouse › bay › shelf.
    const whShort = await addLocation('WH-S', 'warehouse', { term: 'short_term' });
    const shortShelf = await addLocation('WH-S-S1', 'warehouse', { parent: whShort });
    const whLong = await addLocation('WH-L', 'warehouse', { term: 'long_term' });
    const bay = await addLocation('WH-L-B1', 'warehouse', { parent: whLong });
    const longShelf = await addLocation('WH-L-B1-S1', 'warehouse', { parent: bay });
    Object.assign(ids, { p1, p2, shortShelf, longShelf });
    const hole = await insertTestHole(db.pool, p1, 'TH26-01');
    ids.hole = hole;

    const add = async (
      key: string,
      readableId: string,
      projectId: string,
      receiptId: string,
      locationId: string,
      unitType: 'bucket' | 'shelby_tube' = 'bucket',
    ) => {
      unit[key] = await insertStorageUnit(
        db.pool,
        { projectId, receiptId, locationId },
        {
          readableId,
          unitType,
          issuedHolderKind: unitType,
        },
      );
    };
    await add('received', 'BKT-2026-000001', p1, r1, receiving);
    await add('lab', 'ST-2026-000001', p1, r1, lab, 'shelby_tube');
    await add('short1', 'BKT-2026-000002', p1, r1, shortShelf);
    await add('short2', 'BKT-2026-000003', p1, r1, shortShelf);
    await add('long', 'ST-2026-000002', p2, r2, longShelf, 'shelby_tube');
    await add('conflict', 'BKT-2026-000004', p1, r1, shortShelf);
    await add('disposed', 'BKT-2026-000005', p2, r2, longShelf);
    await add('due', 'BKT-2026-000006', p2, r2, longShelf);
    await add('overdue', 'BKT-2026-000007', p1, r1, shortShelf);
    await insertSummary(
      db.pool,
      { storageUnitId: unit.short2!, projectId: p1, testHoleId: hole },
      { type: 'all' },
    );

    await db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [
      unit.disposed,
    ]);
    await db.pool.query(
      `INSERT INTO location_conflict (storage_unit_id, saved_location_id, saved_version)
       VALUES ($1, $2, 1)`,
      [unit.conflict, shortShelf],
    );
    // Retain until = received + 1 year: due today, and overdue since 2026-11-01.
    await db.pool.query(`UPDATE storage_unit SET received_date = '2025-11-13' WHERE id = $1`, [
      unit.due,
    ]);
    await db.pool.query(`UPDATE storage_unit SET received_date = '2025-11-01' WHERE id = $1`, [
      unit.overdue,
    ]);
  });

  afterAll(async () => {
    await db?.drop();
  });

  const list = (input: Record<string, string>) =>
    queryInventory(db.pool, inventoryListQuerySchema.parse({ pageSize: '100', ...input }), TODAY);

  const keysOf = (itemIds: string[]) =>
    itemIds.map((id) => Object.entries(unit).find(([, value]) => value === id)?.[0]).sort();

  const counts = async (input: Record<string, string> = {}): Promise<InventoryStageCounts> =>
    (await list({ ...input, counts: '1' })).stageCounts!;

  it('counts every tab in one query; All includes disposed and units awaiting put-away', async () => {
    expect(await counts()).toEqual({
      all: 9,
      in_lab: 1,
      short_term: 2,
      long_term: 1,
      retention_due: 2,
      disposed: 1,
      conflicts: 1,
    });
    // Without counts=1 no counts are sent.
    expect((await list({ stage: 'all' })).stageCounts).toBeUndefined();
  });

  it('shows each tab’s units, Short-term and Long-term by the effective storage term', async () => {
    const tab = async (stage: string) => keysOf((await list({ stage })).items.map((i) => i.id));
    expect(await tab('in_lab')).toEqual(['lab']);
    expect(await tab('short_term')).toEqual(['short1', 'short2']);
    // ST-2026-000002 sits on a shelf whose term comes from its warehouse two levels up.
    expect(await tab('long_term')).toEqual(['long']);
    expect(await tab('retention_due')).toEqual(['due', 'overdue']);
    expect(await tab('disposed')).toEqual(['disposed']);
    expect(await tab('conflicts')).toEqual(['conflict']);
    expect((await tab('all')).length).toBe(9);
    const page = await list({ stage: 'retention_due' });
    expect(new Set(page.items.map((i) => i.recordStatus))).toEqual(
      new Set(['retention_due', 'retention_overdue']),
    );
    expect(page.total).toBe(2);
  });

  it('moves a unit between Short-term and Long-term when its warehouse term changes', async () => {
    const shortWarehouse = (
      await db.pool.query<{ id: string }>(`SELECT id FROM location WHERE code = 'WH-S'`)
    ).rows[0]!.id;
    await db.pool.query(`UPDATE location SET storage_term = 'long_term' WHERE id = $1`, [
      shortWarehouse,
    ]);
    try {
      const c = await counts();
      expect(c.short_term).toBe(0);
      expect(c.long_term).toBe(3);
    } finally {
      await db.pool.query(`UPDATE location SET storage_term = 'short_term' WHERE id = $1`, [
        shortWarehouse,
      ]);
    }
  });

  it('honours every filter in the counts as well as the rows', async () => {
    expect(await counts({ projectId: ids.p1! })).toEqual({
      all: 6,
      in_lab: 1,
      short_term: 2,
      long_term: 0,
      retention_due: 1,
      disposed: 0,
      conflicts: 1,
    });
    expect((await counts({ type: 'bucket' })).all).toBe(7);
    expect(await counts({ locationId: ids.shortShelf! })).toMatchObject({
      all: 4,
      short_term: 2,
      retention_due: 1,
      conflicts: 1,
      in_lab: 0,
    });
    expect(await counts({ testHoleId: ids.hole! })).toMatchObject({ all: 1, short_term: 1 });
    expect(await counts({ receivedFrom: '2026-01-01' })).toMatchObject({
      all: 7,
      retention_due: 0,
    });
    expect(await counts({ receivedTo: '2025-12-31' })).toMatchObject({
      all: 2,
      retention_due: 2,
    });
    expect(await counts({ retention: 'eligible_by_date' })).toMatchObject({
      all: 2,
      retention_due: 2,
    });
    expect(await counts({ search: 'st-2026-000002' })).toMatchObject({ all: 1, long_term: 1 });
    // A tab and a filter together: the rows honour both, the counts only the filter.
    const page = await list({ stage: 'short_term', projectId: ids.p1!, counts: '1' });
    expect(page.total).toBe(2);
    expect(page.stageCounts!.all).toBe(6);
  });

  it('ignores the older status parameter while the tabs are in use', async () => {
    expect((await list({ stage: 'all', status: 'current' })).total).toBe(9);
    // Without a tab it still means Current stock.
    expect((await list({})).total).toBe(8);
  });

  it('sorts by stage in lifecycle order, by where, project and type, with the ID tie-breaker', async () => {
    const order = async (input: Record<string, string>) =>
      (await list({ stage: 'all', ...input })).items.map((i) => i.readableId);
    expect(await order({ sort: 'stage' })).toEqual([
      'BKT-2026-000001', // received
      'ST-2026-000001', // in lab
      'BKT-2026-000002', // short-term
      'BKT-2026-000003',
      'ST-2026-000002', // long-term
      'BKT-2026-000006', // retention due
      'BKT-2026-000007', // overdue
      'BKT-2026-000005', // disposed
      'BKT-2026-000004', // conflict
    ]);
    const byWhere = await order({ sort: 'where', dir: 'desc' });
    expect(byWhere.slice(0, 3)).toEqual(['BKT-2026-000007', 'BKT-2026-000004', 'BKT-2026-000003']);
    const byProject = await order({ sort: 'project' });
    expect(
      byProject
        .slice(0, 6)
        .every((id) => !['ST-2026-000002', 'BKT-2026-000005', 'BKT-2026-000006'].includes(id)),
    ).toBe(true);
    const byType = await order({ sort: 'type' });
    expect(byType.slice(0, 7).every((id) => id.startsWith('BKT-'))).toBe(true);
    expect(byType.slice(7)).toEqual(['ST-2026-000001', 'ST-2026-000002']);
  });

  it('pages without overlap or gaps under every sort', async () => {
    for (const sort of ['received', 'id', 'retain_until', 'project', 'type', 'where', 'stage']) {
      const seen: string[] = [];
      for (let page = 1; page <= 4; page += 1) {
        const result = await list({ stage: 'all', sort, page: String(page), pageSize: '3' });
        expect(result.total).toBe(9);
        seen.push(...result.items.map((i) => i.readableId));
      }
      expect(seen).toHaveLength(9);
      expect(new Set(seen).size).toBe(9);
    }
  });

  it('sends the location path from the warehouse down', async () => {
    const page = await list({ stage: 'long_term' });
    expect(page.items[0]!.locationPath).toEqual([
      'Place WH-L',
      'Place WH-L-B1',
      'Place WH-L-B1-S1',
    ]);
    const lab = await list({ stage: 'in_lab' });
    expect(lab.items[0]!.locationPath).toEqual(['Place LAB-01']);
  });
});
