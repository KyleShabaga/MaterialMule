import {
  actionRequestListSchema,
  inventoryPageSchema,
  labProgramReviewSchema,
  labProgramSchema,
  projectRetentionSchema,
  storageUnitRetentionSchema,
  type LabProgram,
} from '@materialmule/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { BusinessClock } from './business-clock.js';

// MM-T29 retention (card AC1–AC9, test plan T1–T4, T6–T8) through the real API and the one
// database calculation (unit_retention). Tested-unit evidence comes from the real MM-T24 route.
// Fictional data only: DEMO-2601 (A, Lead Project Engineer Pat Example `pe`) and DEMO-2602 (B, also `pe`); Lee
// Manager (`lm`) Lab Manager; Alex Tester (`tech`) Technician; Jordan Smith (`js`).
describe.runIf(testDatabaseUrl)('retention (MM-T29)', () => {
  let h: LabHarness;
  let moisture: string;
  let clock: BusinessClock;
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

  const status = (id: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send('post', `/api/test-requests/${id}/status`, { idempotencyKey: newKey(), ...body }, as);

  /** Real MM-T24 completion by a LAB station for Jordan Smith, linking exactly `units`. */
  async function complete(requestId: string, units: string[]) {
    expect((await status(requestId, { to: 'in_progress', version: 1 })).status).toBe(200);
    const done = await status(
      requestId,
      { to: 'completed', version: 2, testedStorageUnitIds: units, actingStaffUserId: h.users.js },
      'lab',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }

  async function unitRetention(id: string, as: As = 'tech') {
    const response = await h.get(`/api/storage-units/${id}/retention`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return storageUnitRetentionSchema.parse(response.body);
  }

  async function projectRetention(project: 'a' | 'b', as: As = 'tech') {
    const response = await h.get(`/api/projects/${h.projects[project]}/retention`, as);
    expect(response.status).toBe(200);
    return projectRetentionSchema.parse(response.body);
  }

  const hold = (body: Record<string, unknown>, as: As = 'lm', key = newKey()) =>
    h.send(
      'post',
      '/api/retention/holds',
      {
        projectId: h.projects.a,
        scope: 'project',
        reason: 'Claim review',
        idempotencyKey: key,
        ...body,
      },
      as,
    );
  const extend = (body: Record<string, unknown>, as: As = 'pe', key = newKey()) =>
    h.send(
      'post',
      '/api/retention/extensions',
      {
        projectId: h.projects.a,
        scope: 'project',
        reason: 'Client asked',
        idempotencyKey: key,
        ...body,
      },
      as,
    );
  const release = (
    kind: 'holds' | 'extensions',
    id: string,
    version: number,
    as: As = 'lm',
    key = newKey(),
  ) =>
    h.send(
      'post',
      `/api/retention/${kind}/${id}/release`,
      { reason: 'Claim settled', version, idempotencyKey: key },
      as,
    );

  async function releaseAllHolds() {
    const { rows } = await h.db.pool.query<{ id: string; version: number }>(
      `SELECT id, version FROM retention_hold WHERE released_at IS NULL`,
    );
    for (const row of rows) expect((await release('holds', row.id, row.version)).status).toBe(200);
  }

  const count = async (sql: string, params: unknown[] = []) =>
    (await h.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('MC', 'Moisture content', 'Moisture')).id;
    clock = h.app.get(BusinessClock);
  }, 60_000);

  afterEach(async () => {
    await releaseAllHolds();
    clock.set(null);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('T1/AC1: minimum = received + 1 calendar year, date-eligible on that date itself; Feb 29 → Feb 28', async () => {
    const hole = await newHole();
    const unit = await h.bucket({ hole, receivedDate: '2026-10-23' });
    at('2027-10-22');
    let r = (await unitRetention(unit.id)).retention;
    expect(r).toMatchObject({
      receivedDate: '2026-10-23',
      minimumRetainUntil: '2027-10-23',
      effectiveRetainUntil: '2027-10-23',
      eligibleByDate: false,
      onHold: false,
      retentionExempt: false,
      asOf: '2027-10-22',
    });
    at('2027-10-23');
    r = (await unitRetention(unit.id)).retention;
    expect(r.eligibleByDate).toBe(true);
    const leap = await h.bucket({ hole, receivedDate: '2024-02-29' });
    expect((await unitRetention(leap.id)).retention.minimumRetainUntil).toBe('2025-02-28');
    const leapToLeap = await h.bucket({ hole, receivedDate: '2027-02-28' });
    expect((await unitRetention(leapToLeap.id)).retention.minimumRetainUntil).toBe('2028-02-28');
  });

  it('T4/AC2: a received-date correction recomputes retain-until at once and keeps both dates in history', async () => {
    const unit = await h.bucket({ hole: await newHole(), receivedDate: '2026-10-23' });
    expect((await unitRetention(unit.id)).retention.minimumRetainUntil).toBe('2027-10-23');
    const corrected = await h.send(
      'patch',
      `/api/storage-units/${unit.id}`,
      {
        version: 1,
        reason: 'Wrong date typed at receiving',
        changes: { receivedDate: '2026-10-21' },
      },
      'tech',
    );
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect((await unitRetention(unit.id)).retention.minimumRetainUntil).toBe('2027-10-21');
    const history = await h.get(`/api/storage-units/${unit.id}/history`, 'tech');
    expect(JSON.stringify(history.body)).toContain('2026-10-23');
    expect(JSON.stringify(history.body)).toContain('2026-10-21');
  });

  it('T2/AC3: a project-wide hold covers current and later units; release records who, when and why', async () => {
    const hole = await newHole();
    const before = await h.bucket({ hole });
    const placed = await hold({ reason: 'Claim review' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const later = await h.bucket({ hole, receivedDate: '2026-11-02' });
    for (const id of [before.id, later.id]) {
      const view = await unitRetention(id);
      expect(view.retention.onHold, id).toBe(true);
      expect(view.holds[0]).toMatchObject({
        active: true,
        reason: 'Claim review',
        scope: 'project',
      });
      expect(view.holds[0]!.placedBy.name).toBe('Lee Manager');
    }
    // Another project's unit isn't covered.
    const other = await h.bucket({ project: 'b', hole: h.holes.b1 });
    expect((await unitRetention(other.id)).retention.onHold).toBe(false);

    const released = await release('holds', placed.body.id, 1, 'pe');
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const view = await unitRetention(later.id);
    expect(view.retention.onHold).toBe(false);
    expect(view.holds[0]).toMatchObject({
      active: false,
      releaseReason: 'Claim settled',
      releasedBy: { name: 'Pat Example' },
    });
    expect(view.holds[0]!.releasedAt).not.toBeNull();
    expect(
      await count(`FROM audit_event WHERE action = 'retention.hold_released' AND entity_id = $1`, [
        placed.body.id,
      ]),
    ).toBe(1);
  });

  it('T3/AC4: a Technician is refused and their request creates one shared action item; approval places the hold and resolves it', async () => {
    const hole = await newHole();
    const unit = await h.bucket({ hole });
    const refused = await hold({}, 'tech');
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: 'forbidden' });

    const key = newKey();
    const ask = () =>
      h.send(
        'post',
        '/api/retention/requests',
        {
          kind: 'hold',
          projectId: h.projects.a,
          scope: 'units',
          unitIds: [unit.id],
          reason: 'Client may dispute',
          idempotencyKey: key,
        },
        'tech',
      );
    const asked = await ask();
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect((await ask()).body).toEqual(asked.body); // exact retry
    expect(await count(`FROM retention_request WHERE idempotency_key = $1`, [key])).toBe(1);
    expect((await unitRetention(unit.id)).retention.onHold).toBe(false);

    for (const who of ['pe', 'lm'] as const) {
      const items = actionRequestListSchema.parse(
        (await h.get('/api/action-items', who)).body,
      ).items;
      expect(
        items.find((i) => i.id === asked.body.actionItemId),
        who,
      ).toMatchObject({
        kind: 'retention_request',
        title: 'Hold requested for DEMO-2601 · 1 unit',
        routeTag: 'LM · Lead Project Engineer',
        href: `/projects/${h.projects.a}#retention`,
        reason: 'Client may dispute',
      });
    }
    // The requester can't decide it.
    const self = await h.send(
      'post',
      `/api/retention/requests/${asked.body.requestId}/approve`,
      { idempotencyKey: newKey() },
      'tech',
    );
    expect(self.status).toBe(403);

    const approved = await h.send(
      'post',
      `/api/retention/requests/${asked.body.requestId}/approve`,
      { idempotencyKey: newKey() },
      'lm',
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await unitRetention(unit.id)).retention.onHold).toBe(true);
    const again = await h.send(
      'post',
      `/api/retention/requests/${asked.body.requestId}/decline`,
      { reason: 'No', idempotencyKey: newKey() },
      'pe',
    );
    expect(again.status).toBe(409);
    for (const who of ['pe', 'lm'] as const) {
      const resolved = actionRequestListSchema
        .parse((await h.get('/api/action-items?status=resolved', who)).body)
        .items.find((i) => i.id === asked.body.actionItemId);
      expect(resolved, who).toMatchObject({
        status: 'resolved',
        resolution: 'approved',
        resolvedBy: { name: 'Lee Manager' },
      });
    }
    const project = await projectRetention('a');
    expect(project.requests.find((r) => r.id === asked.body.requestId)).toMatchObject({
      status: 'approved',
      decidedBy: { name: 'Lee Manager' },
    });
    expect(project.holds.find((x) => x.fromRequestId === asked.body.requestId)).toMatchObject({
      active: true,
      scope: 'units',
      placedBy: { name: 'Lee Manager' },
    });

    // Decline: needs a reason, changes nothing, resolves the item.
    const second = await h.send(
      'post',
      '/api/retention/requests',
      {
        kind: 'extension',
        projectId: h.projects.a,
        scope: 'project',
        extendMonths: 12,
        reason: 'Might need it',
        idempotencyKey: newKey(),
      },
      'js',
    );
    expect(second.status).toBe(201);
    const noReason = await h.send(
      'post',
      `/api/retention/requests/${second.body.requestId}/decline`,
      { idempotencyKey: newKey() },
      'pe',
    );
    expect(noReason.status).toBe(400);
    const declined = await h.send(
      'post',
      `/api/retention/requests/${second.body.requestId}/decline`,
      { reason: 'Standard retention is enough', idempotencyKey: newKey() },
      'pe',
    );
    expect(declined.status).toBe(200);
    expect(
      await count(`FROM retention_extension WHERE request_id = $1`, [second.body.requestId]),
    ).toBe(0);
    expect(
      await count(`FROM action_item WHERE id = $1 AND resolution = 'declined'`, [
        second.body.actionItemId,
      ]),
    ).toBe(1);
  });

  it('T2/AC5: an extension to 2028-06-30 on two selected units changes only those units', async () => {
    const hole = await newHole();
    const [x, y, z] = [
      await h.bucket({ hole }),
      await h.bucket({ hole }),
      await h.bucket({ hole }),
    ];
    const set = await extend({ scope: 'units', unitIds: [x.id, y.id], retainUntil: '2028-06-30' });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    for (const id of [x.id, y.id]) {
      expect((await unitRetention(id)).retention.effectiveRetainUntil).toBe('2028-06-30');
    }
    expect((await unitRetention(z.id)).retention.effectiveRetainUntil).toBe('2027-10-23');
    // A months extension adds to each unit's own minimum; the latest active one wins.
    const months = await extend({ scope: 'units', unitIds: [z.id], extendMonths: 6 });
    expect((await unitRetention(z.id)).retention.effectiveRetainUntil).toBe('2028-04-23');
    expect((await release('extensions', months.body.id, 1, 'lm')).status).toBe(200);
    expect((await unitRetention(z.id)).retention.effectiveRetainUntil).toBe('2027-10-23');
    // Units of another project can't be chosen.
    const foreign = await h.bucket({ project: 'b', hole: h.holes.b1 });
    const wrong = await extend({
      scope: 'units',
      unitIds: [foreign.id],
      retainUntil: '2028-06-30',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('unit_not_in_project');
    await release('extensions', set.body.id, 1, 'lm');
  });

  it('AC6: closing a program changes no retain-until date', async () => {
    const hole = await newHole();
    const unit = await h.bucket({ hole });
    const program = await submitted(hole);
    const before = (await unitRetention(unit.id)).retention;
    const testId = program.lines[0]!.requests[0]!.id;
    const cancel = await h.send(
      'post',
      `/api/test-requests/${testId}/cancel`,
      { reason: 'Not needed', version: 1, idempotencyKey: newKey() },
      'pe',
    );
    expect(cancel.status).toBe(200);
    const version = (
      await h.db.pool.query<{ version: number }>('SELECT version FROM lab_program WHERE id = $1', [
        program.id,
      ])
    ).rows[0]!.version;
    const closed = await h.send(
      'post',
      `/api/lab-programs/${program.id}/close`,
      { version, idempotencyKey: newKey() },
      'pe',
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await unitRetention(unit.id)).retention).toEqual(before);
  });

  it('T6/AC7: exact-unit tested tube and tested bulk bucket are exempt; untested tube, ordinary bucket and the sibling are not; no hold is released', async () => {
    const hole = await newHole();
    const tested = await h.tube({ holeId: hole, sampleReference: 'T1' });
    const untested = await h.tube({ holeId: hole, sampleReference: 'T2' });
    const bucket = await h.bucket({ hole });
    const group = await h.bulkGroup({
      holeId: hole,
      sampleReference: 'B1',
      depthFrom: 1.5,
      buckets: 2,
    });
    const [bktA, bktB] = group.members;
    const placed = await hold({ reason: 'Claim review' });
    const ext = await extend({ retainUntil: '2030-01-01' });
    expect([placed.status, ext.status]).toEqual([201, 201]);

    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    await complete(requestId, [tested.id, bktA!.id]);

    for (const id of [tested.id, bktA!.id]) {
      const view = await unitRetention(id);
      expect(view.retention, id).toMatchObject({ retentionExempt: true, onHold: true });
      expect(view.retention.effectiveRetainUntil).toBe('2030-01-01'); // history, not a gate
    }
    for (const id of [untested.id, bucket.id, bktB!.id]) {
      expect((await unitRetention(id)).retention, id).toMatchObject({
        retentionExempt: false,
        onHold: true,
        effectiveRetainUntil: '2030-01-01',
      });
    }
    // BKT-A uses the T36 route despite the hold, extension, future date and open program.
    const removed = await h.send(
      'post',
      `/api/storage-units/${bktA!.id}/tested-removal`,
      {
        testRequestId: requestId,
        confirmPhysicalRemoval: true,
        version: 1,
        idempotencyKey: newKey(),
      },
      'tech',
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    // The project hold stays active and still covers BKT-B and everything else.
    expect(
      await count(`FROM retention_hold WHERE id = $1 AND released_at IS NULL`, [placed.body.id]),
    ).toBe(1);
    const sibling = await unitRetention(bktB!.id);
    expect(sibling.retention).toMatchObject({ onHold: true, retentionExempt: false });
    const { rows } = await h.db.pool.query<{ status: string; current_location_id: string }>(
      'SELECT status, current_location_id FROM storage_unit WHERE id = $1',
      [bktB!.id],
    );
    expect(rows[0]!.status).toBe('in_stock');
    await release('extensions', ext.body.id, 1, 'lm');
  });

  it('T7/AC8: two LAB stations, whoever they select, can neither manage nor request retention; refresh shows a personal decision', async () => {
    const unit = await h.bucket({ hole: await newHole() });
    const [stationA, stationB] = [await h.cookie('lab'), await h.cookie('lab')];
    const placed = await hold({ reason: 'Manager hold' }, 'lm');
    expect(placed.status).toBe(201);
    for (const [station, person] of [
      [stationA, h.users.lm],
      [stationB, h.users.pe],
    ] as const) {
      const attempts = [
        await hold({ actingStaffUserId: person }, station),
        await extend({ retainUntil: '2029-01-01', actingStaffUserId: person }, station),
        await h.send(
          'post',
          `/api/retention/holds/${placed.body.id}/release`,
          { reason: 'x', version: 1, idempotencyKey: newKey(), actingStaffUserId: person },
          station,
        ),
        await h.send(
          'post',
          '/api/retention/requests',
          {
            kind: 'hold',
            projectId: h.projects.a,
            scope: 'project',
            reason: 'x',
            idempotencyKey: newKey(),
          },
          station,
        ),
      ];
      expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403]);
      const view = await unitRetention(unit.id, station);
      expect(view).toMatchObject({ canManage: false, canRequest: false });
      expect(view.retention.onHold).toBe(true);
    }
  });

  it('T8/AC9: concurrent decisions keep separate history; a stale or second release gets 409', async () => {
    const unit = await h.bucket({ hole: await newHole() });
    const [one, two] = await Promise.all([
      hold({ reason: 'Claim A' }, 'lm'),
      hold({ reason: 'Claim B' }, 'pe'),
    ]);
    expect([one.status, two.status]).toEqual([201, 201]);
    const [r1, r2] = await Promise.all([
      release('holds', one.body.id, 1, 'lm'),
      release('holds', one.body.id, 1, 'pe'),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const stale = await release('holds', two.body.id, 2, 'lm');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_retention');
    const view = await unitRetention(unit.id);
    expect(view.retention.onHold).toBe(true); // Claim B still holds it
    expect(view.holds.map((x) => [x.reason, x.active])).toEqual(
      expect.arrayContaining([
        ['Claim A', false],
        ['Claim B', true],
      ]),
    );
    expect(
      await count(`FROM audit_event WHERE action = 'retention.hold_released' AND entity_id = $1`, [
        one.body.id,
      ]),
    ).toBe(1);
    // Retrying the winning release returns the same result, nothing new.
    const key = newKey();
    expect((await release('holds', two.body.id, 1, 'lm', key)).status).toBe(200);
    expect((await release('holds', two.body.id, 1, 'lm', key)).status).toBe(200);
    expect(
      await count(`FROM audit_event WHERE action = 'retention.hold_released' AND entity_id = $1`, [
        two.body.id,
      ]),
    ).toBe(1);
  });

  it('inventory: retention columns and On hold / Eligible by date filters use the same calculation', async () => {
    const hole = await newHole('b');
    const old = await h.bucket({ project: 'b', hole, receivedDate: '2025-01-10' });
    const fresh = await h.bucket({ project: 'b', hole, receivedDate: '2026-10-20' });
    at('2026-10-27');
    const eligible = inventoryPageSchema.parse(
      (
        await h.get(
          `/api/inventory?projectId=${h.projects.b}&retention=eligible_by_date&pageSize=100`,
          'tech',
        )
      ).body,
    );
    const ids = eligible.items.map((i) => i.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(fresh.id);
    expect(eligible.items.find((i) => i.id === old.id)!.retention).toEqual({
      effectiveRetainUntil: '2026-01-10',
      onHold: false,
      eligibleByDate: true,
      retentionExempt: false,
    });
    const placed = await hold({ projectId: h.projects.b, scope: 'units', unitIds: [fresh.id] });
    expect(placed.status).toBe(201);
    const onHold = inventoryPageSchema.parse(
      (await h.get(`/api/inventory?projectId=${h.projects.b}&retention=on_hold`, 'lab')).body,
    );
    expect(onHold.items.map((i) => i.id)).toEqual([fresh.id]);
  });

  it('database rules: release once, no deletes, selected units from the project only', async () => {
    const unit = await h.bucket({ hole: await newHole() });
    const placed = await hold({ scope: 'units', unitIds: [unit.id] });
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
    expect(await fails('DELETE FROM retention_hold WHERE id = $1', [placed.body.id])).toBe('23001');
    expect(
      await fails(`UPDATE retention_hold SET reason = 'changed' WHERE id = $1`, [placed.body.id]),
    ).toBe('23001');
    expect(
      await fails('DELETE FROM retention_hold_unit WHERE hold_id = $1', [placed.body.id]),
    ).not.toBeNull();
    const foreign = await h.bucket({ project: 'b', hole: h.holes.b1 });
    expect(
      await fails('INSERT INTO retention_hold_unit (hold_id, storage_unit_id) VALUES ($1, $2)', [
        placed.body.id,
        foreign.id,
      ]),
    ).toBe('retention_scope_unit_matches');
    expect((await release('holds', placed.body.id, 1)).status).toBe(200);
    expect(
      await fails(
        `UPDATE retention_hold SET released_at = now(), version = version + 1 WHERE id = $1`,
        [placed.body.id],
      ),
    ).toBe('23001');
  });
});
