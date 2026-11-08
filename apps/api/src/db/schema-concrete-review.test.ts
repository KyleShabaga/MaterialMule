import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';

// MM-V2-C28 (migration 0025): exception notes on a submitted version and the issuer's choices on
// an issued one, each rule proven in the database. Fictional data only (DEMO- projects).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };

describe.runIf(testDatabaseUrl)('concrete review exceptions (MM-V2-C28, migration 0025)', () => {
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

  async function submitted(project = projectA) {
    const { rows: reports } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id, technician_user_id,
         report_date) VALUES ($1, $2, $2, '2026-11-08') RETURNING id`,
      [project, tech],
    );
    const reportId = reports[0]!.id;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_report_version (project_id, field_report_id, version_no, snapshot,
         snapshot_sha256, report_row_version, submitted_by_user_id, submitted_staff_user_id,
         route_kind)
       VALUES ($1, $2, 1, '{"kind":"field"}', '', 1, $3, $3, 'designated_reviewers')
       RETURNING id`,
      [project, reportId, tech],
    );
    await db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [reportId],
    );
    return { reportId, versionId: rows[0]!.id };
  }

  const note = (
    v: { reportId: string; versionId: string },
    values: { code?: string; field?: string | null; note?: string; project?: string } = {},
  ) =>
    db.pool.query<{ id: string }>(
      `INSERT INTO concrete_report_exception_note
         (project_id, field_report_id, version_id, code, field, note, documented_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        values.project ?? projectA,
        v.reportId,
        v.versionId,
        values.code ?? 'slump_out_of_range',
        values.field === undefined ? 'readings.r1.value' : values.field,
        values.note ?? 'Accepted by the engineer of record',
        reviewer,
      ],
    );

  const review = (versionId: string) =>
    db.pool.query(
      `UPDATE concrete_report_version SET state = 'reviewed', reviewed_by_user_id = $2,
         reviewed_at = now(), review_source = 'designated_reviewer' WHERE id = $1`,
      [versionId, reviewer],
    );

  it('documents an exception on a version awaiting review, once per code and field', async () => {
    const v = await submitted();
    await note(v);
    await note(v, { code: 'unknown_mix', field: null });
    await expect(note(v, { note: 'Second note' })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_report_exception_note_one',
    });
    await expect(note(v, { code: 'unknown_mix', field: null })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_report_exception_note_one',
    });
    // Another field of the same code is another exception.
    await note(v, { field: 'readings.r2.value' });
  });

  it('refuses a note once the version is reviewed, or for another report or project', async () => {
    const v = await submitted();
    const other = await submitted();
    await expect(note({ reportId: other.reportId, versionId: v.versionId })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_exception_note_open_version',
    });
    await expect(note(v, { project: projectB })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_exception_note_open_version',
    });
    await review(v.versionId);
    await expect(note(v)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_exception_note_open_version',
    });
  });

  it('refuses blank notes and malformed codes', async () => {
    const v = await submitted();
    await expect(note(v, { note: '   ' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_exception_note_note_check',
    });
    await expect(note(v, { code: 'Slump Out' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_exception_note_code_check',
    });
    await expect(note(v, { field: ' ' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_exception_note_field_check',
    });
  });

  it('notes are append-only', async () => {
    const v = await submitted();
    const { rows } = await note(v);
    const id = rows[0]!.id;
    await expect(
      db.pool.query(`UPDATE concrete_report_exception_note SET note = 'changed' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_report_exception_note_append_only',
    });
    await expect(
      db.pool.query('DELETE FROM concrete_report_exception_note WHERE id = $1', [id]),
    ).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_report_exception_note_append_only',
    });
    await expect(db.pool.query('TRUNCATE concrete_report_exception_note')).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_report_exception_note_append_only',
    });
  });

  it('the issue choices are recorded exactly when the version is issued', async () => {
    const v = await submitted();
    await review(v.versionId);
    await expect(
      db.pool.query(
        `UPDATE concrete_report_version SET state = 'returned', closed_by_user_id = $2,
           closed_at = now(), close_comment = 'Fix the slump', review_cleared_at = now(),
           issue_include_machine_info = true WHERE id = $1`,
        [v.versionId, reviewer],
      ),
    ).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_issue_options_shape',
    });
    await expect(
      db.pool.query(
        `UPDATE concrete_report_version SET state = 'issued', issued_by_user_id = $2,
           issued_at = now(), issue_source = 'lead_project_engineer' WHERE id = $1`,
        [v.versionId, tech],
      ),
    ).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_issue_options_shape',
    });
    await db.pool.query(
      `UPDATE concrete_report_version SET state = 'issued', issued_by_user_id = $2,
         issued_at = now(), issue_source = 'lead_project_engineer',
         issue_include_photos = false, issue_include_machine_info = true WHERE id = $1`,
      [v.versionId, tech],
    );
    // An issued version never changes (0021), its choices included.
    await expect(
      db.pool.query(
        `UPDATE concrete_report_version SET issue_include_machine_info = false WHERE id = $1`,
        [v.versionId],
      ),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_version_issued_frozen' });
  });
});
