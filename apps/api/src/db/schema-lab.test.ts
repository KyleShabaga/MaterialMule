import { labProgramReviewSchema, labProgramSchema, type LabProgram } from '@materialmule/shared';
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
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
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

// MM-T80: the T24/T25/T26 lab rules proved in the database itself, past the service. The state is
// built through the real routes (createLabHarness); each refusal is a direct SQL write.
describe.runIf(testDatabaseUrl)('lab lifecycle rules in the database (MM-T80)', () => {
  let h: LabHarness;
  let moisture: string;

  async function submitted(): Promise<LabProgram> {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects.a, `TH-${newKey().slice(0, 8)}`],
    );
    await h.bucket({ hole: rows[0]!.id });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: rows[0]!.id }, 'all', [moisture])],
      },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
    );
    const response = await h.send(
      'post',
      `/api/lab-programs/${created.body.id}/submit`,
      {
        version: created.body.version,
        idempotencyKey: newKey(),
        coverage: review.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
      },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return labProgramSchema.parse(response.body);
  }

  async function request(id: string) {
    const { rows } = await h.db.pool.query<{ version: number; status: string }>(
      'SELECT version, status FROM test_request WHERE id = $1',
      [id],
    );
    return rows[0]!;
  }

  /** Moves a request along the real routes as the technician, then accepts it as the lead. */
  async function advance(id: string, to: 'in_progress' | 'completed' | 'review' | 'accepted') {
    const steps = ['in_progress', 'completed', 'review'] as const;
    const from = steps.indexOf((await request(id)).status as (typeof steps)[number]) + 1;
    for (const step of steps.slice(from)) {
      const moved = await h.send(
        'post',
        `/api/test-requests/${id}/status`,
        { to: step, version: (await request(id)).version, idempotencyKey: newKey() },
        'tech',
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      if (step === to) return;
    }
    const reviewed = await h.send(
      'post',
      `/api/test-requests/${id}/review`,
      { action: 'complete', version: (await request(id)).version, idempotencyKey: newKey() },
      'tech',
    );
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const accepted = await h.send(
      'post',
      `/api/test-requests/${id}/accept`,
      { version: (await request(id)).version, idempotencyKey: newKey() },
      'pe',
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  }

  const closeSql = (programId: string) =>
    h.db.pool.query(
      `UPDATE lab_program SET status = 'closed', closed_at = now(), closed_by_user_id = $2,
              closed_by_name_snapshot = 'Pat Example'
       WHERE id = $1`,
      [programId, h.users.pe],
    );

  const transition = { code: PG.checkViolation, constraint: 'test_request_transition' };

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC80', 'Moisture content (fictional)', 'Moisture')).id;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('test_request_status_guard: status and review move only along the shared table', async () => {
    const program = await submitted();
    const id = program.lines[0]!.requests[0]!.id;
    const set = (sql: string) =>
      h.db.pool.query(`UPDATE test_request SET ${sql} WHERE id = $1`, [id]);
    // Requested can't skip ahead.
    for (const to of ['completed', 'accepted']) {
      await expect(set(`status = '${to}'`), to).rejects.toMatchObject(transition);
    }
    await advance(id, 'completed');
    // Completed never goes back, and can't be accepted unreviewed.
    for (const to of ['in_progress', 'requested', 'accepted']) {
      await expect(set(`status = '${to}'`), to).rejects.toMatchObject(transition);
    }
    // Review starts awaiting review.
    await expect(set(`status = 'review', review_state = 'returned'`)).rejects.toMatchObject(
      transition,
    );
    await advance(id, 'review');
    // Accepted only once the review is complete; review sub-states follow their own table.
    await expect(set(`status = 'accepted'`)).rejects.toMatchObject(transition);
    await expect(set(`review_state = 'correction_done'`)).rejects.toMatchObject(transition);
    await set(`review_state = 'returned'`);
    await expect(set(`review_state = 'review_complete'`)).rejects.toMatchObject(transition);
    await set(`review_state = 'correction_done'`);
    await set(`review_state = 'review_complete'`);
    await expect(set(`review_state = 'awaiting_review'`)).rejects.toMatchObject(transition);
  });

  it('test_request_status_guard: Accepted returns to Requested only with the next identity revision', async () => {
    const program = await submitted();
    const id = program.lines[0]!.requests[0]!.id;
    await advance(id, 'accepted');
    // Same revision: the transition rule. Skipping a revision: the snapshot rule (test_request_guard).
    for (const [revision, code] of [
      ['identity_revision', PG.checkViolation],
      ['identity_revision + 2', PG.restrictViolation],
    ] as const) {
      await expect(
        h.db.pool.query(
          `UPDATE test_request SET status = 'requested', identity_revision = ${revision}
           WHERE id = $1`,
          [id],
        ),
        revision,
      ).rejects.toMatchObject({ code });
    }
    expect((await request(id)).status).toBe('accepted');
  });

  it('lab_program_closure_guard: closing needs every test Accepted or Cancelled with its reason', async () => {
    const program = await submitted();
    const id = program.lines[0]!.requests[0]!.id;
    for (const step of [null, 'in_progress', 'completed', 'review'] as const) {
      if (step) await advance(id, step);
      await expect(closeSql(program.id), step ?? 'requested').rejects.toMatchObject({
        code: PG.checkViolation,
        constraint: 'lab_program_closure',
      });
    }
    const cancelled = await h.send(
      'post',
      `/api/test-requests/${id}/cancel`,
      { reason: 'Not needed', version: (await request(id)).version, idempotencyKey: newKey() },
      'pe',
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    await closeSql(program.id);

    const accepted = await submitted();
    await advance(accepted.lines[0]!.requests[0]!.id, 'accepted');
    await closeSql(accepted.id);
  });

  it('test_request_status_guard: a closed program’s tests can’t change status or review', async () => {
    const program = await submitted();
    const id = program.lines[0]!.requests[0]!.id;
    await advance(id, 'accepted');
    await closeSql(program.id);
    // Even the one move the table allows from Accepted.
    await expect(
      h.db.pool.query(
        `UPDATE test_request SET status = 'requested', review_state = NULL,
                identity_revision = identity_revision + 1
         WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    expect((await request(id)).status).toBe('accepted');
  });

  it('lab_program_guard: a submitted program keeps its project, number and submission and is never deleted', async () => {
    const program = await submitted();
    for (const sql of [
      `UPDATE lab_program SET status = 'draft' WHERE id = $1`,
      `UPDATE lab_program SET program_number = 'LP-2026-999999' WHERE id = $1`,
      `UPDATE lab_program SET submitted_at = submitted_at - interval '1 day' WHERE id = $1`,
      `UPDATE lab_program SET submit_idempotency_key = gen_random_uuid() WHERE id = $1`,
      `UPDATE lab_program SET notes = 'changed later' WHERE id = $1`,
      `UPDATE lab_program SET project_id = '${h.projects.b}' WHERE id = $1`,
      `DELETE FROM lab_program WHERE id = $1`,
    ]) {
      await expect(h.db.pool.query(sql, [program.id]), sql).rejects.toMatchObject({
        code: PG.restrictViolation,
      });
    }
  });

  it('acceptance_delegation_guard: a grant never changes or disappears; it is revoked once', async () => {
    const granted = await h.send(
      'post',
      `/api/projects/${h.projects.b}/acceptance-delegates`,
      {
        delegateUserId: h.users.js,
        reason: 'Covers acceptance while the lead is away',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM acceptance_delegation
       WHERE project_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL`,
      [h.projects.b, h.users.js],
    );
    const id = rows[0]!.id;
    for (const sql of [
      `UPDATE acceptance_delegation SET delegate_user_id = '${h.users.jo}' WHERE id = $1`,
      `UPDATE acceptance_delegation SET project_id = '${h.projects.a}' WHERE id = $1`,
      `UPDATE acceptance_delegation SET granted_at = granted_at - interval '1 day' WHERE id = $1`,
      `UPDATE acceptance_delegation SET grant_reason = 'Rewritten' WHERE id = $1`,
      `UPDATE acceptance_delegation SET delegate_name_snapshot = 'Someone else' WHERE id = $1`,
      `DELETE FROM acceptance_delegation WHERE id = $1`,
    ]) {
      await expect(h.db.pool.query(sql, [id]), sql).rejects.toMatchObject({
        code: PG.restrictViolation,
      });
    }
    const revoke = `UPDATE acceptance_delegation SET revoked_at = now(), revoked_by_user_id = $2,
                           revoked_by_name_snapshot = 'Pat Example', revoke_reason = $3
                    WHERE id = $1`;
    await h.db.pool.query(revoke, [id, h.users.pe, 'Lead is back']);
    // Revoked: not again, not undone, not deleted.
    await expect(h.db.pool.query(revoke, [id, h.users.pe, 'Twice'])).rejects.toMatchObject({
      code: PG.restrictViolation,
    });
    for (const sql of [
      `UPDATE acceptance_delegation SET revoked_at = NULL, revoked_by_user_id = NULL,
              revoked_by_name_snapshot = NULL, revoke_reason = NULL WHERE id = $1`,
      'DELETE FROM acceptance_delegation WHERE id = $1',
    ]) {
      await expect(h.db.pool.query(sql, [id]), sql).rejects.toMatchObject({
        code: PG.restrictViolation,
      });
    }
  });
});
