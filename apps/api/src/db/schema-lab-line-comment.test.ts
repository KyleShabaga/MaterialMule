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

// STRATA-129 (migration 0050): a lab program line's optional comment. Null for none; otherwise
// trimmed, not blank, at most 2000 characters, no control characters but line breaks and tabs.
// Like the rest of the line it changes only while the program is a draft. Fictional data only.

const CHECK = { code: PG.checkViolation, constraint: 'test_line_comment_check' };

describe.runIf(testDatabaseUrl)('lab line comment (0050)', () => {
  let db: TestSchema;
  let user: string;
  let project: string;
  let hole: string;
  let testType: string;
  let unit: string;
  let receipt: string;

  const SOILS = '00000000-0000-4000-8000-00000000c101';

  async function program(): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO lab_program (project_id, created_by_account_user_id, created_by_account_type,
                                requested_by_user_id, requested_by_name_snapshot,
                                create_idempotency_key)
       VALUES ($1, $2, 'test', $2, 'Test AT', gen_random_uuid()) RETURNING id`,
      [project, user],
    );
    return rows[0]!.id;
  }

  async function line(programId: string, comment: string | null) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id, scope,
                              comment)
       VALUES ($1, $2, 1, 'test_hole', $3, 'all', $4) RETURNING id`,
      [programId, project, hole, comment],
    );
    return rows[0]!.id;
  }

  const setComment = (lineId: string, comment: string | null) =>
    db.pool.query('UPDATE test_line SET comment = $2 WHERE id = $1', [lineId, comment]);

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    user = await insertUser(db.pool);
    project = await insertProject(db.pool, 'DEMO-2601', user);
    hole = await insertTestHole(db.pool, project, 'TH26-01');
    receipt = await insertReceipt(db.pool, project, user);
    unit = await insertStorageUnit(
      db.pool,
      { projectId: project, receiptId: receipt, locationId: await receivingLabId(db.pool) },
      { readableId: 'BKT-2026-000014' },
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO test_type (group_id, code, description) VALUES ($1, 'DEMO-LC', 'Fictional')
       RETURNING id`,
      [SOILS],
    );
    testType = rows[0]!.id;
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a line has no comment unless one is given', async () => {
    const id = await line(await program(), null);
    const { rows } = await db.pool.query('SELECT comment FROM test_line WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ comment: null });
  });

  it('keeps a trimmed comment up to 2000 characters, with line breaks and tabs', async () => {
    const id = await line(await program(), 'Run the hydrometer\n\ton the finer half');
    await expect(setComment(id, 'x'.repeat(2000))).resolves.toBeDefined();
    await expect(setComment(id, null)).resolves.toBeDefined();
  });

  it('refuses a blank, untrimmed, too long or control-character comment', async () => {
    const id = await line(await program(), null);
    for (const bad of [
      '',
      '   ',
      ' padded',
      'padded ',
      'x'.repeat(2001),
      'bell\u0007',
      'esc\u001b',
    ]) {
      await expect(setComment(id, bad), JSON.stringify(bad)).rejects.toMatchObject(CHECK);
    }
  });

  it('is frozen with the rest of the line once the program is submitted', async () => {
    const programId = await program();
    const lineId = await line(programId, 'Before submission');
    // Submission is the service's job; here only the frozen state matters, so coverage, the
    // request and the status change are written directly the way the submit transaction does.
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
         VALUES ($1, $2, $3, $4, $5, true, 'hole_summary', 'BKT-2026-000014', 'bucket',
                 '2026-10-23')`,
        [programId, lineId, unit, receipt, project],
      );
      await client.query(
        `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
           test_description_snapshot, test_group_snapshot)
         VALUES ($1, $2, $3, 'DEMO-LC', 'Fictional', 'Soils')`,
        [programId, lineId, testType],
      );
      await client.query(
        `UPDATE lab_program SET status = 'submitted', program_number = 'LP-2026-9998',
                submitted_at = now(), submitted_by_account_user_id = created_by_account_user_id,
                submitted_by_account_type = 'test', submitted_by_name_snapshot = 'Test AT',
                submitted_for_user_id = created_by_account_user_id,
                submitted_for_name_snapshot = 'Test AT', submit_idempotency_key = gen_random_uuid()
         WHERE id = $1`,
        [programId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await expect(setComment(lineId, 'Changed after submission')).rejects.toMatchObject({
      code: PG.restrictViolation,
    });
    await expect(setComment(lineId, null)).rejects.toMatchObject({ code: PG.restrictViolation });
  });
});
