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
  insertUser,
  PG,
  receivingLabId,
} from '../test-support/fixtures.js';

// STRATA-90/91 (migration 0046): the disposal list and a hold's "until" date. Every rule proven in
// the database with fictional data only (DEMO-2601).

describe.runIf(testDatabaseUrl)('retention pipeline schema (0046)', () => {
  let db: TestSchema;
  let user: string;
  let project: string;
  let receipt: string;
  let location: string;
  let n = 0;

  async function unit(): Promise<string> {
    n += 1;
    return insertStorageUnit(
      db.pool,
      { projectId: project, receiptId: receipt, locationId: location },
      { readableId: `BKT-2026-${String(900000 + n)}` },
    );
  }

  const add = (unitId: string, projectId = project) =>
    db.pool.query<{ id: string }>(
      `INSERT INTO disposal_list_entry
         (storage_unit_id, project_id, added_by_user_id, added_by_name_snapshot, reason,
          idempotency_key, request_hash)
       VALUES ($1, $2, $3, 'Test AT', 'Report issued', $4, 'hash') RETURNING id`,
      [unitId, projectId, user, randomUUID()],
    );

  const remove = (entryId: string) =>
    db.pool.query(
      `UPDATE disposal_list_entry
       SET ended_at = now(), end_kind = 'removed', ended_by_user_id = $2,
           ended_by_name_snapshot = 'Test AT', end_reason = 'Keep it', end_idempotency_key = $3
       WHERE id = $1`,
      [entryId, user, randomUUID()],
    );

  beforeAll(async () => {
    db = await createMigratedSchema();
    user = await insertUser(db.pool, 'AT');
    project = await insertProject(db.pool, 'DEMO-2601', user);
    location = await receivingLabId(db.pool);
    receipt = await insertReceipt(db.pool, project, user, 50);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps at most one live entry per unit; a removed entry lets it go on again', async () => {
    const id = await unit();
    const first = await add(id);
    await expect(add(id)).rejects.toMatchObject({ code: PG.uniqueViolation });
    await remove(first.rows[0]!.id);
    await expect(add(id)).resolves.toBeDefined();
  });

  it('only a unit in stock, in its own project, goes on the list', async () => {
    const id = await unit();
    const other = await insertProject(db.pool, 'DEMO-2602', user);
    await expect(add(id, other)).rejects.toMatchObject({ code: PG.checkViolation });
    await db.pool.query(
      `UPDATE storage_unit SET status = 'approved_for_disposal', version = version + 1
       WHERE id = $1`,
      [id],
    );
    await expect(add(id)).rejects.toMatchObject({ code: PG.checkViolation });
  });

  it('an entry ends once, with the right facts; nothing else changes and nothing is deleted', async () => {
    const entry = (await add(await unit())).rows[0]!.id;
    // Removed needs who and why.
    await expect(
      db.pool.query(
        `UPDATE disposal_list_entry SET ended_at = now(), end_kind = 'removed' WHERE id = $1`,
        [entry],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    // Approved needs the approval.
    await expect(
      db.pool.query(
        `UPDATE disposal_list_entry SET ended_at = now(), end_kind = 'approved',
                ended_by_user_id = $2, ended_by_name_snapshot = 'Test AT' WHERE id = $1`,
        [entry, user],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      db.pool.query(`UPDATE disposal_list_entry SET reason = 'Changed' WHERE id = $1`, [entry]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await remove(entry);
    await expect(remove(entry)).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(
      db.pool.query('DELETE FROM disposal_list_entry WHERE id = $1', [entry]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('a hold may carry an until date; only a hold request may', async () => {
    const hold = await db.pool.query<{ hold_until: string }>(
      `INSERT INTO retention_hold (project_id, scope, reason, placed_by_user_id,
                                   placed_by_name_snapshot, idempotency_key, request_hash,
                                   hold_until)
       VALUES ($1, 'project', 'Claim review', $2, 'Test AT', $3, 'hash', '2027-03-31')
       RETURNING hold_until::text`,
      [project, user, randomUUID()],
    );
    expect(hold.rows[0]!.hold_until).toBe('2027-03-31');
    const request = (kind: string) =>
      db.pool.query(
        `INSERT INTO retention_request (project_id, kind, scope, extend_months, reason,
                                        requested_by_user_id, requested_by_name_snapshot,
                                        idempotency_key, request_hash, hold_until)
         VALUES ($1, $2, 'project', $3, 'Asked', $4, 'Test AT', $5, 'hash', '2027-03-31')`,
        [project, kind, kind === 'extension' ? 6 : null, user, randomUUID()],
      );
    await expect(request('hold')).resolves.toBeDefined();
    await expect(request('extension')).rejects.toMatchObject({ code: PG.checkViolation });
  });
});
