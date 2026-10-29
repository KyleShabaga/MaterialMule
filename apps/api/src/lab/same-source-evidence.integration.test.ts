import {
  labProgramReviewSchema,
  labProgramSchema,
  programWorkSchema,
  sameSourceUnitsSchema,
  storageUnitDetailSchema,
  type LabProgram,
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

// MM-T73 (owner decision 2026-10-28, option B): a Shelby tube or bulk-sample bucket outside a
// line's frozen coverage (not chosen on a Specific line, not ticked on a Grabs/SPT line) can be
// recorded as tested when it is from the line's own source in the program's project, with an
// explicit confirmation by the person completing the test. The confirmed link is evidence for
// MM-T36 removal after testing. The database rules (test_request_unit_link_guard) are proven here rather
// than in schema.test.ts because they need submitted programs with frozen coverage and
// completion events (the lab harness). Real PostgreSQL, fictional data only (DEMO-2601/2602).
describe.runIf(testDatabaseUrl)('same-source tested-unit evidence (MM-T73)', () => {
  let h: LabHarness;
  let ucs: string;
  let moisture: string;
  type As = PersonKey | 'lab';

  async function newHole(project: 'a' | 'b' = 'a') {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects[project], `TH26-${newKey().slice(0, 6)}`],
    );
    return rows[0]!.id;
  }

  /** Creates and submits a program with `lines`, freezing the reviewed coverage. */
  async function submitted(lines: unknown[]): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects.a, idempotencyKey: newKey(), lines },
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

  /** "TH26-xx / Specific / T5 at 10–12 ft / UCS" with no unit chosen. */
  const specific = (holeId: string, tests = [ucs]) =>
    line({ kind: 'test_hole', id: holeId }, 'specific', tests, {
      sampleLabel: 'T5',
      depthMode: 'interval',
      depthFrom: 10,
      depthTo: 12,
      depthUnit: 'ft',
    });

  const status = (requestId: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send(
      'post',
      `/api/test-requests/${requestId}/status`,
      { idempotencyKey: newKey(), ...body },
      as,
    );

  const start = async (requestId: string) =>
    expect((await status(requestId, { to: 'in_progress', version: 1 })).status).toBe(200);

  /** Mark completed as LAB for Jordan Smith. */
  const completeAsLab = (requestId: string, body: Record<string, unknown>) =>
    status(
      requestId,
      { to: 'completed', version: 2, actingStaffUserId: h.users.js, ...body },
      'lab',
    );

  async function sameSource(requestId: string, as: As = 'lab') {
    const response = await h.get(`/api/test-requests/${requestId}/same-source-units`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return sameSourceUnitsSchema.parse(response.body).units.map((u) => u.storageUnitId);
  }

  const detail = async (id: string) =>
    storageUnitDetailSchema.parse((await h.get(`/api/storage-units/${id}`, 'tech')).body);

  const remove = (unitId: string, testRequestId: string, as: As = 'tech') =>
    h.send(
      'post',
      `/api/storage-units/${unitId}/tested-removal`,
      { confirmPhysicalRemoval: true, idempotencyKey: newKey(), testRequestId, version: 1 },
      as,
    );

  async function requestStatus(id: string) {
    const { rows } = await h.db.pool.query<{ status: string; version: number }>(
      'SELECT status, version FROM test_request WHERE id = $1',
      [id],
    );
    return rows[0]!;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    ucs = (await h.testType('DEMO-UCS', 'Unconfined compression (fictional)')).id;
    moisture = (await h.testType('DEMO-MC3', 'Moisture content (fictional)')).id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('T1 / AC1: Specific line, tube not chosen → completion with a confirmed same-source tube → Used by the program, removal succeeds', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole, sampleReference: 'T5' });
    const sibling = await h.tube({ holeId: hole, sampleReference: 'T6' });
    const bulk = await h.bulkGroup({
      holeId: hole,
      sampleReference: 'B1',
      depthFrom: 1,
      buckets: 1,
    });
    const ordinary = await h.bucket({ hole });
    const program = await submitted([specific(hole)]);
    expect(program.lines[0]!.coverage).toEqual([]);
    const requestId = program.lines[0]!.requests[0]!.id;

    // The picker offers the source's tubes and bulk buckets only (never an ordinary bucket).
    const offered = await sameSource(requestId);
    expect(offered.sort()).toEqual([tube.id, sibling.id, bulk.members[0]!.id].sort());
    expect(offered).not.toContain(ordinary.id);

    await start(requestId);
    // Without the confirmation the tube is still refused, as before.
    const unconfirmed = await completeAsLab(requestId, { testedStorageUnitIds: [tube.id] });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.body.code).toBe('unit_not_covered');
    // A confirmation must name units that are also listed as tested (shape error).
    const stray = await completeAsLab(requestId, {
      testedStorageUnitIds: [],
      sameSourceConfirmedUnitIds: [tube.id],
    });
    expect(stray.status).toBe(400);

    const key = newKey();
    const body = {
      to: 'completed',
      version: 2,
      actingStaffUserId: h.users.js,
      idempotencyKey: key,
      testedStorageUnitIds: [tube.id],
      sameSourceConfirmedUnitIds: [tube.id],
    };
    const done = await h.send('post', `/api/test-requests/${requestId}/status`, body, 'lab');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // An exact retry replays; nothing is linked twice.
    const replay = await h.send('post', `/api/test-requests/${requestId}/status`, body, 'lab');
    expect(replay.status).toBe(200);

    // The confirmation (who and when) is stored with the link.
    const { rows: links } = await h.db.pool.query(
      `SELECT coverage_basis, confirmed_by_account_user_id, confirmed_by_person_user_id,
              confirmed_by_person_name_snapshot, confirmed_at
       FROM test_request_unit_link WHERE test_request_id = $1`,
      [requestId],
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      coverage_basis: 'same_source_confirmed',
      confirmed_by_account_user_id: h.users.lab,
      confirmed_by_person_user_id: h.users.js,
    });
    expect(links[0].confirmed_at).toBeInstanceOf(Date);
    // Visible in the program's work view and the audit trail.
    const work = programWorkSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}/work`, 'tech')).body,
    );
    expect(work.testedUnits).toEqual([
      expect.objectContaining({
        storageUnitId: tube.id,
        coverageBasis: 'same_source_confirmed',
        confirmation: expect.objectContaining({
          accountUserId: h.users.lab,
          person: expect.objectContaining({ userId: h.users.js }),
        }),
      }),
    ]);
    const { rows: audit } = await h.db.pool.query<{ after: Record<string, unknown> }>(
      `SELECT after_values AS after FROM audit_event WHERE action = 'test_request.status_changed'
         AND entity_id = $1 AND after_values->>'status' = 'completed'`,
      [requestId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({
      testedUnits: [tube.readableId],
      sameSourceConfirmedUnits: [tube.readableId],
    });

    // Used by that program; contents destroyed; removal available. The sibling is untouched.
    const tested = await detail(tube.id);
    expect(tested.testing).toMatchObject({ contentsDestroyed: true, blocker: null });
    expect(tested.testing!.evidence).toEqual([
      expect.objectContaining({
        programNumber: program.programNumber,
        testRequestId: requestId,
        sameSourceConfirmation: expect.objectContaining({
          person: expect.objectContaining({ userId: h.users.js }),
        }),
      }),
    ]);
    expect((await detail(sibling.id)).testing).toMatchObject({ blocker: 'no_tested_evidence' });
    // No longer offered to a later program: not covered, not in its same-source picker.
    const later = await submitted([line({ kind: 'test_hole', id: hole }, 'all', [ucs])]);
    expect(later.lines[0]!.coverage.map((c) => c.storageUnitId)).not.toContain(tube.id);
    expect(later.lines[0]!.coverage.map((c) => c.storageUnitId)).toContain(sibling.id);
    const laterSpecific = await submitted([specific(hole)]);
    expect(await sameSource(laterSpecific.lines[0]!.requests[0]!.id)).not.toContain(tube.id);

    // AC4: LAB can't remove; a personal account can, and the test status doesn't change.
    const before = await requestStatus(requestId);
    expect((await remove(tube.id, requestId, 'lab')).status).toBe(403);
    const removed = await remove(tube.id, requestId);
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect((await detail(tube.id)).status).toBe('disposed');
    expect(await requestStatus(requestId)).toEqual(before);
  });

  it('T2 / AC2: Grabs line, tube not ticked → same; a ticked (covered) tube needs no confirmation', async () => {
    const hole = await newHole();
    const ticked = await h.tube({ holeId: hole, sampleReference: 'T1' });
    const unticked = await h.tube({ holeId: hole, sampleReference: 'T2' });
    const program = await submitted([
      line({ kind: 'test_hole', id: hole }, 'grabs', [ucs, moisture], { unitIds: [ticked.id] }),
    ]);
    const [first, second] = program.lines[0]!.requests.map((r) => r.id) as [string, string];
    expect(await sameSource(first)).toEqual([unticked.id]);

    await start(first);
    // Confirming a covered unit is refused: it needs none.
    const needless = await completeAsLab(first, {
      testedStorageUnitIds: [ticked.id],
      sameSourceConfirmedUnitIds: [ticked.id],
    });
    expect(needless.status).toBe(422);
    expect(needless.body.code).toBe('confirmation_not_needed');
    const done = await completeAsLab(first, {
      testedStorageUnitIds: [ticked.id, unticked.id],
      sameSourceConfirmedUnitIds: [unticked.id],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const { rows } = await h.db.pool.query<{ storage_unit_id: string; coverage_basis: string }>(
      `SELECT storage_unit_id, coverage_basis FROM test_request_unit_link
       WHERE test_request_id = $1`,
      [first],
    );
    expect(Object.fromEntries(rows.map((r) => [r.storage_unit_id, r.coverage_basis]))).toEqual({
      [ticked.id]: 'frozen_coverage',
      [unticked.id]: 'same_source_confirmed',
    });

    // Covered units keep working exactly as before (no confirmation) on the program's other test.
    await start(second);
    expect((await completeAsLab(second, { testedStorageUnitIds: [ticked.id] })).status).toBe(200);

    expect((await detail(unticked.id)).testing).toMatchObject({
      contentsDestroyed: true,
      blocker: null,
    });
    const removed = await remove(unticked.id, first);
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect((await requestStatus(first)).status).toBe('completed');
  });

  it('AC3: a unit of another source or project, or an ordinary bucket, is refused by the server and the database', async () => {
    const hole = await newHole();
    const otherHole = await newHole();
    await h.tube({ holeId: hole, sampleReference: 'T5' });
    const otherSource = await h.tube({ holeId: otherHole, sampleReference: 'T5' });
    const otherProject = await h.tube({ project: 'b', holeId: h.holes.b1, sampleReference: 'T5' });
    const ordinary = await h.bucket({ hole });
    const standalone = await h.tube({ location: 'Embankment Location 07' });
    const program = await submitted([specific(hole)]);
    const requestId = program.lines[0]!.requests[0]!.id;
    const offered = await sameSource(requestId);
    for (const unit of [otherSource, otherProject, ordinary, standalone]) {
      expect(offered).not.toContain(unit.id);
    }

    await start(requestId);
    for (const unit of [otherSource, otherProject, ordinary, standalone]) {
      const refused = await completeAsLab(requestId, {
        testedStorageUnitIds: [unit.id],
        sameSourceConfirmedUnitIds: [unit.id],
      });
      expect(refused.status, unit.readableId).toBe(422);
      expect(refused.body.code).toBe('unit_not_covered');
    }
    expect((await requestStatus(requestId)).status).toBe('in_progress');

    // Database: raw evidence as a client past the service would write it.
    const { rows: events } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_request_status_history
         (test_request_id, program_id, from_status, to_status, account_user_id, account_type,
          account_name_snapshot, person_user_id, person_name_snapshot, idempotency_key,
          request_hash)
       SELECT r.id, r.program_id, 'in_progress', 'completed', $2, 'personal', 'Alex Tester',
              $2, 'Alex Tester', gen_random_uuid(), 'x'
       FROM test_request r WHERE r.id = $1 RETURNING id`,
      [requestId, h.users.tech],
    );
    const eventId = events[0]!.id;
    const link = (
      unitId: string,
      projectId: string,
      basis: string,
      confirmedBy: string | null = h.users.tech,
    ) =>
      h.db.pool.query(
        `INSERT INTO test_request_unit_link (test_request_id, status_history_id, storage_unit_id,
                                             project_id, unit_readable_id_snapshot,
                                             coverage_basis, confirmed_by_account_user_id,
                                             confirmed_by_person_user_id,
                                             confirmed_by_person_name_snapshot, confirmed_at)
         VALUES ($1, $2, $3, $4, 'x', $5,
                 CASE WHEN $5 = 'same_source_confirmed' THEN $6::uuid END,
                 CASE WHEN $5 = 'same_source_confirmed' THEN $6::uuid END,
                 CASE WHEN $5 = 'same_source_confirmed' THEN 'Alex Tester' END,
                 CASE WHEN $5 = 'same_source_confirmed' THEN now() END)`,
        [requestId, eventId, unitId, projectId, basis, confirmedBy],
      );
    await expect(link(otherSource.id, h.projects.a, 'same_source_confirmed')).rejects.toMatchObject(
      { constraint: 'test_request_unit_link_same_source' },
    );
    await expect(link(ordinary.id, h.projects.a, 'same_source_confirmed')).rejects.toMatchObject({
      constraint: 'test_request_unit_link_same_source',
    });
    await expect(
      link(otherProject.id, h.projects.b, 'same_source_confirmed'),
    ).rejects.toMatchObject({ constraint: 'test_request_unit_link_same_project' });
    // Without a confirmation, a unit outside the frozen coverage is refused outright.
    await expect(link(otherSource.id, h.projects.a, 'frozen_coverage')).rejects.toMatchObject({
      constraint: 'test_request_unit_link_covered',
    });
    const nineTube = await h.tube({ holeId: hole, sampleReference: 'T9' });
    await expect(link(nineTube.id, h.projects.a, 'frozen_coverage')).rejects.toMatchObject({
      constraint: 'test_request_unit_link_covered',
    });
    // The confirmation must be the completion's own account and person.
    await expect(
      link(nineTube.id, h.projects.a, 'same_source_confirmed', h.users.pe),
    ).rejects.toMatchObject({ constraint: 'test_request_unit_link_confirmed_by_completer' });
    // The rules allow the real thing.
    await expect(link(nineTube.id, h.projects.a, 'same_source_confirmed')).resolves.toBeDefined();
  });

  it('a tube another program already tested is still refused (shelby_contents_destroyed_by_program), and a covered unit can’t be confirmed in the database', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole, sampleReference: 'T5' });
    const covered = await h.tube({ holeId: hole, sampleReference: 'T6' });
    const all = await submitted([line({ kind: 'test_hole', id: hole }, 'all', [ucs])]);
    const later = await submitted([specific(hole)]);
    const first = all.lines[0]!.requests[0]!.id;
    const second = later.lines[0]!.requests[0]!.id;
    expect((await sameSource(second)).sort()).toEqual([tube.id, covered.id].sort());

    await start(first);
    expect((await completeAsLab(first, { testedStorageUnitIds: [tube.id] })).status).toBe(200);
    // No longer offered, and refused when named anyway.
    expect(await sameSource(second)).toEqual([covered.id]);
    await start(second);
    const refused = await completeAsLab(second, {
      testedStorageUnitIds: [tube.id],
      sameSourceConfirmedUnitIds: [tube.id],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('unit_contents_destroyed');

    // Database: confirming a unit that is in the line's coverage is refused.
    const { rows } = await h.db.pool.query(
      `SELECT test_request_id, status_history_id FROM test_request_unit_link
       WHERE test_request_id = $1`,
      [first],
    );
    await expect(
      h.db.pool.query(
        `INSERT INTO test_request_unit_link (test_request_id, status_history_id, storage_unit_id,
                                             project_id, unit_readable_id_snapshot,
                                             coverage_basis, confirmed_by_account_user_id,
                                             confirmed_by_person_user_id,
                                             confirmed_by_person_name_snapshot, confirmed_at)
         VALUES ($1, $2, $3, $4, 'x', 'same_source_confirmed', $5, $6, 'Jordan Smith', now())`,
        [
          rows[0].test_request_id,
          rows[0].status_history_id,
          covered.id,
          h.projects.a,
          h.users.lab,
          h.users.js,
        ],
      ),
    ).rejects.toMatchObject({ constraint: 'test_request_unit_link_same_source' });
    // A covered link carries no confirmation (and a confirmed one must record who and when).
    await expect(
      h.db.pool.query(
        `INSERT INTO test_request_unit_link (test_request_id, status_history_id, storage_unit_id,
                                             project_id, unit_readable_id_snapshot, confirmed_at)
         VALUES ($1, $2, $3, $4, 'x', now())`,
        [rows[0].test_request_id, rows[0].status_history_id, covered.id, h.projects.a],
      ),
    ).rejects.toMatchObject({ constraint: 'test_request_unit_link_confirmation_shape' });
  });

  it('same-source units are listed for an existing test only', async () => {
    const hole = await newHole();
    await h.tube({ holeId: hole });
    const program = await submitted([specific(hole)]);
    const requestId = program.lines[0]!.requests[0]!.id;
    expect((await h.get(`/api/test-requests/${requestId}/same-source-units`, 'tech')).status).toBe(
      200,
    );
    expect((await h.get(`/api/test-requests/${newKey()}/same-source-units`, 'tech')).status).toBe(
      404,
    );
  });
});
