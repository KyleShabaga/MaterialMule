import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteRescheduleResultSchema,
  concreteScheduleHistorySchema,
  concreteSpecimenSetDetailSchema,
  concreteWorklistSchema,
  projectCapabilitiesSchema,
  type ConcreteSpecimenSetDetail,
  type ConcreteWorklist,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-V2-C22: the daily concrete lab worklist and authorized rescheduling (card AC1–AC3; test
// plan T2). Real PostgreSQL, direct API calls, `on=` fixing the business date. Fictional data
// only: DEMO-2601 (A) and DEMO-2602 (B), both led by Pat Example `pe`; Lee Manager `lm` is a Lab
// Manager. Permanent numbers are attached with SQL, standing in for C18's allocator.
describe.runIf(testDatabaseUrl)('concrete lab worklist (MM-V2-C22)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab' | 'anonymous';

  const get = async (url: string, as: Caller = 'tech') => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  const send = async (method: 'post' | 'patch', url: string, body: unknown, as: Caller) => {
    const req = h.http()[method](url).set(CSRF_HEADER, '1');
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req.send(body as object);
  };

  async function worklist(query: string, as: Caller = 'tech'): Promise<ConcreteWorklist> {
    const response = await get(`/api/concrete/lab-worklist?${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteWorklistSchema.parse(response.body);
  }
  const ids = (list: ConcreteWorklist) =>
    list.groups.flatMap((g) => g.rows.map((r) => r.identity.permanentId ?? r.specimenId));

  async function castSet(projectId: string, castAt: string): Promise<ConcreteSpecimenSetDetail> {
    const report = await send(
      'post',
      `/api/concrete/projects/${projectId}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', specimensCast: true, castAt },
      'tech',
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
    const set = await send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      'tech',
    );
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(set.body);
  }

  let numberCounter = 0;
  async function attachNumber(set: ConcreteSpecimenSetDetail) {
    numberCounter += 1;
    const permanentId = `26-${String(numberCounter).padStart(2, '0')}`;
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [set.id, numberCounter, permanentId],
    );
    return permanentId;
  }

  async function snapshot() {
    const { rows } = await h.db.pool.query(
      `SELECT id, assigned_age, target_date::text, hold_expires_on::text, version
       FROM concrete_specimen ORDER BY id`,
    );
    const { rows: tallies } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_specimen_reschedule) AS reschedules,
              (SELECT count(*)::int FROM audit_event WHERE entity_type = 'concrete_specimen')
                AS audit`,
    );
    return { specimens: rows, ...(tallies[0] as { reschedules: number; audit: number }) };
  }

  const reschedulePath = (id: string) => `/api/concrete/specimens/${id}/reschedule`;

  // A: cast Saturday 7 Nov 2026 → 7 d Sat 14 Nov, 28 d Sat 5 Dec (B, C), HOLD 56 d Sat 2 Jan 2027.
  // B: cast Monday 2 Nov 2026 → 7 d 9 Nov, 28 d 30 Nov (B, C), HOLD 28 Dec 2026.
  let a: ConcreteSpecimenSetDetail;
  let b: ConcreteSpecimenSetDetail;
  let aId: string;
  let bId: string;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    a = await castSet(h.projects.a, '2026-11-07T08:00:00-06:00');
    b = await castSet(h.projects.b, '2026-11-02T09:15:00-06:00');
    aId = await attachNumber(a);
    bId = await attachNumber(b);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC1: Today defaults on, groups by project with counts, and keeps a Saturday target flagged', async () => {
    const list = await worklist('on=2026-12-05');
    expect(list.view).toBe('today');
    expect(list.today).toBe('2026-12-05');
    expect(list.upcomingThrough).toBe('2026-12-12');
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0]).toMatchObject({
      projectId: h.projects.a,
      projectNumber: 'DEMO-2601',
      count: 2,
      canReschedule: false,
    });
    expect(ids(list)).toEqual([`${aId}B`, `${aId}C`]);
    for (const row of list.groups[0]!.rows) {
      expect(row).toMatchObject({
        assignedAge: 28,
        castingDate: '2026-11-07',
        targetDate: '2026-12-05',
        holdExpiresOn: null,
        daysOverdue: null,
        reschedulable: true,
      });
      // Saturday stays Saturday, flagged; nothing moves it to Friday or Monday.
      expect(row.flags).toContain('weekend_target');
    }
    expect(list.counts).toMatchObject({ today: 2, hold: 2, exceptions: 0 });
    expect(list.total).toBe(2);
    expect(list.projects.map((p) => p.projectNumber)).toEqual(['DEMO-2601', 'DEMO-2602']);
  });

  it('AC2: untested specimens past target are Overdue, and reading them changes no target', async () => {
    const before = await snapshot();
    const list = await worklist('view=overdue&on=2026-12-06');
    expect(list.groups.map((g) => [g.projectNumber, g.count])).toEqual([
      ['DEMO-2601', 3],
      ['DEMO-2602', 3],
    ]);
    expect(ids(list)).toEqual([`${aId}A`, `${aId}B`, `${aId}C`, `${bId}A`, `${bId}B`, `${bId}C`]);
    const late = list.groups[1]!.rows[0]!;
    expect(late).toMatchObject({ targetDate: '2026-11-09', daysOverdue: 27 });
    expect(late.flags).toContain('overdue');
    expect(list.counts).toMatchObject({ overdue: 6, today: 0, upcoming: 0 });
    // The same read again, and the stored rows are byte-for-byte as they were.
    await worklist('view=overdue&on=2026-12-06');
    expect(await snapshot()).toEqual(before);
  });

  it('Upcoming covers tomorrow through seven days ahead, across projects', async () => {
    const list = await worklist('view=upcoming&on=2026-11-28');
    expect(list.upcomingThrough).toBe('2026-12-05');
    expect(ids(list)).toEqual([`${aId}B`, `${aId}C`, `${bId}B`, `${bId}C`]);
    // On the 7-day target itself it is Today, not Upcoming.
    const today = await worklist('view=upcoming&on=2026-11-30');
    expect(ids(today)).toEqual([`${aId}B`, `${aId}C`]);
    expect(today.counts.today).toBe(2);
  });

  it('AC3: HOLD shows hold-until and a review flag at expiry; nothing is scheduled automatically', async () => {
    const before = await snapshot();
    const early = await worklist('view=hold&on=2026-12-27');
    expect(early.groups.flatMap((g) => g.rows.map((r) => [r.holdExpiresOn, r.flags]))).toEqual([
      ['2027-01-02', ['report_draft']],
      ['2026-12-28', ['report_draft']],
    ]);
    const due = await worklist('view=hold&on=2027-01-02');
    for (const row of due.groups.flatMap((g) => g.rows)) {
      expect(row).toMatchObject({
        assignedAge: 'HOLD',
        targetDate: null,
        holdKind: 'ordinary',
        reschedulable: false,
      });
      expect(row.flags).toContain('hold_review_due');
    }
    // Past expiry the HOLD stays a HOLD: no target, no test, no disposal, no audit event.
    expect(await snapshot()).toEqual(before);
    const later = await worklist('on=2027-01-02');
    expect(later.counts.today).toBe(0);
  });

  it('filters by project and pages', async () => {
    const list = await worklist(`view=overdue&on=2026-12-06&projectId=${h.projects.b}`);
    expect(list.groups.map((g) => g.projectNumber)).toEqual(['DEMO-2602']);
    expect(list.counts.overdue).toBe(3);
    // The filter list still offers every project.
    expect(list.projects).toHaveLength(2);
    const empty = await worklist('view=overdue&on=2026-12-06&page=2');
    expect(empty.groups).toEqual([]);
    expect(empty.total).toBe(6);
    expect((await get('/api/concrete/lab-worklist?view=later')).status).toBe(400);
    expect((await get('/api/concrete/lab-worklist?on=12/05/2026')).status).toBe(400);
  });

  it('reads with the internal read permission: LAB included, nobody signed out', async () => {
    expect((await worklist('on=2026-12-05', 'lab')).counts.today).toBe(2);
    expect((await get('/api/concrete/lab-worklist', 'anonymous')).status).toBe(401);
  });

  it('a void set or report leaves the worklist', async () => {
    const c = await castSet(h.projects.a, '2026-11-07T15:00:00-06:00');
    expect((await worklist('on=2026-12-05')).counts.today).toBe(4);
    await attachNumber(c);
    await h.db.pool.query(
      `UPDATE concrete_specimen_set
       SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Cast in error' WHERE id = $1`,
      [c.id, h.users.pe],
    );
    expect((await worklist('on=2026-12-05')).counts.today).toBe(2);
  });

  it('Exceptions: empty without a machine; the testing machine calibration flag once it is overdue', async () => {
    const none = await worklist('view=exceptions&on=2026-12-05');
    expect(none).toMatchObject({ testingMachineRegistered: false, exceptions: [], groups: [] });
    const machine = await send(
      'post',
      '/api/concrete/testing-machine',
      { kind: 'testing_machine', make: 'Example', model: 'Press 1', idempotencyKey: newKey() },
      'lm',
    );
    expect(machine.status, JSON.stringify(machine.body)).toBe(201);
    const machineId = (machine.body as { id: string }).id;
    const calibration = await send(
      'post',
      `/api/concrete/testing-machine/${machineId}/calibrations`,
      {
        calibratedOn: '2025-11-01',
        nextDueOn: '2026-11-30',
        performedBy: 'Example Calibration Co.',
        result: 'Within tolerance',
        idempotencyKey: newKey(),
      },
      'lm',
    );
    expect(calibration.status, JSON.stringify(calibration.body)).toBe(201);
    const ok = await worklist('view=exceptions&on=2026-11-29');
    expect(ok).toMatchObject({ testingMachineRegistered: true, exceptions: [] });
    const overdue = await worklist('view=exceptions&on=2026-12-05');
    expect(overdue.counts.exceptions).toBe(1);
    expect(overdue.exceptions).toEqual([
      {
        kind: 'testing_machine',
        equipmentId: machineId,
        label: 'Example Press 1',
        nextDueOn: '2026-11-30',
        flags: ['calibration_overdue'],
      },
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // Rescheduling
  // ---------------------------------------------------------------------------------------------

  it('refuses rescheduling to anyone without the authority, before reading the body', async () => {
    const before = await snapshot();
    const target = a.specimens[1]!.id;
    const body = { idempotencyKey: newKey(), version: 1, newAge: 56, reason: 'Per engineer' };
    for (const caller of ['tech', 'js', 'lab', 'lm'] as const) {
      for (const payload of [body, { bogus: true }]) {
        const response = await send('post', reschedulePath(target), payload, caller);
        expect(response.status, `${caller}`).toBe(403);
      }
    }
    expect((await send('post', reschedulePath(target), body, 'anonymous')).status).toBe(401);
    // An unknown specimen: 404 to someone who could reschedule somewhere, else 403.
    expect((await send('post', reschedulePath(randomUUID()), body, 'pe')).status).toBe(404);
    expect((await send('post', reschedulePath(randomUUID()), body, 'tech')).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('the lead reschedules with a reason: target follows casting, history and audit kept, retries exact-once', async () => {
    const specimen = a.specimens[1]!; // 28 d, 5 Dec 2026
    const before = await snapshot();
    const key = newKey();
    const body = {
      idempotencyKey: key,
      version: 1,
      newAge: 56,
      reason: 'Engineer requested a 56-day break',
    };
    expect(
      (await send('post', reschedulePath(specimen.id), { ...body, reason: ' ' }, 'pe')).status,
    ).toBe(400);
    const response = await send('post', reschedulePath(specimen.id), body, 'pe');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const result = concreteRescheduleResultSchema.parse(response.body);
    expect(result).toMatchObject({
      specimenId: specimen.id,
      identity: { permanentId: `${aId}B` },
      assignedAge: 56,
      castingDate: '2026-11-07',
      // 7 Nov 2026 + 56 days = 2 Jan 2027 (a Saturday: kept and flagged).
      targetDate: '2027-01-02',
      version: 2,
    });
    expect(result.flags).toEqual(expect.arrayContaining(['weekend_target', 'rescheduled']));
    expect(result.history).toEqual([
      expect.objectContaining({
        previousAge: 28,
        newAge: 56,
        previousTargetDate: '2026-12-05',
        newTargetDate: '2027-01-02',
        reason: 'Engineer requested a 56-day break',
        by: { userId: h.users.pe, initials: 'PE', name: 'Pat Example' },
      }),
    ]);
    const after = await snapshot();
    expect(after.reschedules).toBe(before.reschedules + 1);
    expect(after.audit).toBe(before.audit + 1);
    const { rows: audit } = await h.db.pool.query(
      `SELECT action, reason, before_values, after_values FROM audit_event
       WHERE entity_type = 'concrete_specimen' AND entity_id = $1`,
      [specimen.id],
    );
    expect(audit).toEqual([
      {
        action: 'concrete_specimen.rescheduled',
        reason: 'Engineer requested a 56-day break',
        before_values: { version: 1, assignedAge: 28, targetDate: '2026-12-05' },
        after_values: { version: 2, assignedAge: 56, targetDate: '2027-01-02' },
      },
    ]);

    // An exact retry returns the same state with no second change.
    const retry = await send('post', reschedulePath(specimen.id), body, 'pe');
    expect(retry.status).toBe(201);
    expect(concreteRescheduleResultSchema.parse(retry.body).version).toBe(2);
    expect(await snapshot()).toEqual(after);
    // The same key for a different change is refused.
    const reused = await send('post', reschedulePath(specimen.id), { ...body, newAge: 42 }, 'pe');
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'idempotency_key_reused' });
    // A stale version is refused with the current state.
    const stale = await send(
      'post',
      reschedulePath(specimen.id),
      { ...body, idempotencyKey: newKey(), newAge: 42 },
      'pe',
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', current: { version: 2 } });
    // The same age is no change.
    const same = await send(
      'post',
      reschedulePath(specimen.id),
      { ...body, idempotencyKey: newKey(), version: 2 },
      'pe',
    );
    expect(same.status).toBe(422);
    expect(await snapshot()).toEqual(after);

    // It leaves Today on 5 Dec and the worklist shows the new target with the flag.
    expect(ids(await worklist('on=2026-12-05'))).toEqual([`${aId}C`]);
    const moved = await worklist('view=overdue&on=2027-01-03');
    const row = moved.groups[0]!.rows.find((r) => r.specimenId === specimen.id)!;
    expect(row).toMatchObject({ targetDate: '2027-01-02', rescheduleCount: 1, version: 2 });
    expect(row.flags).toContain('rescheduled');

    const history = await get(`/api/concrete/specimens/${specimen.id}/schedule-history`, 'lab');
    expect(history.status).toBe(200);
    expect(concreteScheduleHistorySchema.parse(history.body).history).toHaveLength(1);
  });

  it('a concrete-grant Lab Manager may reschedule; the capability list says who can', async () => {
    const capabilityOf = async (as: Caller) => {
      const response = await get(`/api/projects/${h.projects.a}/capabilities`, as);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return projectCapabilitiesSchema
        .parse(response.body)
        .capabilities.find((c) => c.action === 'concrete_specimen.reschedule')!;
    };
    expect(await capabilityOf('pe')).toMatchObject({
      allowed: true,
      sources: ['lead_project_engineer'],
    });
    expect((await capabilityOf('lm')).allowed).toBe(false);
    expect((await capabilityOf('tech')).allowed).toBe(false);

    const grant = await send(
      'post',
      `/api/projects/${h.projects.a}/concrete-lab-managers`,
      { labManagerUserId: h.users.lm, reason: 'Runs the concrete lab', idempotencyKey: newKey() },
      'pe',
    );
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    expect(await capabilityOf('lm')).toMatchObject({
      allowed: true,
      sources: ['concrete_lab_manager'],
    });
    expect((await worklist('view=overdue&on=2026-12-06', 'lm')).groups[0]).toMatchObject({
      projectId: h.projects.a,
      canReschedule: true,
    });
    const specimen = a.specimens[2]!;
    const response = await send(
      'post',
      reschedulePath(specimen.id),
      { idempotencyKey: newKey(), version: 1, newAge: 35, reason: 'Machine down on the 5th' },
      'lm',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(concreteRescheduleResultSchema.parse(response.body).targetDate).toBe('2026-12-12');
    // The grant covers project A only.
    const other = await send(
      'post',
      reschedulePath(b.specimens[1]!.id),
      { idempotencyKey: newKey(), version: 1, newAge: 35, reason: 'Machine down' },
      'lm',
    );
    expect(other.status).toBe(403);
  });

  it('refuses HOLD specimens (C26) and unnumbered draft sets (edit the draft)', async () => {
    const hold = a.specimens[3]!;
    const response = await send(
      'post',
      reschedulePath(hold.id),
      { idempotencyKey: newKey(), version: 1, newAge: 56, reason: 'Test it' },
      'pe',
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'hold_specimen' });

    const draft = await castSet(h.projects.a, '2026-11-20T10:00:00-06:00');
    const onDraft = await send(
      'post',
      reschedulePath(draft.specimens[0]!.id),
      { idempotencyKey: newKey(), version: 1, newAge: 14, reason: 'Early break' },
      'pe',
    );
    expect(onDraft.status).toBe(409);
    expect(onDraft.body).toMatchObject({ code: 'edit_on_draft' });
    const listed = await worklist('view=upcoming&on=2026-11-25');
    const row = listed.groups.flatMap((g) => g.rows).find((r) => r.setId === draft.id)!;
    expect(row).toMatchObject({ reschedulable: false });
    expect(row.flags).toContain('report_draft');
  });

  // MM-V2-C38 (owner decision 2026-11-09): number the set first. The report is moved past draft
  // with SQL, standing in for C09's submit (which needs a complete report).
  it('AC1/AC2: past draft an unnumbered set is refused until numbered; on a draft it is edited', async () => {
    const set = await castSet(h.projects.a, '2026-11-21T10:00:00-06:00');
    const specimen = set.specimens[1]!;
    const body = () => ({ idempotencyKey: newKey(), version: 1, newAge: 35, reason: 'Late' });

    // AC2: on the draft, the age is still the technician's to change (C05), as before.
    const onDraft = await send('post', reschedulePath(specimen.id), body(), 'pe');
    expect(onDraft.status).toBe(409);
    expect(onDraft.body).toMatchObject({ code: 'edit_on_draft' });

    await h.db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [set.fieldReportId],
    );
    // AC1: refused, nothing written, nothing audited.
    const before = await snapshot();
    for (const as of ['pe', 'lm'] as const) {
      const refused = await send('post', reschedulePath(specimen.id), body(), as);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body).toMatchObject({ code: 'set_not_numbered' });
      expect(String(refused.body.message)).toMatch(/Number this set first/);
    }
    expect(await snapshot()).toEqual(before);
    const listed = await worklist('view=upcoming&on=2026-11-25');
    const row = listed.groups.flatMap((g) => g.rows).find((r) => r.setId === set.id)!;
    expect(row).toMatchObject({ reschedulable: false, reportState: 'submitted' });

    // Numbered, the same reschedule goes through.
    await attachNumber(set);
    const done = await send('post', reschedulePath(specimen.id), body(), 'pe');
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(concreteRescheduleResultSchema.parse(done.body)).toMatchObject({ assignedAge: 35 });
  });

  it('the database keeps a numbered set age fixed except through a recorded reschedule', async () => {
    const specimen = b.specimens[0]!;
    await expect(
      h.db.pool.query(`UPDATE concrete_specimen SET assigned_age = '14' WHERE id = $1`, [
        specimen.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'concrete_specimen_age_fixed' });
    // A reschedule row for a different change doesn't open the guard either.
    const client = await h.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO concrete_specimen_reschedule
           (project_id, specimen_id, previous_age, new_age, previous_target_date, new_target_date,
            reason, rescheduled_by_user_id, rescheduled_by_name_snapshot, idempotency_key,
            request_hash)
         VALUES ($1, $2, '7', '10', '2026-11-09', '2026-11-12', 'x', $3, 'Pat Example', $4, 'h')`,
        [h.projects.b, specimen.id, h.users.pe, randomUUID()],
      );
      await expect(
        client.query(`UPDATE concrete_specimen SET assigned_age = '14' WHERE id = $1`, [
          specimen.id,
        ]),
      ).rejects.toMatchObject({ constraint: 'concrete_specimen_age_fixed' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // History is append-only.
    await expect(h.db.pool.query('DELETE FROM concrete_specimen_reschedule')).rejects.toMatchObject(
      { constraint: 'concrete_specimen_reschedule_append_only' },
    );
    await expect(
      h.db.pool.query(`UPDATE concrete_specimen_reschedule SET reason = 'changed'`),
    ).rejects.toMatchObject({ constraint: 'concrete_specimen_reschedule_append_only' });
  });

  // Last in the file: it adds a June set, which the HOLD view would otherwise count.
  it('MM-V2-C37 AC1: a 28-day target on Canada Day stays on that date with a holiday flag', async () => {
    // Cast Wednesday 3 Jun 2026 → 28 days is Wednesday 1 Jul 2026, Canada Day (reference seed).
    const set = await castSet(h.projects.b, '2026-06-03T09:00:00-06:00');
    const permanentId = await attachNumber(set);
    expect(set.specimens.map((s) => [s.letter, s.targetDate, s.flags])).toEqual([
      ['A', '2026-06-10', []],
      ['B', '2026-07-01', ['holiday_target']],
      ['C', '2026-07-01', ['holiday_target']],
      ['D', null, []],
    ]);
    const before = await snapshot();
    const list = await worklist(`on=2026-07-01&projectId=${h.projects.b}`);
    expect(ids(list)).toEqual([`${permanentId}B`, `${permanentId}C`]);
    for (const row of list.groups[0]!.rows) {
      expect(row.targetDate).toBe('2026-07-01');
      expect(row.flags).toContain('holiday_target');
      expect(row.flags).not.toContain('weekend_target');
    }
    // Reading it moved nothing.
    expect(await snapshot()).toEqual(before);

    // The calendar is read live: once the holiday is removed, the same target is unflagged.
    await h.db.pool.query(
      `UPDATE company_holiday
       SET removed_at = now(), removed_by_user_id = $1, removed_by_name_snapshot = 'Admin',
           removal_reason = 'Fictional test', version = version + 1
       WHERE holiday_on = '2026-07-01' AND removed_at IS NULL`,
      [h.users.admin],
    );
    const after = await worklist(`on=2026-07-01&projectId=${h.projects.b}`);
    expect(
      after.groups[0]!.rows.map((r) => [r.targetDate, r.flags.includes('holiday_target')]),
    ).toEqual([
      ['2026-07-01', false],
      ['2026-07-01', false],
    ]);
  });
});
