import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteHoldActionResultSchema,
  concreteHoldHistorySchema,
  concreteHoldListSchema,
  concreteHoldProblemsSchema,
  concreteLabToday,
  concreteSpecimenSetDetailSchema,
  concreteWorklistSchema,
  type ConcreteSpecimenSetDetail,
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

// STRATA-121: Hold until a date from Breaks (POST /api/concrete/holds/hold-until). Real
// PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A) is led by Pat Example `pe`,
// DEMO-2602 (B) by Jordan Smith `js` (set here); Lee Manager `lm` is a Lab Manager (ordinary HOLD
// authority by role alone); Alex Tester `tech` is an ordinary internal user; LAB is the shared
// station. Sets are cast Monday 2 Nov 2026 09:15 in Edmonton: 7 d → 9 Nov, 28 d → 30 Nov, HOLD
// 56 d → 28 Dec. Permanent numbers are attached with SQL (standing in for C18).
describe.runIf(testDatabaseUrl)('concrete Hold until from Breaks (STRATA-121)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab';
  const HOLD_UNTIL = '2027-06-30';
  const PATH = '/api/concrete/holds/hold-until';

  const get = (url: string, as: Caller = 'tech') => h.http().get(url).set('Cookie', cookies[as]!);
  const post = (url: string, body: unknown, as: Caller) =>
    h
      .http()
      .post(url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as]!)
      .send(body as object);

  async function report(projectId: string): Promise<string> {
    const response = await post(
      `/api/concrete/projects/${projectId}/field-reports`,
      {
        idempotencyKey: newKey(),
        material: 'concrete',
        specimensCast: true,
        castAt: '2026-11-02T09:15:00-06:00',
      },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body).id;
  }
  let counter = 0;
  /** A 7/28/28/HOLD set, numbered unless asked otherwise. */
  async function set(reportId: string, numbered = true): Promise<ConcreteSpecimenSetDetail> {
    const response = await post(
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const detail = concreteSpecimenSetDetailSchema.parse(response.body);
    if (numbered) {
      counter += 1;
      await h.db.pool.query(
        `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
        [detail.id, counter, `26-${String(counter).padStart(2, '0')}`],
      );
    }
    return detail;
  }
  const version = async (id: string) =>
    (
      await h.db.pool.query<{ version: number }>(
        'SELECT version FROM concrete_specimen WHERE id = $1',
        [id],
      )
    ).rows[0]!.version;
  const items = (ids: string[]) =>
    Promise.all(
      ids.map(async (specimenId) => ({ specimenId, version: await version(specimenId) })),
    );
  const body = async (ids: string[], extra: Record<string, unknown> = {}) => ({
    idempotencyKey: newKey(),
    items: await items(ids),
    holdUntil: HOLD_UNTIL,
    reason: 'Keep for the owner’s follow-up testing',
    ...extra,
  });

  async function tallies() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_specimen_hold_assignment) AS assignments,
              (SELECT count(*)::int FROM concrete_hold_command) AS commands,
              (SELECT count(*)::int FROM audit_event WHERE entity_type = 'concrete_specimen')
                AS audit,
              (SELECT json_agg(json_build_object('id', id, 'age', assigned_age,
                       'hold', hold_expires_on, 'target', target_date, 'v', version) ORDER BY id)
               FROM concrete_specimen) AS specimens`,
    );
    return rows[0] as Record<string, unknown>;
  }
  const specimen = async (id: string) =>
    (
      await h.db.pool.query<{
        age: string;
        target: string | null;
        hold: string | null;
        until: string | null;
      }>(
        `SELECT assigned_age AS age, target_date::text AS target, hold_expires_on::text AS hold,
                hold_until::text AS until
         FROM concrete_specimen WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  let reportA: string;
  let reportB: string;
  let a1: ConcreteSpecimenSetDetail;
  let a2: ConcreteSpecimenSetDetail;
  let b1: ConcreteSpecimenSetDetail;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    await h.db.pool.query('UPDATE project SET lead_project_engineer_user_id = $2 WHERE id = $1', [
      h.projects.b,
      h.users.js,
    ]);
    reportA = await report(h.projects.a);
    reportB = await report(h.projects.b);
    a1 = await set(reportA);
    a2 = await set(reportA);
    b1 = await set(reportB);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('refuses callers without ordinary HOLD authority before the body; LAB never borrows it', async () => {
    const before = await tallies();
    const target = await body([a1.specimens[1]!.id]);
    expect((await post(PATH, target, 'tech')).status).toBe(403);
    expect((await post(PATH, target, 'lab')).status).toBe(403);
    // Naming a Lab Manager on the LAB station grants nothing (and isn't part of the request).
    const named = await post(PATH, { ...target, performedByUserId: h.users.lm }, 'lab');
    expect(named.status).toBe(403);
    expect((await h.http().post(PATH).set(CSRF_HEADER, '1').send(target)).status).toBe(401);
    expect(await tallies()).toEqual(before);
  });

  it('validates the date and the reason', async () => {
    const before = await tallies();
    const ids = [a1.specimens[1]!.id];
    expect((await post(PATH, await body(ids, { reason: '  ' }), 'pe')).status).toBe(400);
    expect((await post(PATH, await body(ids, { holdUntil: '2027-02-30' }), 'pe')).status).toBe(400);
    expect((await post(PATH, await body(ids, { holdUntil: 'next week' }), 'pe')).status).toBe(400);
    for (const day of ['2026-01-01', concreteLabToday()]) {
      const past = await post(PATH, await body(ids, { holdUntil: day }), 'pe');
      expect(past.status, day).toBe(400);
      expect(past.body.errors[0]).toMatchObject({ field: 'holdUntil', code: 'not_after_today' });
    }
    expect((await post(PATH, { ...(await body(ids)), items: [] }, 'pe')).status).toBe(400);
    expect(await tallies()).toEqual(before);
  });

  it('the lead holds scheduled specimens until the date: off due work, onto HOLD, with history', async () => {
    const [, b, c] = a1.specimens;
    const request = await body([b!.id, c!.id]);
    const before = await tallies();
    const response = await post(PATH, request, 'pe');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = concreteHoldActionResultSchema.parse(response.body);
    expect(
      result.rows.map((r) => [r.specimenId, r.assignedAge, r.holdExpiresOn, r.status]),
    ).toEqual([
      [b!.id, 'HOLD', HOLD_UNTIL, 'held'],
      [c!.id, 'HOLD', HOLD_UNTIL, 'held'],
    ]);
    expect(result.rows[0]!.actions).toMatchObject({ scheduleTest: true, authorizeDisposal: true });
    expect(await specimen(b!.id)).toEqual({
      age: 'HOLD',
      target: null,
      hold: HOLD_UNTIL,
      until: HOLD_UNTIL,
    });
    const after = await tallies();
    expect([
      (after.assignments as number) - (before.assignments as number),
      (after.commands as number) - (before.commands as number),
      (after.audit as number) - (before.audit as number),
    ]).toEqual([2, 1, 2]);
    const { rows: audit } = await h.db.pool.query(
      `SELECT entity_id, actor_user_id, reason, before_values, after_values FROM audit_event
       WHERE action = 'concrete_specimen.hold_assigned' AND entity_id = $1`,
      [b!.id],
    );
    expect(audit).toEqual([
      {
        entity_id: b!.id,
        actor_user_id: h.users.pe,
        reason: request.reason,
        before_values: {
          version: request.items[0]!.version,
          assignedAge: 28,
          targetDate: '2026-11-30',
        },
        after_values: {
          version: request.items[0]!.version + 1,
          assignedAge: 'HOLD',
          holdUntil: HOLD_UNTIL,
          commandId: result.commandId,
        },
      },
    ]);

    // Off the due views on 30 Nov; on the HOLD view with its hold-until date (a review flag only).
    const today = concreteWorklistSchema.parse(
      (await get('/api/concrete/lab-worklist?view=today&on=2026-11-30')).body,
    );
    const due = today.groups.flatMap((g) => g.rows.map((r) => r.specimenId));
    expect(due).not.toContain(b!.id);
    expect(due).toContain(a2.specimens[1]!.id);
    const held = concreteWorklistSchema.parse(
      (await get(`/api/concrete/lab-worklist?view=hold&on=${HOLD_UNTIL}`)).body,
    );
    const heldRow = held.groups.flatMap((g) => g.rows).find((r) => r.specimenId === b!.id)!;
    expect(heldRow).toMatchObject({ holdExpiresOn: HOLD_UNTIL, holdKind: 'ordinary' });
    expect(heldRow.flags).toContain('hold_review_due');
    // The authoritative HOLD counts include them; the date changes nothing by itself.
    const list = concreteHoldListSchema.parse(
      (await get(`/api/concrete/holds?projectId=${h.projects.a}&on=${HOLD_UNTIL}`)).body,
    );
    expect(
      list.rows.filter((r) => [b!.id, c!.id].includes(r.specimenId)).map((r) => r.status),
    ).toEqual(['review_due', 'review_due']);
    expect(list.counts.open).toBe(4); // a1 B, C and both sets' own HOLD specimens (D)
    // History keeps the age and target it had.
    const history = concreteHoldHistorySchema.parse(
      (await get(`/api/concrete/specimens/${b!.id}/hold-history`)).body,
    );
    expect(history.events).toEqual([
      expect.objectContaining({
        kind: 'hold_assigned',
        by: expect.objectContaining({ userId: h.users.pe }),
        reason: request.reason,
        previousAge: 28,
        previousTargetDate: '2026-11-30',
        holdUntil: HOLD_UNTIL,
        commandId: result.commandId,
      }),
    ]);
    // The worklist group says who may use Hold until.
    expect(today.groups.find((g) => g.projectId === h.projects.a)!.canHoldUntil).toBe(false);
    const asPe = concreteWorklistSchema.parse(
      (await get('/api/concrete/lab-worklist?view=today&on=2026-11-30', 'pe')).body,
    );
    expect(asPe.groups.find((g) => g.projectId === h.projects.a)!.canHoldUntil).toBe(true);

    // An exact retry replays; the same key for something else is 409; a new key is refused.
    const settled = await tallies();
    const replay = await post(PATH, request, 'pe');
    expect(replay.status).toBe(200);
    expect(replay.body.commandId).toBe(result.commandId);
    const reused = await post(PATH, { ...request, reason: 'Different reason' }, 'pe');
    expect([reused.status, reused.body.code]).toEqual([409, 'idempotency_key_reused']);
    const again = await post(PATH, { ...request, idempotencyKey: newKey() }, 'pe');
    expect(again.status).toBe(409);
    expect(concreteHoldProblemsSchema.parse(again.body).problems).toEqual([
      { specimenId: b!.id, code: 'already_on_hold' },
      { specimenId: c!.id, code: 'already_on_hold' },
    ]);
    expect(await tallies()).toEqual(settled);
  });

  it('cross-project: the lead of A can’t hold B’s specimens; a Lab Manager can hold both', async () => {
    const mixed = [a2.specimens[0]!.id, b1.specimens[0]!.id];
    const before = await tallies();
    const refused = await post(PATH, await body(mixed), 'pe');
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: 'forbidden', specimens: [b1.specimens[0]!.id] });
    expect(await tallies()).toEqual(before);
    const ok = await post(PATH, await body(mixed), 'lm');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await specimen(b1.specimens[0]!.id)).until).toBe(HOLD_UNTIL);
  });

  it('mixed eligibility changes nothing and names each ineligible specimen', async () => {
    const r = await report(h.projects.a);
    const ok = await set(r);
    const draft = await set(r, false);
    const tested = await set(r);
    const voided = await set(r);
    const failed = await set(r);
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET voided_at = now(), voided_by_user_id = $2,
         void_reason = 'Fictional void for the test' WHERE id = $1`,
      [voided.id, h.users.pe],
    );
    await h.db.pool.query(
      `INSERT INTO concrete_specimen_failure_hold
         (project_id, specimen_id, reason, placed_by_user_id, placed_by_name_snapshot)
       SELECT project_id, id, 'Low 28-day result', $2, 'Pat Example'
       FROM concrete_specimen WHERE id = $1`,
      [failed.specimens[1]!.id, h.users.pe],
    );
    // A saved test entry (even an incomplete one) keeps the specimen off HOLD.
    const entry = await h
      .http()
      .put(`/api/concrete/specimens/${tested.specimens[0]!.id}/test-results/${randomUUID()}`)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies.lm!)
      .send({ idempotencyKey: newKey(), version: 0, maxLoad: 300.1 });
    expect(entry.status, JSON.stringify(entry.body)).toBe(200);

    const ids = [
      ok.specimens[0]!.id,
      ok.specimens[3]!.id, // HOLD already
      draft.specimens[0]!.id,
      tested.specimens[0]!.id,
      voided.specimens[0]!.id,
      failed.specimens[1]!.id,
    ];
    const request = await body(ids);
    request.items[0]!.version += 1; // stale
    const before = await tallies();
    const response = await post(PATH, request, 'pe');
    expect(response.status).toBe(409);
    expect(concreteHoldProblemsSchema.parse(response.body).problems).toEqual([
      { specimenId: ids[0], code: 'version_conflict' },
      { specimenId: ids[1], code: 'already_on_hold' },
      { specimenId: ids[2], code: 'unnumbered_set' },
      { specimenId: ids[3], code: 'tested_specimen' },
      { specimenId: ids[4], code: 'set_void' },
      { specimenId: ids[5], code: 'failed_hold' },
    ]);
    const unknown = await post(
      PATH,
      { ...(await body([])), items: [{ specimenId: randomUUID(), version: 1 }] },
      'pe',
    );
    expect(unknown.body.problems).toEqual([{ specimenId: expect.any(String), code: 'not_found' }]);
    expect(await tallies()).toEqual(before);
  });

  it('concurrent requests for the same specimens: one holds, the other is refused, one history', async () => {
    const r = await report(h.projects.a);
    const s = await set(r);
    const ids = [s.specimens[0]!.id, s.specimens[1]!.id];
    const [x, y] = await Promise.all([
      post(PATH, await body(ids), 'pe'),
      post(PATH, await body(ids), 'lm'),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const { rows } = await h.db.pool.query(
      `SELECT count(*)::int AS n FROM concrete_specimen_hold_assignment
       WHERE specimen_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(rows[0]).toEqual({ n: 2 });
  });

  it('released like any ordinary HOLD: Schedule test derives from casting; disposal as usual', async () => {
    const [, b, c] = a1.specimens;
    // Schedule test: the chosen date goes, the target is casting + the new age.
    const scheduled = await post(
      '/api/concrete/holds/schedule-test',
      {
        idempotencyKey: newKey(),
        items: await items([b!.id]),
        newAge: 56,
        reason: 'Test it at 56 days',
      },
      'pe',
    );
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(await specimen(b!.id)).toEqual({
      age: '56',
      target: '2026-12-28',
      hold: null,
      until: null,
    });
    const history = concreteHoldHistorySchema.parse(
      (await get(`/api/concrete/specimens/${b!.id}/hold-history`)).body,
    );
    expect(history.events.map((e) => e.kind)).toEqual(['hold_assigned', 'test_scheduled']);
    expect(history.events[1]).toMatchObject({ previousHoldExpiresOn: HOLD_UNTIL, newAge: 56 });

    // Authorize disposal, then lab staff record it.
    const authorized = await post(
      '/api/concrete/holds/authorize-disposal',
      { idempotencyKey: newKey(), items: await items([c!.id]), reason: 'Not needed' },
      'pe',
    );
    expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
    const recorded = await post(
      '/api/concrete/disposal/record',
      {
        idempotencyKey: newKey(),
        specimenIds: [c!.id],
        disposedAt: new Date().toISOString(),
        performedByUserId: h.users.lm,
      },
      'lab',
    );
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body.rows[0]).toMatchObject({ status: 'disposed', holdExpiresOn: HOLD_UNTIL });
    // A disposed specimen can't be held again.
    const again = await post(PATH, await body([c!.id]), 'pe');
    expect(again.body.problems).toEqual([{ specimenId: c!.id, code: 'disposed' }]);
  });
});
