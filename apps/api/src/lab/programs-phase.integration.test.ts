import {
  labProgramListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  programUnitsSchema,
  type LabProgram,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// STRATA-87: the programs list's phase (its status tag), tab counts and closed date, and the
// program page's Units to pull. Real PostgreSQL, fictional data only (DEMO-2601).
describe.runIf(testDatabaseUrl)('lab program phase and units to pull (STRATA-87)', () => {
  let h: LabHarness;
  let moisture: string;

  async function hole(): Promise<string> {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects.a, `TH-${newKey().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  async function submit(holeId: string): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
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

  async function version(requestId: string) {
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM test_request WHERE id = $1',
      [requestId],
    );
    return rows[0]!.version;
  }

  async function move(requestId: string, to: string) {
    const response = await h.send(
      'post',
      `/api/test-requests/${requestId}/status`,
      { to, version: await version(requestId), idempotencyKey: newKey() },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  async function listed(programId: string, status = 'submitted') {
    const list = labProgramListSchema.parse(
      (await h.get(`/api/lab-programs?status=${status}`, 'tech')).body,
    );
    return { list, row: list.items.find((item) => item.id === programId) };
  }

  async function units(programId: string, as: 'tech' | 'lab' = 'tech') {
    const response = await h.get(`/api/lab-programs/${programId}/units`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return programUnitsSchema.parse(response.body);
  }

  async function labLocation(): Promise<string> {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, 'Soils lab bench (fictional)', 'lab')
       RETURNING id`,
      [`LB-${newKey().slice(0, 6)}`],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-PH87', 'Moisture content (fictional)')).id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('walks the phases: pull units, testing, review, ready to close, closed', async () => {
    const holeId = await hole();
    const bucket = await h.bucket({ hole: holeId });
    const program = await submit(holeId);
    const requestId = program.lines[0]!.requests[0]!.id;

    expect((await listed(program.id)).row).toMatchObject({ phase: 'pull', closedAt: null });
    const before = await units(program.id);
    expect(before).toMatchObject({ toPull: 1, atLab: 0 });
    expect(before.units).toEqual([
      expect.objectContaining({
        storageUnitId: bucket.id,
        readableId: bucket.readableId,
        lineNumbers: [1],
        toPull: true,
        atLab: false,
      }),
    ]);
    expect(before.units[0]!.location?.code).toBeTruthy();

    // At a lab location the unit is no longer to pull: the program is testing.
    await h.db.pool.query('UPDATE storage_unit SET current_location_id = $2 WHERE id = $1', [
      bucket.id,
      await labLocation(),
    ]);
    expect((await listed(program.id)).row?.phase).toBe('testing');
    expect(await units(program.id, 'lab')).toMatchObject({ toPull: 0, atLab: 1 });

    await move(requestId, 'in_progress');
    await move(requestId, 'completed');
    // Completed but not sent to review is still lab work.
    expect((await listed(program.id)).row?.phase).toBe('testing');
    await move(requestId, 'review');
    expect((await listed(program.id)).row?.phase).toBe('review');

    const reviewed = await h.send(
      'post',
      `/api/test-requests/${requestId}/review`,
      { action: 'complete', version: await version(requestId), idempotencyKey: newKey() },
      'lm',
    );
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const accepted = await h.send(
      'post',
      `/api/test-requests/${requestId}/accept`,
      { version: await version(requestId), idempotencyKey: newKey() },
      'pe',
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await listed(program.id)).row?.phase).toBe('ready');

    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM lab_program WHERE id = $1',
      [program.id],
    );
    const closed = await h.send(
      'post',
      `/api/lab-programs/${program.id}/close`,
      { version: rows[0]!.version, idempotencyKey: newKey() },
      'tech',
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const after = (await listed(program.id, 'closed')).row;
    expect(after?.phase).toBe('closed');
    expect(after?.closedAt).toEqual(expect.any(String));
    // A closed program has nothing to pull, wherever its units are.
    expect((await units(program.id)).toPull).toBe(0);
  });

  it('counts each tab under the list’s visibility: drafts are this account’s own', async () => {
    const holeId = await hole();
    await h.bucket({ hole: holeId });
    const draft = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture])],
      },
      'tech',
    );
    expect(draft.status).toBe(201);
    const mine = (await listed(draft.body.id, 'draft')).list;
    expect(mine.items.find((item) => item.id === draft.body.id)?.phase).toBe('draft');
    const { rows } = await h.db.pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM lab_program
       WHERE status <> 'draft' OR created_by_account_user_id = $1 GROUP BY status`,
      [h.users.tech],
    );
    const n = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
    expect(mine.counts).toEqual({ open: n('submitted'), drafts: n('draft'), closed: n('closed') });
    // Someone else sees the same open and closed programs but none of this draft.
    const others = labProgramListSchema.parse((await h.get('/api/lab-programs', 'pe')).body);
    expect(others.counts?.open).toBe(n('submitted'));
    expect(others.items.some((item) => item.id === draft.body.id)).toBe(false);
  });

  it('units: 404 for a draft, someone else’s draft or a bad ID; 401 signed out', async () => {
    const holeId = await hole();
    await h.bucket({ hole: holeId });
    const draft = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture])],
      },
      'tech',
    );
    expect((await h.get(`/api/lab-programs/${draft.body.id}/units`, 'tech')).status).toBe(404);
    expect((await h.get(`/api/lab-programs/${draft.body.id}/units`, 'pe')).status).toBe(404);
    expect((await h.get('/api/lab-programs/not-an-id/units', 'tech')).status).toBe(404);
    expect((await h.http().get(`/api/lab-programs/${draft.body.id}/units`)).status).toBe(401);
  });
});
