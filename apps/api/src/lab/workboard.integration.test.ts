import {
  labProgramReviewSchema,
  labProgramSchema,
  workboardColumn,
  worklistSchema,
  type LabProgram,
  type Worklist,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  line,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// STRATA-88: the Workboard's columns, search, column filter, orders and the Review action, from
// GET /api/worklist. Real PostgreSQL (own schema), fictional data only (DEMO-2601, TH26-xx).
describe.runIf(testDatabaseUrl)('Workboard columns and tools (STRATA-88)', () => {
  let h: LabHarness;
  let moisture: string;
  let atterberg: string;

  async function hole(): Promise<string> {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects.a, `TH-${newKey().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  /** A program on a fresh hole of project A, requested and submitted by the technician. */
  async function submit(tests: string[], withUnit = true): Promise<LabProgram> {
    const holeId = await hole();
    if (withUnit) await h.bucket({ hole: holeId });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', tests)],
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

  async function setStatus(requestId: string, to: string) {
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM test_request WHERE id = $1',
      [requestId],
    );
    const response = await h.send(
      'post',
      `/api/test-requests/${requestId}/status`,
      { to, version: rows[0]!.version, idempotencyKey: newKey() },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  /** Moves the program's units to a lab location, so nothing is left to pull. */
  async function unitsAtLab(program: LabProgram) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, 'Lab bench (fictional)', 'lab')
       RETURNING id`,
      [`LB-${newKey().slice(0, 6)}`],
    );
    await h.db.pool.query(
      `UPDATE storage_unit SET current_location_id = $2
       WHERE id IN (SELECT storage_unit_id FROM program_scope_snapshot WHERE program_id = $1)`,
      [program.id, rows[0]!.id],
    );
  }

  async function list(query: string, as: PersonKey | 'lab' = 'lm'): Promise<Worklist> {
    const response = await h.get(`/api/worklist?${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return worklistSchema.parse(response.body);
  }

  let review: LabProgram;
  let pull: LabProgram;
  let testing: LabProgram;
  let ready: LabProgram;

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-WMC', 'Moisture content (fictional)')).id;
    atterberg = (await h.testType('DEMO-WATT', 'Atterberg limits (fictional)', 'Atterberg')).id;

    // Waiting for review: its one test sent to review; no lab work left (its unit stays stored).
    review = await submit([atterberg]);
    const [sent] = review.lines[0]!.requests;
    for (const to of ['in_progress', 'completed', 'review']) await setStatus(sent!.id, to);
    // Units to pull: nothing started, its bucket is in storage.
    pull = await submit([moisture]);
    // In testing: started, and its units are at the lab.
    testing = await submit([moisture]);
    await setStatus(testing.lines[0]!.requests[0]!.id, 'in_progress');
    await unitsAtLab(testing);
    // Ready to close: every test cancelled with a reason (accepting needs the lead's review).
    ready = await submit([moisture]);
    const request = ready.lines[0]!.requests[0]!;
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM test_request WHERE id = $1',
      [request.id],
    );
    const cancelled = await h.send(
      'post',
      `/api/test-requests/${request.id}/cancel`,
      { version: rows[0]!.version, reason: 'Not needed (fictional)', idempotencyKey: newKey() },
      'lm',
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('places each program in one column, as labProgramPhase does', async () => {
    const all = await list('');
    const placed = Object.fromEntries(all.items.map((item) => [item.programId, item]));
    expect(placed[review.id]).toMatchObject({ column: 'review', unitsToPull: 0, openCount: 0 });
    expect(placed[pull.id]).toMatchObject({ column: 'pull' });
    expect(placed[pull.id]!.unitsToPull).toBeGreaterThan(0);
    expect(placed[testing.id]).toMatchObject({ column: 'testing', unitsToPull: 0 });
    expect(placed[ready.id]).toMatchObject({ column: 'ready', unitsToPull: 0, openCount: 0 });
    for (const item of all.items) {
      expect(item.column).toBe(
        workboardColumn({ counts: item.counts, unitsToPull: item.unitsToPull }),
      );
    }
  });

  it('filters to one column, with that column’s totals', async () => {
    const pulls = await list('column=pull');
    expect(pulls.items.map((item) => item.programId)).toEqual([pull.id]);
    expect(pulls).toMatchObject({ total: 1, urgentTotal: 0 });
    // Unknown columns and orders are ignored, never an error.
    expect((await list('column=nope&sort=nope')).total).toBe(4);
  });

  it('offers Review only to a personal reviewer who is not the requester', async () => {
    const reviewItem = (body: Worklist) => body.items.find((i) => i.programId === review.id)!;
    expect(reviewItem(await list('', 'lm')).canReview).toBe(true);
    // The technician requested it: never one's own work.
    expect(reviewItem(await list('', 'tech')).canReview).toBe(false);
    // The shared LAB account never reviews.
    expect(reviewItem(await list('', 'lab')).canReview).toBe(false);
    // Programs with nothing in Review offer it to no one.
    expect((await list('', 'lm')).items.filter((i) => i.canReview).map((i) => i.programId)).toEqual(
      [review.id],
    );
  });

  it('searches program, project and test text, with LIKE characters taken literally', async () => {
    expect((await list(`search=${encodeURIComponent(pull.programNumber!)}`)).items).toHaveLength(1);
    expect((await list('search=DEMO-WATT')).items.map((i) => i.programId)).toEqual([review.id]);
    expect((await list('search=atterberg')).items.map((i) => i.programId)).toEqual([review.id]);
    expect((await list('search=%25')).total).toBe(0);
    expect((await list('search=_')).total).toBe(0);
  });

  it('orders by priority then oldest open, oldest open, or newest submitted', async () => {
    const urgent = await h.send(
      'patch',
      `/api/lab-programs/${ready.id}/priority`,
      { priority: 'urgent', version: ready.version, idempotencyKey: newKey() },
      'lm',
    );
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(200);
    const ids = async (sort: string) => (await list(`sort=${sort}`)).items.map((i) => i.programId);
    // Urgent first; then the oldest open test first, programs with nothing open after.
    expect(await ids('priority')).toEqual([ready.id, pull.id, testing.id, review.id]);
    // Oldest open first whatever the priority; programs with nothing open last (urgent first).
    expect(await ids('oldest')).toEqual([pull.id, testing.id, ready.id, review.id]);
    expect(await ids('newest')).toEqual([ready.id, testing.id, pull.id, review.id]);
    expect((await list('')).urgentTotal).toBe(1);
  });

  it('takes several projects', async () => {
    const both = await list(`projectId=${h.projects.a}&projectId=${h.projects.b}`);
    expect(both.total).toBe(4);
    expect((await list(`projectId=${h.projects.b}`)).total).toBe(0);
  });
});
