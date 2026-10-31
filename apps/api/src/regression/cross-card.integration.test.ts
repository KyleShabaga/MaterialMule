import { randomUUID } from 'node:crypto';
import {
  disposalCandidatesSchema,
  inventoryPageSchema,
  labProgramReviewSchema,
  labProgramSchema,
  moveConflictResponseSchema,
  storageUnitDetailSchema,
  storageUnitRetentionSchema,
  type LabProgram,
  type MoveRequest,
} from '@materialmule/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BusinessClock } from '../retention/business-clock.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-T80 cross-card regression: the rules that span cards, proved through the real routes
// instead of SQL stand-ins. T28 moves after a real MM-T36 removal or MM-T30 disposal, T26
// repeats after a real removal, T36 removal from a standalone source and after an
// accepted-request change, T36 AC10 with real holds, extensions and approvals, the owner rule
// (Kyle, 2026-10-30) that disposal waits for an open location conflict, and T29 business dates at
// America/Edmonton midnight and across daylight-saving changes. Real PostgreSQL, fictional data
// only (DEMO-2601 / DEMO-2602, Lee Manager `lm`, Alex Tester `tech`, Pat Example `pe`).
describe.runIf(testDatabaseUrl)('cross-card regression (MM-T80)', () => {
  let h: LabHarness;
  let moisture: string;
  let sieve: string;
  let clock: BusinessClock;
  let shelf: string;
  let bench: string;
  type As = Parameters<LabHarness['send']>[3];

  async function newHole(project: 'a' | 'b' = 'a') {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects[project], `TH-${newKey().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  async function addLocation(code: string) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [code, `Shelf ${code}`],
    );
    return rows[0]!.id;
  }

  /** A submitted program of `lines` on project A, covering every unit available now. */
  async function submit(lines: unknown[], project: 'a' | 'b' = 'a'): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects[project], idempotencyKey: newKey(), lines },
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

  const onHole = (holeId: string, tests: string[] = [moisture]) =>
    submit([line({ kind: 'test_hole', id: holeId }, 'all', tests)]);

  async function requestVersion(id: string) {
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM test_request WHERE id = $1',
      [id],
    );
    return rows[0]!.version;
  }

  const status = (id: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send('post', `/api/test-requests/${id}/status`, { idempotencyKey: newKey(), ...body }, as);

  /** Start, then Mark completed linking exactly `units`. */
  async function complete(requestId: string, units: string[]) {
    let version = await requestVersion(requestId);
    const started = await status(requestId, { to: 'in_progress', version });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    version = started.body.version as number;
    const done = await status(requestId, {
      to: 'completed',
      version,
      testedStorageUnitIds: units,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }

  /** Completed (linking `units`) → review → review complete → accepted by the project's lead. */
  async function accept(requestId: string, units: string[]) {
    await complete(requestId, units);
    let version = await requestVersion(requestId);
    const inReview = await status(requestId, { to: 'review', version });
    expect(inReview.status, JSON.stringify(inReview.body)).toBe(200);
    const reviewed = await h.send(
      'post',
      `/api/test-requests/${requestId}/review`,
      { action: 'complete', version: inReview.body.version, idempotencyKey: newKey() },
      'tech',
    );
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    version = reviewed.body.version as number;
    const accepted = await h.send(
      'post',
      `/api/test-requests/${requestId}/accept`,
      { version, idempotencyKey: newKey() },
      'pe',
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return accepted.body.version as number;
  }

  async function detail(id: string) {
    const response = await h.get(`/api/storage-units/${id}`, 'tech');
    expect(response.status).toBe(200);
    return storageUnitDetailSchema.parse(response.body);
  }

  /** MM-T36 removal after testing, confirmed by Alex Tester at the unit's current version. */
  async function removeTested(unitId: string, testRequestId: string) {
    return h.send(
      'post',
      `/api/storage-units/${unitId}/tested-removal`,
      {
        testRequestId,
        confirmPhysicalRemoval: true,
        version: (await detail(unitId)).version,
        idempotencyKey: newKey(),
      },
      'tech',
    );
  }

  const approve = (unitIds: string[], as: As = 'lm') =>
    h.send('post', '/api/disposal/approvals', { unitIds, idempotencyKey: newKey() }, as);
  const disposalScan = (suNumber: string, as: As = 'tech') =>
    h.send('post', '/api/disposal/remove', { suNumber, idempotencyKey: newKey() }, as);

  async function candidate(unitId: string, project: 'a' | 'b' = 'a') {
    const response = await h.get(`/api/disposal/eligible?projectId=${h.projects[project]}`, 'lm');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return disposalCandidatesSchema
      .parse(response.body)
      .units.find((u) => u.storageUnitId === unitId);
  }

  /** A move as a personal account (`tech`) or as the LAB station for Jordan Smith. */
  function intent(
    unitId: string,
    toLocationId: string,
    baseVersion: number,
    options: { as?: 'tech' | 'lab'; offline?: boolean } = {},
  ): MoveRequest {
    const as = options.as ?? 'tech';
    return {
      clientMoveId: randomUUID(),
      storageUnitId: unitId,
      toLocationId,
      baseVersion,
      scannedAt: new Date().toISOString(),
      capturedOffline: options.offline ?? false,
      captureContext: {
        stationId: randomUUID(),
        accountId: h.users[as],
        ...(as === 'lab' ? { moverUserId: h.users.js } : {}),
      },
    };
  }
  const move = (body: MoveRequest) =>
    h.send(
      'post',
      '/api/moves',
      body,
      body.captureContext.accountId === h.users.lab ? 'lab' : 'tech',
    );

  async function movementEvents(unitId: string) {
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM movement_event WHERE storage_unit_id = $1',
      [unitId],
    );
    return rows[0]!.n;
  }

  /** Every move a stale or fresh client could send after the unit left the lab is refused. */
  async function expectMovesRefused(unitId: string, savedLocationId: string) {
    const current = (await detail(unitId)).version;
    const events = await movementEvents(unitId);
    for (const body of [
      intent(unitId, shelf, current), // online, current version
      intent(unitId, bench, current, { as: 'lab' }), // LAB station, current version
      intent(unitId, bench, 1, { as: 'lab', offline: true }), // queued before it left
    ]) {
      const refused = await move(body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe('storage_unit_disposed');
    }
    const after = await detail(unitId);
    expect(after).toMatchObject({ status: 'disposed', version: current });
    expect(after.location?.id).toBe(savedLocationId);
    expect(await movementEvents(unitId)).toBe(events);
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM location_conflict WHERE storage_unit_id = $1`,
      [unitId],
    );
    expect(rows[0]!.n).toBe(0);
  }

  /** The business day for the retention/disposal clock: an exact instant. */
  const at = (instant: string) => clock.set(new Date(instant));

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('T80-MC', 'Moisture content (fictional)', 'Moisture')).id;
    sieve = (await h.testType('T80-SV', 'Sieve analysis (fictional)', 'Sieve')).id;
    clock = h.app.get(BusinessClock);
    shelf = await addLocation('T80-SHELF');
    bench = await addLocation('T80-BENCH');
  }, 60_000);

  afterEach(() => clock.set(null));

  afterAll(async () => {
    await h?.close();
  });

  describe('MM-T28 moves after the unit left the lab (test plan T1)', () => {
    it('after a real removal after testing, online, LAB and queued moves get 422 storage_unit_disposed', async () => {
      const hole = await newHole();
      const tube = await h.tube({ holeId: hole, sampleReference: 'T1' });
      const program = await onHole(hole);
      const requestId = program.lines[0]!.requests[0]!.id;
      // Moved once before testing, so a queued move can carry the older version.
      expect((await move(intent(tube.id, shelf, 1))).status).toBe(201);
      await complete(requestId, [tube.id]);
      const removed = await removeTested(tube.id, requestId);
      expect(removed.status, JSON.stringify(removed.body)).toBe(201);
      await expectMovesRefused(tube.id, shelf);
    });

    it('after a real standard disposal (approval, then disposal scan), moves get 422 storage_unit_disposed', async () => {
      const unit = await h.bucket({ hole: await newHole(), receivedDate: '2026-10-23' });
      at('2027-10-24T18:00:00Z');
      expect((await move(intent(unit.id, bench, 1))).status).toBe(201);
      const approved = await approve([unit.id]);
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      const disposed = await disposalScan(unit.readableId);
      expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
      await expectMovesRefused(unit.id, bench);
    });
  });

  describe('MM-T26 repeats after a real removal (L13 redone)', () => {
    it('a repeat of the accepted test is created, but completing it with the removed tube is refused', async () => {
      const hole = await newHole();
      const tube = await h.tube({ holeId: hole });
      const program = await onHole(hole);
      const id = program.lines[0]!.requests[0]!.id;
      await accept(id, [tube.id]);
      const removed = await removeTested(tube.id, id);
      expect(removed.status, JSON.stringify(removed.body)).toBe(201);

      const repeated = await h.send(
        'post',
        `/api/test-requests/${id}/repeat`,
        { version: await requestVersion(id), idempotencyKey: newKey() },
        'tech',
      );
      expect(repeated.status, JSON.stringify(repeated.body)).toBe(201);
      const repeatId = repeated.body.testRequestId as string;
      expect((await status(repeatId, { to: 'in_progress', version: 1 })).status).toBe(200);
      const reuse = await status(repeatId, {
        to: 'completed',
        version: 2,
        testedStorageUnitIds: [tube.id],
      });
      expect(reuse.status, JSON.stringify(reuse.body)).toBe(422);
      expect(await requestVersion(repeatId)).toBe(2);
      const { rows } = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM test_request_unit_link WHERE test_request_id = $1',
        [repeatId],
      );
      expect(rows[0]!.n).toBe(0);
      expect((await detail(tube.id)).status).toBe('disposed');
    });
  });

  describe('MM-T36 removal sources', () => {
    it('a tube from a standalone sampling location is removed through its standalone line', async () => {
      const tube = await h.tube({ location: 'Embankment Location 03', sampleReference: 'T3' });
      const sibling = await h.tube({ location: 'Embankment Location 03', sampleReference: 'T4' });
      const program = await submit([
        line({ kind: 'standalone_unit', id: tube.id }, 'all', [moisture]),
      ]);
      expect(program.lines[0]!.coverage.map((c) => c.storageUnitId)).toEqual([tube.id]);
      const requestId = program.lines[0]!.requests[0]!.id;
      await complete(requestId, [tube.id]);
      const removed = await removeTested(tube.id, requestId);
      expect(removed.status, JSON.stringify(removed.body)).toBe(201);
      expect(removed.body.removal).toMatchObject({
        reason: 'tested_shelby',
        testRequestId: requestId,
      });
      const after = await detail(tube.id);
      expect(after.status).toBe('disposed');
      // Same free-text source, not the same tube: the sibling stays and can't borrow evidence.
      expect((await detail(sibling.id)).status).toBe('in_stock');
      const borrowed = await removeTested(sibling.id, requestId);
      expect(borrowed.status).toBe(422);
      expect(borrowed.body.code).toBe('no_tested_evidence');
    });

    it('after an accepted-request change re-links the tube, removal names the request and still succeeds once', async () => {
      const hole = await newHole();
      const tube = await h.tube({ holeId: hole });
      const program = await onHole(hole);
      const id = program.lines[0]!.requests[0]!.id;
      const version = await accept(id, [tube.id]);
      const changed = await h.send(
        'patch',
        `/api/test-requests/${id}`,
        { testTypeId: sieve, version, reason: 'Wrong test requested', idempotencyKey: newKey() },
        'tech',
      );
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      // Same program: the changed test may record the destroyed tube again.
      await complete(id, [tube.id]);
      const { rows: links } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM test_request_unit_link
         WHERE test_request_id = $1 AND storage_unit_id = $2`,
        [id, tube.id],
      );
      expect(links[0]!.n).toBe(2);
      const tested = await detail(tube.id);
      expect(tested.testing).toMatchObject({ contentsDestroyed: true, blocker: null });

      const removed = await removeTested(tube.id, id);
      expect(removed.status, JSON.stringify(removed.body)).toBe(201);
      expect(removed.body.removal).toMatchObject({
        testRequestId: id,
        programNumber: program.programNumber,
        testCode: 'T80-SV',
      });
      const again = await removeTested(tube.id, id);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_removed');
      const { rows } = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tested_unit_removal WHERE storage_unit_id = $1',
        [tube.id],
      );
      expect(rows[0]!.n).toBe(1);
    });
  });

  it('MM-T36 AC10: a real approval, unit hold, extension and approved hold request do not block removal after testing', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole, sampleReference: 'T9' });
    // Received 2026-10-23: date-eligible on 2027-10-24 with nothing open, so a Lab Manager
    // approves standard disposal before any testing is planned.
    at('2027-10-24T18:00:00Z');
    const approved = await approve([tube.id]);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const approvalId = approved.body.approvals[0].id as string;
    expect((await detail(tube.id)).status).toBe('approved_for_disposal');

    const program = await onHole(hole);
    expect(program.lines[0]!.coverage.map((c) => c.storageUnitId)).toContain(tube.id);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, [tube.id]);

    // A unit hold, a unit extension to 2031 and a hold asked for and approved by the lead.
    const hold = await h.send(
      'post',
      '/api/retention/holds',
      {
        projectId: h.projects.a,
        scope: 'units',
        unitIds: [tube.id],
        reason: 'Claim review',
        idempotencyKey: newKey(),
      },
      'lm',
    );
    const extension = await h.send(
      'post',
      '/api/retention/extensions',
      {
        projectId: h.projects.a,
        scope: 'units',
        unitIds: [tube.id],
        retainUntil: '2031-01-01',
        reason: 'Client asked',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    const asked = await h.send(
      'post',
      '/api/retention/requests',
      {
        kind: 'hold',
        projectId: h.projects.a,
        scope: 'units',
        unitIds: [tube.id],
        reason: 'Client may dispute',
        idempotencyKey: newKey(),
      },
      'tech',
    );
    expect([hold.status, extension.status, asked.status]).toEqual([201, 201, 201]);
    const decided = await h.send(
      'post',
      `/api/retention/requests/${asked.body.requestId}/approve`,
      { idempotencyKey: newKey() },
      'pe',
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const retention = storageUnitRetentionSchema.parse(
      (await h.get(`/api/storage-units/${tube.id}/retention`, 'tech')).body,
    );
    expect(retention.retention).toMatchObject({
      onHold: true,
      effectiveRetainUntil: '2031-01-01',
      retentionExempt: true,
    });
    expect(retention.holds.filter((x) => x.releasedAt === null)).toHaveLength(2);
    // The program stays open; nothing above blocks the T36 exception.
    const removed = await removeTested(tube.id, requestId);
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect(removed.body.removal).toMatchObject({
      reason: 'tested_shelby',
      previousStatus: 'approved_for_disposal',
    });
    const { rows } = await h.db.pool.query<{ used: boolean; program: string }>(
      `SELECT a.used_at IS NOT NULL AS used, lp.status AS program
       FROM disposal_approval a, lab_program lp WHERE a.id = $1 AND lp.id = $2`,
      [approvalId, program.id],
    );
    expect(rows[0]).toEqual({ used: true, program: 'submitted' });
    // Barcode lookup still finds it, holds and extensions remain on record and unreleased.
    const lookup = await h.get(`/api/storage-units/lookup?code=${tube.readableId}`, 'lab');
    expect(lookup.body).toEqual({ id: tube.id, readableId: tube.readableId });
    const kept = storageUnitRetentionSchema.parse(
      (await h.get(`/api/storage-units/${tube.id}/retention`, 'tech')).body,
    );
    expect(kept.holds.filter((x) => x.releasedAt === null)).toHaveLength(2);
    expect(kept.extensions.filter((x) => x.releasedAt === null)).toHaveLength(1);
    // The standard scan has nothing left to do.
    expect((await disposalScan(tube.readableId)).body.result).toBe('not_approved');
  });

  describe('MM-T30 disposal and an open location conflict (owner rule, Kyle 2026-10-30)', () => {
    /** A real conflict: a move at version 1 saved, then a queued move from version 1 arrives. */
    async function openConflict(unitId: string) {
      const saved = await move(intent(unitId, shelf, (await detail(unitId)).version));
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      const queued = await move(
        intent(unitId, bench, saved.body.resultingVersion - 1, { as: 'lab', offline: true }),
      );
      expect(queued.status, JSON.stringify(queued.body)).toBe(409);
      return moveConflictResponseSchema.parse(queued.body).conflictId;
    }

    async function resolve(conflictId: string) {
      const { rows } = await h.db.pool.query<{ version: number; unit_version: number }>(
        `SELECT c.version, su.version AS unit_version
         FROM location_conflict c JOIN storage_unit su ON su.id = c.storage_unit_id
         WHERE c.id = $1`,
        [conflictId],
      );
      const resolved = await h.send(
        'post',
        `/api/location-conflicts/${conflictId}/resolve`,
        {
          clientResolutionId: randomUUID(),
          locationId: shelf,
          note: 'Checked the shelf.',
          expectedUnitVersion: rows[0]!.unit_version,
          expectedConflictVersion: rows[0]!.version,
        },
        'tech',
      );
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
    }

    it('approval is refused while the conflict is open and allowed once it is resolved', async () => {
      const unit = await h.bucket({ hole: await newHole(), receivedDate: '2026-10-23' });
      at('2027-10-24T18:00:00Z');
      const conflictId = await openConflict(unit.id);
      expect((await candidate(unit.id))?.blockers.map((b) => b.code)).toEqual([
        'location_conflict',
      ]);
      const refused = await approve([unit.id]);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'not_eligible',
        units: [{ storageUnitId: unit.id, blockers: [{ code: 'location_conflict' }] }],
      });
      expect((await detail(unit.id)).status).toBe('in_stock');

      await resolve(conflictId);
      expect(await candidate(unit.id)).toMatchObject({ eligible: true, blockers: [] });
      expect((await approve([unit.id])).status).toBe(201);
      const disposed = await disposalScan(unit.readableId);
      expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
      expect((await detail(unit.id)).status).toBe('disposed');
    });

    it('a conflict opened after approval blocks the disposal scan until it is resolved', async () => {
      const unit = await h.bucket({ hole: await newHole(), receivedDate: '2026-10-23' });
      at('2027-10-24T18:00:00Z');
      expect((await approve([unit.id])).status).toBe(201);
      const conflictId = await openConflict(unit.id);
      const blocked = await disposalScan(unit.readableId);
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);
      expect(blocked.body).toMatchObject({
        result: 'blocked',
        blockers: [{ code: 'location_conflict' }],
      });
      expect((await detail(unit.id)).status).toBe('approved_for_disposal');

      await resolve(conflictId);
      const disposed = await disposalScan(unit.readableId);
      expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
      const after = await detail(unit.id);
      expect(after.status).toBe('disposed');
      expect(after.location?.id).toBe(shelf);
    });
  });

  describe('MM-T29 business dates in America/Edmonton (test plan T3)', () => {
    /** The unit endpoint and the inventory filter, which must agree on every instant. */
    async function eligibleByDate(unit: { id: string; readableId: string }) {
      const single = storageUnitRetentionSchema.parse(
        (await h.get(`/api/storage-units/${unit.id}/retention`, 'tech')).body,
      ).retention;
      const listed = inventoryPageSchema
        .parse(
          (
            await h.get(
              `/api/inventory?search=${encodeURIComponent(unit.readableId)}&retention=eligible_by_date`,
              'tech',
            )
          ).body,
        )
        .items.map((i) => i.id);
      expect(listed.includes(unit.id), `inventory vs unit at ${single.asOf}`).toBe(
        single.eligibleByDate,
      );
      return {
        eligible: single.eligibleByDate,
        asOf: single.asOf,
        until: single.effectiveRetainUntil,
      };
    }

    // Each case: received date, retain-until date, then the last instant before and the first
    // instant of the retain-until day in Edmonton (MDT is UTC-6, MST is UTC-7). The changes used
    // are the March 2026 and November 2025 ones, which every tzdata release agrees on (from
    // tzdata 2026 Edmonton stays on UTC-6 and has no November 2026 change).
    const cases = [
      // Plain MDT day: midnight is 06:00Z.
      ['MDT midnight', '2025-10-23', '2026-10-23', '2026-10-23T05:59:59Z', '2026-10-23T06:00:00Z'],
      // Daylight saving starts 2026-03-08 02:00 MST: that midnight is still MST (07:00Z)…
      [
        'March change day',
        '2025-03-08',
        '2026-03-08',
        '2026-03-08T06:59:59Z',
        '2026-03-08T07:00:00Z',
      ],
      // …and the next midnight is MDT (06:00Z).
      [
        'after the March change',
        '2025-03-09',
        '2026-03-09',
        '2026-03-09T05:59:59Z',
        '2026-03-09T06:00:00Z',
      ],
      // Daylight saving ends 2025-11-02 02:00 MDT: that midnight is still MDT (06:00Z)…
      [
        'November change day',
        '2024-11-02',
        '2025-11-02',
        '2025-11-02T05:59:59Z',
        '2025-11-02T06:00:00Z',
      ],
      // …and the next midnight is MST (07:00Z): 06:00Z is still the day before.
      [
        'after the November change',
        '2024-11-03',
        '2025-11-03',
        '2025-11-03T06:59:59Z',
        '2025-11-03T07:00:00Z',
      ],
    ] as const;

    it.each(cases)(
      '%s: eligible from Edmonton midnight, not a second before',
      async (_, received, until, before, from) => {
        const unit = await h.bucket({ project: 'b', hole: h.holes.b1, receivedDate: received });
        at(before);
        expect(await eligibleByDate(unit)).toEqual({
          eligible: false,
          asOf: new Date(new Date(until).getTime() - 86_400_000).toISOString().slice(0, 10),
          until,
        });
        at(from);
        expect(await eligibleByDate(unit)).toEqual({ eligible: true, asOf: until, until });
      },
    );

    it('05:59Z and 06:00Z on an MST day are both the day before; 07:00Z is the day', async () => {
      const unit = await h.bucket({ project: 'b', hole: h.holes.b1, receivedDate: '2024-12-15' });
      for (const instant of [
        '2025-12-15T05:59:59Z',
        '2025-12-15T06:00:00Z',
        '2025-12-15T06:59:59Z',
      ]) {
        at(instant);
        expect(await eligibleByDate(unit)).toMatchObject({ eligible: false, asOf: '2025-12-14' });
      }
      at('2025-12-15T07:00:00Z');
      expect(await eligibleByDate(unit)).toMatchObject({ eligible: true, asOf: '2025-12-15' });
    });

    it('the disposal list and approval use the same business day', async () => {
      const unit = await h.bucket({
        project: 'b',
        hole: await newHole('b'),
        receivedDate: '2025-10-23',
      });
      at('2026-10-23T05:59:59Z');
      expect((await candidate(unit.id, 'b'))?.eligible).toBe(false);
      const early = await approve([unit.id]);
      expect(early.status).toBe(422);
      expect(early.body.units[0].blockers[0].label).toBe('Retain until 2026-10-23');
      at('2026-10-23T06:00:00Z');
      expect(await candidate(unit.id, 'b')).toMatchObject({ eligible: true, blockers: [] });
      expect((await approve([unit.id])).status).toBe(201);
    });
  });
});
