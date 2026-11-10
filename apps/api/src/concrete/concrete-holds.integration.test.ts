import { randomUUID } from 'node:crypto';
import {
  concreteDisposalReadySchema,
  concreteFieldReportDetailSchema,
  concreteHoldActionResultSchema,
  concreteHoldHistorySchema,
  concreteHoldListSchema,
  concreteSpecimenSetDetailSchema,
  type ConcreteHoldList,
  type ConcreteSpecimenSetDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { CONCRETE_LAB_MANAGER_GRANT } from '../project-access/grant-tables.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { endGrantDuring } from '../test-support/grant-race.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-V2-C26: HOLD management, bulk HOLD actions and disposal (card AC1–AC3; test plan T1). Real
// PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A) and DEMO-2602 (B), both led by
// Pat Example `pe`; Lee Manager `lm` is a Lab Manager with no concrete grant unless a test adds
// one; Alex Tester `tech` is an ordinary internal user. Permanent numbers are attached with SQL
// (standing in for C18) and failed-specimen holds are inserted with SQL (standing in for C25).
describe.runIf(testDatabaseUrl)('concrete HOLD management and disposal (MM-V2-C26)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab' | 'anonymous';

  const get = async (url: string, as: Caller = 'tech') => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  const post = async (url: string, body: unknown, as: Caller) => {
    const req = h.http().post(url).set(CSRF_HEADER, '1');
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req.send(body as object);
  };

  async function holds(query = '', as: Caller = 'tech'): Promise<ConcreteHoldList> {
    const response = await get(`/api/concrete/holds?${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteHoldListSchema.parse(response.body);
  }

  let reportA: string;
  let reportB: string;
  async function report(projectId: string, castAt: string): Promise<string> {
    const response = await post(
      `/api/concrete/projects/${projectId}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', specimensCast: true, castAt },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body).id;
  }
  let numberCounter = 0;
  /** A numbered 7/28/28/HOLD set; returns its HOLD specimen (letter D). */
  async function heldSpecimen(reportId: string, numbered = true) {
    const response = await post(
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const set: ConcreteSpecimenSetDetail = concreteSpecimenSetDetailSchema.parse(response.body);
    if (numbered) {
      numberCounter += 1;
      await h.db.pool.query(
        `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
        [set.id, numberCounter, `26-${String(numberCounter).padStart(2, '0')}`],
      );
    }
    const hold = set.specimens.find((s) => s.assignedAge === 'HOLD')!;
    const tested = set.specimens.find((s) => s.assignedAge === 28)!;
    return { set, hold: hold.id, tested: tested.id };
  }
  async function failureHold(specimenId: string) {
    await h.db.pool.query(
      `INSERT INTO concrete_specimen_failure_hold
         (project_id, specimen_id, reason, placed_by_user_id, placed_by_name_snapshot)
       SELECT project_id, id, 'Low 28-day result', $2, 'Pat Example'
       FROM concrete_specimen WHERE id = $1`,
      [specimenId, h.users.pe],
    );
  }
  const version = async (id: string) =>
    (
      await h.db.pool.query<{ version: number }>(
        'SELECT version FROM concrete_specimen WHERE id = $1',
        [id],
      )
    ).rows[0]!.version;
  const items = async (ids: string[]) =>
    Promise.all(
      ids.map(async (specimenId) => ({ specimenId, version: await version(specimenId) })),
    );

  async function tallies() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_specimen_disposal) AS disposals,
              (SELECT count(*)::int FROM concrete_specimen_disposal WHERE disposed_at IS NOT NULL)
                AS disposed,
              (SELECT count(*)::int FROM concrete_specimen_hold_schedule) AS schedules,
              (SELECT count(*)::int FROM concrete_hold_command) AS commands,
              (SELECT count(*)::int FROM audit_event WHERE entity_type = 'concrete_specimen')
                AS audit,
              (SELECT json_agg(json_build_object('id', id, 'age', assigned_age,
                       'hold', hold_expires_on, 'target', target_date, 'v', version) ORDER BY id)
               FROM concrete_specimen) AS specimens`,
    );
    return rows[0] as Record<string, unknown>;
  }

  // Cast Saturday 7 Nov 2026 (A) / Monday 2 Nov 2026 (B): HOLD 56 d → 2 Jan 2027 / 28 Dec 2026.
  let fiveA: string[];
  let holdB: string;
  let failedA: string;
  let failedB: string;
  let unnumbered: string;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    reportA = await report(h.projects.a, '2026-11-07T08:00:00-06:00');
    reportB = await report(h.projects.b, '2026-11-02T09:15:00-06:00');
    fiveA = [];
    for (let i = 0; i < 5; i += 1) fiveA.push((await heldSpecimen(reportA)).hold);
    const b = await heldSpecimen(reportB);
    holdB = b.hold;
    failedB = b.tested;
    failedA = (await heldSpecimen(reportA)).tested;
    await failureHold(failedA);
    await failureHold(failedB);
    unnumbered = (await heldSpecimen(reportA, false)).hold;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('HOLD table: project, specimen ID, casting date, HOLD expiry, status; ordinary and failed kept apart', async () => {
    const list = await holds('on=2026-12-01', 'pe');
    expect(list.counts).toMatchObject({ open: 10, disposal_authorized: 0, disposed: 0 });
    const ordinary = list.rows.find((r) => r.specimenId === fiveA[0])!;
    expect(ordinary).toMatchObject({
      project: { projectNumber: 'DEMO-2601' },
      identity: { permanentId: '26-01D' },
      holdKind: 'ordinary',
      assignedAge: 'HOLD',
      castingDate: '2026-11-07',
      holdExpiresOn: '2027-01-02',
      status: 'held',
      failureReason: null,
      disposal: null,
      actions: { scheduleTest: true, authorizeDisposal: true, recordDisposal: false },
    });
    const failed = list.rows.find((r) => r.specimenId === failedA)!;
    expect(failed).toMatchObject({
      holdKind: 'failed',
      assignedAge: 28,
      holdExpiresOn: null,
      status: 'held',
      failureReason: 'Low 28-day result',
      actions: { scheduleTest: false, authorizeDisposal: true },
    });
    // An unnumbered set can't be scheduled here (its draft report changes its ages).
    expect(list.rows.find((r) => r.specimenId === unnumbered)!.actions.scheduleTest).toBe(false);
    expect((await holds('kind=failed&on=2026-12-01')).rows.map((r) => r.specimenId).sort()).toEqual(
      [failedA, failedB].sort(),
    );
    expect(
      (await holds(`kind=ordinary&projectId=${h.projects.b}`)).rows.map((r) => r.specimenId),
    ).toEqual([holdB]);
    // An ordinary internal user and LAB read it, with no actions.
    const asTech = await holds('', 'tech');
    expect(asTech.rows.every((r) => !r.actions.scheduleTest && !r.actions.authorizeDisposal)).toBe(
      true,
    );
    expect((await holds('', 'lab')).total).toBe(10);
    expect((await get('/api/concrete/holds', 'anonymous')).status).toBe(401);
    expect((await get('/api/concrete/holds?status=gone')).status).toBe(400);
  });

  it('AC3: at HOLD expiry only the review flag changes; nothing is scheduled, released or disposed', async () => {
    const before = await tallies();
    const early = await holds(`kind=ordinary&projectId=${h.projects.b}&on=2026-12-27`);
    expect(early.rows[0]!.status).toBe('held');
    const due = await holds(`kind=ordinary&projectId=${h.projects.b}&on=2026-12-28`);
    expect(due.rows[0]!).toMatchObject({
      status: 'review_due',
      assignedAge: 'HOLD',
      disposal: null,
    });
    const later = await holds('on=2027-06-01');
    expect(
      later.rows.filter((r) => r.holdKind === 'ordinary').every((r) => r.status === 'review_due'),
    ).toBe(true);
    // A failed-specimen hold is never released by a date.
    expect(
      later.rows.filter((r) => r.holdKind === 'failed').every((r) => r.status === 'held'),
    ).toBe(true);
    expect(await tallies()).toEqual(before);
  });

  it('refuses callers with no HOLD authority before reading the body', async () => {
    const before = await tallies();
    for (const path of [
      '/api/concrete/holds/schedule-test',
      '/api/concrete/holds/authorize-disposal',
    ]) {
      for (const caller of ['tech', 'js', 'lab'] as const) {
        for (const payload of [
          { bogus: true },
          { idempotencyKey: newKey(), items: [], reason: 'x' },
        ]) {
          expect((await post(path, payload, caller)).status, `${caller} ${path}`).toBe(403);
        }
      }
      expect((await post(path, {}, 'anonymous')).status).toBe(401);
    }
    // Recording disposal is lab staff: an ordinary internal user is refused.
    expect((await post('/api/concrete/disposal/record', { bogus: true }, 'tech')).status).toBe(403);
    expect(await tallies()).toEqual(before);
  });

  it('AC1: bulk authorize for five specimens writes five history entries and disposes of none', async () => {
    const before = await tallies();
    const key = newKey();
    const body = {
      idempotencyKey: key,
      items: await items(fiveA),
      reason: 'Spare cylinders not needed',
    };
    const response = await post('/api/concrete/holds/authorize-disposal', body, 'lm');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = concreteHoldActionResultSchema.parse(response.body);
    expect(result.rows.map((r) => r.specimenId)).toEqual(fiveA);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        status: 'disposal_authorized',
        holdKind: 'ordinary',
        disposal: {
          reason: 'Spare cylinders not needed',
          authorizedBy: { userId: h.users.lm, name: 'Lee Manager' },
          disposedAt: null,
          disposedBy: null,
        },
        actions: { scheduleTest: false, authorizeDisposal: false, recordDisposal: true },
      });
    }
    const after = await tallies();
    expect(after).toMatchObject({
      disposals: (before.disposals as number) + 5,
      disposed: before.disposed,
      commands: (before.commands as number) + 1,
      audit: (before.audit as number) + 5,
      specimens: before.specimens,
    });
    // One audit event and one history entry per specimen, all in the one command.
    const { rows: audit } = await h.db.pool.query<{
      entity_id: string;
      after_values: { commandId: string };
    }>(
      `SELECT entity_id, after_values FROM audit_event
       WHERE action = 'concrete_specimen.disposal_authorized' ORDER BY entity_id`,
    );
    expect(audit.map((a) => a.entity_id)).toEqual([...fiveA].sort());
    expect(new Set(audit.map((a) => a.after_values.commandId))).toEqual(
      new Set([result.commandId]),
    );
    for (const id of fiveA) {
      const history = concreteHoldHistorySchema.parse(
        (await get(`/api/concrete/specimens/${id}/hold-history`, 'lab')).body,
      );
      expect(history.events).toEqual([
        expect.objectContaining({
          kind: 'disposal_authorized',
          reason: 'Spare cylinders not needed',
          commandId: result.commandId,
        }),
      ]);
    }
    // Exact retry: same result, nothing new. Same key, other change: 409.
    const retry = await post('/api/concrete/holds/authorize-disposal', body, 'lm');
    expect(retry.status).toBe(200);
    expect(concreteHoldActionResultSchema.parse(retry.body).commandId).toBe(result.commandId);
    expect(await tallies()).toEqual(after);
    const reused = await post(
      '/api/concrete/holds/authorize-disposal',
      { ...body, reason: 'Other' },
      'lm',
    );
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'idempotency_key_reused' });
    // Already authorized: refused, with the specimen named.
    const again = await post(
      '/api/concrete/holds/authorize-disposal',
      { idempotencyKey: newKey(), items: await items([fiveA[0]!]), reason: 'Again' },
      'pe',
    );
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      code: 'not_eligible',
      problems: [{ specimenId: fiveA[0], code: 'disposal_authorized' }],
    });
    // Authorized specimens leave the open list and the testing worklist, and appear in Ready.
    const list = await holds('status=disposal_authorized');
    expect(list.rows.map((r) => r.specimenId).sort()).toEqual([...fiveA].sort());
    const ready = concreteDisposalReadySchema.parse(
      (await get('/api/concrete/disposal/ready', 'lab')).body,
    );
    expect(ready.specimens.map((s) => s.specimenId).sort()).toEqual([...fiveA].sort());
    expect(ready).toMatchObject({ canRecord: true, requiresPerformer: true });
    expect(
      concreteDisposalReadySchema.parse((await get('/api/concrete/disposal/ready')).body).canRecord,
    ).toBe(false);
    const worklist = await get('/api/concrete/lab-worklist?view=hold&on=2026-12-01', 'pe');
    const listed = (
      worklist.body as { groups: { rows: { specimenId: string }[] }[] }
    ).groups.flatMap((g) => g.rows.map((r) => r.specimenId));
    expect(listed.some((id) => fiveA.includes(id))).toBe(false);
  });

  it('AC2: a Lab Manager without the project grant releases an ordinary HOLD but not a failed-specimen hold', async () => {
    const before = await tallies();
    // Mixed batch: refused whole, naming the failed specimen; nothing written.
    const mixed = await post(
      '/api/concrete/holds/authorize-disposal',
      { idempotencyKey: newKey(), items: await items([holdB, failedB]), reason: 'Clear out' },
      'lm',
    );
    expect(mixed.status).toBe(403);
    expect(mixed.body).toMatchObject({ code: 'forbidden', specimens: [failedB] });
    expect(await tallies()).toEqual(before);
    const failedOnly = await post(
      '/api/concrete/holds/authorize-disposal',
      { idempotencyKey: newKey(), items: await items([failedB]), reason: 'Clear out' },
      'lm',
    );
    expect(failedOnly.status).toBe(403);
    // Ordinary HOLD release (Schedule test) by the same Lab Manager is allowed.
    const scheduled = await post(
      '/api/concrete/holds/schedule-test',
      {
        idempotencyKey: newKey(),
        items: await items([holdB]),
        newAge: 56,
        reason: 'Engineer wants a 56-day break',
      },
      'lm',
    );
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    const row = concreteHoldActionResultSchema.parse(scheduled.body).rows[0]!;
    expect(row).toMatchObject({ specimenId: holdB, assignedAge: 56 });
    const { rows } = await h.db.pool.query(
      'SELECT assigned_age, target_date::text, hold_expires_on FROM concrete_specimen WHERE id = $1',
      [holdB],
    );
    // 2 Nov 2026 + 56 days = 28 Dec 2026; the HOLD expiry is gone, the target follows casting.
    expect(rows[0]).toEqual({
      assigned_age: '56',
      target_date: '2026-12-28',
      hold_expires_on: null,
    });
    const history = concreteHoldHistorySchema.parse(
      (await get(`/api/concrete/specimens/${holdB}/hold-history`)).body,
    );
    expect(history.events).toEqual([
      expect.objectContaining({
        kind: 'test_scheduled',
        newAge: 56,
        newTargetDate: '2026-12-28',
        previousHoldExpiresOn: '2026-12-28',
        by: expect.objectContaining({ userId: h.users.lm }),
      }),
    ]);
    // It left the HOLD table and is on the worklist on its new target date.
    expect((await holds('status=all')).rows.some((r) => r.specimenId === holdB)).toBe(false);
    const today = await get('/api/concrete/lab-worklist?on=2026-12-28', 'pe');
    expect(JSON.stringify(today.body)).toContain(holdB);

    // With the project's concrete grant the same Lab Manager may release the failed hold.
    const grant = await post(
      `/api/projects/${h.projects.b}/concrete-lab-managers`,
      { labManagerUserId: h.users.lm, reason: 'Runs the concrete lab', idempotencyKey: newKey() },
      'pe',
    );
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    const allowed = await post(
      '/api/concrete/holds/authorize-disposal',
      { idempotencyKey: newKey(), items: await items([failedB]), reason: 'Photo kept; dispose' },
      'lm',
    );
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(concreteHoldActionResultSchema.parse(allowed.body).rows[0]).toMatchObject({
      holdKind: 'failed',
      status: 'disposal_authorized',
    });
    // The lead releases a failed hold on their own project without any grant.
    const lead = await post(
      '/api/concrete/holds/authorize-disposal',
      { idempotencyKey: newKey(), items: await items([failedA]), reason: 'Reviewed; dispose' },
      'pe',
    );
    expect(lead.status, JSON.stringify(lead.body)).toBe(200);
  });

  it('Schedule test refuses a failed hold, an unnumbered set and a stale version, changing nothing', async () => {
    const extra = (await heldSpecimen(reportA)).hold;
    const before = await tallies();
    const attempt = async (ids: string[], overrides: Record<string, unknown> = {}) =>
      post(
        '/api/concrete/holds/schedule-test',
        {
          idempotencyKey: newKey(),
          items: await items(ids),
          newAge: 90,
          reason: 'Retest',
          ...overrides,
        },
        'pe',
      );
    const failed = await attempt([failedA]);
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ problems: [{ specimenId: failedA, code: 'failed_hold' }] });
    const draft = await attempt([unnumbered]);
    expect(draft.body).toMatchObject({
      problems: [{ specimenId: unnumbered, code: 'unnumbered_set' }],
    });
    const stale = await attempt([extra], { items: [{ specimenId: extra, version: 99 }] });
    expect(stale.body).toMatchObject({
      problems: [{ specimenId: extra, code: 'version_conflict' }],
    });
    const unknown = await attempt([], { items: [{ specimenId: randomUUID(), version: 1 }] });
    expect(unknown.body).toMatchObject({ problems: [{ code: 'not_found' }] });
    expect((await attempt([extra], { newAge: 0 })).status).toBe(400);
    expect((await attempt([extra], { reason: ' ' })).status).toBe(400);
    expect(await tallies()).toEqual(before);
    // The database refuses an age change on a numbered set without a HOLD schedule row.
    await expect(
      h.db.pool.query(`UPDATE concrete_specimen SET assigned_age = '90' WHERE id = $1`, [extra]),
    ).rejects.toMatchObject({ constraint: 'concrete_specimen_age_fixed' });
    // …and any age change once disposal is authorized, numbered or not, and C22's reschedule too.
    await expect(
      h.db.pool.query(`UPDATE concrete_specimen SET assigned_age = '7' WHERE id = $1`, [fiveA[1]]),
    ).rejects.toMatchObject({ constraint: 'concrete_specimen_age_disposal' });
  });

  it('Record disposal: lab staff record actual removal in bulk; LAB names the performer', async () => {
    const extra = (await heldSpecimen(reportA)).hold;
    const before = await tallies();
    const removal = (body: Record<string, unknown>, as: Caller) =>
      post('/api/concrete/disposal/record', { idempotencyKey: newKey(), ...body }, as);
    const now = new Date();
    // Removed just now (after the authorizations above, to the second).
    const at = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
    // LAB must name the performing person.
    const nameless = await removal({ specimenIds: fiveA.slice(0, 3), disposedAt: at }, 'lab');
    expect(nameless.status).toBe(400);
    // Not yet authorized, or a future time: refused, nothing written.
    const notAuthorized = await removal(
      { specimenIds: [fiveA[0], extra], disposedAt: at, performedByUserId: h.users.tech },
      'lab',
    );
    expect(notAuthorized.status).toBe(409);
    expect(notAuthorized.body).toMatchObject({
      problems: [{ specimenId: extra, code: 'not_authorized_for_disposal' }],
    });
    const future = await removal(
      { specimenIds: [fiveA[0]], disposedAt: new Date(now.getTime() + 3_600_000).toISOString() },
      'lm',
    );
    expect(future.status).toBe(400);
    expect(future.body).toMatchObject({ errors: [{ field: 'disposedAt', code: 'in_future' }] });
    const early = await removal(
      { specimenIds: [fiveA[0]], disposedAt: '2026-01-01T09:00:00-07:00' },
      'lm',
    );
    expect(early.body).toMatchObject({ problems: [{ code: 'before_authorization' }] });
    const tallyBefore = await tallies();
    expect(tallyBefore.disposed).toBe(before.disposed);

    const response = await removal(
      { specimenIds: fiveA.slice(0, 3), disposedAt: at, performedByUserId: h.users.tech },
      'lab',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = concreteHoldActionResultSchema.parse(response.body);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        status: 'disposed',
        disposal: { disposedAt: at, disposedBy: { userId: h.users.tech, name: 'Alex Tester' } },
        actions: { recordDisposal: false },
      });
    }
    const after = await tallies();
    expect(after).toMatchObject({
      disposed: (before.disposed as number) + 3,
      audit: (before.audit as number) + 3,
      specimens: before.specimens,
    });
    const { rows: audit } = await h.db.pool.query(
      `SELECT actor_user_id, receiver_user_id FROM audit_event
       WHERE action = 'concrete_specimen.disposed' AND entity_id = $1`,
      [fiveA[0]],
    );
    // The LAB account recorded it; the named person performed it.
    expect(audit).toEqual([{ actor_user_id: h.users.lab, receiver_user_id: h.users.tech }]);
    const history = concreteHoldHistorySchema.parse(
      (await get(`/api/concrete/specimens/${fiveA[0]}/hold-history`)).body,
    );
    expect(history.events.map((e) => e.kind)).toEqual(['disposal_authorized', 'disposed']);
    expect(history.events[1]).toMatchObject({
      by: { userId: h.users.tech },
      recordedBy: { userId: h.users.lab },
      disposedAt: at,
    });
    // Disposed is distinct from authorized-but-not-removed.
    const list = await holds('status=disposed');
    expect(list.rows.map((r) => r.specimenId).sort()).toEqual(fiveA.slice(0, 3).sort());
    const ready = concreteDisposalReadySchema.parse(
      (await get('/api/concrete/disposal/ready')).body,
    );
    expect(ready.specimens.some((s) => fiveA.slice(0, 3).includes(s.specimenId))).toBe(false);
    expect(ready.specimens.some((s) => s.specimenId === fiveA[3])).toBe(true);
    // Recording again is refused; the database keeps the first removal.
    const twice = await removal({ specimenIds: [fiveA[0]], disposedAt: at }, 'lm');
    expect(twice.body).toMatchObject({ problems: [{ code: 'disposed' }] });
    await expect(
      h.db.pool.query(
        'UPDATE concrete_specimen_disposal SET disposed_at = now() WHERE specimen_id = $1',
        [fiveA[0]],
      ),
    ).rejects.toMatchObject({ constraint: 'concrete_specimen_disposal_append_only' });
    await expect(
      h.db.pool.query('DELETE FROM concrete_specimen_disposal WHERE specimen_id = $1', [fiveA[3]]),
    ).rejects.toMatchObject({ constraint: 'concrete_specimen_disposal_append_only' });
    // A personal lab-staff account records as itself, and may not name someone else.
    const other = await removal(
      { specimenIds: [fiveA[3]], disposedAt: at, performedByUserId: h.users.tech },
      'lm',
    );
    expect(other.status).toBe(400);
    const self = await removal({ specimenIds: [fiveA[3]], disposedAt: at }, 'lm');
    expect(self.status, JSON.stringify(self.body)).toBe(200);
    expect(
      concreteHoldActionResultSchema.parse(self.body).rows[0]!.disposal!.disposedBy,
    ).toMatchObject({ userId: h.users.lm });
  });

  it('the database ties an authorization to the hold it releases', async () => {
    const extra = (await heldSpecimen(reportA)).hold;
    const command = await h.db.pool.query<{ id: string }>(
      `INSERT INTO concrete_hold_command (idempotency_key, kind, request_hash, account_user_id, specimen_ids)
       VALUES ($1, 'authorize_disposal', 'x', $2, ARRAY[$3]::uuid[]) RETURNING id`,
      [randomUUID(), h.users.pe, extra],
    );
    await expect(
      h.db.pool.query(
        `INSERT INTO concrete_specimen_disposal
           (project_id, specimen_id, hold_kind, authorization_command_id, authorization_reason,
            authorized_by_user_id, authorized_by_name_snapshot)
         SELECT project_id, id, 'failed', $2, 'x', $3, 'Pat Example' FROM concrete_specimen WHERE id = $1`,
        [extra, command.rows[0]!.id, h.users.pe],
      ),
    ).rejects.toMatchObject({ constraint: 'concrete_specimen_disposal_hold_matches' });
    await expect(
      h.db.pool.query('DELETE FROM concrete_hold_command WHERE id = $1', [command.rows[0]!.id]),
    ).rejects.toMatchObject({ constraint: 'concrete_hold_command_append_only' });
  });

  it('review fix #134: a Lab Manager grant revoked before the final check refuses the failed-hold release; nothing is written', async () => {
    // Lee holds the concrete grant on B (AC2 above); a new failed hold there.
    const failed = (await heldSpecimen(reportB)).tested;
    await failureHold(failed);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM project_concrete_lab_manager_grant
       WHERE project_id = $1 AND lab_manager_user_id = $2 AND revoked_at IS NULL`,
      [h.projects.b, h.users.lm],
    );
    const body = { idempotencyKey: newKey(), items: await items([failed]), reason: 'Dispose' };
    const before = await tallies();
    const response = await endGrantDuring(
      h.db.pool,
      CONCRETE_LAB_MANAGER_GRANT,
      rows[0]!.id,
      { userId: h.users.pe, initials: 'PE', displayName: 'Pat Example' },
      () => post('/api/concrete/holds/authorize-disposal', body, 'lm'),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body).toMatchObject({ code: 'forbidden', specimens: [failed] });
    expect(await tallies()).toEqual(before);
  });
});
