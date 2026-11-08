import { randomUUID } from 'node:crypto';
import {
  concreteCastingCorrectionResultSchema,
  concreteFieldReportDetailSchema,
  concreteMixDetailSchema,
  concreteSpecimenSetDefaultsSchema,
  concreteSpecimenSetDetailSchema,
  concreteSpecimenSetListSchema,
  concreteSpecimenSetVersionConflictResponseSchema,
  type ConcreteFieldReportDetail,
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

// MM-V2-C05: specimen sets, age assignments and stable identity records (card AC1–AC5; test plan
// T1, T2). Real PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A, led by Pat
// Example `pe`), DEMO-2602 (B); invented suppliers, mixes and people. Permanent numbers are
// attached with SQL, standing in for C18's allocator, which doesn't exist yet.
describe.runIf(testDatabaseUrl)('concrete specimen sets (MM-V2-C05)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};

  type Caller = PersonKey | 'lab' | 'anonymous';

  const get = async (url: string, as: Caller = 'tech') => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  const send = async (
    method: 'post' | 'patch' | 'delete',
    url: string,
    body: unknown,
    as: Caller = 'tech',
  ) => {
    const req = h.http()[method](url).set(CSRF_HEADER, '1');
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req.send(body as object);
  };
  const setsPath = (reportId: string) => `/api/concrete/field-reports/${reportId}/specimen-sets`;
  const setPath = (id: string) => `/api/concrete/specimen-sets/${id}`;
  const correctionPath = (reportId: string) =>
    `/api/concrete/field-reports/${reportId}/casting-correction`;

  async function report(
    body: Record<string, unknown> = {},
    as: Caller = 'tech',
    projectId = h.projects.a,
  ): Promise<ConcreteFieldReportDetail> {
    const response = await send(
      'post',
      `/api/concrete/projects/${projectId}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', specimensCast: true, ...body },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  async function readReport(id: string) {
    const response = await get(`/api/concrete/field-reports/${id}`);
    expect(response.status).toBe(200);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  async function createSet(
    reportId: string,
    body: Record<string, unknown> = {},
    as: Caller = 'tech',
  ): Promise<ConcreteSpecimenSetDetail> {
    const response = await send(
      'post',
      setsPath(reportId),
      { idempotencyKey: newKey(), ...body },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(response.body);
  }

  async function readSet(id: string, as: Caller = 'tech') {
    const response = await get(setPath(id), as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteSpecimenSetDetailSchema.parse(response.body);
  }

  const rows = (...ages: (number | 'HOLD' | null)[]) =>
    ages.map((age) => ({ id: randomUUID(), age }));

  const summary = (set: ConcreteSpecimenSetDetail) =>
    set.specimens.map((s) => [s.letter, s.assignedAge]);

  async function counts() {
    const { rows: out } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_specimen_set) AS sets,
              (SELECT count(*)::int FROM concrete_specimen) AS specimens,
              (SELECT count(*)::int FROM concrete_specimen_set_command) AS commands,
              (SELECT count(*)::int FROM concrete_casting_correction) AS corrections,
              (SELECT count(*)::int FROM audit_event
               WHERE entity_type IN ('concrete_specimen_set', 'concrete_field_report')) AS audit`,
    );
    return out[0] as {
      sets: number;
      specimens: number;
      commands: number;
      corrections: number;
      audit: number;
    };
  }

  let numberCounter = 0;
  /** Stand-in for C18: attach the project's next permanent number to a set. */
  async function attachNumber(setId: string, prefix = '26') {
    numberCounter += 1;
    await h.db.pool.query(
      `UPDATE concrete_specimen_set
       SET permanent_number = $2, permanent_id = $3, temporary_id = $4 WHERE id = $1`,
      [
        setId,
        numberCounter,
        `${prefix}-${String(numberCounter).padStart(2, '0')}`,
        `TMP-D07-${String(numberCounter).padStart(3, '0')}`,
      ],
    );
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'js', 'lab', 'disabled'] as const) {
      cookies[key] = await h.cookie(key);
    }
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // AC1–AC3: count follows the populated assignments
  // ---------------------------------------------------------------------------------------------

  it('AC1: the lab default 7/28/28/HOLD stores four distinct specimens; count is four', async () => {
    const r = await report({ castAt: '2026-11-02T09:15:00-06:00' });
    const defaults = concreteSpecimenSetDefaultsSchema.parse(
      (await get(`/api/concrete/field-reports/${r.id}/specimen-set-defaults`)).body,
    );
    expect(defaults).toMatchObject({
      schedule: { ages: [7, 28, 28, 'HOLD'], source: 'lab_default', holdDurationDays: 56 },
      specimenType: 'cylinder',
      mouldSize: '150x300',
    });
    const before = await counts();
    const set = await createSet(r.id);
    expect(set).toMatchObject({
      fieldReportId: r.id,
      projectId: h.projects.a,
      specimenType: 'cylinder',
      mouldSize: '150x300',
      castingDate: '2026-11-02',
      specimenCount: 4,
      identity: { temporaryId: null, permanentId: null, permanentNumber: null },
      defaultSchedule: {
        ages: [7, 28, 28, 'HOLD'],
        source: 'lab_default',
        mixRevisionId: null,
        holdDurationDays: 56,
        holdDurationSource: 'lab_default',
      },
      technician: { userId: h.users.tech },
      createdBy: { userId: h.users.tech },
      void: null,
      version: 1,
      canEdit: true,
    });
    expect(summary(set)).toEqual([
      ['A', 7],
      ['B', 28],
      ['C', 28],
      ['D', 'HOLD'],
    ]);
    expect(new Set(set.specimens.map((s) => s.id)).size).toBe(4);
    expect(set.specimens.map((s) => [s.targetDate, s.holdExpiresOn])).toEqual([
      ['2026-11-09', null],
      ['2026-11-30', null],
      ['2026-11-30', null],
      [null, '2026-12-28'],
    ]);
    // No identity alias exists until C12/C18 attach one.
    expect(set.specimens.every((s) => s.identity.permanentId === null)).toBe(true);
    expect(await counts()).toEqual({
      ...before,
      sets: before.sets + 1,
      specimens: before.specimens + 4,
      commands: before.commands + 1,
      audit: before.audit + 1,
    });
    // The report's review now checks set detail itself: nothing set-related is missing.
    const detail = await readReport(r.id);
    expect(detail.completeness.missingRequired.filter((p) => p.startsWith('specimenSets'))).toEqual(
      [],
    );
    expect(detail.review.deferredChecks.map((c) => c.owner)).not.toContain('C05');
  });

  it('AC2: blank rows are dropped, an added row counts, and there is no count input', async () => {
    const r = await report();
    const set = await createSet(r.id, { specimens: rows(7, null, 28, 28, null, 'HOLD', 56) });
    expect(set.specimenCount).toBe(5);
    expect(summary(set)).toEqual([
      ['A', 7],
      ['B', 28],
      ['C', 28],
      ['D', 'HOLD'],
      ['E', 56],
    ]);
    // Dates are unknown until the report's casting time is.
    expect(set.specimens.every((s) => s.targetDate === null && s.holdExpiresOn === null)).toBe(
      true,
    );

    // A save with an extra row and a blank one: the count follows; kept rows keep their ids.
    const kept = set.specimens.slice(0, 2).map((s) => ({ id: s.id, age: s.assignedAge }));
    const next = [...kept, { id: randomUUID(), age: null }, { id: randomUUID(), age: 91 }];
    const saved = await send('patch', setPath(set.id), {
      idempotencyKey: newKey(),
      version: set.version,
      specimens: next,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = concreteSpecimenSetDetailSchema.parse(saved.body);
    expect(after.specimenCount).toBe(3);
    expect(summary(after)).toEqual([
      ['A', 7],
      ['B', 28],
      ['C', 91],
    ]);
    expect(after.specimens.slice(0, 2).map((s) => s.id)).toEqual(kept.map((k) => k.id));
    expect(after.version).toBe(2);

    const counted = await send('post', setsPath(r.id), { idempotencyKey: newKey(), count: 4 });
    expect(counted.status).toBe(400);
    const tooMany = await send('post', setsPath(r.id), {
      idempotencyKey: newKey(),
      specimens: rows(...Array<number>(27).fill(28)),
    });
    expect(tooMany.status).toBe(400);
  });

  it('AC3: no specimens → no specimen rows and no numbers; Specimens cast = No refuses a set', async () => {
    const r = await report();
    const before = await counts();
    const empty = await createSet(r.id, { specimens: rows(null, null) });
    expect(empty.specimenCount).toBe(0);
    expect(empty.specimens).toEqual([]);
    expect(empty.identity).toEqual({ temporaryId: null, permanentId: null, permanentNumber: null });
    expect((await counts()).specimens).toBe(before.specimens);
    // Cast yes with only an empty set: the review still wants specimens.
    expect((await readReport(r.id)).completeness.missingRequired).toContain('specimenSets');

    const notCast = await report({ specimensCast: false });
    const refused = await send('post', setsPath(notCast.id), { idempotencyKey: newKey() });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'specimens_not_cast' });
    const { rows: numbers } = await h.db.pool.query(
      'SELECT count(*)::int AS n FROM concrete_specimen_set WHERE permanent_number IS NOT NULL',
    );
    expect(numbers[0].n).toBe(numberCounter);
  });

  it('changing Specimens cast to No keeps the specimens and warns (nothing silently deleted)', async () => {
    const r = await report();
    const set = await createSet(r.id);
    const saved = await send('patch', `/api/concrete/field-reports/${r.id}`, {
      idempotencyKey: newKey(),
      version: r.version,
      specimensCast: false,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const detail = concreteFieldReportDetailSchema.parse(saved.body);
    expect(detail.review.warnings.map((w) => w.code)).toContain('specimens_recorded_but_not_cast');
    expect((await readSet(set.id)).specimenCount).toBe(4);
  });

  // ---------------------------------------------------------------------------------------------
  // AC4: saved schedules never recalculate
  // ---------------------------------------------------------------------------------------------

  it('AC4: a project-settings change leaves saved assignments and the snapshot unchanged', async () => {
    const settingsPath = `/api/projects/${h.projects.b}/concrete-settings`;
    const first = await send(
      'patch',
      settingsPath,
      { version: 0, defaultSpecimenAges: [3, 7, 28, 'HOLD'], holdDurationDays: 90 },
      'pe',
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const r = await report({ castAt: '2026-11-02T09:00:00-06:00' }, 'tech', h.projects.b);
    const set = await createSet(r.id);
    expect(set.defaultSchedule).toMatchObject({
      ages: [3, 7, 28, 'HOLD'],
      source: 'project',
      holdDurationDays: 90,
      holdDurationSource: 'project',
    });
    expect(set.specimens.at(-1)!.holdExpiresOn).toBe('2027-01-31');

    const second = await send(
      'patch',
      settingsPath,
      {
        version: (first.body as { version: number }).version,
        defaultSpecimenAges: [28],
        holdDurationDays: 30,
      },
      'pe',
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await readSet(set.id)).toEqual(set);
  });

  it('AC4: the mix overrides the project; a later mix edit never re-schedules the set', async () => {
    const created = await send(
      'post',
      `/api/projects/${h.projects.a}/concrete-mixes`,
      {
        idempotencyKey: newKey(),
        spec: {
          supplierName: 'Example Ready-Mix',
          mixNumber: '0542',
          plantNames: ['North Plant'],
          specifiedStrengthMpa: 32,
          slumpTargetMm: 80,
          slumpToleranceMm: 30,
          airMinPercent: 5,
          airMaxPercent: 8,
          maxAggregateSizeMm: 20,
          cementType: 'GU',
          testAges: [7, 7, 28, 56, 'HOLD'],
        },
      },
      'pe',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const mix = concreteMixDetailSchema.parse(created.body);
    const r = await report({ mixId: mix.id });
    const set = await createSet(r.id);
    expect(set.defaultSchedule).toMatchObject({
      ages: [7, 7, 28, 56, 'HOLD'],
      source: 'mix',
      mixRevisionId: mix.draftRevision!.id,
    });
    expect(set.specimenCount).toBe(5);

    const edited = await send(
      'patch',
      `/api/concrete-mixes/${mix.id}`,
      { idempotencyKey: newKey(), version: mix.version, spec: { testAges: [28] } },
      'pe',
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await readSet(set.id)).toEqual(set);
  });

  // ---------------------------------------------------------------------------------------------
  // Retries, versions, ownership and authority (T2)
  // ---------------------------------------------------------------------------------------------

  it('an exact retry returns the same set once; a reused key with another body is refused', async () => {
    const r = await report();
    const key = newKey();
    const id = randomUUID();
    const body = { idempotencyKey: key, id, specimens: rows(7, 28) };
    const first = await send('post', setsPath(r.id), body);
    expect(first.status).toBe(201);
    const before = await counts();
    const again = await send('post', setsPath(r.id), body);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await counts()).toEqual(before);
    const reused = await send('post', setsPath(r.id), { ...body, specimens: rows(28) });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'idempotency_key_reused' });
    const taken = await send('post', setsPath(r.id), { idempotencyKey: newKey(), id });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'set_id_taken' });
    expect(await counts()).toEqual(before);
  });

  it('a save from an old version conflicts without writing; a foreign specimen id is refused', async () => {
    const r = await report();
    const set = await createSet(r.id);
    const ok = await send('patch', setPath(set.id), {
      idempotencyKey: newKey(),
      version: 1,
      mouldSize: '100x200',
    });
    expect(ok.status).toBe(200);
    const before = await counts();
    const stale = await send('patch', setPath(set.id), {
      idempotencyKey: newKey(),
      version: 1,
      mouldSize: '150x300',
    });
    expect(stale.status).toBe(409);
    const conflict = concreteSpecimenSetVersionConflictResponseSchema.parse(stale.body);
    expect(conflict.current).toMatchObject({ version: 2, mouldSize: '100x200' });
    expect(await counts()).toEqual(before);

    const other = await createSet((await report()).id);
    const beforeForeign = await counts();
    const foreign = await send('patch', setPath(set.id), {
      idempotencyKey: newKey(),
      version: 2,
      specimens: [{ id: other.specimens[0]!.id, age: 7 }],
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ code: 'specimen_id_taken' });
    expect(await counts()).toEqual(beforeForeign);
  });

  it('own drafts only; LAB names the technician; inactive and anonymous callers are refused', async () => {
    const r = await report();
    const mine = await send('post', setsPath(r.id), { idempotencyKey: newKey() }, 'js');
    expect(mine.status).toBe(403);
    expect(mine.body).toMatchObject({ code: 'not_own_draft' });
    const lead = await send('post', setsPath(r.id), { idempotencyKey: newKey() }, 'pe');
    expect(lead.status).toBe(403);

    const unnamed = await send('post', setsPath(r.id), { idempotencyKey: newKey() }, 'lab');
    expect(unnamed.status).toBe(400);
    const wrong = await send(
      'post',
      setsPath(r.id),
      { idempotencyKey: newKey(), technicianUserId: h.users.js },
      'lab',
    );
    expect(wrong.status).toBe(403);
    const atStation = await createSet(r.id, { technicianUserId: h.users.tech }, 'lab');
    expect(atStation).toMatchObject({
      technician: { userId: h.users.tech },
      createdBy: { userId: h.users.lab },
    });
    const { rows: audit } = await h.db.pool.query(
      `SELECT actor_user_id, receiver_user_id FROM audit_event
       WHERE entity_id = $1 AND action = 'concrete_specimen_set.created'`,
      [atStation.id],
    );
    expect(audit).toEqual([{ actor_user_id: h.users.lab, receiver_user_id: h.users.tech }]);

    expect(
      (await send('post', setsPath(r.id), { idempotencyKey: newKey() }, 'disabled')).status,
    ).toBe(401);
    expect(
      (await send('post', setsPath(r.id), { idempotencyKey: newKey() }, 'anonymous')).status,
    ).toBe(401);
    expect((await get(setPath(atStation.id), 'anonymous')).status).toBe(401);
    // Reads follow the project: LAB and other staff read the set.
    expect((await readSet(atStation.id, 'lab')).canEdit).toBe(true);
    expect((await readSet(atStation.id, 'js')).canEdit).toBe(false);
  });

  it('a submitted report refuses set edits; an unknown report or set is 404', async () => {
    const r = await report();
    const set = await createSet(r.id);
    await h.db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [r.id],
    );
    const refused = await send('patch', setPath(set.id), {
      idempotencyKey: newKey(),
      version: 1,
      mouldSize: '100x200',
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'not_a_draft' });
    expect((await readSet(set.id)).canEdit).toBe(false);
    expect((await send('post', setsPath(randomUUID()), { idempotencyKey: newKey() })).status).toBe(
      404,
    );
    expect((await get(setPath(randomUUID()))).status).toBe(404);
  });

  it('discarding an unnumbered draft set removes it once; a numbered set stays', async () => {
    const r = await report();
    const set = await createSet(r.id);
    const key = newKey();
    const before = await counts();
    const gone = await send('delete', setPath(set.id), { idempotencyKey: key, version: 1 });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body).toEqual({ id: set.id, discarded: true });
    const again = await send('delete', setPath(set.id), { idempotencyKey: key, version: 1 });
    expect(again.status).toBe(200);
    expect(await counts()).toEqual({
      ...before,
      sets: before.sets - 1,
      specimens: before.specimens - 4,
      commands: before.commands + 1,
      audit: before.audit + 1,
    });
    expect((await get(setPath(set.id))).status).toBe(404);

    const kept = await createSet(r.id);
    await attachNumber(kept.id);
    const refused = await send('delete', setPath(kept.id), {
      idempotencyKey: newKey(),
      version: 1,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'set_numbered' });
    expect((await readSet(kept.id)).specimenCount).toBe(4);
  });

  // ---------------------------------------------------------------------------------------------
  // Numbered sets and AC5
  // ---------------------------------------------------------------------------------------------

  it('a numbered set keeps its letters and ages; mould detail still edits', async () => {
    const r = await report();
    const set = await createSet(r.id);
    await attachNumber(set.id);
    const numbered = await readSet(set.id);
    expect(numbered.identity.permanentId).toMatch(/^26-\d{2,}$/);
    expect(numbered.specimens[0]!.identity.permanentId).toBe(`${numbered.identity.permanentId}A`);
    expect(numbered.specimens[0]!.identity.temporaryId).toBe(`${numbered.identity.temporaryId}A`);
    expect(numbered.canEdit).toBe(false);
    const reschedule = await send('patch', setPath(set.id), {
      idempotencyKey: newKey(),
      version: numbered.version,
      specimens: rows(28, 28),
    });
    expect(reschedule.status).toBe(409);
    expect(reschedule.body).toMatchObject({ code: 'set_numbered' });
    const mould = await send('patch', setPath(set.id), {
      idempotencyKey: newKey(),
      version: numbered.version,
      mouldSize: '100x200',
    });
    expect(mould.status, JSON.stringify(mould.body)).toBe(200);
    expect(summary(concreteSpecimenSetDetailSchema.parse(mould.body))).toEqual(summary(numbered));
  });

  it('AC5: after numbering, a casting correction returns its effects, then applies with IDs stable', async () => {
    const castAt = '2026-12-31T10:00:00-06:00';
    const r = await report({ castAt });
    const set = await createSet(r.id);
    await attachNumber(set.id);
    const numbered = await readSet(set.id);
    const current = await readReport(r.id);

    // The draft save path refuses: casting now changes only through a recorded correction.
    const viaDraft = await send('patch', `/api/concrete/field-reports/${r.id}`, {
      idempotencyKey: newKey(),
      version: current.version,
      castAt: '2027-01-02T10:00:00-06:00',
    });
    expect(viaDraft.status).toBe(409);
    expect(viaDraft.body).toMatchObject({ code: 'casting_correction_required' });

    const body = {
      idempotencyKey: newKey(),
      version: current.version,
      castAt: '2027-01-02T10:00:00-06:00',
      reason: 'Casting date misread from the field sheet',
    };
    // Authority: the technician and LAB can't; the lead can (owner to confirm the action).
    expect(
      (await send('post', correctionPath(r.id), { ...body, confirm: false }, 'tech')).status,
    ).toBe(403);
    expect(
      (await send('post', correctionPath(r.id), { ...body, confirm: false }, 'lab')).status,
    ).toBe(403);
    expect(
      (await send('post', correctionPath(randomUUID()), { ...body, confirm: false }, 'tech'))
        .status,
    ).toBe(403);
    expect(
      (await send('post', correctionPath(r.id), { ...body, reason: ' ', confirm: true }, 'pe'))
        .status,
    ).toBe(400);

    const before = await counts();
    const preview = await send('post', correctionPath(r.id), { ...body, confirm: false }, 'pe');
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    const effects = concreteCastingCorrectionResultSchema.parse(preview.body);
    expect(effects).toMatchObject({
      applied: false,
      previousCastAt: new Date(castAt).toISOString(),
      castingYearDiffers: [
        { setId: set.id, permanentId: numbered.identity.permanentId, castingYear: 2027 },
      ],
      reportVersion: current.version,
    });
    expect(effects.effects.map((e) => [e.letter, e.before, e.after])).toEqual([
      [
        'A',
        { targetDate: '2027-01-07', holdExpiresOn: null },
        { targetDate: '2027-01-09', holdExpiresOn: null },
      ],
      [
        'B',
        { targetDate: '2027-01-28', holdExpiresOn: null },
        { targetDate: '2027-01-30', holdExpiresOn: null },
      ],
      [
        'C',
        { targetDate: '2027-01-28', holdExpiresOn: null },
        { targetDate: '2027-01-30', holdExpiresOn: null },
      ],
      [
        'D',
        { targetDate: null, holdExpiresOn: '2027-02-25' },
        { targetDate: null, holdExpiresOn: '2027-02-27' },
      ],
    ]);
    expect(effects.effects[0]!.permanentId).toBe(`${numbered.identity.permanentId}A`);
    expect(await counts()).toEqual(before);
    expect(await readSet(set.id)).toEqual(numbered);

    const applied = await send('post', correctionPath(r.id), { ...body, confirm: true }, 'pe');
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const result = concreteCastingCorrectionResultSchema.parse(applied.body);
    expect(result).toMatchObject({ applied: true, reportVersion: current.version + 1 });
    expect(result.effects).toEqual(effects.effects);
    const after = await readSet(set.id);
    expect(after.identity).toEqual(numbered.identity);
    expect(after.specimens.map((s) => s.identity)).toEqual(
      numbered.specimens.map((s) => s.identity),
    );
    expect(summary(after)).toEqual(summary(numbered));
    expect(after.castingDate).toBe('2027-01-02');
    expect(after.specimens.map((s) => s.targetDate ?? s.holdExpiresOn)).toEqual([
      '2027-01-09',
      '2027-01-30',
      '2027-01-30',
      '2027-02-27',
    ]);
    // The weekend target (Saturday 9 January 2027) is kept and flagged.
    expect(after.specimens[0]!.flags).toEqual(['weekend_target']);
    expect(await counts()).toEqual({
      ...before,
      corrections: before.corrections + 1,
      audit: before.audit + 1,
    });
    const { rows: audit } = await h.db.pool.query(
      `SELECT reason, before_values, after_values FROM audit_event
       WHERE entity_id = $1 AND action = 'concrete_field_report.casting_corrected'`,
      [r.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      reason: body.reason,
      before_values: { castAt: new Date(castAt).toISOString() },
    });

    // An exact retry returns the same result without a second correction or event.
    const retry = await send('post', correctionPath(r.id), { ...body, confirm: true }, 'pe');
    expect(retry.status).toBe(201);
    expect(concreteCastingCorrectionResultSchema.parse(retry.body).effects).toEqual(result.effects);
    expect((await counts()).corrections).toBe(before.corrections + 1);
    const reused = await send(
      'post',
      correctionPath(r.id),
      { ...body, castAt: '2027-01-03T10:00:00-06:00', confirm: true },
      'pe',
    );
    expect(reused.status).toBe(409);
    // A stale version conflicts.
    const stale = await send(
      'post',
      correctionPath(r.id),
      { ...body, idempotencyKey: newKey(), castAt: '2027-01-03T10:00:00-06:00', confirm: false },
      'pe',
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict' });
  });

  it('a report without a numbered set corrects casting on its draft, not through the correction', async () => {
    const r = await report({ castAt: '2026-11-02T09:00:00-06:00' });
    const set = await createSet(r.id);
    const correction = await send(
      'post',
      correctionPath(r.id),
      {
        idempotencyKey: newKey(),
        version: r.version,
        castAt: '2026-11-03T09:00:00-06:00',
        reason: 'Wrong day',
        confirm: false,
      },
      'pe',
    );
    expect(correction.status).toBe(409);
    expect(correction.body).toMatchObject({ code: 'no_numbered_set' });
    const saved = await send('patch', `/api/concrete/field-reports/${r.id}`, {
      idempotencyKey: newKey(),
      version: r.version,
      castAt: '2026-11-03T09:00:00-06:00',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // Dates follow the draft's casting time; the saved ages don't change.
    const after = await readSet(set.id);
    expect(summary(after)).toEqual(summary(set));
    expect(after.specimens[0]!.targetDate).toBe('2026-11-10');
  });

  it('lists a report’s sets in creation order', async () => {
    const r = await report();
    const a = await createSet(r.id);
    const b = await createSet(r.id, { specimens: rows(28) });
    const list = concreteSpecimenSetListSchema.parse((await get(setsPath(r.id), 'lab')).body);
    expect(list.items.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(list.items.map((s) => s.specimenCount)).toEqual([4, 1]);
  });
});
