import {
  labProgramReviewSchema,
  labProgramSchema,
  retentionDecisionResultSchema,
  retentionDecisionUnitsSchema,
  retentionPipelineSchema,
  storageUnitRetentionSchema,
  type LabProgram,
  type RetentionPipeline,
} from '@materialmule/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { BusinessClock } from './business-clock.js';

// STRATA-90/91: the Retention pipeline (tabs, bands, counts) and the decision drawer through the
// real API. Kyle's decisions (2026-11-13): STRATA-110 an Overdue unit that qualifies shows in both
// its band (tagged Eligible) and the Eligible tab, one rule; STRATA-113 the minimum is received +
// 1 year and an extension never makes retain-until earlier. Fictional data only: DEMO-2601 (A) and
// DEMO-2602 (B), both led by Pat Example (`pe`); Lee Manager (`lm`) Lab Manager; Alex Tester
// (`tech`) and Jordan Smith (`js`) ordinary staff.
describe.runIf(testDatabaseUrl)('retention pipeline and decisions (STRATA-90/91)', () => {
  let h: LabHarness;
  let moisture: string;
  let clock: BusinessClock;
  type As = Parameters<LabHarness['send']>[3];

  const at = (date: string) => clock.set(new Date(`${date}T18:00:00Z`));
  const TODAY = '2027-06-15';

  async function newHole(project: 'a' | 'b' = 'b') {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects[project], `TH-${newKey().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  /** A bucket on project B whose minimum retain-until is `retainUntil` (received a year before). */
  async function unitEnding(retainUntil: string, hole?: string) {
    const [y, m, d] = retainUntil.split('-');
    return h.bucket({
      project: 'b',
      hole: hole ?? (await newHole()),
      receivedDate: `${Number(y) - 1}-${m}-${d}`,
    });
  }

  async function pipeline(query: string, as: As = 'pe'): Promise<RetentionPipeline> {
    const response = await h.get(`/api/retention/pipeline?${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return retentionPipelineSchema.parse(response.body);
  }
  const rowOf = (page: RetentionPipeline, id: string) =>
    page.rows.find((r) => r.storageUnitId === id);

  async function version(id: string) {
    return (
      await h.db.pool.query<{ version: number }>('SELECT version FROM storage_unit WHERE id = $1', [
        id,
      ])
    ).rows[0]!.version;
  }

  async function decide(body: Record<string, unknown>, as: As = 'pe') {
    return h.send(
      'post',
      '/api/retention/decisions',
      { reason: 'Report issued', idempotencyKey: newKey(), ...body },
      as,
    );
  }
  const units = async (...ids: string[]) =>
    Promise.all(ids.map(async (id) => ({ id, version: await version(id) })));

  async function submitted(holeId: string, project: 'a' | 'b' = 'b'): Promise<LabProgram> {
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

  async function releaseAll() {
    for (const table of ['retention_hold', 'retention_extension']) {
      const { rows } = await h.db.pool.query<{ id: string; version: number }>(
        `SELECT id, version FROM ${table} WHERE released_at IS NULL`,
      );
      for (const row of rows) {
        const kind = table === 'retention_hold' ? 'holds' : 'extensions';
        const response = await h.send(
          'post',
          `/api/retention/${kind}/${row.id}/release`,
          { reason: 'Test clean-up', version: row.version, idempotencyKey: newKey() },
          'lm',
        );
        expect(response.status).toBe(200);
      }
    }
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('MC', 'Moisture content', 'Moisture')).id;
    clock = h.app.get(BusinessClock);
  }, 60_000);

  afterEach(async () => {
    await releaseAll();
    clock.set(null);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('bands by effective retain-until; an eligible Overdue unit is in both its band and Eligible (STRATA-110)', async () => {
    at(TODAY);
    const overdue = await unitEnding('2027-06-01');
    const today = await unitEnding(TODAY);
    const month = await unitEnding('2027-07-10');
    const later = await unitEnding('2027-09-01');
    const beyond = await unitEnding('2027-12-01');
    const heldHole = await newHole();
    const held = await unitEnding('2027-06-02', heldHole);
    const placed = await h.send(
      'post',
      '/api/retention/holds',
      {
        projectId: h.projects.b,
        scope: 'units',
        unitIds: [held.id],
        holdUntil: '2027-06-30',
        reason: 'Claim review',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);

    const coming = await pipeline('tab=coming');
    expect(rowOf(coming, overdue.id)).toMatchObject({ band: 'overdue', eligible: true });
    expect(rowOf(coming, today.id)).toMatchObject({ band: 'overdue', eligible: true });
    expect(rowOf(coming, month.id)).toMatchObject({ band: 'month', eligible: false });
    expect(rowOf(coming, later.id)).toMatchObject({ band: 'later', eligible: false });
    expect(rowOf(coming, beyond.id)).toBeUndefined();
    expect(rowOf(coming, held.id)).toMatchObject({
      band: 'overdue',
      eligible: false,
      hold: { count: 1, holdUntil: '2027-06-30', reason: 'Claim review' },
    });
    // Rows come Overdue first, then Within 30 days, then Within 90 days.
    const bands = coming.rows.map((r) => r.band);
    expect(bands.indexOf('later')).toBeGreaterThan(bands.lastIndexOf('overdue'));

    // The Eligible tab is the same rule and its count matches the tagged Overdue rows.
    const eligible = await pipeline('tab=eligible');
    const ids = eligible.rows.map((r) => r.storageUnitId);
    expect(ids).toEqual(expect.arrayContaining([overdue.id, today.id]));
    expect(ids).not.toContain(held.id);
    const tagged = coming.rows.filter((r) => r.band === 'overdue' && r.eligible).length;
    expect(eligible.counts.eligible).toBe(tagged);
    expect(eligible.total).toBe(eligible.counts.eligible);

    // A hold "until" a date never releases itself (choice made, STRATA-91).
    at('2027-07-05');
    expect(rowOf(await pipeline(`tab=coming&search=${held.readableId}`), held.id)).toMatchObject({
      eligible: false,
      hold: { holdUntil: '2027-06-30' },
    });
    expect((await pipeline(`tab=eligible&search=${held.readableId}`)).total).toBe(0);
  });

  it('filters, search and sort are applied on the server; counts stay unfiltered', async () => {
    at(TODAY);
    const a = await unitEnding('2027-06-10');
    const b = await unitEnding('2027-07-01');
    const all = await pipeline('tab=coming');
    const overdueOnly = await pipeline('tab=coming&filter=overdue');
    expect(rowOf(overdueOnly, a.id)).toBeDefined();
    expect(rowOf(overdueOnly, b.id)).toBeUndefined();
    expect(overdueOnly.bandCounts.month).toBe(0);
    expect(overdueOnly.counts).toEqual(all.counts);
    const searched = await pipeline(`tab=coming&search=${b.readableId.toLowerCase()}`);
    expect(searched.rows.map((r) => r.readableId)).toEqual([b.readableId]);
    // Jordan leads nothing: "Projects I lead" leaves nothing.
    expect((await pipeline('tab=coming&filter=mine', 'js')).total).toBe(0);
    expect((await pipeline('tab=coming&filter=mine', 'pe')).total).toBeGreaterThan(0);
    const byId = await pipeline('tab=coming&sort=id&dir=desc');
    const overdueIds = byId.rows.filter((r) => r.band === 'overdue').map((r) => r.readableId);
    expect(overdueIds).toEqual([...overdueIds].sort().reverse());
    const otherProject = await pipeline(`tab=coming&projectId=${h.projects.a}`);
    expect(rowOf(otherProject, a.id)).toBeUndefined();
    expect(rowOf(await pipeline(`tab=coming&projectId=${h.projects.b}`), a.id)).toBeDefined();
    expect((await h.get('/api/retention/pipeline?tab=nope', 'pe')).status).toBe(400);
  });

  it('an open program tags the row and blocks the disposal list; tested units sit apart from the bands', async () => {
    at(TODAY);
    const hole = await newHole();
    const covered = await unitEnding('2027-06-01', hole);
    const tube = await h.tube({ project: 'b', holeId: hole, sampleReference: 'T1' });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    const status = (body: Record<string, unknown>, as: As) =>
      h.send(
        'post',
        `/api/test-requests/${requestId}/status`,
        { idempotencyKey: newKey(), ...body },
        as,
      );
    expect((await status({ to: 'in_progress', version: 1 }, 'tech')).status).toBe(200);
    const done = await status(
      {
        to: 'completed',
        version: 2,
        testedStorageUnitIds: [tube.id],
        actingStaffUserId: h.users.js,
      },
      'lab',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const coming = await pipeline('tab=coming');
    expect(rowOf(coming, covered.id)).toMatchObject({ programOpen: true, eligible: false });
    expect(rowOf(coming, tube.id)).toBeUndefined();
    expect(coming.tested.map((t) => t.storageUnitId)).toContain(tube.id);
    expect(coming.counts.tested).toBeGreaterThanOrEqual(1);

    const drawer = retentionDecisionUnitsSchema.parse(
      (await h.get(`/api/retention/decision-units?ids=${covered.id},${tube.id}`, 'pe')).body,
    );
    const byId = new Map(drawer.units.map((u) => [u.storageUnitId, u]));
    expect(byId.get(covered.id)!.listBlockers.map((b) => b.code)).toContain('program_open');
    expect(byId.get(tube.id)!.listBlockers.map((b) => b.code)).toContain('retention_exempt');
    expect(byId.get(covered.id)).toMatchObject({
      minimumRetainUntil: '2027-06-01',
      effectiveRetainUntil: '2027-06-01',
      canDecide: true,
    });

    const listed = retentionDecisionResultSchema.parse(
      (await decide({ action: 'dispose', units: await units(covered.id, tube.id) })).body,
    );
    expect(listed.done).toEqual([]);
    expect(Object.fromEntries(listed.failed.map((f) => [f.storageUnitId, f.code]))).toEqual({
      [covered.id]: 'not_eligible',
      [tube.id]: 'not_eligible',
    });
  });

  it('extend: per-unit version checks and STRATA-113 (never earlier than the current retain-until)', async () => {
    at(TODAY);
    const hole = await newHole();
    const plain = await unitEnding('2027-06-20', hole);
    const extended = await unitEnding('2027-06-20', hole);
    const stale = await unitEnding('2027-06-20', hole);
    const first = await decide({
      action: 'extend',
      units: await units(extended.id),
      retainUntil: '2029-01-31',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const staleUnits = [{ id: stale.id, version: (await version(stale.id)) - 1 }];
    const result = retentionDecisionResultSchema.parse(
      (
        await decide({
          action: 'extend',
          units: [...(await units(plain.id, extended.id)), ...staleUnits],
          extendMonths: 12,
        })
      ).body,
    );
    expect(result.done.map((d) => d.storageUnitId)).toEqual([plain.id]);
    expect(Object.fromEntries(result.failed.map((f) => [f.storageUnitId, f.code]))).toEqual({
      [extended.id]: 'retain_until_too_early',
      [stale.id]: 'changed',
    });
    const after = storageUnitRetentionSchema.parse(
      (await h.get(`/api/storage-units/${plain.id}/retention`, 'pe')).body,
    );
    expect(after.retention.effectiveRetainUntil).toBe('2028-06-20');

    // The direct routes refuse it as a whole (422), and so does a request.
    const direct = await h.send(
      'post',
      '/api/retention/extensions',
      {
        projectId: h.projects.b,
        scope: 'units',
        unitIds: [extended.id],
        retainUntil: '2028-01-01',
        reason: 'Shorter',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    expect(direct.status).toBe(422);
    expect(direct.body).toMatchObject({
      code: 'retain_until_too_early',
      units: [{ storageUnitId: extended.id, effectiveRetainUntil: '2029-01-31' }],
    });
    const asked = await h.send(
      'post',
      '/api/retention/requests',
      {
        kind: 'extension',
        projectId: h.projects.b,
        scope: 'units',
        unitIds: [extended.id],
        extendMonths: 1,
        reason: 'Shorter',
        idempotencyKey: newKey(),
      },
      'tech',
    );
    expect(asked.status).toBe(422);
    // A whole-project extension earlier than any unit's date fails per unit, nothing placed.
    const project = retentionDecisionResultSchema.parse(
      (await decide({ action: 'extend', projectId: h.projects.b, extendMonths: 1 })).body,
    );
    expect(project.created).toEqual([]);
    expect(project.failed.map((f) => f.storageUnitId)).toContain(extended.id);
  });

  it('hold with a date, by request: the requester asks, the lead approves; the date is kept', async () => {
    at(TODAY);
    const unit = await unitEnding('2027-06-20');
    const asked = await h.send(
      'post',
      '/api/retention/requests',
      {
        kind: 'hold',
        projectId: h.projects.b,
        scope: 'units',
        unitIds: [unit.id],
        holdUntil: '2027-12-31',
        reason: 'Client may ask for more tests',
        idempotencyKey: newKey(),
      },
      'tech',
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(rowOf(await pipeline(`tab=coming&search=${unit.readableId}`), unit.id)).toMatchObject({
      requestWaiting: true,
    });
    const approved = await h.send(
      'post',
      `/api/retention/requests/${asked.body.requestId}/approve`,
      { idempotencyKey: newKey() },
      'pe',
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const view = storageUnitRetentionSchema.parse(
      (await h.get(`/api/storage-units/${unit.id}/retention`, 'pe')).body,
    );
    expect(view.holds[0]).toMatchObject({ active: true, holdUntil: '2027-12-31' });
    // An extension request can't carry a hold date.
    const bad = await h.send(
      'post',
      '/api/retention/requests',
      {
        kind: 'extension',
        projectId: h.projects.b,
        scope: 'units',
        unitIds: [unit.id],
        extendMonths: 24,
        holdUntil: '2027-12-31',
        reason: 'x',
        idempotencyKey: newKey(),
      },
      'tech',
    );
    expect(bad.status).toBe(400);
  });

  it('disposal list: add, approve (leaves the list), revoke (back on the list), remove with a reason', async () => {
    at(TODAY);
    const hole = await newHole();
    const one = await unitEnding('2027-06-01', hole);
    const two = await unitEnding('2027-06-01', hole);
    const before = (await pipeline('tab=list')).counts;
    const key = newKey();
    const body = { action: 'dispose', units: await units(one.id, two.id), reason: 'Report issued' };
    const added = await decide({ ...body, idempotencyKey: key });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.done).toHaveLength(2);
    // Retrying the same key repeats nothing.
    const again = await decide({ ...body, idempotencyKey: key });
    expect(again.body.done).toHaveLength(2);
    expect(
      (
        await h.db.pool.query(
          'SELECT 1 FROM disposal_list_entry WHERE storage_unit_id = ANY($1::uuid[])',
          [[one.id, two.id]],
        )
      ).rowCount,
    ).toBe(2);
    // Being on the list changes nothing about the unit.
    const { rows } = await h.db.pool.query<{ status: string }>(
      'SELECT status FROM storage_unit WHERE id = $1',
      [one.id],
    );
    expect(rows[0]!.status).toBe('in_stock');

    let list = await pipeline('tab=list');
    expect(list.counts.list).toBe(before.list + 2);
    expect(list.counts.eligible).toBe(before.eligible - 2);
    expect(rowOf(list, one.id)).toMatchObject({
      listEntry: { reason: 'Report issued', addedBy: { userId: h.users.pe } },
      canApprove: true,
    });
    expect(rowOf(await pipeline('tab=coming'), one.id)).toBeUndefined();
    // Already listed: fails on its own.
    const dup = retentionDecisionResultSchema.parse(
      (await decide({ action: 'dispose', units: await units(one.id) })).body,
    );
    expect(dup.failed[0]).toMatchObject({ code: 'already_on_list' });

    // Approve: leaves the list for Approved.
    const approved = await h.send(
      'post',
      '/api/disposal/approvals',
      { unitIds: [one.id], idempotencyKey: newKey() },
      'pe',
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    list = await pipeline('tab=approved');
    expect(rowOf(list, one.id)).toMatchObject({ status: 'approved_for_disposal' });
    expect(rowOf(list, one.id)!.approval).not.toBeNull();
    expect(rowOf(await pipeline('tab=list'), one.id)).toBeUndefined();

    // Revoke: back on the list, still in stock.
    const revoked = await h.send(
      'post',
      `/api/disposal/approvals/${approved.body.approvals[0].id}/revoke`,
      { reason: 'Client wants it kept', idempotencyKey: newKey() },
      'pe',
    );
    expect(revoked.status).toBe(200);
    expect(rowOf(await pipeline('tab=list'), one.id)).toMatchObject({
      status: 'in_stock',
      listEntry: { reason: 'Client wants it kept' },
    });

    // Remove: reason required; back in Eligible.
    const noReason = await h.send(
      'post',
      '/api/disposal/list/remove',
      { unitIds: [one.id, two.id], reason: ' ', idempotencyKey: newKey() },
      'lm',
    );
    expect(noReason.status).toBe(400);
    const removed = await h.send(
      'post',
      '/api/disposal/list/remove',
      { unitIds: [one.id, two.id], reason: 'Decided to keep', idempotencyKey: newKey() },
      'lm',
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.removed).toHaveLength(2);
    const eligible = await pipeline('tab=eligible');
    expect(eligible.rows.map((r) => r.storageUnitId)).toEqual(
      expect.arrayContaining([one.id, two.id]),
    );
  });

  it('refuses direct calls: requesters, LAB, other projects; nothing changes', async () => {
    at(TODAY);
    const unit = await unitEnding('2027-06-01');
    const entries = async () =>
      (await h.db.pool.query('SELECT 1 FROM disposal_list_entry')).rowCount;
    const holds = async () => (await h.db.pool.query('SELECT 1 FROM retention_hold')).rowCount;
    const [entriesBefore, holdsBefore] = [await entries(), await holds()];
    for (const as of ['tech', 'js', 'lab', 'admin'] as const) {
      for (const action of ['dispose', 'hold'] as const) {
        const response = await decide({ action, units: await units(unit.id) }, as);
        expect(response.status, `${as} ${action}`).toBe(403);
      }
      const removed = await h.send(
        'post',
        '/api/disposal/list/remove',
        { unitIds: [unit.id], reason: 'x', idempotencyKey: newKey() },
        as,
      );
      expect(removed.status, as).toBe(403);
    }
    // Requesters see the units but can't decide.
    const view = retentionDecisionUnitsSchema.parse(
      (await h.get(`/api/retention/decision-units?ids=${unit.id}`, 'tech')).body,
    );
    expect(view.units[0]).toMatchObject({ canDecide: false, canApprove: false });
    expect(view.canRequest).toBe(true);
    expect(await entries()).toBe(entriesBefore);
    expect(await holds()).toBe(holdsBefore);
  });
});
