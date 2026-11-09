import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateReportNumber } from '../concrete/reports/report-numbers.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { runSeed } from './seed.js';
import { withTransaction } from './transaction.js';

// MM-V2-C32 (migration 0031): report numbers, template revisions and issued files, each rule
// proven in the database. Fictional data only (DEMO- projects, invented people).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const FIELD_TEMPLATE = '00000000-0000-4000-8000-000c32000001';
const SUMMARY_TEMPLATE = '00000000-0000-4000-8000-000c32000003';

describe.runIf(testDatabaseUrl)('concrete report output (MM-V2-C32, migration 0031)', () => {
  let db: TestSchema;
  let tech: string;
  let project: string;
  let year: number;

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    tech = await insertUser(db.pool, 'AT');
    project = await insertProject(db.pool, 'DEMO-2601', tech);
    const { rows } = await db.pool.query<{ year: number }>(
      `SELECT extract(year FROM (now() AT TIME ZONE 'America/Edmonton'))::int AS year`,
    );
    year = rows[0]!.year;
  });

  afterAll(async () => {
    await db?.drop();
  });

  const allocate = (kind: 'field' | 'strength' | 'summary', subjectId: string = randomUUID()) =>
    withTransaction(db.pool, (client) =>
      allocateReportNumber(client, { kind, projectId: project, subjectId, userId: tech }),
    );

  async function seqs(kind: string) {
    const { rows } = await db.pool.query<{ seq: number }>(
      'SELECT seq FROM concrete_report_number WHERE report_kind = $1 AND number_year = $2 ORDER BY seq',
      [kind, year],
    );
    return rows.map((r) => r.seq);
  }

  it('numbers per kind and year in the provisional formats, from 1', async () => {
    const field = await allocate('field');
    const strength = await allocate('strength');
    const summary = await allocate('summary');
    expect(field.reportNumber).toBe(`CF-${year}-00001`);
    expect(strength.reportNumber).toBe(`CS-${year}-00001`);
    expect(summary.reportNumber).toBe(`CSR-${year}-0001`);
    expect((await allocate('field')).reportNumber).toBe(`CF-${year}-00002`);
  });

  it('a report keeps its number: a retry or revision allocates nothing', async () => {
    const subject = randomUUID();
    const first = await allocate('field', subject);
    const again = await allocate('field', subject);
    expect(again).toMatchObject({
      id: first.id,
      reportNumber: first.reportNumber,
      allocated: false,
    });
    expect(first.allocated).toBe(true);
  });

  it('gap-free under concurrent issues, with rolled-back issues (retries) in between', async () => {
    const before = await seqs('strength');
    const tasks = Array.from({ length: 12 }, (_, i) =>
      withTransaction(db.pool, async (client) => {
        const n = await allocateReportNumber(client, {
          kind: 'strength',
          projectId: project,
          subjectId: randomUUID(),
          userId: tech,
        });
        // Every third issue fails after taking its number (e.g. a render error): rolled back.
        if (i % 3 === 0) throw new Error('simulated issue failure');
        return n.seq;
      }).catch(() => null),
    );
    const committed = (await Promise.all(tasks)).filter((s): s is number => s !== null);
    expect(committed).toHaveLength(8);
    const after = await seqs('strength');
    // Contiguous from 1 with no gap, every committed issue holding exactly one number.
    expect(after).toEqual(Array.from({ length: before.length + 8 }, (_, i) => i + 1));
    expect([...committed].sort((a, b) => a - b)).toEqual(after.slice(before.length));
  });

  it('refuses a number not taken from the counter, a skipped step and a counted-but-unused value', async () => {
    const insertNumber = (seq: number, kind = 'summary') =>
      db.pool.query(
        `INSERT INTO concrete_report_number
           (report_kind, number_year, seq, report_number, project_id, subject_id, allocated_by_user_id)
         VALUES ($1, $2, $3, '', $4, $5, $6)`,
        [kind, year, seq, project, randomUUID(), tech],
      );
    await expect(insertNumber(99)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_report_number_from_counter',
    });
    await expect(
      db.pool.query(
        `UPDATE concrete_report_number_counter SET last_seq = last_seq + 2
         WHERE report_kind = 'summary' AND number_year = $1`,
        [year],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_number_counter_step' });
    // Raising the counter without issuing the number fails at commit (no gap).
    await expect(
      db.pool.query(
        `UPDATE concrete_report_number_counter SET last_seq = last_seq + 1
         WHERE report_kind = 'summary' AND number_year = $1`,
        [year],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_number_no_gap' });
    await expect(
      db.pool.query(
        `INSERT INTO concrete_report_number
           (report_kind, number_year, seq, report_number, project_id, subject_id,
            allocated_by_user_id, allocated_at)
         VALUES ('summary', $1, 1, '', $2, $3, $4, now() - interval '400 days')`,
        [year, project, randomUUID(), tech],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_number_year' });
  });

  it('numbers, counters and templates never change or go away', async () => {
    const n = await allocate('field');
    await expect(
      db.pool.query(`UPDATE concrete_report_number SET seq = seq WHERE id = $1`, [n.id]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_number_fixed' });
    await expect(
      db.pool.query('DELETE FROM concrete_report_number WHERE id = $1', [n.id]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_number_fixed' });
    await expect(
      db.pool.query(`DELETE FROM concrete_report_number_counter WHERE report_kind = 'field'`),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_number_counter_kept' });
    await expect(
      db.pool.query(`UPDATE concrete_report_template SET provisional = false WHERE id = $1`, [
        FIELD_TEMPLATE,
      ]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_template_fixed' });
    const { rows } = await db.pool.query<{ revision: string; provisional: boolean }>(
      `SELECT revision, provisional FROM concrete_report_template ORDER BY report_kind`,
    );
    expect(rows).toEqual([
      { revision: 'P1', provisional: true },
      { revision: 'P1', provisional: true },
      { revision: 'P1', provisional: true },
    ]);
  });

  /** A summary report with its number and file, in one transaction (as the service does). */
  async function issueSummary(content: Buffer) {
    return withTransaction(db.pool, async (client) => {
      const id = randomUUID();
      const n = await allocateReportNumber(client, {
        kind: 'summary',
        projectId: project,
        subjectId: id,
        userId: tech,
      });
      await client.query(
        `INSERT INTO concrete_summary_report
           (id, project_id, report_number_id, filters, snapshot, snapshot_sha256,
            issued_by_user_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3, '{}', '{"kind":"summary"}', '', $4, $5, 'h')`,
        [id, project, n.id, tech, randomUUID()],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO concrete_report_file
           (report_kind, project_id, report_number_id, report_template_id, revision_no,
            summary_report_id, file_name, content, byte_size, sha256, include_photos,
            include_machine_info, created_by_user_id)
         VALUES ('summary', $1, $2, $3, 7, $4, 'CSR-test.pdf', $5, 1, 'forged', false, false, $6)
         RETURNING id`,
        [project, n.id, SUMMARY_TEMPLATE, id, content, tech],
      );
      return { summaryId: id, fileId: rows[0]!.id, numberId: n.id };
    });
  }

  it('a file stores its bytes with the database SHA-256; it never changes', async () => {
    const content = Buffer.from('%PDF-1.7 fictional bytes');
    const { fileId } = await issueSummary(content);
    const { rows } = await db.pool.query<{
      sha256: string;
      byte_size: number;
      revision_no: number;
    }>('SELECT sha256, byte_size, revision_no FROM concrete_report_file WHERE id = $1', [fileId]);
    expect(rows[0]).toEqual({
      sha256: createHash('sha256').update(content).digest('hex'),
      byte_size: content.length,
      revision_no: 0,
    });
    await expect(
      db.pool.query(`UPDATE concrete_report_file SET content = 'x' WHERE id = $1`, [fileId]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_file_fixed' });
    await expect(
      db.pool.query('DELETE FROM concrete_report_file WHERE id = $1', [fileId]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_file_fixed' });
    await expect(
      db.pool.query(`UPDATE concrete_summary_report SET filters = '{"x":1}'`),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_summary_report_fixed' });
  });

  it('a summary report without its file is refused at commit', async () => {
    await expect(
      withTransaction(db.pool, async (client) => {
        const id = randomUUID();
        const n = await allocateReportNumber(client, {
          kind: 'summary',
          projectId: project,
          subjectId: id,
          userId: tech,
        });
        await client.query(
          `INSERT INTO concrete_summary_report
             (id, project_id, report_number_id, filters, snapshot, snapshot_sha256,
              issued_by_user_id, idempotency_key, request_hash)
           VALUES ($1, $2, $3, '{}', '{}', '', $4, $5, 'h')`,
          [id, project, n.id, tech, randomUUID()],
        );
      }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_summary_report_file_stored' });
  });

  describe('field report versions', () => {
    async function reviewedVersion() {
      const { rows: r } = await db.pool.query<{ id: string }>(
        `INSERT INTO concrete_field_report (project_id, created_by_user_id, technician_user_id,
           report_date, comments)
         VALUES ($1, $2, $2, '2026-11-08', 'Fictional pour') RETURNING id`,
        [project, tech],
      );
      const reportId = r[0]!.id;
      const { rows: v } = await db.pool.query<{ id: string }>(
        `INSERT INTO concrete_report_version
           (project_id, field_report_id, version_no, snapshot, snapshot_sha256, report_row_version,
            submitted_by_user_id, submitted_staff_user_id, route_kind)
         VALUES ($1, $2, 1, '{"kind":"field"}', '', 1, $3, $3, 'designated_reviewers') RETURNING id`,
        [project, reportId, tech],
      );
      await db.pool.query(
        `UPDATE concrete_report_version SET state = 'reviewed', reviewed_by_user_id = $2,
           reviewed_at = now(), review_source = 'lead_project_engineer' WHERE id = $1`,
        [v[0]!.id, tech],
      );
      return { reportId, versionId: v[0]!.id };
    }

    const issueSql = `UPDATE concrete_report_version SET state = 'issued', issued_by_user_id = $2,
        issued_at = now(), issue_source = 'lead_project_engineer', issue_include_photos = false,
        issue_include_machine_info = true, report_number_id = $3, report_template_id = $4
      WHERE id = $1`;
    const fileSql = `INSERT INTO concrete_report_file
        (report_kind, project_id, report_number_id, report_template_id, revision_no,
         report_version_id, file_name, content, byte_size, sha256, include_photos,
         include_machine_info, created_by_user_id)
      VALUES ('field', $1, $2, $3, 0, $4, 'CF-test.pdf', $5, 0, '', false, $6, $7)
      RETURNING id, revision_no, supersedes_file_id`;

    it('an issued version records its own number and template and has its file by commit', async () => {
      const { reportId, versionId } = await reviewedVersion();
      // Another report's number is refused.
      const other = await allocate('field');
      await expect(
        db.pool.query(issueSql, [versionId, tech, other.id, FIELD_TEMPLATE]),
      ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_version_own_number' });
      // Issued with a template but no file: refused at commit.
      await expect(
        withTransaction(db.pool, async (client) => {
          const n = await allocateReportNumber(client, {
            kind: 'field',
            projectId: project,
            subjectId: reportId,
            userId: tech,
          });
          await client.query(issueSql, [versionId, tech, n.id, FIELD_TEMPLATE]);
        }),
      ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_version_file_stored' });
      // A file that disagrees with the version's choices is refused; a matching one commits.
      await withTransaction(db.pool, async (client) => {
        const n = await allocateReportNumber(client, {
          kind: 'field',
          projectId: project,
          subjectId: reportId,
          userId: tech,
        });
        await client.query(issueSql, [versionId, tech, n.id, FIELD_TEMPLATE]);
        await client.query('SAVEPOINT s');
        await expect(
          client.query(fileSql, [
            project,
            n.id,
            FIELD_TEMPLATE,
            versionId,
            Buffer.from('%PDF'),
            false,
            tech,
          ]),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_report_file_matches_version' });
        await client.query('ROLLBACK TO SAVEPOINT s');
        await client.query(fileSql, [
          project,
          n.id,
          FIELD_TEMPLATE,
          versionId,
          Buffer.from('%PDF'),
          true,
          tech,
        ]);
      });
    });

    it('each issue of a numbered report adds Rev 0, 1, … linked to the file it supersedes', async () => {
      const first = await reviewedVersion();
      const n = await allocate('field', first.reportId);
      // The same number on a second report's version is refused (own number), so revisions
      // are versions of the same report: build v1 (issued) then v2 (revision).
      const files: { id: string; revision_no: number; supersedes_file_id: string | null }[] = [];
      await withTransaction(db.pool, async (client) => {
        await client.query(issueSql, [first.versionId, tech, n.id, FIELD_TEMPLATE]);
        files.push(
          (
            await client.query(fileSql, [
              project,
              n.id,
              FIELD_TEMPLATE,
              first.versionId,
              Buffer.from('%PDF r0'),
              true,
              tech,
            ])
          ).rows[0],
        );
      });
      const { rows: v2 } = await db.pool.query<{ id: string }>(
        `INSERT INTO concrete_report_version
           (project_id, field_report_id, version_no, revision_of_version_id, snapshot,
            snapshot_sha256, report_row_version, submitted_by_user_id, submitted_staff_user_id,
            route_kind)
         VALUES ($1, $2, 2, $3, '{"kind":"field"}', '', 2, $4, $4, 'designated_reviewers')
         RETURNING id`,
        [project, first.reportId, first.versionId, tech],
      );
      await db.pool.query(
        `UPDATE concrete_report_version SET state = 'reviewed', reviewed_by_user_id = $2,
           reviewed_at = now(), review_source = 'lead_project_engineer' WHERE id = $1`,
        [v2[0]!.id, tech],
      );
      await withTransaction(db.pool, async (client) => {
        await client.query(issueSql, [v2[0]!.id, tech, n.id, FIELD_TEMPLATE]);
        files.push(
          (
            await client.query(fileSql, [
              project,
              n.id,
              FIELD_TEMPLATE,
              v2[0]!.id,
              Buffer.from('%PDF r1'),
              true,
              tech,
            ])
          ).rows[0],
        );
      });
      expect(files.map((f) => f.revision_no)).toEqual([0, 1]);
      expect(files[0]!.supersedes_file_id).toBeNull();
      expect(files[1]!.supersedes_file_id).toBe(files[0]!.id);
      // The issued original and its file are unchanged.
      await expect(
        db.pool.query(
          `UPDATE concrete_report_version SET report_template_id = NULL WHERE id = $1`,
          [first.versionId],
        ),
      ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_report_version_issued_frozen' });
    });
  });
});
