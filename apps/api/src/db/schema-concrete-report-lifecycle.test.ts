import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C09 (migration 0021): report versions, transitions and the submitted-report lock, each
// rule proven in the database. Fictional data only (DEMO- projects, invented people).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };
const FOREIGN = { code: PG.foreignKeyViolation };

describe.runIf(testDatabaseUrl)('concrete report lifecycle (MM-V2-C09, migration 0021)', () => {
  let db: TestSchema;
  let tech: string;
  let reviewer: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    reviewer = await insertUser(db.pool, 'RV');
    projectA = await insertProject(db.pool, 'DEMO-2601', tech);
    projectB = await insertProject(db.pool, 'DEMO-2602', tech);
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function report(project = projectA) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id, technician_user_id,
         report_date, comments)
       VALUES ($1, $2, $2, '2026-11-08', 'Fictional pour') RETURNING id`,
      [project, tech],
    );
    return rows[0]!.id;
  }

  async function submit(
    reportId: string,
    values: Record<string, unknown> = {},
    project = projectA,
  ) {
    const row: Record<string, unknown> = {
      project_id: project,
      field_report_id: reportId,
      version_no: 1,
      snapshot: JSON.stringify({ kind: 'field', note: 'as submitted' }),
      snapshot_sha256: 'ignored',
      report_row_version: 1,
      submitted_by_user_id: tech,
      submitted_staff_user_id: tech,
      route_kind: 'designated_reviewers',
      ...values,
    };
    const columns = Object.keys(row);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_report_version (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    await db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [reportId],
    );
    return rows[0]!.id;
  }

  const review = (id: string) =>
    db.pool.query(
      `UPDATE concrete_report_version SET state = 'reviewed', reviewed_by_user_id = $2,
         reviewed_at = now(), review_source = 'designated_reviewer' WHERE id = $1`,
      [id, reviewer],
    );
  const issue = (id: string) =>
    db.pool.query(
      `UPDATE concrete_report_version SET state = 'issued', issued_by_user_id = $2,
         issued_at = now(), issue_source = 'lead_project_engineer',
         issue_include_photos = false, issue_include_machine_info = false WHERE id = $1`,
      [id, tech],
    );

  it('the snapshot hash is the database SHA-256 of the stored jsonb text', async () => {
    const id = await submit(await report());
    const { rows } = await db.pool.query<{ same: boolean; hash: string }>(
      `SELECT snapshot_sha256 = encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') AS same,
              snapshot_sha256 AS hash
       FROM concrete_report_version WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ same: true });
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('versions number 1, 2, 3 … without gaps and start as submitted', async () => {
    const reportId = await report();
    await expect(submit(reportId, { version_no: 2 })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_no_sequence',
    });
    await expect(submit(reportId, { state: 'reviewed' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_starts_submitted',
    });
    const first = await submit(reportId);
    // A second open version of the same report: no double submission.
    await expect(submit(reportId, { version_no: 2 })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_report_version_one_open',
    });
    await db.pool.query(
      `UPDATE concrete_report_version SET state = 'recalled', closed_by_user_id = $2,
         closed_at = now() WHERE id = $1`,
      [first, tech],
    );
    await submit(reportId, { version_no: 2 });
  });

  it('a version belongs to its report project; it can name no other report', async () => {
    const reportId = await report();
    await expect(submit(reportId, {}, projectB)).rejects.toMatchObject(FOREIGN);
  });

  it('what was submitted never changes (snapshot, hash, route, submitter)', async () => {
    const id = await submit(await report());
    for (const [column, value] of [
      ['snapshot', JSON.stringify({ kind: 'field', note: 'edited later' })],
      ['snapshot_sha256', 'f'.repeat(64)],
      ['submitted_staff_user_id', reviewer],
      ['route_kind', 'lead_project_engineer'],
      ['version_no', 9],
    ] as const) {
      await expect(
        db.pool.query(`UPDATE concrete_report_version SET ${column} = $2 WHERE id = $1`, [
          id,
          value,
        ]),
        column,
      ).rejects.toMatchObject(RESTRICT);
    }
  });

  it('state moves only along the confirmed transitions, with its own columns', async () => {
    const id = await submit(await report());
    // submitted → issued skips review.
    await expect(issue(id)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_transition',
    });
    // A return needs who and why.
    await expect(
      db.pool.query(`UPDATE concrete_report_version SET state = 'returned' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_version_state_shape' });
    await review(id);
    // reviewed → recalled is not allowed (recall only before review).
    await expect(
      db.pool.query(
        `UPDATE concrete_report_version SET state = 'recalled', closed_by_user_id = $2,
           closed_at = now() WHERE id = $1`,
        [id, tech],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_version_transition' });
    // A return after review must clear the review (fresh review, AC3) and keeps who reviewed.
    await expect(
      db.pool.query(
        `UPDATE concrete_report_version SET state = 'returned', closed_by_user_id = $2,
           closed_at = now(), close_comment = 'Fix the ticket number' WHERE id = $1`,
        [id, reviewer],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_version_state_shape' });
    await db.pool.query(
      `UPDATE concrete_report_version SET state = 'returned', closed_by_user_id = $2,
         closed_at = now(), close_comment = 'Fix the ticket number', review_cleared_at = now()
       WHERE id = $1`,
      [id, reviewer],
    );
    const { rows } = await db.pool.query(
      'SELECT reviewed_by_user_id, review_cleared_at IS NOT NULL AS cleared FROM concrete_report_version WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ reviewed_by_user_id: reviewer, cleared: true });
  });

  it('AC4: an issued version never changes and no version is ever deleted', async () => {
    const id = await submit(await report());
    await review(id);
    await issue(id);
    await expect(
      db.pool.query(`UPDATE concrete_report_version SET close_comment = 'x' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_version_issued_frozen' });
    await expect(
      db.pool.query('DELETE FROM concrete_report_version WHERE id = $1', [id]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_version_no_delete' });
    await expect(db.pool.query('TRUNCATE concrete_report_version CASCADE')).rejects.toMatchObject(
      RESTRICT,
    );
  });

  it('a revision links only to an issued version of the same report', async () => {
    const reportId = await report();
    const original = await submit(reportId);
    await review(original);
    await issue(original);
    const other = await submit(await report());
    await review(other);
    await issue(other);
    await expect(
      submit(reportId, { version_no: 2, revision_of_version_id: other }),
    ).rejects.toMatchObject(FOREIGN);
    const revision = await submit(reportId, { version_no: 2, revision_of_version_id: original });
    expect(revision).toBeTruthy();
    const third = await report();
    const unissued = await submit(third);
    await db.pool.query(
      `UPDATE concrete_report_version SET state = 'recalled', closed_by_user_id = $2, closed_at = now() WHERE id = $1`,
      [unissued, tech],
    );
    await expect(
      submit(third, { version_no: 2, revision_of_version_id: unissued }),
    ).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_revision_of_issued',
    });
  });

  it('AC1: a submitted or reviewed report and its readings are locked; returned reopens them', async () => {
    const reportId = await report();
    await db.pool.query(
      `INSERT INTO concrete_field_reading (project_id, field_report_id, test, context, position, value)
       VALUES ($1, $2, 'slump', 'initial', 1, 80)`,
      [projectA, reportId],
    );
    const id = await submit(reportId);
    const locked = { ...RESTRICT, constraint: 'concrete_field_report_locked' };
    await expect(
      db.pool.query(`UPDATE concrete_field_report SET comments = 'changed' WHERE id = $1`, [
        reportId,
      ]),
    ).rejects.toMatchObject(locked);
    await expect(
      db.pool.query(`UPDATE concrete_field_reading SET value = 90 WHERE field_report_id = $1`, [
        reportId,
      ]),
    ).rejects.toMatchObject(locked);
    await expect(
      db.pool.query(
        `INSERT INTO concrete_field_reading (project_id, field_report_id, test, context, position, value)
         VALUES ($1, $2, 'slump', 'retest', 2, 70)`,
        [projectA, reportId],
      ),
    ).rejects.toMatchObject(locked);
    await expect(
      db.pool.query('DELETE FROM concrete_field_reading WHERE field_report_id = $1', [reportId]),
    ).rejects.toMatchObject(locked);
    // Lifecycle columns still move, and the casting time (only C05's recorded correction
    // changes it after numbering).
    await db.pool.query(`UPDATE concrete_field_report SET cast_at = now() WHERE id = $1`, [
      reportId,
    ]);
    await db.pool.query(
      `UPDATE concrete_field_report SET version = version + 1, updated_at = now() WHERE id = $1`,
      [reportId],
    );
    await review(id);
    await db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'reviewed' WHERE id = $1`,
      [reportId],
    );
    await expect(
      db.pool.query(`UPDATE concrete_field_report SET comments = 'changed' WHERE id = $1`, [
        reportId,
      ]),
    ).rejects.toMatchObject(locked);
    await db.pool.query(
      `UPDATE concrete_report_version SET state = 'returned', closed_by_user_id = $2,
         closed_at = now(), close_comment = 'Fix it', review_cleared_at = now() WHERE id = $1`,
      [id, reviewer],
    );
    await db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'returned' WHERE id = $1`,
      [reportId],
    );
    await db.pool.query(`UPDATE concrete_field_report SET comments = 'corrected' WHERE id = $1`, [
      reportId,
    ]);
    await db.pool.query(`UPDATE concrete_field_reading SET value = 85 WHERE field_report_id = $1`, [
      reportId,
    ]);
  });

  it('a Lab Manager correction mark exists only while the report is returned', async () => {
    const reportId = await report();
    await expect(
      db.pool.query(
        `UPDATE concrete_field_report SET lab_manager_corrected_by_user_id = $2 WHERE id = $1`,
        [reportId, tech],
      ),
    ).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_lab_manager_correction_check',
    });
  });

  it('transitions are append-only, unique per key, and return / revise need a comment', async () => {
    const reportId = await report();
    const versionId = await submit(reportId);
    const insert = (values: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        project_id: projectA,
        field_report_id: reportId,
        version_id: versionId,
        action: 'submit',
        from_state: 'draft',
        to_state: 'submitted',
        actor_user_id: tech,
        idempotency_key: randomUUID(),
        request_hash: 'h',
        ...values,
      };
      const columns = Object.keys(row);
      return db.pool.query<{ id: string }>(
        `INSERT INTO concrete_report_transition (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(row),
      );
    };
    const key = randomUUID();
    const { rows } = await insert({ idempotency_key: key });
    await expect(insert({ idempotency_key: key })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_report_transition_idempotency_key',
    });
    for (const action of ['return', 'revise']) {
      await expect(insert({ action })).rejects.toMatchObject({
        ...REJECT,
        constraint: 'concrete_report_transition_comment_required',
      });
    }
    await expect(
      db.pool.query(`UPDATE concrete_report_transition SET comment = 'x' WHERE id = $1`, [
        rows[0]!.id,
      ]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      db.pool.query('DELETE FROM concrete_report_transition WHERE id = $1', [rows[0]!.id]),
    ).rejects.toMatchObject(RESTRICT);
    // A transition names a version of the same report.
    const other = await report();
    await expect(insert({ field_report_id: other })).rejects.toMatchObject(FOREIGN);
  });

  it('only field reports for now (strength reports wait for G2)', async () => {
    const reportId = await report();
    await expect(submit(reportId, { report_kind: 'strength' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_kind_check',
    });
  });

  describe('populated database', () => {
    let fresh: TestSchema | undefined;
    afterAll(async () => {
      await fresh?.drop();
    });

    it('existing reports keep their rows; the new tables start empty', async () => {
      fresh = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        fresh.pool,
        all.filter((m) => m.version < '0021'),
      );
      await runSeed(fresh.pool, 'reference', 'test');
      const user = await insertUser(fresh.pool, 'MG');
      const project = await insertProject(fresh.pool, 'DEMO-2699', user);
      await fresh.pool.query(
        `INSERT INTO concrete_field_report (project_id, created_by_user_id, technician_user_id)
         VALUES ($1, $2, $2)`,
        [project, user],
      );
      const before = await fresh.pool.query(
        'SELECT row_to_json(r)::jsonb AS row FROM concrete_field_report r',
      );
      expect(
        (
          await migrate(
            fresh.pool,
            all.filter((m) => m.version < '0022'),
          )
        ).applied,
      ).toEqual(['0021_concrete_report_lifecycle']);
      const after = await fresh.pool.query(
        'SELECT row_to_json(r)::jsonb AS row FROM concrete_field_report r',
      );
      expect(after.rows[0].row).toEqual({
        ...before.rows[0].row,
        lab_manager_corrected_by_user_id: null,
      });
      const { rows } = await fresh.pool.query(
        `SELECT (SELECT count(*)::int FROM concrete_report_version) AS versions,
                (SELECT count(*)::int FROM concrete_report_transition) AS transitions`,
      );
      expect(rows[0]).toEqual({ versions: 0, transitions: 0 });
    }, 60_000);
  });
});
