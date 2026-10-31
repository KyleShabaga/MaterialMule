import {
  disposalCandidatesSchema,
  disposalReadySchema,
  labProgramReviewSchema,
  labProgramSchema,
} from '@materialmule/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BusinessClock } from '../retention/business-clock.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  receivingLabId,
} from '../test-support/fixtures.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MISC-13 "Ready for disposal": units in every project that standard disposal can take now, from
// the database's unit_disposal_eligible. Its own schema, so the list holds only this file's units.
// Fictional data: DEMO-2601 (A) and DEMO-2602 (B) led by Pat Example (`pe`), DEMO-2603 led by
// Jordan Smith (`js`); Lee Manager (`lm`) Lab Manager; Alex Tester (`tech`) no role.
describe.runIf(testDatabaseUrl)('ready for disposal (MISC-13)', () => {
  let h: LabHarness;
  let clock: BusinessClock;
  let moisture: string;
  let projectC: string;
  type As = Parameters<LabHarness['send']>[3];

  /** Buckets received 2026-10-23 are eligible by date from 2027-10-23. */
  const at = (date: string) => clock.set(new Date(`${date}T18:00:00Z`));

  async function newHole(project: 'a' | 'b' = 'a') {
    return insertTestHole(h.db.pool, h.projects[project], `TH-${newKey().slice(0, 8)}`);
  }
  const oldBucket = async (project: 'a' | 'b' = 'a') =>
    h.bucket({ project, hole: await newHole(project), receivedDate: '2026-10-23' });

  async function ready(as: As = 'lm', page?: number) {
    const response = await h.get(`/api/disposal/ready${page ? `?page=${page}` : ''}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return disposalReadySchema.parse(response.body);
  }
  const ids = async (as: As = 'lm') => (await ready(as)).units.map((u) => u.storageUnitId);

  const approve = (unitIds: string[], as: As = 'lm') =>
    h.send('post', '/api/disposal/approvals', { unitIds, idempotencyKey: newKey() }, as);
  const scan = (suNumber: string, as: As = 'tech') =>
    h.send('post', '/api/disposal/remove', { suNumber, idempotencyKey: newKey() }, as);
  const hold = (unitIds: string[], reason = 'Claim review') =>
    h.send(
      'post',
      '/api/retention/holds',
      { projectId: h.projects.a, scope: 'units', unitIds, reason, idempotencyKey: newKey() },
      'lm',
    );
  const release = (holdId: string) =>
    h.send(
      'post',
      `/api/retention/holds/${holdId}/release`,
      { reason: 'Done', version: 1, idempotencyKey: newKey() },
      'lm',
    );

  /** A submitted program on `holeId` (all units, moisture content). */
  async function submitted(holeId: string) {
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

  /** Tests `unitId` to completion, accepts it and closes the program: the unit is then exempt. */
  async function testAndClose(holeId: string, unitId: string) {
    const program = await submitted(holeId);
    const testId = program.lines[0]!.requests[0]!.id;
    let version = 1;
    for (const to of ['in_progress', 'completed', 'review']) {
      const moved = await h.send(
        'post',
        `/api/test-requests/${testId}/status`,
        {
          to,
          version,
          idempotencyKey: newKey(),
          ...(to === 'completed' ? { testedStorageUnitIds: [unitId] } : {}),
        },
        'tech',
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      version = moved.body.version as number;
    }
    const reviewed = await h.send(
      'post',
      `/api/test-requests/${testId}/review`,
      { action: 'complete', version, idempotencyKey: newKey() },
      'js',
    );
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const accepted = await h.send(
      'post',
      `/api/test-requests/${testId}/accept`,
      { version: reviewed.body.version, idempotencyKey: newKey() },
      'pe',
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM lab_program WHERE id = $1',
      [program.id],
    );
    const closed = await h.send(
      'post',
      `/api/lab-programs/${program.id}/close`,
      { version: rows[0]!.version, idempotencyKey: newKey() },
      'pe',
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    clock = h.app.get(BusinessClock);
    moisture = (await h.testType('MC', 'Moisture content', 'Moisture')).id;
    projectC = await insertProject(h.db.pool, 'DEMO-2603', h.users.js);
  }, 60_000);

  afterEach(() => clock.set(null));

  afterAll(async () => {
    await h?.close();
  });

  it('empty: no units at all, then only units still under retention', async () => {
    at('2027-10-24');
    expect(await ready()).toMatchObject({ total: 0, units: [], page: 1, asOf: '2027-10-24' });
    await h.bucket({ hole: await newHole(), receivedDate: '2027-06-01' });
    expect(await ready()).toMatchObject({ total: 0, units: [] });
    expect((await ready('lm', 3)).units).toEqual([]);
  });

  it('lists eligible units with project, location, retain-until and reason; leaves every blocked unit out', async () => {
    at('2027-10-24');
    const plain = await oldBucket();
    const inB = await oldBucket('b');
    const held = await oldBucket();
    const extended = await oldBucket();
    const recent = await h.bucket({ hole: await newHole(), receivedDate: '2027-06-01' });
    const approved = await oldBucket();
    const disposed = await oldBucket();
    const programHole = await newHole();
    const covered = await h.bucket({ hole: programHole, receivedDate: '2026-10-23' });
    const conflicted = await oldBucket();
    // Untested Shelby tube and bulk sample buckets follow the normal rules.
    const tube = await h.tube({ holeId: await newHole() });
    const bulk = await h.bulkGroup({ sampleReference: 'B1', depthFrom: 0.5, buckets: 1 });
    // A tested tube (exact-unit evidence, program closed) is retention exempt: its own route.
    const testedHole = await newHole();
    const tested = await h.tube({ holeId: testedHole });
    await testAndClose(testedHole, tested.id);

    expect((await hold([held.id])).status).toBe(201);
    const extension = await h.send(
      'post',
      '/api/retention/extensions',
      {
        projectId: h.projects.a,
        scope: 'units',
        unitIds: [extended.id],
        extendMonths: 6,
        reason: 'Client asked',
        idempotencyKey: newKey(),
      },
      'lm',
    );
    expect(extension.status, JSON.stringify(extension.body)).toBe(201);
    expect((await approve([approved.id, disposed.id])).status).toBe(201);
    expect((await scan(disposed.readableId)).body.result).toBe('disposed');
    await submitted(programHole);
    await h.db.pool.query(
      `INSERT INTO location_conflict (storage_unit_id, saved_location_id, saved_version)
       SELECT id, current_location_id, version FROM storage_unit WHERE id = $1`,
      [conflicted.id],
    );

    const list = await ready();
    const shown = list.units.map((u) => u.storageUnitId);
    expect(shown).toEqual(
      expect.arrayContaining([plain.id, inB.id, approved.id, tube.id, bulk.members[0]!.id]),
    );
    for (const blocked of [held, extended, recent, disposed, covered, conflicted, tested]) {
      expect(shown, blocked.readableId).not.toContain(blocked.id);
    }
    expect(list.total).toBe(list.units.length);
    // The tested tube is left out for its exemption alone: by date, holds and programs it passes.
    const perProject = disposalCandidatesSchema.parse(
      (await h.get(`/api/disposal/eligible?projectId=${h.projects.a}`, 'lm')).body,
    );
    expect(perProject.units.find((u) => u.storageUnitId === tested.id)).toMatchObject({
      retentionExempt: true,
      eligible: true,
    });
    const row = list.units.find((u) => u.storageUnitId === plain.id)!;
    expect(row).toMatchObject({
      readableId: plain.readableId,
      unitType: 'bucket',
      project: { id: h.projects.a, projectNumber: 'DEMO-2601' },
      location: { code: 'RECEIVING', name: 'Receiving lab' },
      effectiveRetainUntil: '2027-10-23',
      stage: 'awaiting_approval',
      reason: { code: 'retention_ended' },
      canApprove: true,
    });
    expect(row.reason.label).toBe(
      'Retention ended 2027-10-23 (1 year after receipt 2026-10-23); no hold, open program or location conflict',
    );
    expect(list.units.find((u) => u.storageUnitId === approved.id)!.stage).toBe('approved');
    expect(list.units.find((u) => u.storageUnitId === inB.id)!.project.projectNumber).toBe(
      'DEMO-2602',
    );

    // Once the extension has passed, the unit is ready, and the reason says so.
    at('2028-04-24');
    const later = (await ready()).units.find((u) => u.storageUnitId === extended.id)!;
    expect(later.reason).toEqual({
      code: 'extension_ended',
      label: 'Extended retention ended 2028-04-23; no hold, open program or location conflict',
    });
    expect(later.effectiveRetainUntil).toBe('2028-04-23');
  });

  it('a hold added after the list loaded blocks approval and the scan; the list then leaves the units out', async () => {
    at('2027-10-24');
    const waiting = await oldBucket();
    const approvedFirst = await oldBucket();
    expect((await approve([approvedFirst.id])).status).toBe(201);
    const before = await ids();
    expect(before).toEqual(expect.arrayContaining([waiting.id, approvedFirst.id]));

    const placed = await hold([waiting.id, approvedFirst.id], 'Late claim');
    expect(placed.status).toBe(201);
    const refused = await approve([waiting.id]);
    expect(refused.status).toBe(422);
    expect(refused.body.units[0].blockers).toEqual(
      expect.arrayContaining([{ code: 'on_hold', label: 'On hold: Late claim' }]),
    );
    const blocked = await scan(approvedFirst.readableId);
    expect(blocked.status).toBe(422);
    expect(blocked.body.result).toBe('blocked');
    const after = await ids();
    expect(after).not.toContain(waiting.id);
    expect(after).not.toContain(approvedFirst.id);

    await release(placed.body.id);
    expect(await ids()).toEqual(expect.arrayContaining([waiting.id, approvedFirst.id]));
    expect((await scan(approvedFirst.readableId)).body.result).toBe('disposed');
    expect(await ids()).not.toContain(approvedFirst.id);
  });

  it('permissions: inventory.read sees every project; canApprove follows each project; approval stays enforced', async () => {
    at('2027-10-24');
    const lab = await receivingLabId(h.db.pool);
    const inC = {
      id: await insertStorageUnit(
        h.db.pool,
        {
          projectId: projectC,
          receiptId: await insertReceipt(h.db.pool, projectC, h.users.tech),
          locationId: lab,
        },
        { readableId: 'BKT-2026-913001' },
      ),
    };
    await insertSummary(
      h.db.pool,
      {
        storageUnitId: inC.id,
        projectId: projectC,
        testHoleId: await insertTestHole(h.db.pool, projectC, 'TH26-01'),
      },
      { type: 'all' },
    );
    const inA = await oldBucket();
    const canApprove = async (as: As) =>
      Object.fromEntries(
        (await ready(as)).units
          .filter((u) => [inA.id, inC.id].includes(u.storageUnitId))
          .map((u) => [u.project.projectNumber, u.canApprove]),
      );
    // The Lab Manager may approve anywhere; the lead only on their own projects.
    expect(await canApprove('lm')).toEqual({ 'DEMO-2601': true, 'DEMO-2603': true });
    expect(await canApprove('pe')).toEqual({ 'DEMO-2601': true, 'DEMO-2603': false });
    expect(await canApprove('js')).toEqual({ 'DEMO-2601': false, 'DEMO-2603': true });
    // Someone on neither project, and the shared LAB account, see the same rows, approving none.
    expect(await canApprove('tech')).toEqual({ 'DEMO-2601': false, 'DEMO-2603': false });
    expect(await canApprove('lab')).toEqual({ 'DEMO-2601': false, 'DEMO-2603': false });
    expect(await ids('tech')).toEqual(await ids('lm'));
    // Listing grants nothing: the route still checks the project's authority.
    expect((await approve([inC.id], 'pe')).status).toBe(403);
    expect((await approve([inC.id], 'tech')).status).toBe(403);
    expect((await h.http().get('/api/disposal/ready')).status).toBe(401);
    expect((await h.get('/api/disposal/ready?page=0', 'lm')).status).toBe(400);
  });
});
