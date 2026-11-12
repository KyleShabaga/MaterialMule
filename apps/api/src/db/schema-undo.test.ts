import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  PG,
  insertProject,
  insertReceipt,
  insertStorageUnit,
  receivingLabId,
} from '../test-support/fixtures.js';

// STRATA-123 (migration 0041): the link between a saved move and the move that undid it, proven in
// the database. One reversal per original; a reversal is never itself undone (undo of an undo is
// not allowed) nor reused as an original; both are saved moves of the same unit by the same
// account (and LAB person); the reversal goes straight back from the original's result; the key
// is the reversal's client move ID; rows are append-only. Fictional data only (DEMO-2601).
describe.runIf(testDatabaseUrl)('movement reversal (STRATA-123, migration 0041)', () => {
  let db: TestSchema;
  let pat: string;
  let alex: string;
  let receiving: string;
  let shelf: string;
  let bench: string;
  let unit: string;
  let otherUnit: string;

  async function person(name: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', 'active') RETURNING id`,
      [name, name.slice(0, 2).toUpperCase()],
    );
    return rows[0]!.id;
  }

  async function location(code: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $1, 'warehouse') RETURNING id`,
      [code],
    );
    return rows[0]!.id;
  }

  async function move(
    unitId: string,
    from: string,
    to: string,
    base: number,
    actor = pat,
    kind: 'move' | 'contested' = 'move',
  ): Promise<{ id: string; clientMoveId: string }> {
    const clientMoveId = randomUUID();
    let conflictId: string | null = null;
    if (kind === 'contested') {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO location_conflict (storage_unit_id, saved_location_id, saved_version)
         VALUES ($1, $2, $3) RETURNING id`,
        [unitId, from, base],
      );
      conflictId = rows[0]!.id;
    }
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO movement_event (storage_unit_id, kind, from_location_id, to_location_id,
                                   base_version, resulting_version, actor_user_id,
                                   actor_account_type, actor_name_snapshot, station_id,
                                   scanned_at, source, client_move_id, conflict_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'personal', 'Fictional person', gen_random_uuid(),
               now(), 'online', $8, $9)
       RETURNING id`,
      [
        unitId,
        kind,
        from,
        to,
        base,
        kind === 'move' ? base + 1 : null,
        actor,
        clientMoveId,
        conflictId,
      ],
    );
    return { id: rows[0]!.id, clientMoveId };
  }

  const link = (
    original: string,
    reversal: { id: string; clientMoveId: string },
    account = pat,
    key = reversal.clientMoveId,
  ) =>
    db.pool.query(
      `INSERT INTO movement_reversal (original_event_id, reversal_event_id, idempotency_key,
                                      account_user_id)
       VALUES ($1, $2, $3, $4)`,
      [original, reversal.id, key, account],
    );

  const refused = (constraint: string) => ({ code: PG.checkViolation, constraint });

  beforeAll(async () => {
    db = await createMigratedSchema();
    pat = await person('Pat Example');
    alex = await person('Alex Tester');
    receiving = await receivingLabId(db.pool);
    shelf = await location('SH-A-01');
    bench = await location('LAB-B1');
    const projectId = await insertProject(db.pool, 'DEMO-2601', pat);
    const receiptId = await insertReceipt(db.pool, projectId, pat, 2);
    unit = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId: receiving },
      { readableId: 'BKT-2026-000001' },
    );
    otherUnit = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId: receiving },
      { readableId: 'BKT-2026-000002' },
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('links a move to the one move that took the unit straight back', async () => {
    const original = await move(unit, receiving, shelf, 1);
    const reversal = await move(unit, shelf, receiving, 2);
    await link(original.id, reversal);
    const { rows } = await db.pool.query(
      'SELECT reversal_event_id FROM movement_reversal WHERE original_event_id = $1',
      [original.id],
    );
    expect(rows).toEqual([{ reversal_event_id: reversal.id }]);
  });

  it('undoes an original at most once, and a reversal reverses one original', async () => {
    const original = await move(otherUnit, receiving, shelf, 1);
    const first = await move(otherUnit, shelf, receiving, 2);
    const second = await move(otherUnit, shelf, receiving, 2);
    await link(original.id, first);
    await expect(link(original.id, second)).rejects.toMatchObject({ code: PG.uniqueViolation });
  });

  it('never undoes an undo, nor reuses a reversal as an original', async () => {
    const a = await move(unit, receiving, bench, 3);
    const b = await move(unit, bench, receiving, 4);
    await link(a.id, b);
    // b (a reversal) can't be the original of another undo.
    const c = await move(unit, receiving, bench, 5);
    await expect(link(b.id, c)).rejects.toMatchObject(refused('movement_reversal_chain_check'));
    // A reversal can't be an event that is already an undone original.
    const d = await move(unit, bench, receiving, 6);
    const e = await move(unit, receiving, bench, 7);
    await link(c.id, d);
    await expect(link(e.id, c)).rejects.toMatchObject(refused('movement_reversal_chain_check'));
  });

  it('accepts only saved moves that go exactly back for the same unit', async () => {
    const original = await move(unit, receiving, shelf, 8);
    // Wrong destination, wrong unit, wrong base version.
    const elsewhere = await move(unit, shelf, bench, 9);
    await expect(link(original.id, elsewhere)).rejects.toMatchObject(
      refused('movement_reversal_shape_check'),
    );
    const otherUnits = await move(otherUnit, shelf, receiving, 9);
    await expect(link(original.id, otherUnits)).rejects.toMatchObject(
      refused('movement_reversal_shape_check'),
    );
    const stale = await move(unit, shelf, receiving, 12);
    await expect(link(original.id, stale)).rejects.toMatchObject(
      refused('movement_reversal_shape_check'),
    );
    // A contested attempt is neither undone nor an undo.
    const contested = await move(unit, shelf, receiving, 9, pat, 'contested');
    await expect(link(original.id, contested)).rejects.toMatchObject(
      refused('movement_reversal_kind_check'),
    );
    // A confirmation in place has nothing to undo.
    const inPlace = await move(unit, shelf, shelf, 9);
    const back = await move(unit, shelf, shelf, 10);
    await expect(link(inPlace.id, back)).rejects.toMatchObject(
      refused('movement_reversal_shape_check'),
    );
  });

  it('only the account that saved the move undoes it, with the reversal as the key', async () => {
    const original = await move(unit, receiving, shelf, 20);
    const byAlex = await move(unit, shelf, receiving, 21, alex);
    await expect(link(original.id, byAlex)).rejects.toMatchObject(
      refused('movement_reversal_actor_check'),
    );
    await expect(link(original.id, byAlex, alex)).rejects.toMatchObject(
      refused('movement_reversal_actor_check'),
    );
    const reversal = await move(unit, shelf, receiving, 21);
    await expect(link(original.id, reversal, pat, randomUUID())).rejects.toMatchObject(
      refused('movement_reversal_key_check'),
    );
  });

  it('is append-only: never updated or deleted', async () => {
    await expect(db.pool.query('DELETE FROM movement_reversal')).rejects.toMatchObject({
      code: PG.restrictViolation,
    });
    await expect(
      db.pool.query('UPDATE movement_reversal SET undone_at = now()'),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });
});
