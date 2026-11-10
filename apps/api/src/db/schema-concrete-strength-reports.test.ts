import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { allocateReportNumber } from '../concrete/reports/report-numbers.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C39 (migration 0032): strength report rows on C09's versions, transitions and C28's
// exception notes, and the lock on results a strength report shows as tested. Each rule proven
// in the database. Fictional data only (DEMO- projects, invented people).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };
const FOREIGN = { code: PG.foreignKeyViolation };

describe.runIf(testDatabaseUrl)('concrete strength reports (MM-V2-C39, migration 0032)', () => {
  let db: TestSchema;
  let tech: string;
  let reviewer: string;
  let projectA: string;
  let fieldReport: string;
  let template: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    reviewer = await insertUser(db.pool, 'RV');
    projectA = await insertProject(db.pool, 'DEMO-2601', tech);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
       RETURNING id`,
      [projectA, tech],
    );
    fieldReport = rows[0]!.id;
    template = randomUUID();
    await db.pool.query(
      `INSERT INTO concrete_report_template (id, report_kind, revision, name, provisional,
         in_force_from)
       VALUES ($1, 'strength', 'T1', 'Strength report template', true, now())`,
      [template],
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** A set with specimens A (7 d) and B (28 d). */
  async function newSet() {
    const { rows: sets } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_specimen_set (project_id, field_report_id) VALUES ($1, $2) RETURNING id`,
      [projectA, fieldReport],
    );
    const setId = sets[0]!.id;
    const specimens: Record<string, string> = {};
    for (const [letter, age] of [
      ['A', '7'],
      ['B', '28'],
    ] as const) {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO concrete_specimen (project_id, set_id, letter, assigned_age)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [projectA, setId, letter, age],
      );
      specimens[letter] = rows[0]!.id;
    }
    return { setId, specimens };
  }

  async function strengthReport(setId: string, values: Record<string, unknown> = {}) {
    const row = {
      project_id: projectA,
      specimen_set_id: setId,
      workflow_state: 'submitted',
      submitted_at: new Date(),
      created_by_user_id: tech,
      ...values,
    };
    const columns = Object.keys(row);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_strength_report (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0]!.id;
  }

  async function version(reportId: string, values: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      report_kind: 'strength',
      project_id: projectA,
      strength_report_id: reportId,
      version_no: 1,
      snapshot: JSON.stringify({ kind: 'strength', results: [] }),
      snapshot_sha256: 'ignored',
      report_row_version: 0,
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
    return rows[0]!.id;
  }

  const review = (id: string) =>
    db.pool.query(
      `UPDATE concrete_report_version SET state = 'reviewed', reviewed_by_user_id = $2,
         reviewed_at = now(), review_source = 'designated_reviewer' WHERE id = $1`,
      [id, reviewer],
    );
  /** Issue a version with a CS number from C32's allocator (one transaction, as the API does). */
  async function issue(id: string, reportId: string): Promise<string> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const number = await allocateReportNumber(client, {
        kind: 'strength',
        projectId: projectA,
        subjectId: reportId,
        userId: tech,
      });
      await client.query(
        `UPDATE concrete_report_version SET state = 'issued', issued_by_user_id = $2,
           issued_at = now(), issue_source = 'lead_project_engineer',
           issue_include_photos = false, issue_include_machine_info = false,
           report_number_id = $3, report_template_id = $4 WHERE id = $1`,
        [id, tech, number.id, template],
      );
      // C32 (0031): an issued version has its stored file, checked at commit.
      await client.query(
        `INSERT INTO concrete_report_file (report_kind, project_id, report_number_id,
           report_template_id, revision_no, report_version_id, file_name, content, byte_size,
           sha256, include_photos, include_machine_info, created_by_user_id)
         VALUES ('strength', $1, $2, $3, 0, $4, 'fictional.pdf', '\x25504446'::bytea, 0, '',
           false, false, $5)`,
        [projectA, number.id, template, id, tech],
      );
      await client.query('COMMIT');
      return number.reportNumber;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  let attempt = 0;
  const newResult = (specimenId: string) => {
    attempt += 1;
    return db.pool.query(
      `INSERT INTO concrete_test_result (id, project_id, specimen_id, attempt_no, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), projectA, specimenId, attempt, tech],
    );
  };

  it('one strength report per set, in the set’s project; never deleted', async () => {
    const { setId } = await newSet();
    const id = await strengthReport(setId);
    await expect(strengthReport(setId)).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_strength_report_set_key',
    });
    const other = await insertProject(db.pool, 'DEMO-2602', tech);
    const { setId: second } = await newSet();
    await expect(strengthReport(second, { project_id: other })).rejects.toMatchObject({
      ...FOREIGN,
      constraint: 'concrete_strength_report_set_fkey',
    });
    await expect(
      db.pool.query('DELETE FROM concrete_strength_report WHERE id = $1', [id]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_strength_report_no_delete' });
    await expect(
      db.pool.query('UPDATE concrete_strength_report SET specimen_set_id = $2 WHERE id = $1', [
        id,
        second,
      ]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_strength_report_identity' });
  });

  it('the CS number: only C32’s concrete_report_number, the report’s own, on every issue', async () => {
    const { setId } = await newSet();
    const reportId = await strengthReport(setId);
    const v = await version(reportId);
    await review(v);
    // An issued strength version always records its number (and template).
    await expect(
      db.pool.query(
        `UPDATE concrete_report_version SET state = 'issued', issued_by_user_id = $2,
           issued_at = now(), issue_source = 'lead_project_engineer',
           issue_include_photos = false, issue_include_machine_info = false WHERE id = $1`,
        [v, tech],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_version_strength_numbered' });
    // Another strength report's number is refused.
    const { setId: otherSet } = await newSet();
    const other = await strengthReport(otherSet);
    await expect(issue(v, other)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_own_number',
    });
    const number = await issue(v, reportId);
    expect(number).toMatch(/^CS-[0-9]{4}-[0-9]{5}$/);
    // The strength report row carries no number of its own (one source of truth).
    const { rows } = await db.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'concrete_strength_report'
         AND column_name LIKE '%number%'`,
    );
    expect(rows).toEqual([]);
  });

  it('a strength version names its strength report only; numbering and one open per report', async () => {
    const { setId } = await newSet();
    const reportId = await strengthReport(setId);
    await expect(version(reportId, { field_report_id: fieldReport })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_report_shape',
    });
    await expect(version(reportId, { report_kind: 'field' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_report_shape',
    });
    await expect(version(reportId, { version_no: 2 })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_version_no_sequence',
    });
    const first = await version(reportId);
    await expect(version(reportId, { version_no: 2 })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_report_version_strength_one_open',
    });
    // The hash is the database SHA-256 of the stored text, for strength versions too.
    const { rows } = await db.pool.query<{ same: boolean }>(
      `SELECT snapshot_sha256 = encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') AS same
       FROM concrete_report_version WHERE id = $1`,
      [first],
    );
    expect(rows[0]!.same).toBe(true);
    // A revision corrects an issued version of the same strength report.
    await expect(
      version(reportId, { version_no: 2, revision_of_version_id: first }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/23/) });
    await review(first);
    await issue(first, reportId);
    const second = await version(reportId, { version_no: 2, revision_of_version_id: first });
    expect(second).toBeTruthy();
    // Issued versions never change and versions are never deleted.
    await expect(
      db.pool.query(`UPDATE concrete_report_version SET snapshot = '{}'::jsonb WHERE id = $1`, [
        first,
      ]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_version_issued_frozen' });
    await expect(
      db.pool.query('DELETE FROM concrete_report_version WHERE id = $1', [second]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_version_no_delete' });
    // Another strength report's version can't be revised from here.
    const { setId: otherSet } = await newSet();
    const other = await strengthReport(otherSet);
    await expect(version(other, { revision_of_version_id: first })).rejects.toMatchObject(FOREIGN);
  });

  it('transitions and exception notes name the strength report of their version', async () => {
    const { setId } = await newSet();
    const reportId = await strengthReport(setId);
    const v = await version(reportId, {
      snapshot: JSON.stringify({ kind: 'strength', results: [], warnings: [] }),
    });
    const transition = (values: Record<string, unknown>) =>
      db.pool.query(
        `INSERT INTO concrete_report_transition
           (report_kind, project_id, strength_report_id, field_report_id, version_id, action,
            from_state, to_state, actor_user_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, 'submit', 'draft', 'submitted', $6, $7, 'h')`,
        [
          values.kind ?? 'strength',
          projectA,
          values.strength ?? reportId,
          values.field ?? null,
          v,
          tech,
          randomUUID(),
        ],
      );
    await transition({});
    await expect(transition({ field: fieldReport })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_transition_report_shape',
    });
    const { setId: otherSet } = await newSet();
    await expect(transition({ strength: await strengthReport(otherSet) })).rejects.toMatchObject(
      FOREIGN,
    );
    await expect(
      db.pool.query('DELETE FROM concrete_report_transition WHERE strength_report_id = $1', [
        reportId,
      ]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_transition_append_only' });

    const note = (versionId: string) =>
      db.pool.query(
        `INSERT INTO concrete_report_exception_note
           (project_id, strength_report_id, version_id, code, field, note, documented_by_user_id)
         VALUES ($1, $2, $3, 'strength_tested_off_target', 'results.A', 'Fictional note', $4)`,
        [projectA, reportId, versionId, reviewer],
      );
    await note(v);
    await expect(
      db.pool.query(
        `INSERT INTO concrete_report_exception_note
           (project_id, strength_report_id, field_report_id, version_id, code, note,
            documented_by_user_id)
         VALUES ($1, $2, $3, $4, 'strength_overdue_untested', 'Both', $5)`,
        [projectA, reportId, fieldReport, v, reviewer],
      ),
    ).rejects.toMatchObject({
      ...REJECT,
      // Naming both reports: refused (the open-version trigger runs before the shape check).
    });
    await review(v);
    await expect(note(v)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_exception_note_open_version',
    });
  });

  it('AC2: results the open or issued version shows as tested are locked until reopened', async () => {
    const { setId, specimens } = await newSet();
    const reportId = await strengthReport(setId);
    const v = await version(reportId, {
      snapshot: JSON.stringify({
        kind: 'strength',
        results: [
          { specimenId: specimens.A, reported: true },
          { specimenId: specimens.B, reported: false },
        ],
      }),
    });
    const locked = { ...RESTRICT, constraint: 'concrete_test_result_reported' };
    await expect(newResult(specimens.A!)).rejects.toMatchObject(locked);
    // A later age (not on the version) stays open.
    await newResult(specimens.B!);
    await review(v);
    await issue(v, reportId);
    await db.pool.query(
      `UPDATE concrete_strength_report SET workflow_state = 'reviewed',
      issue_count = 1, last_issued_version = 1, last_issued_at = now(),
      last_issued_by_user_id = $2 WHERE id = $1`,
      [reportId, tech],
    );
    await expect(newResult(specimens.A!)).rejects.toMatchObject(locked);
    // A revision (C09's revise of the issued version) reopens the report as a draft: the
    // correction can be entered.
    await reopen(reportId, 'revise');
    await revised(reportId, v);
    await newResult(specimens.A!);
  });

  /** Back to draft (recall) or returned, as the lifecycle commands set the report row. */
  const reopen = (reportId: string, how: 'revise' | 'recall' | 'return') =>
    db.pool.query(
      how === 'return'
        ? `UPDATE concrete_strength_report SET workflow_state = 'returned' WHERE id = $1`
        : `UPDATE concrete_strength_report SET workflow_state = 'draft', submitted_at = NULL
           WHERE id = $1`,
      [reportId],
    );
  /** C09's revise transition on an issued version. */
  const revised = (reportId: string, versionId: string) =>
    db.pool.query(
      `INSERT INTO concrete_report_transition
         (report_kind, project_id, strength_report_id, version_id, action, from_state, to_state,
          actor_user_id, comment, idempotency_key, request_hash)
       VALUES ('strength', $1, $2, $3, 'revise', 'reviewed', 'draft', $4, 'Correction', $5, 'h')`,
      [projectA, reportId, versionId, reviewer, randomUUID()],
    );

  it('review fix: recalling or returning a later age keeps the issued results locked', async () => {
    const { setId, specimens } = await newSet();
    const reportId = await strengthReport(setId);
    const snapshot = (reportedB: boolean) =>
      JSON.stringify({
        kind: 'strength',
        results: [
          { specimenId: specimens.A, reported: true },
          { specimenId: specimens.B, reported: reportedB },
        ],
      });
    const v1 = await version(reportId, { snapshot: snapshot(false) });
    await review(v1);
    await issue(v1, reportId);
    await db.pool.query(
      `UPDATE concrete_strength_report SET workflow_state = 'reviewed',
      issue_count = 1, last_issued_version = 1, last_issued_at = now(),
      last_issued_by_user_id = $2 WHERE id = $1`,
      [reportId, tech],
    );
    const locked = { ...RESTRICT, constraint: 'concrete_test_result_reported' };
    // The cumulative Rev 1 (A and the new age B), submitted, then recalled.
    await db.pool.query(
      `UPDATE concrete_strength_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [reportId],
    );
    const v2 = await version(reportId, {
      version_no: 2,
      revision_of_version_id: v1,
      snapshot: snapshot(true),
    });
    await expect(newResult(specimens.B!)).rejects.toMatchObject(locked);
    await db.pool.query(
      `UPDATE concrete_report_version SET state = 'recalled', closed_at = now(),
         closed_by_user_id = $2 WHERE id = $1`,
      [v2, tech],
    );
    await reopen(reportId, 'recall');
    // The new age is open for correction; the issued result stays locked.
    await newResult(specimens.B!);
    await expect(newResult(specimens.A!)).rejects.toMatchObject(locked);
    // So is excluding it from its strength test (C24).
    await expect(
      db.pool.query(
        `INSERT INTO concrete_strength_exclusion (project_id, specimen_id, sequence_no, action,
           reason, user_id, user_name_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, 1, 'exclude', 'Fictional', $3, 'Riley Reviewer', $4, 'h')`,
        [projectA, specimens.A, reviewer, randomUUID()],
      ),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_strength_exclusion_reported' });
    // Resubmitted, then returned: the same.
    await db.pool.query(
      `UPDATE concrete_strength_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [reportId],
    );
    const v3 = await version(reportId, {
      version_no: 3,
      revision_of_version_id: v1,
      snapshot: snapshot(true),
    });
    await db.pool.query(
      `UPDATE concrete_report_version SET state = 'returned', closed_at = now(),
         closed_by_user_id = $2, close_comment = 'Check B' WHERE id = $1`,
      [v3, reviewer],
    );
    await reopen(reportId, 'return');
    await newResult(specimens.B!);
    await expect(newResult(specimens.A!)).rejects.toMatchObject(locked);
    // A revise of the issued version reopens it.
    await reopen(reportId, 'revise');
    await revised(reportId, v1);
    await newResult(specimens.A!);
  });

  describe('populated database', () => {
    let fresh: TestSchema | undefined;
    afterAll(async () => {
      await fresh?.drop();
    });

    it('existing field-report versions keep their rows unchanged', async () => {
      fresh = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        fresh.pool,
        all.filter((m) => m.version < '0032'),
      );
      await runSeed(fresh.pool, 'reference', 'test');
      const user = await insertUser(fresh.pool, 'MG');
      const project = await insertProject(fresh.pool, 'DEMO-2610', user);
      const { rows: reports } = await fresh.pool.query<{ id: string }>(
        `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
         RETURNING id`,
        [project, user],
      );
      await fresh.pool.query(
        `INSERT INTO concrete_report_version (project_id, field_report_id, version_no, snapshot,
           snapshot_sha256, report_row_version, submitted_by_user_id, submitted_staff_user_id,
           route_kind)
         VALUES ($1, $2, 1, '{"kind":"field"}', '', 1, $3, $3, 'designated_reviewers')`,
        [project, reports[0]!.id, user],
      );
      const before = await fresh.pool.query('SELECT * FROM concrete_report_version');
      await migrate(fresh.pool, all);
      const after = await fresh.pool.query(
        'SELECT * FROM concrete_report_version ORDER BY version_no',
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({
        ...before.rows[0],
        report_kind: 'field',
        strength_report_id: null,
      });
    });
  });
});
