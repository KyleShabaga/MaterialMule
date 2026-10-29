import {
  labProgramReviewSchema,
  labProgramSchema,
  laterReceiptsSchema,
  programWorkSchema,
  type LabProgram,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { PG } from '../test-support/fixtures.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-T26 amendments (D02) and accepted-request changes (D09): card AC3, AC4 (amend/change on a
// closed program), AC7, test plan T2, T5 and preparation scenarios L04, L06, L07, L11. Real
// PostgreSQL. Fictional data only: DEMO-2601 (A), Lead Project Engineer Pat Example (`pe`), Technician Alex
// Tester (`tech`), Lab Manager Lee Manager (`lm`).
describe.runIf(testDatabaseUrl)('lab amendments and accepted-request changes (MM-T26)', () => {
  let h: LabHarness;
  let moisture: string;
  let sieve: string;
  let retired: string;

  async function newHole() {
    return (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects.a, `TH-${newKey().slice(0, 8)}`],
      )
    ).rows[0]!.id;
  }

  async function submit(lines: unknown[]): Promise<LabProgram> {
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
    return labProgramSchema.parse(submitted.body);
  }

  const status = (id: string, to: string, version: number, extra = {}) =>
    h.send(
      'post',
      `/api/test-requests/${id}/status`,
      { to, version, idempotencyKey: newKey(), ...extra },
      'tech',
    );

  /** Requested → Accepted along the whole path; returns the new version. */
  async function accept(id: string, units?: string[]): Promise<number> {
    let version = (await row(id)).version;
    for (const to of ['in_progress', 'completed', 'review']) {
      const moved = await status(
        id,
        to,
        version,
        to === 'completed' && units ? { testedStorageUnitIds: units } : {},
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      version = moved.body.version as number;
    }
    version = (
      await h.send(
        'post',
        `/api/test-requests/${id}/review`,
        { action: 'complete', version, idempotencyKey: newKey() },
        'tech',
      )
    ).body.version as number;
    const accepted = await h.send(
      'post',
      `/api/test-requests/${id}/accept`,
      { version, idempotencyKey: newKey() },
      'pe',
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return accepted.body.version as number;
  }

  async function row(id: string) {
    const { rows } = await h.db.pool.query<{
      status: string;
      version: number;
      test_code_snapshot: string;
      sample_label_override: string | null;
      depth_from_override: string | null;
      identity_revision: number;
      accepted_by_user_id: string | null;
    }>(
      `SELECT status, version, test_code_snapshot, sample_label_override, depth_from_override,
              identity_revision, accepted_by_user_id
       FROM test_request WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function programVersion(id: string) {
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM lab_program WHERE id = $1',
      [id],
    );
    return rows[0]!.version;
  }

  const change = (id: string, body: Record<string, unknown>, as: string = 'tech') =>
    h.send(
      'patch',
      `/api/test-requests/${id}`,
      { reason: 'Field log corrected', idempotencyKey: newKey(), ...body },
      as,
    );
  const amend = async (programId: string, body: Record<string, unknown>, as: string = 'tech') =>
    h.send(
      'post',
      `/api/lab-programs/${programId}/amend`,
      { version: await programVersion(programId), idempotencyKey: newKey(), ...body },
      as,
    );

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC27', 'Moisture content (fictional)', 'Moisture')).id;
    sieve = (await h.testType('DEMO-SV27', 'Sieve analysis (fictional)', 'Sieve')).id;
    const old = await h.testType('DEMO-OLD27', 'Retired test (fictional)', 'Old');
    retired = old.id;
    const retiring = await h.send(
      'post',
      `/api/test-types/${retired}/retire`,
      { version: old.version },
      'lm',
    );
    expect([200, 204]).toContain(retiring.status);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('AC3/L04/T2: a depth change resets only that test; history and the sibling stay', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const p = await submit([
      {
        ...line({ kind: 'test_hole', id: hole }, 'specific', [moisture, sieve]),
        sampleLabel: 'G3',
        depthMode: 'point',
        depthFrom: 1.5,
        depthUnit: 'm',
      },
    ]);
    const [a, b] = p.lines[0]!.requests.map((r) => r.id) as [string, string];
    const va = await accept(a);
    await accept(b);

    const blank = await change(a, { identity: undefined, testTypeId: undefined, version: va });
    expect(blank.status).toBe(400);
    const same = await change(a, {
      identity: { sampleLabel: 'G3', depthMode: 'point', depthFrom: 1.5, depthUnit: 'm' },
      version: va,
    });
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('no_changes');

    const changed = await change(a, {
      identity: { sampleLabel: 'G3', depthMode: 'point', depthFrom: 2, depthUnit: 'm' },
      version: va,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await row(a)).toMatchObject({
      status: 'requested',
      sample_label_override: 'G3',
      depth_from_override: '2.00',
      identity_revision: 1,
      accepted_by_user_id: null,
    });
    expect((await row(b)).status).toBe('accepted');

    const view = programWorkSchema.parse(
      (await h.get(`/api/lab-programs/${p.id}/work`, 'pe')).body,
    );
    expect(view.lifecycle.identityRevisions).toEqual([
      expect.objectContaining({
        testRequestId: a,
        before: { test: 'DEMO-MC27', sample: 'G3 at 1.5 m' },
        after: { test: 'DEMO-MC27', sample: 'G3 at 2 m' },
        reason: 'Field log corrected',
      }),
    ]);
    // The historical acceptance stays in the review events.
    expect(view.reviewEvents.filter((e) => e.testRequestId === a).map((e) => e.kind)).toEqual([
      'review_completed',
      'accepted',
    ]);
    expect(view.statusHistory.at(-1)).toMatchObject({
      testRequestId: a,
      fromStatus: 'accepted',
      toStatus: 'requested',
    });
    const program = labProgramSchema.parse((await h.get(`/api/lab-programs/${p.id}`, 'pe')).body);
    expect(program.lines[0]!.requests.find((r) => r.id === a)!.identity).toMatchObject({
      sampleLabel: 'G3',
      depthFrom: 2,
    });
    // Fresh review and acceptance are needed: it starts over from Requested.
    await accept(a);
    expect((await row(a)).status).toBe('accepted');
  });

  const repeat = async (id: string, as: string = 'tech') =>
    h.send(
      'post',
      `/api/test-requests/${id}/repeat`,
      { version: (await row(id)).version, idempotencyKey: newKey() },
      as,
    );

  async function overrides(id: string) {
    const { rows } = await h.db.pool.query<Record<string, string | null>>(
      `SELECT sample_label_override, depth_mode_override, depth_from_override,
              depth_to_override, depth_unit_override, test_code_snapshot
       FROM test_request WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  it('MM-T72 AC1/AC3/T1: a repeat of a changed test keeps the changed sample and depth', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const p = await submit([
      {
        ...line({ kind: 'test_hole', id: hole }, 'specific', [moisture]),
        sampleLabel: 'S3',
        depthMode: 'point',
        depthFrom: 1.5,
        depthUnit: 'm',
      },
    ]);
    const id = p.lines[0]!.requests[0]!.id;
    const version = await accept(id);
    const changed = await change(id, {
      identity: { sampleLabel: 'S3B', depthMode: 'point', depthFrom: 2, depthUnit: 'm' },
      version,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    await accept(id);

    // AC3: LAB still can't repeat.
    expect((await repeat(id, 'lab')).status).toBe(403);

    const repeated = await repeat(id);
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(201);
    const repeatId = repeated.body.testRequestId as string;
    expect(await overrides(repeatId)).toEqual(await overrides(id));
    expect(await overrides(repeatId)).toMatchObject({
      sample_label_override: 'S3B',
      depth_from_override: '2.00',
    });
    const program = labProgramSchema.parse((await h.get(`/api/lab-programs/${p.id}`, 'pe')).body);
    expect(program.lines[0]!.requests.find((r) => r.id === repeatId)!.identity).toMatchObject({
      sampleLabel: 'S3B',
      depthMode: 'point',
      depthFrom: 2,
      depthUnit: 'm',
    });
  });

  it('MM-T72 AC2/T2: a repeat of an unchanged test shows the line identity', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const p = await submit([
      {
        ...line({ kind: 'test_hole', id: hole }, 'specific', [moisture]),
        sampleLabel: 'S4',
        depthMode: 'interval',
        depthFrom: 1,
        depthTo: 1.5,
        depthUnit: 'm',
      },
    ]);
    const id = p.lines[0]!.requests[0]!.id;
    await accept(id);
    const repeated = await repeat(id);
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(201);
    const repeatId = repeated.body.testRequestId as string;
    expect(await overrides(repeatId)).toMatchObject({
      sample_label_override: null,
      depth_mode_override: null,
      depth_from_override: null,
      depth_to_override: null,
      depth_unit_override: null,
    });
    const program = labProgramSchema.parse((await h.get(`/api/lab-programs/${p.id}`, 'pe')).body);
    // No own identity: the request shows its line's sample and depth.
    expect(program.lines[0]!.requests.find((r) => r.id === repeatId)!.identity).toBeNull();
    expect(program.lines[0]).toMatchObject({ sampleLabel: 'S4', depthFrom: 1, depthTo: 1.5 });
  });

  it('database (MM-T72): a repeat must carry its original current test, sample and depth', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const p = await submit([
      {
        ...line({ kind: 'test_hole', id: hole }, 'specific', [moisture]),
        sampleLabel: 'S5',
        depthMode: 'point',
        depthFrom: 1.5,
        depthUnit: 'm',
      },
    ]);
    const id = p.lines[0]!.requests[0]!.id;
    const version = await accept(id);
    expect(
      (
        await change(id, {
          identity: { sampleLabel: 'S5', depthMode: 'point', depthFrom: 2, depthUnit: 'm' },
          version,
        })
      ).status,
    ).toBe(200);
    await accept(id);
    const insertRepeat = (overrideSql: string) =>
      h.db.pool.query(
        `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
                                   test_name_snapshot, test_description_snapshot,
                                   test_group_snapshot, test_subgroup_snapshot, sort_order,
                                   sample_label_override, depth_mode_override,
                                   depth_from_override, depth_to_override, depth_unit_override,
                                   repeat_of_id, created_by_user_id, created_by_name_snapshot,
                                   create_idempotency_key, create_request_hash)
         SELECT program_id, line_id, test_type_id, test_code_snapshot, test_name_snapshot,
                test_description_snapshot, test_group_snapshot, test_subgroup_snapshot,
                sort_order, ${overrideSql}, id, $2, 'Alex Tester', $3, 'hash'
         FROM test_request WHERE id = $1`,
        [id, h.users.tech, newKey()],
      );
    // The line's old identity (no overrides) is refused…
    await expect(insertRepeat('NULL, NULL, NULL, NULL, NULL')).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'test_request_repeat_identity',
    });
    // …and so is any other depth.
    await expect(insertRepeat(`'S5', 'point', 2.5, NULL, 'm'`)).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'test_request_repeat_identity',
    });
    // The original's current identity is accepted.
    await expect(
      insertRepeat(
        'sample_label_override, depth_mode_override, depth_from_override, depth_to_override, depth_unit_override',
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('accepted-request change: test swap, refusals, retries and LAB', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const p = await submit([line({ kind: 'test_hole', id: hole }, 'all', [moisture])]);
    const id = p.lines[0]!.requests[0]!.id;
    const notAccepted = await change(id, { testTypeId: sieve, version: 1 });
    expect(notAccepted.status).toBe(422);
    expect(notAccepted.body.code).toBe('invalid_transition');
    const version = await accept(id);

    expect(
      (
        await change(id, {
          identity: { sampleLabel: 'G1', depthMode: 'point', depthFrom: 1, depthUnit: 'm' },
          version,
        })
      ).body.code,
    ).toBe('not_specific');
    expect((await change(id, { testTypeId: retired, version })).body.code).toBe('retired_tests');
    const lab = await change(
      id,
      { testTypeId: sieve, version, actingStaffUserId: h.users.pe },
      'lab',
    );
    expect(lab.status).toBe(403);

    const key = newKey();
    const body = {
      testTypeId: sieve,
      version,
      reason: 'Wrong test requested',
      idempotencyKey: key,
    };
    const once = await h.send('patch', `/api/test-requests/${id}`, body, 'tech');
    const twice = await h.send('patch', `/api/test-requests/${id}`, body, 'tech');
    expect(once.status, JSON.stringify(once.body)).toBe(200);
    expect(twice.body).toEqual(once.body);
    expect(await row(id)).toMatchObject({ status: 'requested', test_code_snapshot: 'DEMO-SV27' });
    const { rows } = await h.db.pool.query(
      'SELECT 1 FROM test_request_identity_revision WHERE test_request_id = $1',
      [id],
    );
    expect(rows).toHaveLength(1);
    // Stale version after the change.
    expect((await change(id, { testTypeId: moisture, version })).status).toBe(409);
  });

  it('a changed test can be completed again with the same unit; both completions keep evidence', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole });
    const p = await submit([line({ kind: 'test_hole', id: hole }, 'all', [moisture])]);
    const id = p.lines[0]!.requests[0]!.id;
    const version = await accept(id, [tube.id]);
    expect((await change(id, { testTypeId: sieve, version })).status).toBe(200);
    await accept(id, [tube.id]);
    const { rows } = await h.db.pool.query(
      'SELECT 1 FROM test_request_unit_link WHERE test_request_id = $1 AND storage_unit_id = $2',
      [id, tube.id],
    );
    expect(rows).toHaveLength(2);
  });

  it('AC7/L07/T5: later receipts join an ALL line only by explicit amendment; the original snapshot is kept', async () => {
    const hole = await newHole();
    const first = await h.bucket({ hole });
    const p = await submit([line({ kind: 'test_hole', id: hole }, 'all', [moisture])]);
    const lineId = p.lines[0]!.id;
    const before = await h.db.pool.query(
      `SELECT to_jsonb(s) AS s FROM program_scope_snapshot s WHERE line_id = $1 ORDER BY id`,
      [lineId],
    );

    // Received after submission: a later receipt alone changes nothing.
    const later = await h.bucket({ hole });
    const another = await h.bucket({ hole });
    const offered = laterReceiptsSchema.parse(
      (await h.get(`/api/lab-programs/${p.id}/later-receipts`, 'tech')).body,
    );
    expect(offered.lines[0]!.units.map((u) => u.readableId).sort()).toEqual(
      [later.readableId, another.readableId].sort(),
    );
    expect((await h.get(`/api/lab-programs/${p.id}/later-receipts`, 'lab')).status).toBe(403);

    const notLater = await amend(p.id, {
      includeLaterReceipts: [{ lineId, unitIds: [first.id] }],
    });
    expect(notLater.status).toBe(422);
    expect(notLater.body.code).toBe('unit_not_later_receipt');

    const key = newKey();
    const body = {
      version: await programVersion(p.id),
      idempotencyKey: key,
      reason: 'Include the bucket received on 2026-10-26',
      includeLaterReceipts: [{ lineId, unitIds: [later.id] }],
    };
    const amended = await h.send('post', `/api/lab-programs/${p.id}/amend`, body, 'tech');
    expect(amended.status, JSON.stringify(amended.body)).toBe(201);
    const replay = await h.send('post', `/api/lab-programs/${p.id}/amend`, body, 'tech');
    expect(replay.status).toBe(201);
    expect(replay.body.amendmentId).toBe(amended.body.amendmentId);

    const { rows: amendments } = await h.db.pool.query<{
      added_unit_readable_ids: string[];
      amendment_number: number;
    }>(
      'SELECT added_unit_readable_ids, amendment_number FROM program_amendment WHERE program_id = $1',
      [p.id],
    );
    expect(amendments).toEqual([
      { added_unit_readable_ids: [later.readableId], amendment_number: 1 },
    ]);
    const after = await h.db.pool.query(
      `SELECT to_jsonb(s) AS s FROM program_scope_snapshot s
       WHERE line_id = $1 AND amendment_id IS NULL ORDER BY id`,
      [lineId],
    );
    expect(after.rows).toEqual(before.rows);
    const program = labProgramSchema.parse((await h.get(`/api/lab-programs/${p.id}`, 'tech')).body);
    const coverage = program.lines[0]!.coverage;
    expect(coverage.find((c) => c.storageUnitId === later.id)).toMatchObject({
      included: true,
      amendmentId: amended.body.amendmentId,
    });
    // The other later receipt is still not covered and is still offered.
    expect(coverage.some((c) => c.storageUnitId === another.id)).toBe(false);
    const still = laterReceiptsSchema.parse(
      (await h.get(`/api/lab-programs/${p.id}/later-receipts`, 'tech')).body,
    );
    expect(still.lines[0]!.units.map((u) => u.storageUnitId)).toEqual([another.id]);
    const view = programWorkSchema.parse(
      (await h.get(`/api/lab-programs/${p.id}/work`, 'tech')).body,
    );
    expect(view.lifecycle.amendments).toEqual([
      expect.objectContaining({
        amendmentNumber: 1,
        addedUnitReadableIds: [later.readableId],
        reason: 'Include the bucket received on 2026-10-26',
      }),
    ]);
  });

  it('Grabs/SPT later receipts stay excluded unless explicitly listed (reviewed_included)', async () => {
    const hole = await newHole();
    const first = await h.bucket({ hole });
    const p = await submit([
      { ...line({ kind: 'test_hole', id: hole }, 'grabs', [moisture]), unitIds: [first.id] },
    ]);
    const lineId = p.lines[0]!.id;
    const later = await h.bucket({ hole });
    const offered = laterReceiptsSchema.parse(
      (await h.get(`/api/lab-programs/${p.id}/later-receipts`, 'tech')).body,
    );
    expect(offered.lines[0]!.units[0]).toMatchObject({
      storageUnitId: later.id,
      unknownClassification: true,
    });
    expect(
      (await amend(p.id, { includeLaterReceipts: [{ lineId, unitIds: [later.id] }] })).status,
    ).toBe(201);
    const { rows } = await h.db.pool.query<{ matching_basis: string; included: boolean }>(
      `SELECT matching_basis, included FROM program_scope_snapshot
       WHERE line_id = $1 AND storage_unit_id = $2`,
      [lineId, later.id],
    );
    expect(rows).toEqual([{ matching_basis: 'reviewed_included', included: true }]);
  });

  it('adds tests and lines to an open program; refuses duplicates, stale and closed', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const p = await submit([line({ kind: 'test_hole', id: hole }, 'all', [moisture])]);
    const lineId = p.lines[0]!.id;

    expect((await amend(p.id, { addTests: [{ lineId, testTypeIds: [moisture] }] })).body.code).toBe(
      'duplicate_test',
    );
    expect((await amend(p.id, { addTests: [{ lineId, testTypeIds: [retired] }] })).body.code).toBe(
      'retired_tests',
    );
    expect((await amend(p.id, {})).status).toBe(400);
    const lab = await h.send(
      'post',
      `/api/lab-programs/${p.id}/amend`,
      {
        version: await programVersion(p.id),
        idempotencyKey: newKey(),
        addTests: [{ lineId, testTypeIds: [sieve] }],
        actingStaffUserId: h.users.pe,
      },
      'lab',
    );
    expect(lab.status).toBe(403);
    const stale = await h.send(
      'post',
      `/api/lab-programs/${p.id}/amend`,
      { version: 1, idempotencyKey: newKey(), addTests: [{ lineId, testTypeIds: [sieve] }] },
      'tech',
    );
    expect(stale.status).toBe(409);

    const added = await amend(p.id, { addTests: [{ lineId, testTypeIds: [sieve] }] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const { rows } = await h.db.pool.query<{ status: string; amendment_id: string }>(
      `SELECT status, amendment_id FROM test_request WHERE line_id = $1 AND test_type_id = $2`,
      [lineId, sieve],
    );
    expect(rows).toEqual([{ status: 'requested', amendment_id: added.body.amendmentId }]);

    // A new ALL line: the coverage the requester reviewed must match.
    const otherHole = await newHole();
    const unit = await h.bucket({ hole: otherHole });
    const newLine = {
      source: { kind: 'test_hole', id: otherHole },
      scope: 'all',
      testTypeIds: [moisture],
      reviewedCoverageUnitIds: [],
    };
    const mismatch = await amend(p.id, { addLines: [newLine] });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('coverage_changed');
    expect(mismatch.body.lines[0].coverage[0].storageUnitId).toBe(unit.id);
    const withLine = await amend(p.id, {
      addLines: [{ ...newLine, reviewedCoverageUnitIds: [unit.id] }],
    });
    expect(withLine.status, JSON.stringify(withLine.body)).toBe(201);
    const program = labProgramSchema.parse((await h.get(`/api/lab-programs/${p.id}`, 'tech')).body);
    expect(program.lines).toHaveLength(2);
    expect(program.lines[1]).toMatchObject({
      lineNumber: 2,
      amendmentId: withLine.body.amendmentId,
      coverage: [expect.objectContaining({ storageUnitId: unit.id, included: true })],
      requests: [expect.objectContaining({ code: 'DEMO-MC27', status: 'requested' })],
    });

    // AC4/L06: a closed program refuses amendments and changes until reopened.
    for (const request of program.lines.flatMap((l) => l.requests)) {
      if ((await row(request.id)).status !== 'accepted') await accept(request.id);
    }
    const closed = await h.send(
      'post',
      `/api/lab-programs/${p.id}/close`,
      { version: await programVersion(p.id), idempotencyKey: newKey() },
      'pe',
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const refused = await amend(p.id, { addTests: [{ lineId, testTypeIds: [retired] }] });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('program_not_open');
    const requestId = program.lines[0]!.requests[0]!.id;
    const changeRefused = await change(requestId, {
      testTypeId: retired,
      version: (await row(requestId)).version,
    });
    expect(changeRefused.body.code).toBe('program_not_open');
  });

  it('a Specific line added by amendment must acknowledge a different depth of the same sample', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const p = await submit([
      {
        ...line({ kind: 'test_hole', id: hole }, 'specific', [moisture]),
        sampleLabel: 'S4',
        depthMode: 'point',
        depthFrom: 3,
        depthUnit: 'ft',
      },
    ]);
    const add = {
      source: { kind: 'test_hole', id: hole },
      scope: 'specific',
      identity: { sampleLabel: 'S4', depthMode: 'point', depthFrom: 3.5, depthUnit: 'ft' },
      testTypeIds: [sieve],
    };
    const refused = await amend(p.id, { addLines: [add] });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('depth_discrepancy');
    const accepted = await amend(p.id, { addLines: [{ ...add, acknowledgedDepths: ['3 ft'] }] });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });

  it('database: amended rows need an amendment; frozen coverage only grows', async () => {
    const hole = await newHole();
    const unit = await h.bucket({ hole });
    const p = await submit([line({ kind: 'test_hole', id: hole }, 'all', [moisture])]);
    await expect(
      h.db.pool.query(
        `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id,
                                scope, source_display_snapshot, coverage_captured_at)
         VALUES ($1, $2, 9, 'test_hole', $3, 'all', 'x', now())`,
        [p.id, h.projects.a, hole],
      ),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(
      h.db.pool.query(`UPDATE program_scope_snapshot SET included = false WHERE program_id = $1`, [
        p.id,
      ]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(
      h.db.pool.query(
        `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
                                   test_description_snapshot, test_group_snapshot)
         VALUES ($1, $2, $3, 'X', 'x', 'Soils')`,
        [p.id, p.lines[0]!.id, sieve],
      ),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    // Accepted → Requested only together with an identity revision.
    const id = p.lines[0]!.requests[0]!.id;
    await accept(id, undefined);
    await expect(
      h.db.pool.query(
        `UPDATE test_request SET status = 'requested', accepted_at = NULL,
                accepted_by_user_id = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    expect(unit.id).toBeTruthy();
  });
});
