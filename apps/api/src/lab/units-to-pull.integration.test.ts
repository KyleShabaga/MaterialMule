import {
  labProgramListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  unitsToPullSchema,
  type LabProgram,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// Field Ledger lane D: the phone "to pull now" list and the programs list progress counts.
// Real PostgreSQL, fictional data only.
describe.runIf(testDatabaseUrl)('units to pull and list progress (Field Ledger)', () => {
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

  async function submit(holeId: string, tests: string[]): Promise<LabProgram> {
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

  async function pull() {
    const response = await h.get('/api/worklist/units-to-pull', 'lab');
    expect(response.status).toBe(200);
    return unitsToPullSchema.parse(response.body);
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

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-PMC', 'Moisture content (fictional)')).id;
    atterberg = (await h.testType('DEMO-PATT', 'Atterberg limits (fictional)')).id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('lists covered units with open tests, with their location and program, until done or at the lab', async () => {
    const holeId = await hole();
    const bucket = await h.bucket({ hole: holeId });
    const program = await submit(holeId, [moisture]);

    const listed = (await pull()).units.find((u) => u.storageUnitId === bucket.id);
    expect(listed).toMatchObject({
      readableId: bucket.readableId,
      programs: [{ programId: program.id, programNumber: program.programNumber }],
      urgent: false,
    });
    expect(listed!.location.code).toBeTruthy();

    // Once its unit sits at a lab location it is no longer "to pull".
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, 'Lab bench (fictional)', 'lab')
       RETURNING id`,
      [`LB-${newKey().slice(0, 6)}`],
    );
    await h.db.pool.query('UPDATE storage_unit SET current_location_id = $2 WHERE id = $1', [
      bucket.id,
      rows[0]!.id,
    ]);
    expect((await pull()).units.some((u) => u.storageUnitId === bucket.id)).toBe(false);
  });

  it('drops a unit when its line has no Requested or In progress test left', async () => {
    const holeId = await hole();
    const bucket = await h.bucket({ hole: holeId });
    const program = await submit(holeId, [moisture]);
    const request = program.lines[0]!.requests[0]!;
    await setStatus(request.id, 'in_progress');
    expect((await pull()).units.some((u) => u.storageUnitId === bucket.id)).toBe(true);
    await setStatus(request.id, 'completed');
    expect((await pull()).units.some((u) => u.storageUnitId === bucket.id)).toBe(false);
  });

  it('is a read for lab_program.read only', async () => {
    expect((await h.get('/api/worklist/units-to-pull', 'tech')).status).toBe(200);
    expect((await h.http().get('/api/worklist/units-to-pull')).status).toBe(401);
  });

  it('counts list progress by status: one cell per test, cancelled apart', async () => {
    const holeId = await hole();
    await h.bucket({ hole: holeId });
    const program = await submit(holeId, [moisture, atterberg]);
    const [first] = program.lines[0]!.requests;
    await setStatus(first!.id, 'in_progress');

    const list = labProgramListSchema.parse(
      (await h.get('/api/lab-programs?status=submitted', 'tech')).body,
    );
    const ours = list.items.find((item) => item.id === program.id);
    expect(ours?.progress).toEqual({ done: 0, inProgress: 1, notStarted: 1, cancelled: 0 });

    const draft = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture, atterberg])],
      },
      'tech',
    );
    const drafts = labProgramListSchema.parse(
      (await h.get('/api/lab-programs?status=draft', 'tech')).body,
    );
    expect(drafts.items.find((item) => item.id === draft.body.id)?.progress).toEqual({
      done: 0,
      inProgress: 0,
      notStarted: 2,
      cancelled: 0,
    });
  });
});
