import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';

// MM-V2-C07 (migration 0027): test-result drafts and their append-only revision history, each
// rule proven in the database. Fictional data only (DEMO- projects).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };

describe.runIf(testDatabaseUrl)('concrete test results (MM-V2-C07, migration 0027)', () => {
  let db: TestSchema;
  let tech: string;
  let lab: string;
  let projectA: string;
  let specimen: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    const { rows: labs } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('LAB station', 'shared_lab', 'active') RETURNING id`,
    );
    lab = labs[0]!.id;
    projectA = await insertProject(db.pool, 'DEMO-2601', tech);
    const { rows: reports } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
       RETURNING id`,
      [projectA, tech],
    );
    const { rows: sets } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_specimen_set (project_id, field_report_id) VALUES ($1, $2) RETURNING id`,
      [projectA, reports[0]!.id],
    );
    const { rows: specimens } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_specimen (project_id, set_id, letter, assigned_age)
       VALUES ($1, $2, 'A', '28') RETURNING id`,
      [projectA, sets[0]!.id],
    );
    specimen = specimens[0]!.id;
  });

  afterAll(async () => {
    await db?.drop();
  });

  let attempt = 0;
  async function result(columns: Record<string, unknown> = {}) {
    attempt += 1;
    const id = randomUUID();
    const all = {
      id,
      project_id: projectA,
      specimen_id: specimen,
      attempt_no: attempt,
      created_by_user_id: tech,
      ...columns,
    };
    const keys = Object.keys(all);
    await db.pool.query(
      `INSERT INTO concrete_test_result (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(all),
    );
    return id;
  }

  const revision = (
    resultId: string,
    values: {
      no?: number;
      kind?: string;
      reason?: string | null;
      account?: string;
      by?: string;
    } = {},
    client: { query: TestSchema['pool']['query'] } = db.pool,
  ) =>
    client.query(
      `INSERT INTO concrete_test_result_revision
         (project_id, result_id, revision_no, kind, changes, reason, account_user_id, account_type,
          entered_by_user_id, entered_by_name_snapshot, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, '{}', $5, $6, $7, $8, 'Someone', $9, 'h')`,
      [
        projectA,
        resultId,
        values.no ?? 1,
        values.kind ?? 'initial',
        values.reason ?? null,
        values.account ?? tech,
        (values.account ?? tech) === lab ? 'shared_lab' : 'test',
        values.by ?? tech,
        randomUUID(),
      ],
    );

  it('a draft holds no data until entered; empty is not zero', async () => {
    const id = await result();
    const { rows } = await db.pool.query(
      `SELECT state, max_load, height_readings, load_unit, dimension_unit, units_provisional,
              tested_on, tester_user_id FROM concrete_test_result WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      state: 'draft',
      max_load: null,
      height_readings: [],
      load_unit: 'kN',
      dimension_unit: 'mm',
      units_provisional: true,
      tested_on: null,
      tester_user_id: null,
    });
  });

  it('AC5: no completed state, unverified unit, calculation method or report link can be stored', async () => {
    await expect(result({ state: 'completed' })).rejects.toMatchObject(REJECT);
    await expect(result({ load_unit: 'lbf' })).rejects.toMatchObject(REJECT);
    await expect(result({ dimension_unit: 'in' })).rejects.toMatchObject(REJECT);
    await expect(result({ units_provisional: false })).rejects.toMatchObject(REJECT);
    await expect(result({ calculation_method: 'area-from-mean-diameter' })).rejects.toMatchObject(
      REJECT,
    );
    await expect(result({ calculation_method_version: '1' })).rejects.toMatchObject(REJECT);
  });

  it('readings are positive, bounded and without gaps', async () => {
    await expect(result({ max_load: 0 })).rejects.toMatchObject(REJECT);
    await expect(result({ max_load: -1 })).rejects.toMatchObject(REJECT);
    await expect(result({ height_readings: [203, 0] })).rejects.toMatchObject(REJECT);
    await expect(result({ diameter_readings: [101, null] })).rejects.toMatchObject(REJECT);
    await expect(result({ height_readings: Array(11).fill(200) })).rejects.toMatchObject(REJECT);
    await expect(
      result({ max_load: 412.5, height_readings: [203.2, 203.4], diameter_readings: [101.6] }),
    ).resolves.toBeTruthy();
  });

  it('the tester is an active person with a snapshot, never a shared account', async () => {
    await expect(
      result({ tester_user_id: lab, tester_name_snapshot: 'LAB' }),
    ).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'concrete_test_result_tester_check',
    });
    await expect(result({ tester_user_id: tech })).rejects.toMatchObject(REJECT);
    await expect(
      result({ tester_user_id: tech, tester_name_snapshot: 'Test AT' }),
    ).resolves.toBeTruthy();
  });

  it('attempt numbers are unique per specimen; results are never deleted', async () => {
    const id = await result();
    await expect(result({ attempt_no: attempt - 1 })).rejects.toMatchObject(UNIQUE);
    await expect(
      db.pool.query('DELETE FROM concrete_test_result WHERE id = $1', [id]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(db.pool.query('TRUNCATE concrete_test_result CASCADE')).rejects.toMatchObject(
      RESTRICT,
    );
  });

  it('a result row changes only with its revision in the same transaction, and keeps its identity', async () => {
    const id = await result();
    await revision(id);
    await expect(
      db.pool.query(`UPDATE concrete_test_result SET max_load = 400, version = 2 WHERE id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({ constraint: 'concrete_test_result_revision_required' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await revision(id, { no: 2, kind: 'entry' }, client);
      await client.query(
        `UPDATE concrete_test_result SET max_load = 400, version = 2 WHERE id = $1`,
        [id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await expect(
      db.pool.query(`UPDATE concrete_test_result SET attempt_no = 99 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ constraint: 'concrete_test_result_identity' });
  });

  it('AC3: a correction needs a reason; the first revision is the initial one; LAB credits a person', async () => {
    const id = await result();
    await expect(revision(id, { no: 2, kind: 'initial' })).rejects.toMatchObject(REJECT);
    await expect(revision(id, { no: 1, kind: 'entry' })).rejects.toMatchObject(REJECT);
    await revision(id, { no: 1 });
    await expect(revision(id, { no: 2, kind: 'correction' })).rejects.toMatchObject({
      constraint: 'concrete_test_result_revision_reason_required',
    });
    await expect(revision(id, { no: 2, kind: 'correction', reason: '  ' })).rejects.toMatchObject(
      REJECT,
    );
    await expect(revision(id, { no: 1, kind: 'initial' })).rejects.toMatchObject(UNIQUE);
    // A personal account credits itself; LAB credits a person, never itself.
    const other = await insertUser(db.pool, 'JS');
    await expect(revision(id, { no: 2, kind: 'entry', by: other })).rejects.toMatchObject(REJECT);
    await expect(
      revision(id, { no: 2, kind: 'entry', account: lab, by: lab }),
    ).rejects.toMatchObject({ constraint: 'concrete_test_result_revision_entered_by_check' });
    await expect(
      revision(id, { no: 2, kind: 'correction', account: lab, by: other, reason: 'Misread' }),
    ).resolves.toBeTruthy();
  });

  it('revisions are append-only', async () => {
    const id = await result();
    await revision(id);
    await expect(
      db.pool.query(`UPDATE concrete_test_result_revision SET reason = 'x' WHERE result_id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      db.pool.query('DELETE FROM concrete_test_result_revision WHERE result_id = $1', [id]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(db.pool.query('TRUNCATE concrete_test_result_revision')).rejects.toMatchObject(
      RESTRICT,
    );
  });
});
