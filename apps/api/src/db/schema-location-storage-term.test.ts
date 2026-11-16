import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, receivingLabId } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';

// STRATA-106 (migration 0043): storage term on locations, a warehouse › bay › shelf hierarchy and
// shelf capacity. Each rule proven in the database. Fictional location codes only.

const CHECK = (constraint: string) => ({ code: PG.checkViolation, constraint });

interface Effective {
  term: string | null;
  source: string;
  from_code: string | null;
}

describe.runIf(testDatabaseUrl)('location storage term and hierarchy (0043)', () => {
  let db: TestSchema;
  let seq = 0;

  async function add(
    options: {
      kind?: string;
      parent?: string | null;
      term?: string | null;
      capacity?: number | null;
      code?: string;
    } = {},
  ): Promise<string> {
    seq++;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind, parent_location_id, storage_term, capacity)
       VALUES ($1, $1, $2, $3, $4, $5) RETURNING id`,
      [
        options.code ?? `ST-L${seq}`,
        options.kind ?? 'warehouse',
        options.parent ?? null,
        options.term ?? null,
        options.capacity ?? null,
      ],
    );
    return rows[0]!.id;
  }

  const setParent = (id: string, parent: string | null) =>
    db.pool.query('UPDATE location SET parent_location_id = $2 WHERE id = $1', [id, parent]);
  const setTerm = (id: string, term: string | null) =>
    db.pool.query('UPDATE location SET storage_term = $2 WHERE id = $1', [id, term]);

  async function effective(id: string): Promise<Effective> {
    const { rows } = await db.pool.query<Effective>(
      `SELECT term, source, from_code FROM location_effective_storage_term WHERE location_id = $1`,
      [id],
    );
    return rows[0]!;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps the term to short_term or long_term and capacity to 1–200 (null is unknown)', async () => {
    await expect(add({ term: 'forever' })).rejects.toMatchObject(
      CHECK('location_storage_term_check'),
    );
    await expect(add({ capacity: 0 })).rejects.toMatchObject(CHECK('location_capacity_check'));
    await expect(add({ capacity: 201 })).rejects.toMatchObject(CHECK('location_capacity_check'));
    await expect(add({ capacity: 1 })).resolves.toBeDefined();
    await expect(add({ capacity: 200, term: 'long_term' })).resolves.toBeDefined();
    const unknown = await add();
    const { rows } = await db.pool.query(
      'SELECT storage_term, capacity, parent_location_id FROM location WHERE id = $1',
      [unknown],
    );
    expect(rows[0]).toEqual({ storage_term: null, capacity: null, parent_location_id: null });
  });

  it('refuses a location as its own parent and any cycle', async () => {
    const a = await add();
    await expect(setParent(a, a)).rejects.toMatchObject(CHECK('location_parent_not_self_check'));
    const b = await add({ parent: a });
    const c = await add({ parent: b });
    await expect(setParent(a, b)).rejects.toMatchObject(CHECK('location_parent_cycle_check'));
    await expect(setParent(a, c)).rejects.toMatchObject(CHECK('location_parent_cycle_check'));
    // Moving within its own chain to a non-descendant is fine: c straight under a.
    await expect(setParent(c, a)).resolves.toBeDefined();
  });

  it('nests at most three levels, counting the levels a reparented location already holds', async () => {
    const warehouse = await add();
    const bay = await add({ parent: warehouse });
    const shelf = await add({ parent: bay });
    await expect(add({ parent: shelf })).rejects.toMatchObject(
      CHECK('location_parent_depth_check'),
    );
    // A bay with a shelf (two levels) can go under a warehouse, not under another bay.
    const otherBay = await add();
    await add({ parent: otherBay });
    await expect(setParent(otherBay, bay)).rejects.toMatchObject(
      CHECK('location_parent_depth_check'),
    );
    await expect(setParent(otherBay, warehouse)).resolves.toBeDefined();
    // A warehouse holding a bay can't itself go under anything that would make four levels.
    const top = await add();
    await expect(setParent(warehouse, top)).rejects.toMatchObject(
      CHECK('location_parent_depth_check'),
    );
  });

  it('keeps the Receiving lab and lab locations outside the hierarchy, with no term', async () => {
    const receiving = await receivingLabId(db.pool);
    const warehouse = await add();
    await expect(setParent(receiving, warehouse)).rejects.toMatchObject(
      CHECK('location_lab_outside_hierarchy_check'),
    );
    await expect(setTerm(receiving, 'short_term')).rejects.toMatchObject(
      CHECK('location_lab_outside_hierarchy_check'),
    );
    await expect(add({ kind: 'lab', parent: warehouse })).rejects.toMatchObject(
      CHECK('location_lab_outside_hierarchy_check'),
    );
    await expect(add({ kind: 'lab', term: 'long_term' })).rejects.toMatchObject(
      CHECK('location_lab_outside_hierarchy_check'),
    );
    // Neither holds other locations.
    const bench = await add({ kind: 'lab' });
    await expect(add({ parent: bench })).rejects.toMatchObject(CHECK('location_parent_kind_check'));
    await expect(add({ parent: receiving })).rejects.toMatchObject(
      CHECK('location_parent_kind_check'),
    );
    // A location holding others can't become a lab; a childless one with no term can.
    await add({ parent: warehouse });
    await expect(
      db.pool.query(`UPDATE location SET kind = 'lab' WHERE id = $1`, [warehouse]),
    ).rejects.toMatchObject(CHECK('location_parent_kind_check'));
    const plain = await add();
    await expect(
      db.pool.query(`UPDATE location SET kind = 'lab' WHERE id = $1`, [plain]),
    ).resolves.toBeDefined();
    expect(await effective(receiving)).toEqual({ term: null, source: 'unset', from_code: null });
  });

  it('a retired location keeps its children but gains no new ones', async () => {
    const warehouse = await add();
    const kept = await add({ parent: warehouse });
    const elsewhere = await add();
    await db.pool.query(
      `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Fictional'
       WHERE id = $1`,
      [warehouse],
    );
    await expect(add({ parent: warehouse })).rejects.toMatchObject(
      CHECK('location_parent_retired_check'),
    );
    await expect(setParent(elsewhere, warehouse)).rejects.toMatchObject(
      CHECK('location_parent_retired_check'),
    );
    const { rows } = await db.pool.query('SELECT parent_location_id FROM location WHERE id = $1', [
      kept,
    ]);
    expect(rows[0]!.parent_location_id).toBe(warehouse);
  });

  it('resolves the nearest own term walking up, with no stored copy', async () => {
    const warehouse = await add({ code: 'ST-WH', term: 'long_term' });
    const bay = await add({ code: 'ST-WH-B1', parent: warehouse });
    const shelf = await add({ code: 'ST-WH-B1-S1', parent: bay });
    expect(await effective(warehouse)).toEqual({
      term: 'long_term',
      source: 'own',
      from_code: 'ST-WH',
    });
    expect(await effective(shelf)).toEqual({
      term: 'long_term',
      source: 'inherited',
      from_code: 'ST-WH',
    });

    // Bay override reaches its shelf; a shelf override wins over both.
    await setTerm(bay, 'short_term');
    expect(await effective(shelf)).toMatchObject({ term: 'short_term', from_code: 'ST-WH-B1' });
    await setTerm(shelf, 'long_term');
    expect(await effective(shelf)).toEqual({
      term: 'long_term',
      source: 'own',
      from_code: 'ST-WH-B1-S1',
    });

    // Clearing overrides falls back up the chain.
    await setTerm(shelf, null);
    await setTerm(bay, null);
    expect(await effective(shelf)).toMatchObject({ term: 'long_term', source: 'inherited' });

    // Changing the warehouse term changes every descendant.
    await setTerm(warehouse, 'short_term');
    expect(await effective(bay)).toMatchObject({ term: 'short_term', from_code: 'ST-WH' });
    expect(await effective(shelf)).toMatchObject({ term: 'short_term', from_code: 'ST-WH' });

    // Reparenting takes the new chain's term; a top-level location with none is unset.
    const other = await add({ code: 'ST-WX', term: 'long_term' });
    await setParent(bay, other);
    expect(await effective(shelf)).toMatchObject({ term: 'long_term', from_code: 'ST-WX' });
    await setParent(bay, null);
    expect(await effective(shelf)).toEqual({ term: null, source: 'unset', from_code: null });
  });

  it('serialises concurrent reparents, so two of them can never build a cycle', async () => {
    const a = await add();
    const b = await add();
    const first = await db.pool.connect();
    const second = await db.pool.connect();
    try {
      await first.query('BEGIN');
      await first.query('UPDATE location SET parent_location_id = $2 WHERE id = $1', [a, b]);
      await second.query('BEGIN');
      const racing = second
        .query('UPDATE location SET parent_location_id = $2 WHERE id = $1', [b, a])
        .then(
          () => 'saved',
          (error: unknown) => error,
        );
      await first.query('COMMIT');
      expect(await racing).toMatchObject(CHECK('location_parent_cycle_check'));
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
  });
});

describe.runIf(testDatabaseUrl)('location storage term migration of existing rows (0043)', () => {
  let db: TestSchema;

  beforeAll(async () => {
    db = await createTestSchema();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('leaves every existing location unset, never guessed from its name', async () => {
    const files = await readMigrations();
    await migrate(
      db.pool,
      files.filter((file) => file.version < '0043'),
    );
    await db.pool.query(
      `INSERT INTO location (code, name, kind) VALUES
         ('LT-01', 'Long-term warehouse', 'warehouse'),
         ('ST-01', 'Short-term staging', 'staging'),
         ('BENCH-01', 'Bench', 'lab')`,
    );
    await migrate(db.pool, files);
    const { rows } = await db.pool.query(
      `SELECT l.code, l.parent_location_id, l.storage_term, l.capacity, e.term, e.source
       FROM location l JOIN location_effective_storage_term e ON e.location_id = l.id
       WHERE l.code IN ('LT-01', 'ST-01', 'BENCH-01') ORDER BY l.code`,
    );
    expect(rows).toEqual(
      ['BENCH-01', 'LT-01', 'ST-01'].map((code) => ({
        code,
        parent_location_id: null,
        storage_term: null,
        capacity: null,
        term: null,
        source: 'unset',
      })),
    );
  });
});
