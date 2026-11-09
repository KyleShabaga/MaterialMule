import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteSpecimenSetDetailSchema,
  concreteSpecimenTestResultsSchema,
  concreteTestResultSaveResultSchema,
  concreteTestResultSchema,
  type ConcreteSpecimenSetDetail,
  type ConcreteTestResultSaveRequest,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-V2-C07: concrete test-result drafts, tester attribution and correction history (card
// AC1–AC5; test plan T2/T3). Real PostgreSQL, direct API calls. Fictional data only: DEMO-2601
// led by Pat Example `pe`; Lee Manager `lm` (Lab Manager); Taylor Bench `lt` (Lab Technician,
// added here); Alex Tester `tech` is an ordinary internal user with no lab role.
describe.runIf(testDatabaseUrl)('concrete test results (MM-V2-C07)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab' | 'lt' | 'anonymous';
  let ltId: string;

  const path = (specimenId: string, resultId?: string) =>
    `/api/concrete/specimens/${specimenId}/test-results${resultId ? `/${resultId}` : ''}`;

  const put = async (
    specimenId: string,
    resultId: string,
    body: Partial<ConcreteTestResultSaveRequest> & { [key: string]: unknown },
    as: Caller = 'lt',
  ) => {
    const req = h.http().put(path(specimenId, resultId)).set(CSRF_HEADER, '1');
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req.send(body);
  };
  const get = async (url: string, as: Caller = 'tech') => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  async function save(
    specimenId: string,
    resultId: string,
    body: Partial<ConcreteTestResultSaveRequest>,
    as: Caller = 'lt',
  ) {
    const response = await put(specimenId, resultId, { idempotencyKey: newKey(), ...body }, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteTestResultSaveResultSchema.parse(response.body);
  }

  async function castSet(): Promise<ConcreteSpecimenSetDetail> {
    const report = await h.send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      {
        idempotencyKey: newKey(),
        material: 'concrete',
        specimensCast: true,
        castAt: '2026-11-02T09:15:00-06:00',
      },
      cookies.tech!,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
    const set = await h.send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      cookies.tech!,
    );
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(set.body);
  }

  async function tallies() {
    const { rows } = await h.db.pool.query<{
      results: number;
      revisions: number;
      audit: number;
      versions: string;
    }>(
      `SELECT (SELECT count(*)::int FROM concrete_test_result) AS results,
              (SELECT count(*)::int FROM concrete_test_result_revision) AS revisions,
              (SELECT count(*)::int FROM audit_event WHERE entity_type = 'concrete_test_result')
                AS audit,
              (SELECT coalesce(string_agg(id || ':' || version || ':' || coalesce(max_load::text, '-'),
                 ',' ORDER BY id), '') FROM concrete_test_result) AS versions`,
    );
    return rows[0]!;
  }

  let set: ConcreteSpecimenSetDetail;
  let specimenA: string;
  let specimenB: string;
  let specimenC: string;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Taylor Bench', 'TB', 'personal', 'active') RETURNING id`,
    );
    ltId = rows[0]!.id;
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_technician')`,
      [ltId],
    );
    const session = await h.app.get(SessionService).create(ltId, 'personal');
    cookies.lt = `${SESSION_COOKIE}=${session.token}`;
    set = await castSet();
    [specimenA, specimenB, specimenC] = set.specimens.map((s) => s.id) as [string, string, string];
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC1/AC5: a partial draft persists as a draft, with provisional units and no strength or method', async () => {
    const resultId = randomUUID();
    const saved = await save(specimenA, resultId, { version: 0, maxLoad: 412.5 });
    expect(saved.created).toBe(true);
    expect(saved.result).toMatchObject({
      id: resultId,
      specimenId: specimenA,
      projectId: h.projects.a,
      attemptNo: 1,
      state: 'draft',
      testedOn: null,
      tester: { userId: ltId, initials: 'TB', name: 'Taylor Bench' },
      maxLoad: 412.5,
      heightReadings: [],
      diameterReadings: [],
      units: { load: 'kN', dimension: 'mm', provisional: true },
      notes: null,
      // No testing machine is registered here, and none is required.
      testingMachineId: null,
      calculationMethod: null,
      calculationMethodVersion: null,
      reportVersionId: null,
      version: 1,
    });
    expect(saved.result.revisions).toHaveLength(1);
    expect(saved.result.revisions[0]).toMatchObject({
      revisionNo: 1,
      kind: 'initial',
      reason: null,
      enteredBy: { userId: ltId, initials: 'TB' },
      account: { userId: ltId, accountType: 'personal' },
    });
    expect(saved.result.revisions[0]!.changes).toMatchObject({
      maxLoad: { before: null, after: 412.5 },
      tester: { before: null, after: { userId: ltId } },
    });
    // Nothing anywhere claims a strength or a completed test.
    const text = JSON.stringify(saved.result);
    expect(text).not.toMatch(/strength|completed|pass|fail/i);

    // Read back by anyone with the internal read, LAB included.
    const one = await get(path(specimenA, resultId), 'lab');
    expect(one.status).toBe(200);
    expect(concreteTestResultSchema.parse(one.body)).toEqual(saved.result);
    const list = await get(path(specimenA), 'tech');
    expect(list.status).toBe(200);
    const parsed = concreteSpecimenTestResultsSchema.parse(list.body);
    expect(parsed.results.map((r) => r.id)).toEqual([resultId]);
    expect((await get(path(specimenA), 'anonymous')).status).toBe(401);
  });

  it('filling empty fields is entry (no reason); a saved value needs a reason, and nothing is written without one (AC3)', async () => {
    const resultId = randomUUID();
    await save(specimenB, resultId, { version: 0, testedOn: '2026-11-30' });
    const entry = await save(specimenB, resultId, {
      version: 1,
      maxLoad: 398.2,
      heightReadings: [203.2, 203.5],
      diameterReadings: [101.6],
    });
    expect(entry.result.version).toBe(2);
    expect(entry.result.revisions[1]).toMatchObject({ kind: 'entry', reason: null });

    const before = await tallies();
    const refused = await put(specimenB, resultId, {
      idempotencyKey: newKey(),
      version: 2,
      maxLoad: 389.2,
      notes: 'Capped with sulphur',
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'reason_required', corrections: ['maxLoad'] });
    expect(await tallies()).toEqual(before);

    // Clearing a saved value is a correction too.
    const cleared = await put(specimenB, resultId, {
      idempotencyKey: newKey(),
      version: 2,
      diameterReadings: [],
    });
    expect(cleared.status).toBe(422);
    expect(cleared.body).toMatchObject({ corrections: ['diameterReadings'] });

    const corrected = await save(specimenB, resultId, {
      version: 2,
      maxLoad: 389.2,
      notes: 'Capped with sulphur',
      reason: 'Misread the dial; rechecked the machine log',
    });
    expect(corrected.result).toMatchObject({
      version: 3,
      maxLoad: 389.2,
      notes: 'Capped with sulphur',
    });
    const revision = corrected.result.revisions[2]!;
    expect(revision).toMatchObject({
      revisionNo: 3,
      kind: 'correction',
      reason: 'Misread the dial; rechecked the machine log',
      enteredBy: { userId: ltId },
    });
    expect(revision.changes).toEqual({
      maxLoad: { before: 398.2, after: 389.2 },
      notes: { before: null, after: 'Capped with sulphur' },
    });
    // Every version's values stay readable in the history.
    expect(corrected.result.revisions.map((r) => r.kind)).toEqual([
      'initial',
      'entry',
      'correction',
    ]);
    const { rows } = await h.db.pool.query<{ action: string; reason: string | null }>(
      `SELECT action, reason FROM audit_event WHERE entity_id = $1 ORDER BY occurred_at, id`,
      [resultId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'concrete_test_result.saved',
      'concrete_test_result.saved',
      'concrete_test_result.corrected',
    ]);
    expect(rows[2]!.reason).toBe('Misread the dial; rechecked the machine log');
  });

  it('AC4: an exact retry returns the same attempt; a reused key or a stale version writes nothing', async () => {
    const resultId = randomUUID();
    const key = newKey();
    const first = await put(specimenC, resultId, { idempotencyKey: key, version: 0, maxLoad: 401 });
    expect(first.status).toBe(200);
    const retried = await put(specimenC, resultId, {
      idempotencyKey: key,
      version: 0,
      maxLoad: 401,
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(first.body);

    const before = await tallies();
    const reused = await put(specimenC, resultId, {
      idempotencyKey: key,
      version: 0,
      maxLoad: 402,
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'idempotency_key_reused' });
    // The same key from another account is not a retry either.
    const otherAccount = await put(
      specimenC,
      resultId,
      { idempotencyKey: key, version: 0, maxLoad: 401 },
      'lm',
    );
    expect(otherAccount.status).toBe(409);

    // A second "first save" of the same attempt, or a save from a stale version, is a conflict.
    const again = await put(specimenC, resultId, {
      idempotencyKey: newKey(),
      version: 0,
      maxLoad: 7,
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'version_conflict',
      current: { version: 1, maxLoad: 401 },
    });
    const stale = await put(specimenC, resultId, {
      idempotencyKey: newKey(),
      version: 5,
      notes: 'From an old tab',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict' });
    expect(await tallies()).toEqual(before);
  });

  it('AC4: racing saves never create a second attempt or overwrite silently', async () => {
    const resultId = randomUUID();
    const key = newKey();
    const twins = await Promise.all([
      put(specimenC, resultId, { idempotencyKey: key, version: 0, heightReadings: [204] }),
      put(specimenC, resultId, { idempotencyKey: key, version: 0, heightReadings: [204] }),
    ]);
    expect(twins.map((r) => r.status)).toEqual([200, 200]);
    expect(twins[0]!.body).toEqual(twins[1]!.body);

    const rivals = await Promise.all([
      put(specimenC, resultId, { idempotencyKey: newKey(), version: 1, maxLoad: 300 }),
      put(specimenC, resultId, { idempotencyKey: newKey(), version: 1, maxLoad: 310 }),
    ]);
    expect(rivals.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await h.db.pool.query<{ count: number; version: number }>(
      `SELECT count(*)::int AS count, max(version) AS version FROM concrete_test_result
       WHERE specimen_id = $1`,
      [specimenC],
    );
    // specimenC holds the attempt from the previous test and this one: attempts 1 and 2.
    expect(rows[0]).toEqual({ count: 2, version: 2 });
    const list = concreteSpecimenTestResultsSchema.parse((await get(path(specimenC))).body);
    expect(list.results.map((r) => r.attemptNo)).toEqual([1, 2]);
  });

  it('AC2: LAB names who enters it; the recorded tester and test date survive a later default and edits', async () => {
    const missing = await put(
      specimenA,
      randomUUID(),
      { idempotencyKey: newKey(), version: 0, maxLoad: 380 },
      'lab',
    );
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      errors: [{ field: 'enteredByUserId', code: 'required' }],
    });

    // The station's page default tester is Lee Manager; Taylor Bench enters it.
    const first = randomUUID();
    const saved = await save(
      specimenA,
      first,
      {
        version: 0,
        enteredByUserId: ltId,
        testerUserId: h.users.lm,
        testedOn: '2026-11-30',
        maxLoad: 380,
      },
      'lab',
    );
    expect(saved.result).toMatchObject({
      attemptNo: 2,
      tester: { userId: h.users.lm, initials: 'LM' },
      testedOn: '2026-11-30',
    });
    expect(saved.result.revisions[0]).toMatchObject({
      enteredBy: { userId: ltId, name: 'Taylor Bench' },
      account: { userId: h.users.lab, accountType: 'shared_lab' },
    });

    // The default changes to Jordan Smith for the next specimen: the first result keeps its tester.
    await save(
      specimenB,
      randomUUID(),
      { version: 0, enteredByUserId: ltId, testerUserId: h.users.js, testedOn: '2026-12-01' },
      'lab',
    );
    const edited = await save(
      specimenA,
      first,
      { version: 1, enteredByUserId: ltId, heightReadings: [203.1] },
      'lab',
    );
    expect(edited.result).toMatchObject({
      tester: { userId: h.users.lm },
      testedOn: '2026-11-30',
      heightReadings: [203.1],
    });
    // A changed display name later doesn't rewrite the recorded tester.
    await h.db.pool.query(`UPDATE app_user SET display_name = 'Lee Renamed' WHERE id = $1`, [
      h.users.lm,
    ]);
    const reread = concreteTestResultSchema.parse((await get(path(specimenA, first))).body);
    expect(reread.tester).toMatchObject({ name: 'Lee Manager' });
    await h.db.pool.query(`UPDATE app_user SET display_name = 'Lee Manager' WHERE id = $1`, [
      h.users.lm,
    ]);

    // Changing the saved tester or test date is a correction like any other.
    const noReason = await put(
      specimenA,
      first,
      { idempotencyKey: newKey(), version: 2, enteredByUserId: ltId, testerUserId: h.users.js },
      'lab',
    );
    expect(noReason.status).toBe(422);
    expect(noReason.body).toMatchObject({ corrections: ['tester'] });
    const fixed = await save(
      specimenA,
      first,
      {
        version: 2,
        enteredByUserId: ltId,
        testerUserId: h.users.js,
        testedOn: '2026-11-29',
        reason: 'Jordan ran this break',
      },
      'lab',
    );
    expect(fixed.result.revisions[2]!.changes).toEqual({
      testedOn: { before: '2026-11-30', after: '2026-11-29' },
      tester: {
        before: { userId: h.users.lm, initials: 'LM', name: 'Lee Manager' },
        after: { userId: h.users.js, initials: 'JS', name: 'Jordan Smith' },
      },
    });
  });

  it('only lab staff save results; LAB attribution grants nothing; testers are active staff', async () => {
    const body = { idempotencyKey: newKey(), version: 0, maxLoad: 350 };
    // An ordinary internal user and the project lead hold no lab role.
    expect((await put(specimenB, randomUUID(), body, 'tech')).status).toBe(403);
    expect((await put(specimenB, randomUUID(), body, 'pe')).status).toBe(403);
    expect((await put(specimenB, randomUUID(), body, 'anonymous')).status).toBe(401);
    // A Lab Manager may.
    await save(specimenB, randomUUID(), { version: 0, maxLoad: 350 }, 'lm');
    // LAB naming an ordinary internal user is attribution only, recorded as such.
    const named = await save(
      specimenB,
      randomUUID(),
      { version: 0, enteredByUserId: h.users.tech },
      'lab',
    );
    expect(named.result.revisions[0]!.enteredBy.userId).toBe(h.users.tech);
    expect(named.result.tester?.userId).toBe(h.users.tech);

    // A personal account never names someone else as the one entering it.
    const other = await put(specimenB, randomUUID(), {
      ...body,
      idempotencyKey: newKey(),
      enteredByUserId: h.users.lm,
    });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({
      errors: [{ field: 'enteredByUserId', code: 'not_allowed' }],
    });

    for (const tester of [h.users.noInitials, h.users.disabled, h.users.lab, randomUUID()]) {
      const response = await put(specimenB, randomUUID(), {
        ...body,
        idempotencyKey: newKey(),
        testerUserId: tester,
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'tester_invalid' });
    }

    // Unknown specimens and attempts; an attempt ID belongs to one specimen only.
    expect((await put(randomUUID(), randomUUID(), body)).status).toBe(404);
    expect((await get(path(randomUUID()))).status).toBe(404);
    expect((await get(path(specimenA, randomUUID()))).status).toBe(404);
    const taken = randomUUID();
    await save(specimenA, taken, { version: 0 });
    const elsewhere = await put(specimenB, taken, { ...body, idempotencyKey: newKey() });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body).toMatchObject({ code: 'result_id_taken' });
    expect((await get(path(specimenB, taken))).status).toBe(404);

    // Validation: no zero readings, no completed state or strength.
    const zero = await put(specimenB, randomUUID(), {
      ...body,
      idempotencyKey: newKey(),
      maxLoad: 0,
    });
    expect(zero.status).toBe(400);
    const completed = await put(specimenB, randomUUID(), {
      ...body,
      idempotencyKey: newKey(),
      state: 'completed',
      strength: 31.2,
    });
    expect(completed.status).toBe(400);
  });

  it('a registered testing machine is referenced; a void set refuses new results', async () => {
    const machine = await h.send(
      'post',
      '/api/concrete/testing-machine',
      { kind: 'testing_machine', make: 'Example', model: 'Press 1', idempotencyKey: newKey() },
      cookies.lm!,
    );
    expect(machine.status, JSON.stringify(machine.body)).toBe(201);
    const withMachine = await save(specimenB, randomUUID(), { version: 0, maxLoad: 360 });
    expect(withMachine.result.testingMachineId).toBe((machine.body as { id: string }).id);

    const voided = await castSet();
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = 90, permanent_id = '26-90' WHERE id = $1`,
      [voided.id],
    );
    await h.db.pool.query(
      `UPDATE concrete_specimen_set
       SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Cast in error' WHERE id = $1`,
      [voided.id, h.users.pe],
    );
    const refused = await put(voided.specimens[0]!.id, randomUUID(), {
      idempotencyKey: newKey(),
      version: 0,
      maxLoad: 300,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'set_void' });
  });
});
