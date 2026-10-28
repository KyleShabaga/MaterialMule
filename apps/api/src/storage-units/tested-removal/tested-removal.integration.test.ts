import {
  confirmTestedRemovalResponseSchema,
  inventoryPageSchema,
  labProgramReviewSchema,
  labProgramSchema,
  minimumRetainUntil,
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  type LabProgram,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../../test-support/database.js';
import { receivingLabId } from '../../test-support/fixtures.js';
import {
  createLabHarness,
  line,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../../test-support/lab-harness.js';

// MM-T36 post-testing removal through the real MM-T24 route: a test completed with the exact
// unit linked, then a personal account confirms the physical removal. Real PostgreSQL, fictional
// data only (DEMO-2601 / DEMO-2602).
describe.runIf(testDatabaseUrl)('tested-unit removal (MM-T36)', () => {
  let h: LabHarness;
  let moisture: string;
  let atterberg: string;
  let labLocationId: string;
  type As = PersonKey | 'lab';

  async function newHole(name: string, project: 'a' | 'b' = 'a') {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects[project], name],
    );
    return rows[0]!.id;
  }

  /** A submitted ALL program on `holeId` covering every unit available now. */
  async function submitted(
    holeId: string,
    tests: string[] = [moisture],
    project: 'a' | 'b' = 'a',
  ): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects[project],
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

  const status = (requestId: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send(
      'post',
      `/api/test-requests/${requestId}/status`,
      { idempotencyKey: newKey(), ...body },
      as,
    );

  /** Start then Mark completed as LAB for Jordan Smith, linking exactly `units`. */
  async function complete(requestId: string, units: string[]) {
    expect((await status(requestId, { to: 'in_progress', version: 1 })).status).toBe(200);
    const done = await status(
      requestId,
      { to: 'completed', version: 2, testedStorageUnitIds: units, actingStaffUserId: h.users.js },
      'lab',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }

  async function detail(id: string, as: As = 'tech'): Promise<StorageUnitDetail> {
    const response = await h.get(`/api/storage-units/${id}`, as);
    expect(response.status).toBe(200);
    return storageUnitDetailSchema.parse(response.body);
  }

  const remove = (
    unitId: string,
    body: Record<string, unknown>,
    as: As = 'tech',
    key: string = newKey(),
  ) =>
    h.send(
      'post',
      `/api/storage-units/${unitId}/tested-removal`,
      { confirmPhysicalRemoval: true, idempotencyKey: key, ...body },
      as,
    );

  async function unitRow(id: string) {
    const { rows } = await h.db.pool.query<{
      status: string;
      current_location_id: string;
      version: number;
    }>('SELECT status, current_location_id, version FROM storage_unit WHERE id = $1', [id]);
    return rows[0]!;
  }

  async function count(sql: string, params: unknown[]) {
    const { rows } = await h.db.pool.query<{ n: number }>(sql, params);
    return rows[0]!.n;
  }

  const removals = (unitId: string) =>
    count('SELECT count(*)::int AS n FROM tested_unit_removal WHERE storage_unit_id = $1', [
      unitId,
    ]);
  const removalEvents = (unitId: string) =>
    count(
      `SELECT count(*)::int AS n FROM audit_event
       WHERE action = 'disposal.removed' AND entity_id = $1`,
      [unitId],
    );

  async function inStockAtLab(): Promise<number> {
    const response = await h.get('/api/locations?includeRetired=true', 'tech');
    expect(response.status).toBe(200);
    const lab = (response.body as { id: string; inStockCount: number }[]).find(
      (location) => location.id === labLocationId,
    );
    return lab!.inStockCount;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)', 'Moisture Content')).id;
    atterberg = (await h.testType('DEMO-ATT', 'Atterberg limits (fictional)')).id;
    labLocationId = await receivingLabId(h.db.pool);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('AC9/AC11 (T10): Shelby tube — testing alone removes nothing; a personal account confirms removal of the exact tube only', async () => {
    const hole = await newHole('TH26-61');
    const tubeA = await h.tube({ holeId: hole, sampleReference: 'T5' });
    const tubeB = await h.tube({ holeId: hole, sampleReference: 'T6' });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, [tubeA.id]);

    // Testing alone: contents destroyed, but the tube is still in stock at its saved location.
    const tested = await detail(tubeA.id);
    expect(tested.status).toBe('in_stock');
    expect(tested.testing).toMatchObject({
      reason: 'tested_shelby',
      contentsDestroyed: true,
      removal: null,
      blocker: null,
    });
    expect(tested.testing!.evidence).toHaveLength(1);
    expect(tested.testing!.evidence[0]).toMatchObject({
      testRequestId: requestId,
      programNumber: program.programNumber,
      testCode: 'DEMO-MC',
      requestStatus: 'completed',
      completedBy: { account: { accountType: 'shared_lab' }, person: { userId: h.users.js } },
    });
    // Its sibling from the same hole, receipt day and program is not tested by association.
    const sibling = await detail(tubeB.id);
    expect(sibling.testing).toMatchObject({
      contentsDestroyed: false,
      evidence: [],
      blocker: 'no_tested_evidence',
    });

    const before = await unitRow(tubeA.id);
    const occupied = await inStockAtLab();

    // Missing or false confirmation is a shape error; nothing changes.
    for (const confirmPhysicalRemoval of [undefined, false]) {
      const response = await h.send(
        'post',
        `/api/storage-units/${tubeA.id}/tested-removal`,
        {
          testRequestId: requestId,
          version: before.version,
          idempotencyKey: newKey(),
          ...(confirmPhysicalRemoval === undefined ? {} : { confirmPhysicalRemoval }),
        },
        'tech',
      );
      expect(response.status).toBe(400);
    }
    // The sibling can't borrow the tested tube's evidence.
    const borrowed = await remove(tubeB.id, { testRequestId: requestId, version: 1 });
    expect(borrowed.status).toBe(422);
    expect(borrowed.body.code).toBe('no_tested_evidence');
    // A stale page gets the current state.
    const stale = await remove(tubeA.id, { testRequestId: requestId, version: before.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(await unitRow(tubeA.id)).toEqual(before);

    const key = newKey();
    const removed = await remove(
      tubeA.id,
      { testRequestId: requestId, version: before.version },
      'tech',
      key,
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    const body = confirmTestedRemovalResponseSchema.parse(removed.body);
    expect(body).toMatchObject({
      readableId: tubeA.readableId,
      status: 'disposed',
      version: before.version + 1,
      replayed: false,
      removal: {
        reason: 'tested_shelby',
        testRequestId: requestId,
        programNumber: program.programNumber,
        testCode: 'DEMO-MC',
        previousStatus: 'in_stock',
        location: { id: before.current_location_id },
        removedBy: { userId: h.users.tech, name: 'Alex Tester' },
      },
    });

    // Disposed, last location kept as history, no longer occupying it; sibling untouched.
    expect(await unitRow(tubeA.id)).toEqual({
      status: 'disposed',
      current_location_id: before.current_location_id,
      version: before.version + 1,
    });
    expect(await inStockAtLab()).toBe(occupied - 1);
    expect((await detail(tubeB.id)).status).toBe('in_stock');
    const after = await detail(tubeA.id);
    expect(after.testing).toMatchObject({ blocker: 'already_removed', contentsDestroyed: true });
    expect(after.testing!.removal).toEqual(body.removal);
    expect(after.receipt.quantity).toBeGreaterThan(0);
    expect(after.sample?.sampleReference).toBe('T5');

    // Removal is not review or acceptance: the test request and program are as they were.
    const { rows: request } = await h.db.pool.query<{ status: string; program_status: string }>(
      `SELECT r.status, lp.status AS program_status
       FROM test_request r JOIN lab_program lp ON lp.id = r.program_id WHERE r.id = $1`,
      [requestId],
    );
    expect(request[0]).toEqual({ status: 'completed', program_status: 'submitted' });
    // …and the lab can still send it to review afterwards; acceptance stays open.
    expect((await status(requestId, { to: 'review', version: 3 })).status).toBe(200);

    // Exact retry: the original result, no second removal or event.
    const replay = await remove(
      tubeA.id,
      { testRequestId: requestId, version: before.version },
      'tech',
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, removal: { id: body.removal.id } });
    const reused = await remove(
      tubeA.id,
      { testRequestId: requestId, version: before.version + 1 },
      'tech',
      key,
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');
    const again = await remove(
      tubeA.id,
      { testRequestId: requestId, version: before.version + 1 },
      'pe',
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'already_removed', removal: { id: body.removal.id } });
    expect(await removals(tubeA.id)).toBe(1);
    expect(await removalEvents(tubeA.id)).toBe(1);

    // Barcode lookup and history keep the record; Current stock leaves it out, Disposed finds it.
    const lookup = await h.get(
      `/api/storage-units/lookup?code=${tubeA.readableId.toLowerCase()}`,
      'lab',
    );
    expect(lookup.body).toEqual({ id: tubeA.id, readableId: tubeA.readableId });
    const history = storageUnitHistoryPageSchema.parse(
      (await h.get(`/api/storage-units/${tubeA.id}/history`, 'tech')).body,
    );
    const event = history.items.find((item) => item.action === 'disposal.removed');
    expect(event).toMatchObject({
      actor: { name: 'Alex Tester', accountType: 'personal' },
      reason: 'Disposed after testing (tested Shelby tube)',
      before: { status: 'in_stock' },
      after: { status: 'disposed', disposalReason: 'tested_shelby', testRequestId: requestId },
    });
    const search = (status: string) =>
      h.get(
        `/api/inventory?search=${encodeURIComponent(tubeA.readableId)}&status=${status}`,
        'tech',
      );
    expect(inventoryPageSchema.parse((await search('current')).body).items).toEqual([]);
    const disposedRows = inventoryPageSchema.parse((await search('disposed')).body).items;
    expect(disposedRows).toHaveLength(1);
    expect(disposedRows[0]).toMatchObject({
      status: 'disposed',
      testedRemovalReason: 'tested_shelby',
      contentsDestroyed: true,
    });

    // Nothing returns it to stock, not even a direct database edit.
    await expect(
      h.db.pool.query(`UPDATE storage_unit SET status = 'in_stock' WHERE id = $1`, [tubeA.id]),
    ).rejects.toMatchObject({ constraint: 'storage_unit_tested_removal_final' });
    await expect(
      h.db.pool.query('DELETE FROM tested_unit_removal WHERE storage_unit_id = $1', [tubeA.id]),
    ).rejects.toThrow();
  });

  it('LAB is refused (403) even when it names a Lab Manager, and nothing changes', async () => {
    const hole = await newHole('TH26-62');
    const tube = await h.tube({ holeId: hole });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, [tube.id]);
    const before = await unitRow(tube.id);
    for (const extra of [{}, { actingStaffUserId: h.users.lm }]) {
      const response = await remove(
        tube.id,
        { testRequestId: requestId, version: before.version, ...extra },
        'lab',
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('forbidden');
    }
    expect(await unitRow(tube.id)).toEqual(before);
    expect(await removals(tube.id)).toBe(0);
    // The LAB station sees the evidence but not a removal it may confirm.
    expect((await detail(tube.id, 'lab')).testing?.blocker).toBeNull();
  });

  it('AC10/AC12 (T12): tested bulk bucket — removal despite a future retain-until date and an open program; the sibling bucket stays tracked', async () => {
    const hole = await newHole('TH26-63');
    const group = await h.bulkGroup({
      holeId: hole,
      sampleReference: 'B1',
      depthFrom: 1.5,
      buckets: 2,
    });
    const [bucketA, bucketB] = group.members;
    // Received today: its minimum retention runs a year past now.
    const today = new Date().toISOString().slice(0, 10);
    await h.db.pool.query(
      'UPDATE storage_unit SET received_date = $2 WHERE id = ANY ($1::uuid[])',
      [[bucketA!.id, bucketB!.id], today],
    );
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, [bucketA!.id]);

    const tested = await detail(bucketA!.id);
    expect(tested.minimumRetainUntil > today).toBe(true);
    expect(minimumRetainUntil(today) > today).toBe(true);
    // Bulk buckets may still hold material: no contents state, only the removal route.
    expect(tested.testing).toMatchObject({
      reason: 'tested_bulk',
      contentsDestroyed: false,
      blocker: null,
    });
    const siblingBefore = await detail(bucketB!.id);
    expect(siblingBefore.testing?.blocker).toBe('no_tested_evidence');

    const removed = await remove(
      bucketA!.id,
      { testRequestId: requestId, version: tested.version },
      'tech',
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect(removed.body.removal.reason).toBe('tested_bulk');
    // The program stays open (no closure gate), and the sibling keeps its own stock and location.
    const { rows } = await h.db.pool.query<{ status: string }>(
      'SELECT status FROM lab_program WHERE id = $1',
      [program.id],
    );
    expect(rows[0]!.status).toBe('submitted');
    const sibling = await detail(bucketB!.id);
    expect(sibling).toMatchObject({ status: 'in_stock', location: siblingBefore.location });
    expect(sibling.testing?.blocker).toBe('no_tested_evidence');
    // Group membership and "bucket n of N" are history, unchanged by the removal.
    expect((await detail(bucketA!.id)).bulkGroup?.members.map((m) => m.readableId)).toEqual(
      siblingBefore.bulkGroup?.members.map((m) => m.readableId),
    );
    const borrowed = await remove(bucketB!.id, {
      testRequestId: requestId,
      version: sibling.version,
    });
    expect(borrowed.body.code).toBe('no_tested_evidence');
  });

  it('T13: ordinary buckets, untested tubes, unrelated or cross-project evidence and units disposed otherwise are refused', async () => {
    const hole = await newHole('TH26-64');
    const bucket = await h.bucket({ hole });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, []);
    const ordinary = await remove(bucket.id, { testRequestId: requestId, version: 1 });
    expect(ordinary.status).toBe(422);
    expect(ordinary.body.code).toBe('not_eligible_unit_type');

    const untested = await h.tube({ holeId: await newHole('TH26-65') });
    const none = await remove(untested.id, { testRequestId: requestId, version: 1 });
    expect(none.body.code).toBe('no_tested_evidence');

    // Project B's tube, tested in project B: its evidence can't remove a project A tube.
    const holeB = await newHole('TH26-66', 'b');
    const tubeB = await h.tube({ project: 'b', holeId: holeB });
    const programB = await submitted(holeB, [moisture], 'b');
    const requestB = programB.lines[0]!.requests[0]!.id;
    await complete(requestB, [tubeB.id]);
    const crossProject = await remove(untested.id, { testRequestId: requestB, version: 1 });
    expect(crossProject.body.code).toBe('no_tested_evidence');
    const unknown = await remove(untested.id, { testRequestId: newKey(), version: 1 });
    expect(unknown.body.code).toBe('no_tested_evidence');

    // Disposed some other way (a future T30 path): not this route's to record.
    await h.db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [tubeB.id]);
    const disposed = await remove(tubeB.id, { testRequestId: requestB, version: 1 });
    expect(disposed.status).toBe(422);
    expect(disposed.body.code).toBe('storage_unit_disposed');
    expect(await removals(tubeB.id)).toBe(0);

    const missing = await remove(newKey(), { testRequestId: requestB, version: 1 });
    expect(missing.status).toBe(404);
  });

  it('an open location conflict must be settled first', async () => {
    const hole = await newHole('TH26-67');
    const tube = await h.tube({ holeId: hole });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, [tube.id]);
    await h.db.pool.query(
      `INSERT INTO location_conflict (storage_unit_id, saved_location_id, saved_version)
       VALUES ($1, $2, 1)`,
      [tube.id, labLocationId],
    );
    expect((await detail(tube.id)).testing?.blocker).toBe('location_conflict_open');
    const response = await remove(tube.id, { testRequestId: requestId, version: 1 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('location_conflict_open');
    expect((await unitRow(tube.id)).status).toBe('in_stock');
  });

  it('T11: concurrent confirmations record one removal; concurrent exact retries replay it', async () => {
    const hole = await newHole('TH26-68');
    const tubeA = await h.tube({ holeId: hole });
    const tubeB = await h.tube({ holeId: hole });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, [tubeA.id, tubeB.id]);

    const racing = await Promise.all(
      (['tech', 'pe', 'lm', 'jo'] as const).map((as) =>
        remove(tubeA.id, { testRequestId: requestId, version: 1 }, as),
      ),
    );
    expect(racing.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(
      racing.filter((r) => r.status === 409).every((r) => r.body.code === 'already_removed'),
    ).toBe(true);
    expect(await removals(tubeA.id)).toBe(1);
    expect(await removalEvents(tubeA.id)).toBe(1);

    const key = newKey();
    const retries = await Promise.all(
      [1, 2, 3].map(() => remove(tubeB.id, { testRequestId: requestId, version: 1 }, 'tech', key)),
    );
    expect(retries.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(retries.map((r) => r.body.removal.id)).size).toBe(1);
    expect(await removals(tubeB.id)).toBe(1);
    expect(await removalEvents(tubeB.id)).toBe(1);
  });

  it('destroyed Shelby contents and removed units are never tested again (stale clients included)', async () => {
    const hole = await newHole('TH26-69');
    const tube = await h.tube({ holeId: hole });
    const other = await h.tube({ holeId: hole });
    // Two programs submitted before any test, both covering both tubes; the first has two tests.
    const first = await submitted(hole, [moisture, atterberg]);
    const second = await submitted(hole);
    const [mc, att] = first.lines[0]!.requests;
    await complete(mc!.id, [tube.id]);

    // Same program, frozen together: its second test may still record the tube.
    await complete(att!.id, [tube.id]);
    // Another program can't test the destroyed contents, whatever its frozen coverage says.
    const secondRequest = second.lines[0]!.requests[0]!.id;
    expect((await status(secondRequest, { to: 'in_progress', version: 1 })).status).toBe(200);
    const again = await status(secondRequest, {
      to: 'completed',
      version: 2,
      testedStorageUnitIds: [tube.id],
    });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('unit_contents_destroyed');
    // The database refuses it too, for a client that gets past the service.
    await expect(
      h.db.pool.query(
        `INSERT INTO test_request_unit_link (test_request_id, status_history_id, storage_unit_id,
                                             project_id, unit_readable_id_snapshot)
         SELECT h.test_request_id, h.id, $2, $3, 'x'
         FROM test_request_status_history h WHERE h.test_request_id = $1 LIMIT 1`,
        [secondRequest, tube.id, h.projects.a],
      ),
    ).rejects.toMatchObject({ constraint: 'test_request_unit_link_contents_available' });
    // A new program no longer covers it (the untested sibling still is).
    const review = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: hole }, 'all', [moisture])],
      },
      'tech',
    );
    const coverage = labProgramReviewSchema
      .parse((await h.get(`/api/lab-programs/${review.body.id}/review`, 'tech')).body)
      .lines[0]!.coverage.map((c) => c.storageUnitId);
    expect(coverage).toContain(other.id);
    expect(coverage).not.toContain(tube.id);

    // After removal the database itself refuses a link (a stale client past the service).
    const removed = await remove(tube.id, { testRequestId: mc!.id, version: 1 });
    expect(removed.status).toBe(201);
    await expect(
      h.db.pool.query(
        `INSERT INTO test_request_unit_link (test_request_id, status_history_id, storage_unit_id, project_id, unit_readable_id_snapshot)
         SELECT l.test_request_id, l.status_history_id, $1, l.project_id, 'x'
         FROM test_request_unit_link l WHERE l.storage_unit_id = $1 LIMIT 1`,
        [tube.id],
      ),
    ).rejects.toMatchObject({ constraint: 'test_request_unit_link_not_disposed' });
  });

  it('a failed removal leaves nothing behind (one transaction)', async () => {
    const hole = await newHole('TH26-70');
    const tube = await h.tube({ holeId: hole });
    const client = await h.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [tube.id]);
      // No evidence: the removal row is refused, so the whole transaction rolls back.
      await expect(
        client.query(
          `INSERT INTO tested_unit_removal
             (storage_unit_id, project_id, unit_readable_id_snapshot, unit_type_snapshot, reason,
              test_request_id, unit_link_id, completion_event_id, program_number_snapshot,
              test_code_snapshot, previous_status, location_id, location_code_snapshot,
              location_name_snapshot, removed_by_user_id, removed_by_account_type,
              removed_by_name_snapshot, physical_removal_confirmed, idempotency_key, request_hash)
           SELECT su.id, su.project_id, su.readable_id, 'shelby_tube', 'tested_shelby',
                  l.test_request_id, l.id, l.status_history_id, 'LP', 'X', 'in_stock',
                  su.current_location_id, 'C', 'N', $2, 'personal', 'N', true, gen_random_uuid(), 'h'
           FROM storage_unit su CROSS JOIN (SELECT * FROM test_request_unit_link LIMIT 1) l
           WHERE su.id = $1`,
          [tube.id, h.users.tech],
        ),
      ).rejects.toMatchObject({ constraint: 'tested_unit_removal_evidence' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await unitRow(tube.id)).status).toBe('in_stock');
    expect(await removals(tube.id)).toBe(0);
  });
});
