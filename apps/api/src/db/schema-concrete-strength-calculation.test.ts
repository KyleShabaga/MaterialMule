import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';

// MM-V2-C24 (migration 0033): versioned calculation methods, stored calculations on test
// results, and reviewer exclusions, each rule proven in the database. Fictional data only.

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };

describe.runIf(testDatabaseUrl)('concrete strength calculation (MM-V2-C24, migration 0033)', () => {
  let db: TestSchema;
  let tech: string;
  let reviewer: string;
  let lab: string;
  let project: string;
  let setId: string;
  let specimen: string;
  let specimenB: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    reviewer = await insertUser(db.pool, 'RV');
    const { rows: labs } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('LAB station', 'shared_lab', 'active') RETURNING id`,
    );
    lab = labs[0]!.id;
    project = await insertProject(db.pool, 'DEMO-2601', tech);
    const { rows: reports } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
       RETURNING id`,
      [project, tech],
    );
    const { rows: sets } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_specimen_set (project_id, field_report_id) VALUES ($1, $2) RETURNING id`,
      [project, reports[0]!.id],
    );
    setId = sets[0]!.id;
    const { rows: specimens } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_specimen (project_id, set_id, letter, assigned_age)
       VALUES ($1, $2, 'A', '28'), ($1, $2, 'B', '28') RETURNING id`,
      [project, setId],
    );
    specimen = specimens[0]!.id;
    specimenB = specimens[1]!.id;
    await db.pool.query(
      `INSERT INTO concrete_calculation_method (method, version, name, provisional, source, is_current)
       VALUES ('compressive_strength', 'P1', 'Calculation method P1 (provisional)', true,
               'design page section 6', true)`,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  // A complete entry with P1 values (worked example 1 of the shared tests).
  const complete = {
    tested_on: '2026-11-09',
    max_load: 450,
    height_readings: [300, 301],
    diameter_readings: [150, 150.4],
  };
  const calc = {
    calc_mean_diameter: 150.2,
    calc_mean_height: 300.5,
    calc_area_raw: 17718.613982172967,
    calc_area: 17719,
    calc_ld_ratio: 2.000665778961385,
    calc_correction_factor: 1,
    calc_strength_raw: 25.39702035682664,
    calc_strength: 25.4,
    calculated_at: new Date(),
  };
  const p1 = { calculation_method: 'compressive_strength', calculation_method_version: 'P1' };

  let attempt = 0;
  async function result(columns: Record<string, unknown> = {}, on = specimen) {
    attempt += 1;
    const id = randomUUID();
    const all = {
      id,
      project_id: project,
      specimen_id: on,
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

  it('a method version never changes and is never deleted; one current per method', async () => {
    await expect(
      db.pool.query(`UPDATE concrete_calculation_method SET provisional = false`),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_calculation_method_fixed' });
    await expect(db.pool.query(`DELETE FROM concrete_calculation_method`)).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_calculation_method_kept',
    });
    await expect(
      db.pool.query(
        `INSERT INTO concrete_calculation_method (method, version, name, provisional, source, is_current)
         VALUES ('compressive_strength', 'W1', 'Worksheet', false, 'worksheet', true)`,
      ),
    ).rejects.toMatchObject({ code: PG.uniqueViolation });
    await expect(
      db.pool.query(
        `INSERT INTO concrete_calculation_method (method, version, name, provisional, source)
         VALUES ('compressive_strength', 'p 1', 'Bad', true, 'x')`,
      ),
    ).rejects.toMatchObject(REJECT);
  });

  it('values are stored only with a method, together, and exactly for a complete entry', async () => {
    await expect(
      result({ ...complete, tester_user_id: tech, tester_name_snapshot: 'AT', ...p1, ...calc }),
    ).resolves.toBeTruthy();
    // No method: no values.
    await expect(
      result({ ...complete, tester_user_id: tech, tester_name_snapshot: 'AT', ...calc }),
    ).rejects.toMatchObject(REJECT);
    // A method with a complete entry needs its values …
    await expect(
      result({ ...complete, tester_user_id: tech, tester_name_snapshot: 'AT', ...p1 }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_test_result_calc_complete' });
    // … and an incomplete one has none.
    await expect(result({ ...p1, ...calc, max_load: 450 })).rejects.toMatchObject(REJECT);
    await expect(result({ ...p1 })).resolves.toBeTruthy();
    // Partial values, unrounded printed values or an unknown version are refused.
    const base = { ...complete, tester_user_id: tech, tester_name_snapshot: 'AT', ...p1 };
    await expect(result({ ...base, ...calc, calc_area: null })).rejects.toMatchObject(REJECT);
    await expect(result({ ...base, ...calc, calc_strength: 25.39 })).rejects.toMatchObject(REJECT);
    await expect(result({ ...base, ...calc, calc_area: 17718.6 })).rejects.toMatchObject(REJECT);
    await expect(result({ ...base, ...calc, calc_flags: ['made_up'] })).rejects.toMatchObject(
      REJECT,
    );
    await expect(
      result({ ...base, ...calc, calculation_method_version: 'Z9' }),
    ).rejects.toMatchObject({ code: PG.foreignKeyViolation });
    // L/D below 1.00: area without strength is a valid shape.
    await expect(
      result({
        ...base,
        ...calc,
        calc_strength_raw: null,
        calc_strength: null,
        calc_correction_factor: null,
        calc_flags: ['ld_below_minimum', 'ld_out_of_range'],
      }),
    ).resolves.toBeTruthy();
  });

  async function revise(
    resultId: string,
    no: number,
    kind: string,
    reason: string | null,
    sql: string,
  ) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO concrete_test_result_revision
           (project_id, result_id, revision_no, kind, changes, reason, account_user_id,
            account_type, entered_by_user_id, entered_by_name_snapshot, idempotency_key,
            request_hash)
         VALUES ($1, $2, $3, $4, '{}', $5, $6, 'test', $6, 'AT', $7, 'h')`,
        [project, resultId, no, kind, reason, tech, randomUUID()],
      );
      await client.query(sql, [resultId, no]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('AC2: the method version stays until a recalculation revision with a reason', async () => {
    await db.pool.query(
      `INSERT INTO concrete_calculation_method (method, version, name, provisional, source)
       VALUES ('compressive_strength', 'T2', 'Test-only method', true, 'schema test')`,
    );
    const id = await result({ ...p1 }, specimenB);
    await db.pool.query(
      `INSERT INTO concrete_test_result_revision
         (project_id, result_id, revision_no, kind, changes, account_user_id, account_type,
          entered_by_user_id, entered_by_name_snapshot, idempotency_key, request_hash)
       VALUES ($1, $2, 1, 'initial', '{}', $3, 'test', $3, 'AT', $4, 'h')`,
      [project, id, tech, randomUUID()],
    );
    const toT2 = `UPDATE concrete_test_result SET calculation_method_version = 'T2', version = $2
                  WHERE id = $1`;
    // An ordinary correction can't move it.
    await expect(revise(id, 2, 'correction', 'typo', toT2)).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_test_result_method_kept',
    });
    // A recalculation needs a reason.
    await expect(revise(id, 2, 'recalculation', null, toT2)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_test_result_revision_reason_required',
    });
    await revise(id, 2, 'recalculation', 'Worksheet method adopted', toT2);
    const { rows } = await db.pool.query(
      'SELECT calculation_method_version FROM concrete_test_result WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ calculation_method_version: 'T2' });
    // Never cleared, even with a recalculation.
    await expect(
      revise(
        id,
        3,
        'recalculation',
        'clear',
        `UPDATE concrete_test_result SET calculation_method = NULL,
           calculation_method_version = NULL, version = $2 WHERE id = $1`,
      ),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_test_result_method_kept' });
  });

  const exclusion = (values: {
    seq: number;
    action: string;
    reason?: string;
    by?: string;
    on?: string;
  }) =>
    db.pool.query(
      `INSERT INTO concrete_strength_exclusion
         (project_id, specimen_id, sequence_no, action, reason, user_id, user_name_snapshot,
          idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, 'Reviewer', $7, 'h')`,
      [
        project,
        values.on ?? specimen,
        values.seq,
        values.action,
        values.reason ?? 'Defective specimen',
        values.by ?? reviewer,
        randomUUID(),
      ],
    );

  it('exclusions alternate from exclude, without gaps, with a reason, by a person', async () => {
    await expect(exclusion({ seq: 1, action: 'reinstate' })).rejects.toMatchObject(REJECT);
    await expect(exclusion({ seq: 1, action: 'exclude', reason: ' ' })).rejects.toMatchObject(
      REJECT,
    );
    await expect(exclusion({ seq: 1, action: 'exclude', by: lab })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_strength_exclusion_person',
    });
    await expect(exclusion({ seq: 3, action: 'exclude' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_strength_exclusion_sequence',
    });
    await exclusion({ seq: 1, action: 'exclude' });
    await expect(exclusion({ seq: 1, action: 'exclude' })).rejects.toMatchObject({
      code: PG.uniqueViolation,
    });
    await exclusion({ seq: 2, action: 'reinstate' });
    await expect(
      db.pool.query(`UPDATE concrete_strength_exclusion SET reason = 'changed'`),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_strength_exclusion_append_only' });
    await expect(db.pool.query(`DELETE FROM concrete_strength_exclusion`)).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_strength_exclusion_append_only',
    });
  });
});
