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
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { runSeed } from './seed.js';

// Lab catalogue and program integrity rules (MM-T23), proved in the database itself. Fictional data.
describe.runIf(testDatabaseUrl)('lab programs schema (MM-T23)', () => {
  let db: TestSchema;
  let user: string;
  let projectA: string;
  let projectB: string;
  let holeA: string;
  let holeB: string;
  let unitA: string;
  let receiptA: string;
  let testType: string;

  const SOILS = '00000000-0000-4000-8000-00000000c101';
  const ADVANCED = '00000000-0000-4000-8000-00000000c102';

  async function program(projectId = projectA): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO lab_program (project_id, created_by_account_user_id, created_by_account_type,
                                requested_by_user_id, requested_by_name_snapshot,
                                create_idempotency_key)
       VALUES ($1, $2, 'test', $2, 'Test AT', gen_random_uuid()) RETURNING id`,
      [projectId, user],
    );
    return rows[0]!.id;
  }

  async function line(programId: string, holeId = holeA, projectId = projectA) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id, scope)
       VALUES ($1, $2, 1, 'test_hole', $3, 'all') RETURNING id`,
      [programId, projectId, holeId],
    );
    return rows[0]!.id;
  }

  const submitSql = (id: string) =>
    `UPDATE lab_program SET status = 'submitted', program_number = 'LP-2026-9999',
            submitted_at = now(), submitted_by_account_user_id = created_by_account_user_id,
            submitted_by_account_type = 'test', submitted_by_name_snapshot = 'Test AT',
            submitted_for_user_id = created_by_account_user_id,
            submitted_for_name_snapshot = 'Test AT', submit_idempotency_key = gen_random_uuid()
     WHERE id = '${id}'`;

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    user = await insertUser(db.pool);
    projectA = await insertProject(db.pool, 'DEMO-2601', user);
    projectB = await insertProject(db.pool, 'DEMO-2602', user);
    holeA = await insertTestHole(db.pool, projectA, 'TH26-01');
    holeB = await insertTestHole(db.pool, projectB, 'TH26-01');
    const locationId = await receivingLabId(db.pool);
    receiptA = await insertReceipt(db.pool, projectA, user);
    unitA = await insertStorageUnit(
      db.pool,
      { projectId: projectA, receiptId: receiptA, locationId },
      { readableId: 'BKT-2026-000014' },
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO test_type (group_id, code, description) VALUES ($1, 'DEMO-MC', 'Fictional')
       RETURNING id`,
      [SOILS],
    );
    testType = rows[0]!.id;
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a test’s subgroup must belong to its group, and codes are unique', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO test_subgroup (group_id, name) VALUES ($1, 'Consolidation') RETURNING id`,
      [ADVANCED],
    );
    await expect(
      db.pool.query(
        `INSERT INTO test_type (group_id, subgroup_id, code, description) VALUES ($1, $2, 'X1', 'x')`,
        [SOILS, rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: PG.foreignKeyViolation });
    await expect(
      db.pool.query(
        `INSERT INTO test_type (group_id, code, description) VALUES ($1, 'DEMO-MC', 'x')`,
        [ADVANCED],
      ),
    ).rejects.toMatchObject({ code: PG.uniqueViolation });
    await expect(
      db.pool.query(`UPDATE test_type SET active = false WHERE id = $1`, [testType]),
    ).rejects.toMatchObject({ code: PG.checkViolation });
  });

  it('a line’s source must belong to the program’s project and match its kind', async () => {
    const id = await program();
    await expect(line(id, holeB)).rejects.toMatchObject({ code: PG.foreignKeyViolation });
    await expect(
      db.pool.query(
        `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id,
                                source_storage_unit_id, scope)
         VALUES ($1, $2, 1, 'test_hole', $3, $4, 'all')`,
        [id, projectA, holeA, unitA],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      db.pool.query(
        `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id,
                                scope, sample_label)
         VALUES ($1, $2, 1, 'test_hole', $3, 'all', 'G3')`,
        [id, projectA, holeA],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation });
  });

  it('an incomplete program can’t be submitted, and a draft can’t be closed', async () => {
    const empty = await program();
    await expect(db.pool.query(submitSql(empty))).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    const noTests = await program();
    await line(noTests);
    await expect(db.pool.query(submitSql(noTests))).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(
      db.pool.query(`UPDATE lab_program SET status = 'closed' WHERE id = $1`, [empty]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('coverage and requests are written only during submission and never change after', async () => {
    const id = await program();
    const lineId = await line(id);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE test_line SET source_display_snapshot = 'TH26-01', coverage_captured_at = now()
         WHERE id = $1`,
        [lineId],
      );
      await client.query(
        `INSERT INTO program_scope_snapshot (program_id, line_id, storage_unit_id, receipt_id,
           project_id, included, matching_basis, unit_readable_id_snapshot, unit_type_snapshot,
           received_date_snapshot)
         VALUES ($1, $2, $3, $4, $5, true, 'hole_summary', 'BKT-2026-000014', 'bucket', '2026-10-23')`,
        [id, lineId, unitA, receiptA, projectA],
      );
      await client.query(
        `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
           test_description_snapshot, test_group_snapshot)
         VALUES ($1, $2, $3, 'DEMO-MC', 'Fictional', 'Soils')`,
        [id, lineId, testType],
      );
      await client.query(submitSql(id));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await expect(
      db.pool.query(
        `INSERT INTO program_scope_snapshot (program_id, line_id, storage_unit_id, receipt_id,
           project_id, included, matching_basis, unit_readable_id_snapshot, unit_type_snapshot,
           received_date_snapshot)
         VALUES ($1, $2, $3, $4, $5, true, 'hole_summary', 'BKT-2026-000014', 'bucket', '2026-10-23')`,
        [id, lineId, unitA, receiptA, projectA],
      ),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    for (const sql of [
      `UPDATE program_scope_snapshot SET included = false WHERE program_id = '${id}'`,
      `UPDATE test_request SET test_description_snapshot = 'changed' WHERE program_id = '${id}'`,
      `DELETE FROM test_request WHERE program_id = '${id}'`,
      `INSERT INTO test_line (program_id, project_id, line_number, scope) VALUES ('${id}', '${projectA}', 2, 'all')`,
      `UPDATE lab_program SET notes = 'changed' WHERE id = '${id}'`,
      `DELETE FROM lab_program WHERE id = '${id}'`,
    ]) {
      await expect(db.pool.query(sql), sql).rejects.toMatchObject({ code: PG.restrictViolation });
    }
  });
});
