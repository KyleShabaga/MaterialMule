import {
  compareWorklist,
  labProgramReviewSchema,
  labProgramSchema,
  WORKLIST_PAGE_SIZE,
  worklistSchema,
  type LabProgram,
  type Worklist,
  type WorklistItem,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// BUG-006: the worklist reaches every matching program, with and without "Only programs with
// open tests", and its project options are not limited to the loaded page. Fictional data only:
// DEMO-2601 / DEMO-2602, TH26-01, program numbers LP-2031-xxxx (never issued by the counter here).
describe.runIf(testDatabaseUrl)('worklist paging (BUG-006)', () => {
  let h: LabHarness;
  let moisture: string;
  const CLONES = 510;

  async function submitted(project: 'a' | 'b'): Promise<LabProgram> {
    const holeId = project === 'a' ? h.holes.a1 : h.holes.b1;
    await h.bucket({ project, hole: holeId });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects[project],
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture])],
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

  /** Copies a submitted program (its line and its one open request) `count` times, older than it. */
  async function cloneOlder(template: string, count: number): Promise<void> {
    const client = await h.db.pool.connect();
    try {
      await client.query('BEGIN');
      // Fixture bulk load only (as bench:seed does): the guards that keep a submitted program's
      // lines and requests from changing are off inside this transaction and back on at commit.
      await client.query('ALTER TABLE test_line DISABLE TRIGGER test_line_guard');
      await client.query('ALTER TABLE test_request DISABLE TRIGGER test_request_guard');
      const { rows: programs } = await client.query<{ id: string; n: number }>(
        `INSERT INTO lab_program (project_id, program_number, status, priority,
                                  created_by_account_user_id, created_by_account_type,
                                  requested_by_user_id, requested_by_initials_snapshot,
                                  requested_by_name_snapshot, create_idempotency_key, submitted_at,
                                  submitted_by_account_user_id, submitted_by_account_type,
                                  submitted_by_initials_snapshot, submitted_by_name_snapshot,
                                  submitted_for_user_id, submitted_for_initials_snapshot,
                                  submitted_for_name_snapshot, submit_idempotency_key)
         SELECT lp.project_id, 'LP-2031-' || lpad(g::text, 4, '0'), 'submitted', 'normal',
                lp.created_by_account_user_id, lp.created_by_account_type, lp.requested_by_user_id,
                lp.requested_by_initials_snapshot, lp.requested_by_name_snapshot,
                gen_random_uuid(), timestamptz '2026-01-01 00:00:00+00' + g * interval '1 minute',
                lp.submitted_by_account_user_id, lp.submitted_by_account_type,
                lp.submitted_by_initials_snapshot, lp.submitted_by_name_snapshot,
                lp.submitted_for_user_id, lp.submitted_for_initials_snapshot,
                lp.submitted_for_name_snapshot, gen_random_uuid()
         FROM lab_program lp, generate_series(1, $2::int) g
         WHERE lp.id = $1
         RETURNING id, substring(program_number FROM 9)::int AS n`,
        [template, count],
      );
      const ids = programs.map((p) => p.id);
      const { rows: lines } = await client.query<{ id: string; program_id: string }>(
        `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id,
                                source_storage_unit_id, source_bulk_group_id, scope, sample_label,
                                depth_mode, depth_from, depth_to, depth_unit,
                                source_display_snapshot, coverage_captured_at)
         SELECT p.id, l.project_id, l.line_number, l.source_kind, l.test_hole_id,
                l.source_storage_unit_id, l.source_bulk_group_id, l.scope, l.sample_label,
                l.depth_mode, l.depth_from, l.depth_to, l.depth_unit, l.source_display_snapshot,
                l.coverage_captured_at
         FROM unnest($2::uuid[]) AS p(id), test_line l
         WHERE l.program_id = $1
         RETURNING id, program_id`,
        [template, ids],
      );
      await client.query(
        `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
                                   test_name_snapshot, test_description_snapshot,
                                   test_group_snapshot, test_subgroup_snapshot, sort_order)
         SELECT n.program_id, n.line_id, r.test_type_id, r.test_code_snapshot,
                r.test_name_snapshot, r.test_description_snapshot, r.test_group_snapshot,
                r.test_subgroup_snapshot, r.sort_order
         FROM unnest($2::uuid[], $3::uuid[]) AS n(program_id, line_id), test_request r
         WHERE r.program_id = $1`,
        [template, lines.map((l) => l.program_id), lines.map((l) => l.id)],
      );
      // One urgent program: it must come first however old it is.
      await client.query(
        `UPDATE lab_program SET priority = 'urgent' WHERE program_number = 'LP-2031-0300'`,
      );
      await client.query('ALTER TABLE test_line ENABLE TRIGGER test_line_guard');
      await client.query('ALTER TABLE test_request ENABLE TRIGGER test_request_guard');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function page(query: string, n: number): Promise<Worklist> {
    const response = await h.get(`/api/worklist?${query}${query ? '&' : ''}page=${n}`, 'lab');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return worklistSchema.parse(response.body);
  }

  async function everyPage(query: string): Promise<{ first: Worklist; items: WorklistItem[] }> {
    const first = await page(query, 1);
    const items = [...first.items];
    const pages = Math.ceil(first.total / first.pageSize);
    for (let n = 2; n <= pages; n += 1) items.push(...(await page(query, n)).items);
    return { first, items };
  }

  let newestA: LabProgram;
  let onlyB: LabProgram;

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)', 'Moisture Content')).id;
    newestA = await submitted('a');
    await cloneOlder(newestA.id, CLONES);
    // DEMO-2602's only program is the newest of all: it sits on the last page.
    onlyB = await submitted('b');
  });

  afterAll(async () => {
    await h?.close();
  });

  for (const [label, query] of [
    ['without Only open', ''],
    ['with Only open', 'open=true'],
  ] as const) {
    it(`reaches all ${CLONES + 2} programs ${label}, in D52 order, with totals`, async () => {
      const { first, items } = await everyPage(query);
      expect(first.total).toBe(CLONES + 2);
      expect(first.pageSize).toBe(WORKLIST_PAGE_SIZE);
      expect(first.items).toHaveLength(WORKLIST_PAGE_SIZE);
      expect(items).toHaveLength(CLONES + 2);
      expect(new Set(items.map((i) => i.programId)).size).toBe(CLONES + 2);
      expect([...items].sort(compareWorklist)).toEqual(items);
      expect(items[0]!.programNumber).toBe('LP-2031-0300');
      expect(items.at(-1)!.programId).toBe(onlyB.id);
      expect(items.at(-2)!.programId).toBe(newestA.id);
      // Both projects are offered from page 1, though DEMO-2602 only appears on the last page.
      expect(first.projects.map((p) => p.projectNumber)).toEqual(['DEMO-2601', 'DEMO-2602']);
    });
  }

  it('offers every project even while one is selected, and reports the total past the end', async () => {
    const filtered = await page(`projectId=${h.projects.b}`, 1);
    expect(filtered.items.map((i) => i.programId)).toEqual([onlyB.id]);
    expect(filtered.total).toBe(1);
    expect(filtered.projects.map((p) => p.projectNumber)).toEqual(['DEMO-2601', 'DEMO-2602']);
    const past = await page('', 99);
    expect(past.items).toEqual([]);
    expect(past.total).toBe(CLONES + 2);
  });
});
