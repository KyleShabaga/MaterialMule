import {
  labProgramReviewSchema,
  storageUnitHistoryActionLabel,
  storageUnitHistoryPageSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MTR-59: a unit's History also lists the retention holds and extensions covering it (its own
// and its project's) and the lab programs and test requests covering it, with who and when.
// MTR-3: each event carries the actor's account type. Fictional data only: DEMO-2601 (A),
// DEMO-2602 (B), Lee Manager (`lm`), Pat Example (`pe`), Alex Tester (`tech`).
describe.runIf(testDatabaseUrl)('storage unit history coverage (MTR-59)', () => {
  let h: LabHarness;
  let moisture: string;

  async function newHole(project: 'a' | 'b' = 'a') {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects[project], `TH-${newKey().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  const retention = (kind: 'holds' | 'extensions', body: Record<string, unknown>, as = 'lm') =>
    h.send(
      'post',
      `/api/retention/${kind}`,
      {
        projectId: h.projects.a,
        scope: 'project',
        reason: 'Claim review',
        idempotencyKey: newKey(),
        ...body,
      },
      as,
    );

  async function history(unitId: string) {
    const response = await h.get(`/api/storage-units/${unitId}/history`, 'tech');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return storageUnitHistoryPageSchema.parse(response.body);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('MC', 'Moisture content', 'Moisture')).id;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('lists covering holds, extensions, releases, programs and test requests, and nothing else', async () => {
    const hole = await newHole();
    const unit = await h.bucket({ hole });
    const neighbour = await h.bucket({ hole: await newHole() });

    // Its own hold, its project's hold (then released), an extension, and holds that don't cover it.
    const own = await retention('holds', {
      scope: 'units',
      unitIds: [unit.id],
      reason: 'Own hold',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const projectWide = await retention('holds', { reason: 'Project hold' });
    expect(projectWide.status).toBe(201);
    const released = await h.send(
      'post',
      `/api/retention/holds/${projectWide.body.id}/release`,
      { reason: 'Claim settled', version: 1, idempotencyKey: newKey() },
      'lm',
    );
    expect(released.status).toBe(200);
    const extended = await retention(
      'extensions',
      { scope: 'units', unitIds: [unit.id], retainUntil: '2029-01-01', reason: 'Client asked' },
      'pe',
    );
    expect(extended.status, JSON.stringify(extended.body)).toBe(201);
    expect(
      (await retention('holds', { scope: 'units', unitIds: [neighbour.id], reason: 'Other' }))
        .status,
    ).toBe(201);
    expect(
      (await retention('holds', { projectId: h.projects.b, reason: 'Other project' })).status,
    ).toBe(201);

    // A program covering the unit's hole, submitted, with its test started.
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: hole }, 'all', [moisture])],
      },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
    );
    const submitted = await h.send(
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
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const { rows: requests } = await h.db.pool.query<{ id: string }>(
      'SELECT id FROM test_request WHERE program_id = $1',
      [created.body.id],
    );
    expect(requests).toHaveLength(1);
    const started = await h.send(
      'post',
      `/api/test-requests/${requests[0]!.id}/status`,
      { idempotencyKey: newKey(), to: 'in_progress', version: 1 },
      'tech',
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const page = await history(unit.id);
    const actions = page.items.map((event) => event.action);
    expect(page.total).toBe(page.items.length);
    expect([...actions].sort()).toEqual(
      // (The harness inserts its buckets directly, so there is no receipt or creation event.)
      [
        'retention.hold_placed',
        'retention.hold_placed',
        'retention.hold_released',
        'retention.extended',
        'lab_program.created',
        'lab_program.submitted',
        'test_request.created',
        'test_request.status_changed',
      ].sort(),
    );
    // Newest first: the test start is the latest event.
    expect(actions[0]).toBe('test_request.status_changed');

    const byAction = (action: string) => page.items.filter((event) => event.action === action);
    expect(
      byAction('retention.hold_placed')
        .map((e) => e.reason)
        .sort(),
    ).toEqual(['Own hold', 'Project hold']);
    const [hold] = byAction('retention.hold_released');
    expect(hold).toMatchObject({ reason: 'Claim settled', actor: { name: 'Lee Manager' } });
    // MTR-3: the actor's account type comes with every event.
    expect(hold!.actor.accountType).toEqual(expect.any(String));
    const [extension] = byAction('retention.extended');
    expect(extension!.actor.name).toBe('Pat Example');
    expect(storageUnitHistoryActionLabel(extension!.action, extension!.after)).toBe(
      'Retention extended to 2029-01-01',
    );
    const [submittedEvent] = byAction('lab_program.submitted');
    expect(storageUnitHistoryActionLabel(submittedEvent!.action, submittedEvent!.after)).toMatch(
      /^Lab program LP-\d{4}-\d{4} submitted$/,
    );
    const [statusEvent] = byAction('test_request.status_changed');
    expect(statusEvent).toMatchObject({
      before: { status: 'requested' },
      after: { status: 'in_progress', code: 'MC' },
      actor: { name: 'Alex Tester' },
    });

    // The neighbour sees the project-wide hold and its release, but not this unit's own events.
    const other = (await history(neighbour.id)).items.map((event) => event.reason);
    expect(other).toContain('Project hold');
    expect(other).toContain('Other');
    expect(other).not.toContain('Own hold');
    expect(other).not.toContain('Other project');
  });

  it('a unit tested by a same-source completion link outside frozen coverage lists its program, including closure and reopening', async () => {
    const hole = await newHole();
    // A Specific line with no unit chosen: the tube is outside the frozen coverage (MM-T73).
    const tube = await h.tube({ holeId: hole, sampleReference: 'T5' });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [
          line({ kind: 'test_hole', id: hole }, 'specific', [moisture], {
            sampleLabel: 'T5',
            depthMode: 'interval',
            depthFrom: 10,
            depthTo: 12,
            depthUnit: 'ft',
          }),
        ],
      },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await h.send(
      'post',
      `/api/lab-programs/${created.body.id}/submit`,
      {
        version: created.body.version,
        idempotencyKey: newKey(),
        coverage: [{ lineId: created.body.lines[0].id, unitIds: [] }],
      },
      'tech',
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const programId = created.body.id as string;
    const { rows: frozen } = await h.db.pool.query(
      'SELECT 1 FROM program_scope_snapshot WHERE program_id = $1 AND storage_unit_id = $2',
      [programId, tube.id],
    );
    expect(frozen).toHaveLength(0);
    const requestId = submitted.body.lines[0].requests[0].id as string;

    const status = async (to: string, extra: Record<string, unknown> = {}, as = 'tech') => {
      const { rows } = await h.db.pool.query<{ version: number }>(
        'SELECT version FROM test_request WHERE id = $1',
        [requestId],
      );
      const moved = await h.send(
        'post',
        `/api/test-requests/${requestId}/status`,
        { to, version: rows[0]!.version, idempotencyKey: newKey(), ...extra },
        as,
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      return moved.body.version as number;
    };
    await status('in_progress');
    await status('completed', {
      testedStorageUnitIds: [tube.id],
      sameSourceConfirmedUnitIds: [tube.id],
    });
    let version = await status('review');
    version = (
      await h.send(
        'post',
        `/api/test-requests/${requestId}/review`,
        { action: 'complete', version, idempotencyKey: newKey() },
        'tech',
      )
    ).body.version;
    const accepted = await h.send(
      'post',
      `/api/test-requests/${requestId}/accept`,
      { version, idempotencyKey: newKey() },
      'pe',
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const programVersion = async () =>
      (
        await h.db.pool.query<{ version: number }>(
          'SELECT version FROM lab_program WHERE id = $1',
          [programId],
        )
      ).rows[0]!.version;
    const closed = await h.send(
      'post',
      `/api/lab-programs/${programId}/close`,
      { version: await programVersion(), idempotencyKey: newKey() },
      'pe',
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const reopened = await h.send(
      'post',
      `/api/lab-programs/${programId}/reopen`,
      {
        reason: 'Client asked for a repeat',
        version: await programVersion(),
        idempotencyKey: newKey(),
      },
      'lm',
    );
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);

    const actions = (await history(tube.id)).items.map((event) => event.action);
    for (const action of [
      'lab_program.created',
      'lab_program.submitted',
      'lab_program.closed',
      'lab_program.reopened',
      'test_request.created',
      'test_request.status_changed',
    ]) {
      expect(actions, action).toContain(action);
    }
  });
});
