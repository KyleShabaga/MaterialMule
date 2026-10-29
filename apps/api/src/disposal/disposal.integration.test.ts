import { randomUUID } from 'node:crypto';
import {
  disposalCandidatesSchema,
  inventoryPageSchema,
  storageUnitHistoryActionLabel,
  labProgramReviewSchema,
  labProgramSchema,
  type LabProgram,
} from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BusinessClock } from '../retention/business-clock.js';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { insertProject, insertReceipt, receivingLabId } from '../test-support/fixtures.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-T30 standard disposal (card AC1–AC10, test plan T1–T3, T7–T10) on the real MM-T29
// calculation and MM-T26/T24/T36 data, plus the T24 → T36 exception for both source variants.
// Real PostgreSQL; races use real connections, never sleeps. Fictional data only: DEMO-2601 (A,
// PM/PE Pat Example `pe`), DEMO-2602 (B); Lee Manager (`lm`) Lab Manager; Alex Tester (`tech`).
describe.runIf(testDatabaseUrl)('standard disposal (MM-T30)', () => {
  let h: LabHarness;
  let moisture: string;
  let clock: BusinessClock;
  let shelf: string;
  type As = Parameters<LabHarness['send']>[3];

  const at = (date: string) => clock.set(new Date(`${date}T18:00:00Z`));

  async function newHole(project: 'a' | 'b' = 'a') {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects[project], `TH-${newKey().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  async function submitted(holeId: string, project: 'a' | 'b' = 'a'): Promise<LabProgram> {
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

  async function closeProgram(program: LabProgram) {
    const testId = program.lines[0]!.requests[0]!.id;
    const version = async (sql: string, id: string) =>
      (await h.db.pool.query<{ version: number }>(sql, [id])).rows[0]!.version;
    const cancel = await h.send(
      'post',
      `/api/test-requests/${testId}/cancel`,
      {
        reason: 'Not needed',
        version: await version('SELECT version FROM test_request WHERE id = $1', testId),
        idempotencyKey: newKey(),
      },
      'pe',
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const closed = await h.send(
      'post',
      `/api/lab-programs/${program.id}/close`,
      {
        version: await version('SELECT version FROM lab_program WHERE id = $1', program.id),
        idempotencyKey: newKey(),
      },
      'pe',
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }

  const status = (id: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send('post', `/api/test-requests/${id}/status`, { idempotencyKey: newKey(), ...body }, as);

  const approve = (unitIds: string[], as: As = 'lm', key = newKey()) =>
    h.send('post', '/api/disposal/approvals', { unitIds, idempotencyKey: key }, as);
  const scan = (suNumber: string, as: As = 'tech', key = newKey()) =>
    h.send('post', '/api/disposal/remove', { suNumber, idempotencyKey: key }, as);
  const hold = (unitIds: string[], reason = 'Claim review', project: 'a' | 'b' = 'a') =>
    h.send(
      'post',
      '/api/retention/holds',
      { projectId: h.projects[project], scope: 'units', unitIds, reason, idempotencyKey: newKey() },
      'lm',
    );

  async function candidates(project: 'a' | 'b' = 'a', as: As = 'lm') {
    const response = await h.get(`/api/disposal/eligible?projectId=${h.projects[project]}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return disposalCandidatesSchema.parse(response.body);
  }

  async function unitRow(id: string) {
    const { rows } = await h.db.pool.query<{
      status: string;
      current_location_id: string;
      version: number;
      disposed_at: Date | null;
      disposed_by_user_id: string | null;
    }>(
      `SELECT status, current_location_id, version, disposed_at, disposed_by_user_id
       FROM storage_unit WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  const count = async (sql: string, params: unknown[] = []) =>
    (await h.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;

  /** A bucket received 2026-10-23 on a fresh hole with no program: eligible from 2027-10-23. */
  async function oldBucket(project: 'a' | 'b' = 'a') {
    return h.bucket({ project, hole: await newHole(project), receivedDate: '2026-10-23' });
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('MC', 'Moisture content', 'Moisture')).id;
    clock = h.app.get(BusinessClock);
    shelf = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO location (code, name, kind) VALUES ('T30-SHELF', 'T30 shelf', 'warehouse')
         RETURNING id`,
      )
    ).rows[0]!.id;
  }, 60_000);

  afterEach(() => clock.set(null));

  afterAll(async () => {
    await h?.close();
  });

  it('T1: eligibility needs the date reached, no hold and every covering program closed (later receipts included)', async () => {
    const hole = await newHole();
    const first = await h.bucket({ hole, receivedDate: '2026-10-23' });
    const program = await submitted(hole);
    // Received after submission on the same hole: still covered by the open program.
    const later = await h.bucket({ hole, receivedDate: '2026-10-24' });
    at('2027-10-22');
    let list = await candidates();
    const of = (id: string) => list.units.find((u) => u.storageUnitId === id)!;
    expect(of(first.id)).toMatchObject({ eligible: false });
    expect(of(first.id).blockers.map((b) => b.label)).toEqual([
      'Retain until 2027-10-23',
      `Program ${program.programNumber} open`,
    ]);
    at('2027-10-25');
    list = await candidates();
    expect(of(later.id).blockers.map((b) => b.label)).toEqual([
      `Program ${program.programNumber} open`,
    ]);
    await closeProgram(program);
    list = await candidates();
    expect(of(first.id)).toMatchObject({ eligible: true, blockers: [] });
    expect((await hold([later.id], 'Claim review')).status).toBe(201);
    list = await candidates();
    expect(of(later.id).blockers.map((b) => b.label)).toEqual(['On hold: Claim review']);
    // The inventory filter uses the same database rule.
    const inventory = inventoryPageSchema.parse(
      (
        await h.get(
          `/api/inventory?projectId=${h.projects.a}&retention=eligible_for_disposal&pageSize=100`,
          'tech',
        )
      ).body,
    );
    expect(inventory.items.map((i) => i.id)).toContain(first.id);
    expect(inventory.items.map((i) => i.id)).not.toContain(later.id);
  });

  it('AC1/AC6: a Lab Manager approves on the eligible date; approval alone disposes nothing; a Technician gets 403', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id], 'tech')).status).toBe(403);
    const key = newKey();
    const approved = await approve([unit.id], 'lm', key);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect((await approve([unit.id], 'lm', key)).body).toEqual(approved.body); // exact retry
    const row = await unitRow(unit.id);
    expect(row).toMatchObject({ status: 'approved_for_disposal', disposed_at: null });
    expect(await count('FROM disposal_removal WHERE storage_unit_id = $1', [unit.id])).toBe(0);
    expect(
      await count(`FROM audit_event WHERE action = 'disposal.approved' AND entity_id = $1`, [
        unit.id,
      ]),
    ).toBe(1);
    // A second approval of the same unit is refused.
    const again = await approve([unit.id], 'pe');
    expect(again.status).toBe(422);
    expect(again.body.units[0].blockers[0].label).toBe('Already approved for disposal');
  });

  it('batch approval is all or nothing and names each ineligible unit', async () => {
    const ok = await oldBucket();
    const young = await h.bucket({ hole: await newHole(), receivedDate: '2027-06-01' });
    at('2027-10-24');
    const refused = await approve([ok.id, young.id]);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'not_eligible',
      units: [{ storageUnitId: young.id, blockers: [{ label: 'Retain until 2028-06-01' }] }],
    });
    expect((await unitRow(ok.id)).status).toBe('in_stock');
    const both = await approve([ok.id, (await oldBucket()).id]);
    expect(both.status).toBe(201);
    expect(both.body.approvals).toHaveLength(2);
  });

  it('T2/AC2: a hold placed after approval blocks the scan with its reason; releasing it lets the scan dispose', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    const placed = await hold([unit.id], 'Claim review');
    const blocked = await scan(unit.readableId);
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({
      result: 'blocked',
      blockers: [{ code: 'on_hold', label: 'On hold: Claim review' }],
    });
    expect((await unitRow(unit.id)).status).toBe('approved_for_disposal');
    expect(
      await count(`FROM audit_event WHERE action = 'disposal.blocked' AND entity_id = $1`, [
        unit.id,
      ]),
    ).toBe(1);
    const released = await h.send(
      'post',
      `/api/retention/holds/${placed.body.id}/release`,
      { reason: 'Settled', version: 1, idempotencyKey: newKey() },
      'pe',
    );
    expect(released.status).toBe(200);
    // Scanner input arrives in any case with stray spaces.
    const done = await scan(`  ${unit.readableId.toLowerCase()} `);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ result: 'disposed', removedBy: { name: 'Alex Tester' } });
  });

  it('AC4: an unapproved unit is refused in Disposal scan mode; a revoked approval too', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    const refused = await scan(unit.readableId);
    expect(refused.status).toBe(422);
    expect(refused.body.result).toBe('not_approved');
    const approved = await approve([unit.id]);
    const approvalId = approved.body.approvals[0].id as string;
    const noReason = await h.send(
      'post',
      `/api/disposal/approvals/${approvalId}/revoke`,
      { idempotencyKey: newKey() },
      'lm',
    );
    expect(noReason.status).toBe(400);
    const revoked = await h.send(
      'post',
      `/api/disposal/approvals/${approvalId}/revoke`,
      { reason: 'Client asked to keep it', idempotencyKey: newKey() },
      'pe',
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect((await unitRow(unit.id)).status).toBe('in_stock');
    expect((await scan(unit.readableId)).body.result).toBe('not_approved');
    expect(
      await count(
        `FROM audit_event WHERE action = 'disposal.approval_revoked' AND entity_id = $1`,
        [unit.id],
      ),
    ).toBe(1);
    expect((await scan('BKT-2026-999999')).status).toBe(404);
  });

  it('AC5: removal records remover and time, leaves Current stock and occupancy, stays searchable with history', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    await approve([unit.id]);
    const before = await unitRow(unit.id);
    expect((await scan(unit.readableId, 'pe')).status).toBe(200);
    const row = await unitRow(unit.id);
    expect(row).toMatchObject({
      status: 'disposed',
      disposed_by_user_id: h.users.pe,
      current_location_id: before.current_location_id, // last location kept as history
    });
    expect(row.disposed_at).not.toBeNull();
    const current = inventoryPageSchema.parse(
      (await h.get(`/api/inventory?projectId=${h.projects.a}&pageSize=100`, 'tech')).body,
    );
    expect(current.items.map((i) => i.id)).not.toContain(unit.id);
    const disposed = inventoryPageSchema.parse(
      (await h.get(`/api/inventory?projectId=${h.projects.a}&status=disposed&pageSize=100`, 'tech'))
        .body,
    );
    expect(disposed.items.map((i) => i.id)).toContain(unit.id);
    const lookup = await h.get(
      `/api/storage-units/lookup?code=${unit.readableId.toLowerCase()}`,
      'tech',
    );
    expect(lookup.body).toMatchObject({ id: unit.id, readableId: unit.readableId });
    const history = await h.get(`/api/storage-units/${unit.id}/history`, 'tech');
    expect(JSON.stringify(history.body)).toContain('disposal.removed');
    expect(
      await count(
        `FROM storage_unit WHERE current_location_id = $1 AND status <> 'disposed' AND id = $2`,
        [before.current_location_id, unit.id],
      ),
    ).toBe(0);
  });

  it('T3: concurrent scans of one unit dispose it once; a retry with the same key replays', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    await approve([unit.id]);
    const [a, b] = [await h.cookie('tech'), await h.cookie('pe')];
    const key = newKey();
    const results = await Promise.all([scan(unit.readableId, a, key), scan(unit.readableId, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await count('FROM disposal_removal WHERE storage_unit_id = $1', [unit.id])).toBe(1);
    expect(
      await count(`FROM audit_event WHERE action = 'disposal.removed' AND entity_id = $1`, [
        unit.id,
      ]),
    ).toBe(1);
    const replay = await scan(unit.readableId, a, key);
    if (results[0]!.status === 200) {
      expect(replay.body).toMatchObject({ result: 'disposed', replayed: true });
    }
    expect(await count('FROM disposal_removal WHERE storage_unit_id = $1', [unit.id])).toBe(1);
  });

  it('review: concurrent exact retries of a scan both return the one disposition, with no refusal audited', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    await approve([unit.id]);
    const key = newKey();
    const results = await Promise.all([
      scan(unit.readableId, 'tech', key),
      scan(unit.readableId, 'tech', key),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.replayed).sort()).toEqual([false, true]);
    expect(
      await count(`FROM audit_event WHERE action = 'disposal.blocked' AND entity_id = $1`, [
        unit.id,
      ]),
    ).toBe(0);
    // Same for a batch approval retried concurrently.
    const other = await oldBucket();
    const batchKey = newKey();
    const batches = await Promise.all([
      approve([other.id], 'lm', batchKey),
      approve([other.id], 'lm', batchKey),
    ]);
    expect(batches.map((r) => r.status)).toEqual([201, 201]);
    expect(batches[0]!.body).toEqual(batches[1]!.body);
  });

  it('a failure inside the removal transaction rolls everything back', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    await approve([unit.id]);
    await h.db.pool.query(`
      CREATE FUNCTION t30_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END; $$;
      CREATE TRIGGER t30_fail BEFORE INSERT ON disposal_removal
        FOR EACH ROW EXECUTE FUNCTION t30_fail();`);
    try {
      const failed = await scan(unit.readableId);
      expect(failed.status).toBe(500);
    } finally {
      await h.db.pool.query('DROP TRIGGER t30_fail ON disposal_removal; DROP FUNCTION t30_fail()');
    }
    expect((await unitRow(unit.id)).status).toBe('approved_for_disposal');
    expect(
      await count('FROM disposal_approval WHERE storage_unit_id = $1 AND used_at IS NOT NULL', [
        unit.id,
      ]),
    ).toBe(0);
    expect(
      await count(`FROM audit_event WHERE action = 'disposal.removed' AND entity_id = $1`, [
        unit.id,
      ]),
    ).toBe(0);
    expect((await scan(unit.readableId)).status).toBe(200);
  });

  it('T9/AC9: two LAB stations, whoever they select, can approve, revoke or remove nothing by either route', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    const [stationA, stationB] = [await h.cookie('lab'), await h.cookie('lab')];
    const approved = await approve([unit.id], 'lm');
    for (const [station, person] of [
      [stationA, h.users.lm],
      [stationB, h.users.pe],
    ] as const) {
      const tries = [
        await h.send(
          'post',
          '/api/disposal/approvals',
          { unitIds: [unit.id], idempotencyKey: newKey(), actingStaffUserId: person },
          station,
        ),
        await h.send(
          'post',
          `/api/disposal/approvals/${approved.body.approvals[0].id}/revoke`,
          { reason: 'x', idempotencyKey: newKey(), actingStaffUserId: person },
          station,
        ),
        await h.send(
          'post',
          '/api/disposal/remove',
          { suNumber: unit.readableId, idempotencyKey: newKey(), actingStaffUserId: person },
          station,
        ),
        await h.send(
          'post',
          `/api/storage-units/${unit.id}/tested-removal`,
          { confirmPhysicalRemoval: true, idempotencyKey: newKey(), actingStaffUserId: person },
          station,
        ),
      ];
      expect(tries.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    }
    expect((await unitRow(unit.id)).status).toBe('approved_for_disposal');
    // A separate personal session records it.
    expect((await scan(unit.readableId, 'tech')).status).toBe(200);
  });

  it('T10/AC10: after disposal, stale LAB moves, queued-move replay, test allocation and status edits are refused', async () => {
    const hole = await newHole();
    const unit = await h.bucket({ hole, receivedDate: '2026-10-23' });
    at('2027-10-24');
    await approve([unit.id]);
    const station = await h.cookie('lab');
    const move = (to: string) => ({
      clientMoveId: randomUUID(),
      storageUnitId: unit.id,
      toLocationId: to,
      baseVersion: 2,
      scannedAt: new Date().toISOString(),
      capturedOffline: true,
      captureContext: { stationId: randomUUID(), accountId: h.users.lab, moverUserId: h.users.js },
    });
    const queued = move(shelf); // captured offline before the disposal
    // Ordinary moves can't dispose: the move body has no status, and extra keys are refused.
    const sneaky = await h.send(
      'post',
      '/api/moves',
      { ...move(shelf), status: 'disposed' },
      station,
    );
    expect(sneaky.status).toBe(400);
    expect((await scan(unit.readableId, 'pe')).status).toBe(200);
    const replayed = await h.send('post', '/api/moves', queued, station);
    expect(replayed.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(replayed.body)).toContain('storage_unit_disposed');
    expect((await unitRow(unit.id)).status).toBe('disposed');
    // New programs no longer cover it; linking it as tested is refused by the database.
    const program = await submitted(hole);
    expect(program.lines[0]!.coverage?.length ?? 0).toBe(0);
    await expect(
      h.db.pool.query(`UPDATE storage_unit SET status = 'in_stock' WHERE id = $1`, [unit.id]),
    ).rejects.toMatchObject({ constraint: 'storage_unit_disposed_final' });
  });

  it('T6/T7 (T24 → T36): a tested tube (test-hole source) and tested BKT-A (standalone group) use the exception; BKT-B stays in stock on hold', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole, sampleReference: 'T1' });
    const untested = await h.tube({ holeId: hole, sampleReference: 'T2' });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    // Standalone bulk sample source, its own program.
    const group = await h.bulkGroup({
      location: 'Stockpile A',
      sampleReference: 'B1',
      depthFrom: 1.5,
      buckets: 2,
    });
    const [bktA, bktB] = group.members;
    const bulkCreated = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'standalone_bulk_group', id: group.groupId }, 'all', [moisture])],
      },
      'tech',
    );
    expect(bulkCreated.status, JSON.stringify(bulkCreated.body)).toBe(201);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${bulkCreated.body.id}/review`, 'tech')).body,
    );
    const bulkProgram = labProgramSchema.parse(
      (
        await h.send(
          'post',
          `/api/lab-programs/${bulkCreated.body.id}/submit`,
          {
            version: bulkCreated.body.version,
            idempotencyKey: newKey(),
            coverage: review.lines.map((l) => ({
              lineId: l.lineId,
              unitIds: l.coverage.map((c) => c.storageUnitId),
            })),
          },
          'tech',
        )
      ).body,
    );
    const bulkRequest = bulkProgram.lines[0]!.requests[0]!.id;
    // Future retention, an extension and a project-wide hold; programs stay open; no approval.
    const extension = await h.send(
      'post',
      '/api/retention/extensions',
      {
        projectId: h.projects.a,
        scope: 'project',
        retainUntil: '2031-01-01',
        reason: 'Client asked',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    const projectHold = await h.send(
      'post',
      '/api/retention/holds',
      {
        projectId: h.projects.a,
        scope: 'project',
        reason: 'Claim review',
        idempotencyKey: newKey(),
      },
      'lm',
    );
    expect([extension.status, projectHold.status]).toEqual([201, 201]);
    for (const [id, units] of [
      [requestId, [tube.id]],
      [bulkRequest, [bktA!.id]],
    ] as const) {
      expect((await status(id, { to: 'in_progress', version: 1 })).status).toBe(200);
      const done = await status(
        id,
        { to: 'completed', version: 2, testedStorageUnitIds: units, actingStaffUserId: h.users.js },
        'lab',
      );
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    // Completion alone disposes nothing and releases no location.
    expect((await unitRow(tube.id)).status).toBe('in_stock');
    // MM-T71 T3/AC3: the tested tube shows only its exception, never hold/retain-until (or open
    // program) blockers, on the Disposal page and in Sample Storage.
    const before = (await candidates()).units.find((u) => u.storageUnitId === tube.id)!;
    expect(before).toMatchObject({ retentionExempt: true, eligible: false, blockers: [] });
    const inStorage = inventoryPageSchema
      .parse((await h.get(`/api/inventory?search=${tube.readableId}`, 'tech')).body)
      .items.find((i) => i.id === tube.id)!;
    expect(inStorage.retention).toMatchObject({ retentionExempt: true });
    // LAB can't confirm removal; a personal account can, without approval or the standard scan.
    const lab = await h.send(
      'post',
      `/api/storage-units/${tube.id}/tested-removal`,
      {
        testRequestId: requestId,
        confirmPhysicalRemoval: true,
        version: 1,
        idempotencyKey: newKey(),
        actingStaffUserId: h.users.lm,
      },
      'lab',
    );
    expect(lab.status).toBe(403);
    // A standard approval recorded earlier (e.g. before testing was planned) for the tube.
    const { rows: stale } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO disposal_approval (storage_unit_id, project_id, batch_id, approved_by_user_id,
         approved_by_name_snapshot, effective_retain_until, idempotency_key, request_hash)
       VALUES ($1, $2, gen_random_uuid(), $3, 'Lee Manager', '2027-10-23', gen_random_uuid(), 'x')
       RETURNING id`,
      [tube.id, h.projects.a, h.users.lm],
    );
    await h.db.pool.query(
      `UPDATE storage_unit SET status = 'approved_for_disposal' WHERE id = $1`,
      [tube.id],
    );
    for (const [id, req] of [
      [tube.id, requestId],
      [bktA!.id, bulkRequest],
    ] as const) {
      const removed = await h.send(
        'post',
        `/api/storage-units/${id}/tested-removal`,
        { testRequestId: req, confirmPhysicalRemoval: true, version: 1, idempotencyKey: newKey() },
        'tech',
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(201);
      expect((await unitRow(id)).status).toBe('disposed');
    }
    expect(
      await count('FROM disposal_approval WHERE id = $1 AND used_at IS NOT NULL', [stale[0]!.id]),
    ).toBe(1);
    // MM-T71 T5/AC5: using the approval is audited (same transaction) and shown in history.
    const { rows: usedEvents } = await h.db.pool.query<{
      after_values: { approvalId: string };
      actor_user_id: string;
    }>(
      `SELECT after_values, actor_user_id FROM audit_event
       WHERE action = 'disposal.approval_used' AND entity_type = 'storage_unit' AND entity_id = $1`,
      [tube.id],
    );
    expect(usedEvents).toHaveLength(1);
    expect(usedEvents[0]!.after_values.approvalId).toBe(stale[0]!.id);
    expect(usedEvents[0]!.actor_user_id).toBe(h.users.tech);
    expect(
      await count(`FROM audit_event WHERE action = 'disposal.approval_used' AND entity_id = $1`, [
        bktA!.id,
      ]),
    ).toBe(0);
    const history = await h.get(`/api/storage-units/${tube.id}/history`, 'tech');
    expect(history.body.items.map((e: { action: string }) => e.action)).toContain(
      'disposal.approval_used',
    );
    expect(storageUnitHistoryActionLabel('disposal.approval_used')).toBe('Disposal approval used');
    const lateRevoke = await h.send(
      'post',
      `/api/disposal/approvals/${stale[0]!.id}/revoke`,
      { reason: 'Too late', idempotencyKey: newKey() },
      'lm',
    );
    expect(lateRevoke.status).toBe(409);
    // The standard scan refuses them (already disposed); untested and sibling units are blocked.
    expect((await scan(tube.readableId)).body.result).toBe('not_approved');
    const sibling = await unitRow(bktB!.id);
    expect(sibling.status).toBe('in_stock');
    const list = await candidates();
    const labels = (id: string) =>
      list.units.find((u) => u.storageUnitId === id)!.blockers.map((b) => b.label);
    expect(labels(bktB!.id)).toEqual(
      expect.arrayContaining(['On hold: Claim review', 'Retain until 2031-01-01']),
    );
    expect(labels(untested.id)).toEqual(expect.arrayContaining(['On hold: Claim review']));
    const untestedRemoval = await h.send(
      'post',
      `/api/storage-units/${untested.id}/tested-removal`,
      {
        testRequestId: requestId,
        confirmPhysicalRemoval: true,
        version: 1,
        idempotencyKey: newKey(),
      },
      'tech',
    );
    expect(untestedRemoval.status).toBe(422);
    // Nothing released the project hold.
    expect(
      await count('FROM retention_hold WHERE id = $1 AND released_at IS NULL', [
        projectHold.body.id,
      ]),
    ).toBe(1);
    // Clean up holds/extensions for other tests.
    await h.send(
      'post',
      `/api/retention/holds/${projectHold.body.id}/release`,
      { reason: 'Done', version: 1, idempotencyKey: newKey() },
      'lm',
    );
    await h.send(
      'post',
      `/api/retention/extensions/${extension.body.id}/release`,
      { reason: 'Done', version: 1, idempotencyKey: newKey() },
      'lm',
    );
  });

  it('MM-T71 T4/AC4: 501 current units are all reachable in pages, with a total matching inventory', async () => {
    const projectId = await insertProject(h.db.pool, 'DEMO-2699', h.users.pe);
    const lab = await receivingLabId(h.db.pool);
    // 501 fictional buckets BKT-2026-900001… in receipts of at most 50 (the receipt limit).
    for (let first = 1; first <= 501; first += 50) {
      const quantity = Math.min(50, 502 - first);
      const receiptId = await insertReceipt(h.db.pool, projectId, h.users.tech, quantity);
      await h.db.pool.query(
        `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                   receipt_id, project_id, unit_type, holder_kind,
                                   current_location_id, received_date, receipt_line)
         SELECT 'BKT-2026-9' || lpad((n + $4 - 1)::text, 5, '0'), 'BKT', 2026, 'bucket', $1, $2,
                'bucket', 'bucket', $3, '2026-10-23', n
         FROM generate_series(1, $5::int) AS n`,
        [receiptId, projectId, lab, first, quantity],
      );
    }
    const seen = new Set<string>();
    let total = -1;
    for (const page of [1, 2, 3]) {
      const response = await h.get(
        `/api/disposal/eligible?projectId=${projectId}&page=${page}`,
        'lm',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const body = disposalCandidatesSchema.parse(response.body);
      expect(body).toMatchObject({ page, pageSize: 200 });
      total = body.total;
      for (const unit of body.units) seen.add(unit.storageUnitId);
      expect(body.units).toHaveLength(page < 3 ? 200 : 101);
    }
    expect(total).toBe(501);
    expect(seen.size).toBe(501);
    const inventory = inventoryPageSchema.parse(
      (await h.get(`/api/inventory?projectId=${projectId}`, 'lm')).body,
    );
    expect(inventory.total).toBe(total);
    // Past the end: an empty page that still reports the total.
    const beyond = disposalCandidatesSchema.parse(
      (await h.get(`/api/disposal/eligible?projectId=${projectId}&page=9`, 'lm')).body,
    );
    expect(beyond).toMatchObject({ total: 501, units: [] });
    expect((await h.get(`/api/disposal/eligible?projectId=${projectId}&page=0`, 'lm')).status).toBe(
      400,
    );
  }, 60_000); // 501 units and four pages: allow for a busy PC

  /** Corrects `unitId`'s project to DEMO-2602 with a summary on a fresh B hole (MM-T13 route). */
  async function correctToB(unitId: string, as: As = 'tech') {
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM storage_unit WHERE id = $1',
      [unitId],
    );
    return h.send(
      'patch',
      `/api/storage-units/${unitId}`,
      {
        version: rows[0]!.version,
        reason: 'Received under the wrong project',
        changes: {
          projectId: h.projects.b,
          holeSummaries: [{ testHoleId: await newHole('b'), type: 'all' }],
        },
      },
      as,
    );
  }

  it('MM-T70 T1/AC2: approved in DEMO-2601, corrected to DEMO-2602 → the scan says Not approved until DEMO-2602 approves', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    const approved = await approve([unit.id], 'pe'); // DEMO-2601's PM/PE
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const approvalId = approved.body.approvals[0].id as string;
    const corrected = await correctToB(unit.id);
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);

    const refused = await scan(unit.readableId);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      result: 'not_approved',
      blockers: [{ code: 'approval_project_changed' }],
    });
    expect(refused.body.message).toMatch(/approved under another project/);
    const row = await unitRow(unit.id);
    expect(row).toMatchObject({ status: 'approved_for_disposal', disposed_at: null });
    expect(await count('FROM disposal_removal WHERE storage_unit_id = $1', [unit.id])).toBe(0);
    expect(
      await count('FROM disposal_approval WHERE id = $1 AND used_at IS NULL', [approvalId]),
    ).toBe(1);
    expect(
      await count(
        `FROM audit_event WHERE action = 'disposal.blocked' AND entity_id = $1
           AND after_values->'blockers' ? 'approval_project_changed'`,
        [unit.id],
      ),
    ).toBe(1);

    // DEMO-2602's Disposal page shows why; its PM/PE or a Lab Manager revokes and approves again.
    const listed = (await candidates('b')).units.find((u) => u.storageUnitId === unit.id)!;
    expect(listed.approval?.id).toBe(approvalId);
    expect(listed.blockers.map((b) => b.code)).toContain('approval_project_changed');
    const revoked = await h.send(
      'post',
      `/api/disposal/approvals/${approvalId}/revoke`,
      { reason: 'Project corrected', idempotencyKey: newKey() },
      'lm',
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const again = await approve([unit.id], 'lm');
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(
      (
        await h.db.pool.query<{ project_id: string }>(
          'SELECT project_id FROM disposal_approval WHERE id = $1',
          [again.body.approvals[0].id],
        )
      ).rows[0]!.project_id,
    ).toBe(h.projects.b);
    const disposed = await scan(unit.readableId);
    expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
    expect(
      (
        await h.db.pool.query<{ project_id: string }>(
          'SELECT project_id FROM disposal_removal WHERE storage_unit_id = $1',
          [unit.id],
        )
      ).rows[0]!.project_id,
    ).toBe(h.projects.b);
  });

  it('MM-T70 AC2: a live approval forced under another project (SQL) is Not approved; the unit is unchanged', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    // Bypass the API: move the unit's project directly.
    await h.db.pool.query('DELETE FROM storage_unit_hole_summary WHERE storage_unit_id = $1', [
      unit.id,
    ]);
    await h.db.pool.query('UPDATE storage_unit SET project_id = $2 WHERE id = $1', [
      unit.id,
      h.projects.b,
    ]);
    const before = await unitRow(unit.id);
    const refused = await scan(unit.readableId, 'lm');
    expect(refused.body.result).toBe('not_approved');
    expect(await unitRow(unit.id)).toEqual(before);
  });

  it('MM-T70 T2/AC3: a project correction racing the disposal scan: exactly one wins, never a removal under the wrong project', async () => {
    for (const round of [0, 1, 2, 3]) {
      const unit = await oldBucket();
      at('2027-10-24');
      expect((await approve([unit.id], 'pe')).status).toBe(201);
      const blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
      await blocker.connect();
      let results: Awaited<ReturnType<typeof scan>>[];
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM storage_unit WHERE id = $1 FOR UPDATE', [unit.id]);
        // Alternate which request reaches the lock first.
        const first = round % 2 === 0 ? correctToB(unit.id) : scan(unit.readableId);
        await waitForUnitLockWaiters(1);
        const second = round % 2 === 0 ? scan(unit.readableId) : correctToB(unit.id);
        await waitForUnitLockWaiters(2);
        await blocker.query('COMMIT');
        results = await Promise.all([first, second]);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end();
      }
      const [correction, removal] = (round % 2 === 0 ? results : [results[1], results[0]]) as [
        (typeof results)[number],
        (typeof results)[number],
      ];
      const row = await unitRow(unit.id);
      const { rows: project } = await h.db.pool.query<{ project_id: string }>(
        'SELECT project_id FROM storage_unit WHERE id = $1',
        [unit.id],
      );
      if (removal.status === 200) {
        // The scan won: disposed under DEMO-2601; the stale correction is refused.
        expect(correction.status).toBe(409);
        expect(row.status).toBe('disposed');
        expect(project[0]!.project_id).toBe(h.projects.a);
      } else {
        // The correction won: the scan is refused and nothing is disposed.
        expect(correction.status, JSON.stringify(correction.body)).toBe(200);
        expect([409, 422]).toContain(removal.status);
        expect(row.status).toBe('approved_for_disposal');
        expect(project[0]!.project_id).toBe(h.projects.b);
      }
      expect(
        await count(
          `FROM disposal_removal r JOIN disposal_approval a ON a.id = r.approval_id
           JOIN storage_unit su ON su.id = r.storage_unit_id
           WHERE r.storage_unit_id = $1
             AND (a.project_id <> su.project_id OR r.project_id <> su.project_id)`,
          [unit.id],
        ),
      ).toBe(0);
    }
  }, 60_000); // four barrier rounds

  it('MM-T70 AC4: LAB still gets 403 for the correction and the scan', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    expect((await correctToB(unit.id, 'lab')).status).toBe(403);
    expect((await scan(unit.readableId, 'lab')).status).toBe(403);
    expect((await unitRow(unit.id)).status).toBe('approved_for_disposal');
  });

  async function waitForUnitLockWaiters(n: number) {
    for (let i = 0; i < 2000; i += 1) {
      const { rows } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%storage_unit%FOR UPDATE%'`,
      );
      if (rows[0]!.n >= n) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`fewer than ${n} requests waited on storage_unit`);
  }

  it('database rules: one disposition per unit, approvals revoked/used once, no deletes', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    const approved = await approve([unit.id]);
    const approvalId = approved.body.approvals[0].id as string;
    const fails = async (sql: string, params: unknown[]) => {
      try {
        await h.db.pool.query(sql, params);
        return null;
      } catch (error) {
        return (
          (error as { constraint?: string; code?: string }).constraint ??
          (error as { code?: string }).code
        );
      }
    };
    expect(await fails('DELETE FROM disposal_approval WHERE id = $1', [approvalId])).toBe('23001');
    expect(
      await fails(
        `INSERT INTO disposal_approval (storage_unit_id, project_id, batch_id, approved_by_user_id,
           approved_by_name_snapshot, effective_retain_until, idempotency_key, request_hash)
         VALUES ($1, $2, gen_random_uuid(), $3, 'X', '2027-10-23', gen_random_uuid(), 'x')`,
        [unit.id, h.projects.a, h.users.lm],
      ),
    ).toBe('disposal_approval_live_key');
    // A removal row that doesn't match a disposed unit is refused.
    expect(
      await fails(
        `INSERT INTO disposal_removal (storage_unit_id, approval_id, project_id,
           unit_readable_id_snapshot, location_id, location_code_snapshot, location_name_snapshot,
           removed_by_user_id, removed_by_account_type, removed_by_name_snapshot, idempotency_key,
           request_hash)
         SELECT $1, $2, $3, 'X', current_location_id, 'X', 'X', $4, 'personal', 'X',
                gen_random_uuid(), 'x'
         FROM storage_unit WHERE id = $1`,
        [unit.id, approvalId, h.projects.a, h.users.lm],
      ),
    ).toBe('disposal_removal_matches_unit');
    // MM-T70: an approval must name the unit's current project.
    const other = await oldBucket();
    expect(
      await fails(
        `INSERT INTO disposal_approval (storage_unit_id, project_id, batch_id, approved_by_user_id,
           approved_by_name_snapshot, effective_retain_until, idempotency_key, request_hash)
         VALUES ($1, $2, gen_random_uuid(), $3, 'X', '2027-10-23', gen_random_uuid(), 'x')`,
        [other.id, h.projects.b, h.users.lm],
      ),
    ).toBe('disposal_approval_matches_unit_project');
    expect((await scan(unit.readableId)).status).toBe(200);
    expect(
      await fails('DELETE FROM disposal_removal WHERE storage_unit_id = $1', [unit.id]),
    ).not.toBeNull();
  });
});
