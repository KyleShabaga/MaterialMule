import {
  concreteFieldReportDetailSchema,
  concreteFieldReportListSchema,
  concreteMixDetailSchema,
  concreteMixPropagationPreviewSchema,
  concreteMixPropagationResultSchema,
  concreteProjectSetListSchema,
  concreteProjectSetStatus,
  concreteProjectSpecimenListSchema,
  concreteSpecimenSetDetailSchema,
  type ConcreteFieldReportDetail,
  type ConcreteMixDetail,
  type ConcreteMixPropagationPreview,
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

// MM-V2-C30 test plan T1: the mix propagation review (preview, per-item and Approve-all
// decisions, history, refusals) and the Specimens / Reports tab reads. Real PostgreSQL, direct API
// calls. Fictional data only: DEMO-2601 (A, led by Pat Example `pe`); invented suppliers and mixes.
describe.runIf(testDatabaseUrl)('concrete mix propagation (MM-V2-C30)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab';

  const get = async (url: string, as: Caller = 'pe') =>
    h.http().get(url).set('Cookie', cookies[as]!);
  const send = async (method: 'post' | 'patch', url: string, body: unknown, as: Caller = 'pe') =>
    h
      .http()
      [method](url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as]!)
      .send(body as object);
  const propagationPath = (mixId: string) => `/api/concrete-mixes/${mixId}/propagation`;

  const fullSpec = {
    plantNames: ['North Plant'],
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    airMinPercent: 5,
    airMaxPercent: 8,
    maxAggregateSizeMm: 20,
    cementType: 'GU',
    testAges: [7, 28, 28, 'HOLD'],
  };

  async function approvedMix(mixNumber: string): Promise<ConcreteMixDetail> {
    const created = await send('post', `/api/projects/${h.projects.a}/concrete-mixes`, {
      idempotencyKey: newKey(),
      spec: { supplierName: 'Example Ready-Mix', mixNumber, ...fullSpec },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const mix = concreteMixDetailSchema.parse(created.body);
    return approve(mix);
  }

  async function approve(mix: ConcreteMixDetail): Promise<ConcreteMixDetail> {
    const approved = await send('post', `/api/concrete-mixes/${mix.id}/approve`, {
      idempotencyKey: newKey(),
      version: mix.version,
      revisionId: mix.draftRevision!.id,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    return concreteMixDetailSchema.parse(approved.body);
  }

  async function revise(mix: ConcreteMixDetail, spec: Record<string, unknown>) {
    const edited = await send('patch', `/api/concrete-mixes/${mix.id}`, {
      idempotencyKey: newKey(),
      version: mix.version,
      spec,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    return approve(concreteMixDetailSchema.parse(edited.body));
  }

  async function report(body: Record<string, unknown>): Promise<ConcreteFieldReportDetail> {
    const response = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', specimensCast: true, ...body },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  async function readReport(id: string) {
    return concreteFieldReportDetailSchema.parse(
      (await get(`/api/concrete/field-reports/${id}`)).body,
    );
  }

  async function createSet(reportId: string): Promise<ConcreteSpecimenSetDetail> {
    const response = await send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(response.body);
  }

  async function preview(mixId: string, as: Caller = 'pe'): Promise<ConcreteMixPropagationPreview> {
    const response = await get(propagationPath(mixId), as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteMixPropagationPreviewSchema.parse(response.body);
  }

  async function counts() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM audit_event) AS audit,
              (SELECT count(*)::int FROM concrete_specimen_reschedule) AS reschedules`,
    );
    return rows[0] as { audit: number; reschedules: number };
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'admin', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC1: the Lead applies only the chosen records; history records the selected scope', async () => {
    const mix = await approvedMix('C30-01');
    const draftA = await report({
      mixId: mix.id,
      applyMixDefaults: true,
      reportDate: '2026-11-02',
      ticketNumber: 'T-3001',
      castAt: '2026-11-02T09:15:00-06:00',
    });
    const draftB = await report({
      mixId: mix.id,
      applyMixDefaults: true,
      reportDate: '2026-11-03',
    });
    const edited = await report({
      mixId: mix.id,
      applyMixDefaults: true,
      reportDate: '2026-11-04',
      projectSpec: { slumpTargetMm: 90 },
    });
    const submitted = await report({ mixId: mix.id, applyMixDefaults: true });
    await h.db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [submitted.id],
    );
    const set = await createSet(draftA.id);
    // Stand-in for C18: a numbered set, so the age change goes through C22's history.
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = 7, permanent_id = '26-07' WHERE id = $1`,
      [set.id],
    );

    const nothingYet = await preview(mix.id);
    expect(nothingYet.items).toEqual([]);

    const revised = await revise(mix, { slumpTargetMm: 100, testAges: [3, 28, 28, 'HOLD'] });
    const shown = await preview(revised.id);
    expect(shown).toMatchObject({ toRevisionNumber: 2, canApply: true, truncated: false });
    const byRecord = new Map(shown.items.map((item) => [item.recordId, item]));
    expect(byRecord.get(draftA.id)).toMatchObject({
      eligible: true,
      fromRevisionNumber: 1,
      changes: [
        { field: 'projectSpec.slumpTargetMm', before: 80, proposed: 100 },
        { field: 'mixRevision', before: 1, proposed: 2 },
      ],
    });
    expect(byRecord.get(edited.id)).toMatchObject({
      eligible: true,
      kept: [{ field: 'projectSpec.slumpTargetMm', before: 90, proposed: 100 }],
      changes: [{ field: 'mixRevision' }],
    });
    expect(byRecord.get(submitted.id)).toMatchObject({
      eligible: false,
      ineligibleReason: 'report_submitted',
    });
    const specimenA = set.specimens.find((s) => s.letter === 'A')!;
    expect(byRecord.get(specimenA.id)).toMatchObject({
      recordType: 'specimen',
      recordLabel: '26-07A',
      eligible: true,
      changes: [{ field: 'assignedAge', before: 7, proposed: 3 }],
    });
    // Only specimen A's age changes (B, C 28 and D HOLD are unchanged).
    expect(shown.items.filter((i) => i.recordType === 'specimen')).toHaveLength(1);
    // Non-Leads may look but not act.
    expect((await preview(revised.id, 'tech')).canApply).toBe(false);

    const key = newKey();
    const body = {
      idempotencyKey: key,
      previewId: shown.previewId,
      selection: {
        kind: 'items',
        itemIds: [`field_report:${draftA.id}`, `specimen:${specimenA.id}`],
      },
      note: 'Supplier revised the slump',
    };
    const applied = await send('post', propagationPath(revised.id), body);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const result = concreteMixPropagationResultSchema.parse(applied.body);
    expect(result).toMatchObject({ scope: 'items' });
    expect(result.appliedItemIds.sort()).toEqual(
      [`field_report:${draftA.id}`, `specimen:${specimenA.id}`].sort(),
    );

    const a = await readReport(draftA.id);
    expect(a.fields.projectSpec.slumpTargetMm).toBe(100);
    expect(a.mixSnapshot).toMatchObject({ revisionNumber: 2, revisionState: 'approved' });
    expect(a.manualSpecChanges.projectSpec).toEqual([]);
    // The ticket column is what was observed: never changed.
    expect(a.fields.ticketSpec).toEqual(draftA.fields.ticketSpec);
    const b = await readReport(draftB.id);
    expect(b.fields.projectSpec.slumpTargetMm).toBe(80);
    expect(b.mixSnapshot!.revisionNumber).toBe(1);
    const s = await readReport(submitted.id);
    expect(s.mixSnapshot!.revisionNumber).toBe(1);

    const { rows: specimens } = await h.db.pool.query<{
      letter: string;
      age: string;
      target: string;
    }>(
      `SELECT letter, assigned_age AS age, target_date::text AS target FROM concrete_specimen
       WHERE set_id = $1 ORDER BY letter`,
      [set.id],
    );
    expect(specimens.map((r) => [r.letter, r.age])).toEqual([
      ['A', '3'],
      ['B', '28'],
      ['C', '28'],
      ['D', 'HOLD'],
    ]);
    expect(specimens[0]!.target).toBe('2026-11-05');
    const history = await get(`/api/concrete/specimens/${specimenA.id}/schedule-history`);
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body)).toContain('updated from the mix by the Lead');

    const detail = concreteMixDetailSchema.parse((await get(`/api/concrete-mixes/${mix.id}`)).body);
    const event = detail.history.find((e) => e.action === 'concrete_mix.propagation_applied');
    expect(event).toMatchObject({
      note: 'Supplier revised the slump',
      after: {
        scope: 'items',
        toRevision: 2,
        applied: expect.arrayContaining(['26-07A']) as unknown,
        notChosen: 2,
        ineligible: 1,
      },
    });

    // The rest stays listed for a later decision.
    const after = await preview(revised.id);
    expect(after.items.map((i) => i.recordId).sort()).toEqual(
      [draftB.id, edited.id, submitted.id].sort(),
    );

    // An exact retry returns the same decision once; another body under the key is refused.
    const before = await counts();
    const retry = await send('post', propagationPath(revised.id), body);
    expect(retry.status).toBe(201);
    expect(concreteMixPropagationResultSchema.parse(retry.body).appliedItemIds.sort()).toEqual(
      result.appliedItemIds.sort(),
    );
    const reused = await send('post', propagationPath(revised.id), { ...body, note: 'other' });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'idempotency_key_reused' });
    expect(await counts()).toEqual(before);

    // A stale preview is refused with the current one.
    const stale = await send('post', propagationPath(revised.id), {
      ...body,
      idempotencyKey: newKey(),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'preview_stale',
      current: { previewId: after.previewId },
    });

    // Naming an ineligible item is refused; Approve all must cover exactly the displayed list.
    const ineligible = await send('post', propagationPath(revised.id), {
      idempotencyKey: newKey(),
      previewId: after.previewId,
      selection: { kind: 'items', itemIds: [`field_report:${submitted.id}`] },
    });
    expect(ineligible.status).toBe(422);
    expect(ineligible.body).toMatchObject({ code: 'item_not_eligible' });
    const partialAll = await send('post', propagationPath(revised.id), {
      idempotencyKey: newKey(),
      previewId: after.previewId,
      selection: { kind: 'approve_all', displayedItemIds: [`field_report:${draftB.id}`] },
    });
    expect(partialAll.status).toBe(409);
    expect(await counts()).toEqual(before);

    const all = await send('post', propagationPath(revised.id), {
      idempotencyKey: newKey(),
      previewId: after.previewId,
      selection: { kind: 'approve_all', displayedItemIds: after.items.map((i) => i.itemId) },
    });
    expect(all.status, JSON.stringify(all.body)).toBe(201);
    const allResult = concreteMixPropagationResultSchema.parse(all.body);
    expect(allResult.scope).toBe('approve_all');
    expect(allResult.appliedItemIds.sort()).toEqual(
      [`field_report:${draftB.id}`, `field_report:${edited.id}`].sort(),
    );
    // The hand-changed slump is kept; only the revision moved on.
    const e = await readReport(edited.id);
    expect(e.fields.projectSpec.slumpTargetMm).toBe(90);
    expect(e.mixSnapshot!.revisionNumber).toBe(2);
    expect(allResult.preview.items.map((i) => i.recordId)).toEqual([submitted.id]);
    const finalDetail = concreteMixDetailSchema.parse(
      (await get(`/api/concrete-mixes/${mix.id}`)).body,
    );
    expect(
      finalDetail.history
        .filter((h) => h.action === 'concrete_mix.propagation_applied')
        .map((h) => h.after.scope),
    ).toEqual(['approve_all', 'items']);
  });

  it('AC3: only the Lead may apply; everyone else is refused and nothing is written', async () => {
    const mix = await approvedMix('C30-02');
    await report({ mixId: mix.id, applyMixDefaults: true });
    const revised = await revise(mix, { cementType: 'HE' });
    const shown = await preview(revised.id);
    expect(shown.eligibleCount).toBe(1);
    const before = await counts();
    for (const as of ['tech', 'lm', 'admin', 'js', 'lab'] as const) {
      const refused = await send(
        'post',
        propagationPath(revised.id),
        {
          idempotencyKey: newKey(),
          previewId: shown.previewId,
          selection: { kind: 'approve_all', displayedItemIds: shown.items.map((i) => i.itemId) },
        },
        as,
      );
      expect(refused.status, as).toBe(403);
    }
    // 403 before the body is read.
    expect((await send('post', propagationPath(revised.id), {}, 'tech')).status).toBe(403);
    expect((await send('post', propagationPath(revised.id), {})).status).toBe(400);
    expect(await counts()).toEqual(before);
    expect((await get(propagationPath('00000000-0000-4000-8000-00000000c300'))).status).toBe(404);
  });

  it('an Unapproved mix has nothing to propagate', async () => {
    const created = await send('post', `/api/projects/${h.projects.a}/concrete-mixes`, {
      idempotencyKey: newKey(),
      spec: { supplierName: 'Example Ready-Mix', mixNumber: 'C30-03' },
    });
    const mix = concreteMixDetailSchema.parse(created.body);
    const shown = await preview(mix.id);
    expect(shown).toMatchObject({ toRevisionId: null, items: [], eligibleCount: 0 });
  });

  it('Specimens and Reports tabs: rows, search and status', async () => {
    const mix = await approvedMix('C30-04');
    const r = await report({
      mixId: mix.id,
      reportDate: '2026-11-05',
      castAt: '2026-11-05T09:15:00-06:00',
      locationElements: ['Footing'],
      locationDescription: 'Grid C30 north footing',
      paperFieldId: 'F-C30',
    });
    await createSet(r.id);
    const response = await get(
      `/api/concrete/projects/${h.projects.a}/specimens?search=${encodeURIComponent('C30 north')}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const list = concreteProjectSpecimenListSchema.parse(response.body);
    expect(list.total).toBe(4);
    expect(list.items.map((i) => [i.assignedAge, i.testDate])).toEqual([
      [7, '2026-11-12'],
      [28, '2026-12-03'],
      [28, '2026-12-03'],
      ['HOLD', '2026-12-31'],
    ]);
    expect(list.items[0]).toMatchObject({
      fieldReportId: r.id,
      castingDate: '2026-11-05',
      structure: ['Footing'],
      location: 'Grid C30 north footing',
      strengthMpa: null,
    });
    const hold = concreteProjectSpecimenListSchema.parse(
      (
        await get(
          `/api/concrete/projects/${h.projects.a}/specimens?status=hold&search=${encodeURIComponent('C30 north')}`,
        )
      ).body,
    );
    expect(hold.items.map((i) => i.assignedAge)).toEqual(['HOLD']);
    expect((await get(`/api/concrete/projects/${h.projects.a}/specimens?status=nope`)).status).toBe(
      400,
    );
    expect((await get(`/api/concrete/projects/${h.projects.a}/specimens`, 'lab')).status).toBe(200);

    const reports = concreteFieldReportListSchema.parse(
      (await get(`/api/concrete/projects/${h.projects.a}/field-reports?search=F-C30`)).body,
    );
    expect(reports.items).toHaveLength(1);
    expect(reports.items[0]).toMatchObject({
      id: r.id,
      reportType: 'field',
      paperFieldId: 'F-C30',
      locationElements: ['Footing'],
      locationDescription: 'Grid C30 north footing',
      issueCount: 0,
      lastIssuedAt: null,
    });
    const issuedOnly = concreteFieldReportListSchema.parse(
      (await get(`/api/concrete/projects/${h.projects.a}/field-reports?search=F-C30&issued=true`))
        .body,
    );
    expect(issuedOnly.items).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // Review fixes (2026-11-09): completed breaks and the provenance of a propagated age
  // -------------------------------------------------------------------------------------------

  let permanentNumber = 900;

  /** A numbered set (C18 stand-in) cast on 2026-11-02 from `mix`'s current approved revision. */
  async function numberedSet(mix: ConcreteMixDetail) {
    const r = await report({
      mixId: mix.id,
      applyMixDefaults: true,
      castAt: '2026-11-02T09:15:00-06:00',
    });
    const set = await createSet(r.id);
    permanentNumber += 1;
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [set.id, permanentNumber, `26-${permanentNumber}`],
    );
    return set.specimens.find((s) => s.letter === 'A')!.id;
  }

  async function specimenRow(id: string) {
    const { rows } = await h.db.pool.query<{ age: string; target: string; version: number }>(
      `SELECT assigned_age AS age, target_date::text AS target, version FROM concrete_specimen
       WHERE id = $1`,
      [id],
    );
    const { rows: history } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM concrete_specimen_reschedule WHERE specimen_id = $1',
      [id],
    );
    return { ...rows[0]!, reschedules: history[0]!.n };
  }

  /** A complete test entry (the break) by the Lab Manager. */
  async function breakSpecimen(specimenId: string) {
    const response = await h
      .http()
      .put(`/api/concrete/specimens/${specimenId}/test-results/${newKey()}`)
      .set('Cookie', cookies.lm!)
      .set(CSRF_HEADER, '1')
      .send({
        idempotencyKey: newKey(),
        version: 0,
        testedOn: '2026-11-09',
        maxLoad: 250,
        heightReadings: [200],
        diameterReadings: [100],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  const applyItems = async (mixId: string, previewId: string, itemIds: string[]) =>
    send('post', propagationPath(mixId), {
      idempotencyKey: newKey(),
      previewId,
      selection: { kind: 'items', itemIds },
    });

  it('a broken specimen keeps its age, target and history when the mix age changes', async () => {
    const mix = await approvedMix('D-P1-01');
    const specimen = await numberedSet(mix);
    await breakSpecimen(specimen);
    const before = await specimenRow(specimen);
    expect(before).toMatchObject({ age: '7', target: '2026-11-09', reschedules: 0 });

    const revised = await revise(mix, { testAges: [14, 28, 28, 'HOLD'] });
    const shown = await preview(revised.id);
    const item = shown.items.find((i) => i.recordId === specimen);
    expect(item).toMatchObject({ eligible: false, ineligibleReason: 'specimen_tested' });

    const refused = await applyItems(revised.id, shown.previewId, [`specimen:${specimen}`]);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({ code: 'item_not_eligible' });
    const all = await send('post', propagationPath(revised.id), {
      idempotencyKey: newKey(),
      previewId: shown.previewId,
      selection: { kind: 'approve_all', displayedItemIds: shown.items.map((i) => i.itemId) },
    });
    expect(all.status, JSON.stringify(all.body)).toBe(201);
    expect(concreteMixPropagationResultSchema.parse(all.body).appliedItemIds).not.toContain(
      `specimen:${specimen}`,
    );
    expect(await specimenRow(specimen)).toEqual(before);
  });

  it('a break saved after the preview makes applying it stale; the age stays', async () => {
    const mix = await approvedMix('D-P1-02');
    const specimen = await numberedSet(mix);
    const revised = await revise(mix, { testAges: [14, 28, 28, 'HOLD'] });
    const shown = await preview(revised.id);
    expect(shown.items.find((i) => i.recordId === specimen)).toMatchObject({ eligible: true });

    await breakSpecimen(specimen);
    const before = await specimenRow(specimen);
    const stale = await applyItems(revised.id, shown.previewId, [`specimen:${specimen}`]);
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body).toMatchObject({ code: 'preview_stale' });
    expect(await specimenRow(specimen)).toEqual(before);
    expect(before).toMatchObject({ age: '7', reschedules: 0 });
  });

  it('a propagated age can be propagated again (7 → 14 → 21)', async () => {
    const mix = await approvedMix('D-P2-01');
    const specimen = await numberedSet(mix);
    const second = await revise(mix, { testAges: [14, 28, 28, 'HOLD'] });
    const first = await preview(second.id);
    const applied = await applyItems(second.id, first.previewId, [`specimen:${specimen}`]);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(await specimenRow(specimen)).toMatchObject({ age: '14', reschedules: 1 });

    const third = await revise(second, { testAges: [21, 28, 28, 'HOLD'] });
    const next = await preview(third.id);
    expect(next.items.find((i) => i.recordId === specimen)).toMatchObject({
      eligible: true,
      changes: [{ field: 'assignedAge', before: 14, proposed: 21 }],
    });
    const again = await applyItems(third.id, next.previewId, [`specimen:${specimen}`]);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(await specimenRow(specimen)).toMatchObject({
      age: '21',
      target: '2026-11-23',
      reschedules: 2,
    });
    // The set's saved schedule (casting snapshot) never changes.
    const { rows } = await h.db.pool.query<{ ages: string[] }>(
      `SELECT st.default_ages AS ages FROM concrete_specimen sp
       JOIN concrete_specimen_set st ON st.id = sp.set_id WHERE sp.id = $1`,
      [specimen],
    );
    expect(rows[0]!.ages).toEqual(['7', '28', '28', 'HOLD']);
  });

  it('a manual reschedule after a propagation stays protected from the next revision', async () => {
    const mix = await approvedMix('D-P2-02');
    const specimen = await numberedSet(mix);
    const second = await revise(mix, { testAges: [14, 28, 28, 'HOLD'] });
    const first = await preview(second.id);
    expect((await applyItems(second.id, first.previewId, [`specimen:${specimen}`])).status).toBe(
      201,
    );
    const manual = await send('post', `/api/concrete/specimens/${specimen}/reschedule`, {
      idempotencyKey: newKey(),
      version: (await specimenRow(specimen)).version,
      newAge: 10,
      reason: 'Lab asked for an earlier break',
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);

    const third = await revise(second, { testAges: [21, 28, 28, 'HOLD'] });
    const next = await preview(third.id);
    expect(next.items.find((i) => i.recordId === specimen)).toMatchObject({
      eligible: false,
      ineligibleReason: 'manually_edited',
    });
    expect(await specimenRow(specimen)).toMatchObject({ age: '10', reschedules: 2 });
  });

  // -------------------------------------------------------------------------------------------
  // STRATA-98: the Sets tab (working labels, test ages, "n of m tested")
  // -------------------------------------------------------------------------------------------

  it('Sets tab: one row per set with its working label, test ages and n of m tested', async () => {
    const mix = await approvedMix('S98-01');
    const r = await report({
      mixId: mix.id,
      applyMixDefaults: true,
      castAt: '2026-11-02T09:15:00-06:00',
      locationElements: ['Footing'],
      locationDescription: 'Grid S98 sets',
    });
    const set = await createSet(r.id);
    // Stand-in for C18: a numbered set, so a break can be entered (as numberedSet above).
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = 980, permanent_id = '26-980'
       WHERE id = $1`,
      [set.id],
    );
    await breakSpecimen(set.specimens.find((s) => s.letter === 'A')!.id);

    const url = `/api/concrete/projects/${h.projects.a}/specimen-sets`;
    const response = await get(`${url}?search=${encodeURIComponent('S98 sets')}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const list = concreteProjectSetListSchema.parse(response.body);
    expect(list.total).toBe(1);
    const row = list.items[0]!;
    expect(row).toMatchObject({
      setId: set.id,
      fieldReportId: r.id,
      identity: { permanentId: '26-980' },
      castingDate: '2026-11-02',
      structure: ['Footing'],
      location: 'Grid S98 sets',
      testAges: [7, 28, 28, 'HOLD'],
      // HOLD isn't counted: 1 of the 3 scheduled specimens is tested.
      testedCount: 1,
      scheduledCount: 3,
      nextTestDate: '2026-11-30',
      voided: false,
    });
    // The working number is the set's place in its project in creation order.
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM concrete_specimen_set
       WHERE project_id = $1
         AND (created_at, id) <= (SELECT created_at, id FROM concrete_specimen_set WHERE id = $2)`,
      [h.projects.a, set.id],
    );
    expect(row.workingNumber).toBe(rows[0]!.n);
    expect(row.workingLabel).toBe(`Set ${row.workingNumber}`);
    expect(row.specimenRange).toBe(`${row.workingNumber}A–${row.workingNumber}D`);
    expect(row.status).toBe(concreteProjectSetStatus({ ...row, today: list.today }));

    // Newest first: a later set comes before it.
    const later = await report({
      mixId: mix.id,
      applyMixDefaults: true,
      locationDescription: 'Grid S98 sets later',
    });
    const laterSet = await createSet(later.id);
    const both = concreteProjectSetListSchema.parse(
      (await get(`${url}?search=${encodeURIComponent('S98 sets')}`)).body,
    );
    expect(both.items.map((i) => i.setId)).toEqual([laterSet.id, set.id]);
    expect(both.items[0]).toMatchObject({
      workingNumber: row.workingNumber + 1,
      castingDate: null,
      status: 'no_casting_time',
      testedCount: 0,
    });

    expect((await get(url, 'lab')).status).toBe(200);
    expect((await get(`${url}?pageSize=500`)).status).toBe(400);
    expect(
      (await get('/api/concrete/projects/00000000-0000-4000-8000-0000000009ff/specimen-sets'))
        .status,
    ).toBe(404);
  });
});
