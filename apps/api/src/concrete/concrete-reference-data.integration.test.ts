import {
  companyHolidayListSchema,
  companyHolidaySchema,
  concreteMixDetailSchema,
  concreteSupplierListSchema,
  concreteSupplierSchema,
  type ConcreteMixDetail,
  type ConcreteSupplier,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { runSeed } from '../db/seed.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-V2-C37: concrete reference data (card AC1–AC3). Suppliers (Lab Manager or admin), the
// company holiday calendar (admin; Alberta general holidays seeded) and mix draft discard (the
// project's Lead). Real PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A, led by
// Pat Example `pe`); invented suppliers such as "Example Ready-Mix" and "Sample Concrete Co".
describe.runIf(testDatabaseUrl)('concrete reference data (MM-V2-C37)', () => {
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

  async function tally() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_supplier) AS suppliers,
              (SELECT coalesce(sum(version), 0)::int FROM concrete_supplier) AS supplier_versions,
              (SELECT count(*)::int FROM company_holiday) AS holidays,
              (SELECT coalesce(sum(version), 0)::int FROM company_holiday) AS holiday_versions,
              (SELECT count(*)::int FROM concrete_mix_revision) AS revisions,
              (SELECT coalesce(sum(version), 0)::int FROM concrete_mix) AS mix_versions,
              (SELECT count(*)::int FROM audit_event) AS audit`,
    );
    return rows[0] as Record<string, number>;
  }

  let supplierCounter = 0;
  async function supplier(as: Caller = 'lm', name?: string): Promise<ConcreteSupplier> {
    supplierCounter += 1;
    const response = await send(
      'post',
      '/api/concrete/suppliers',
      { name: name ?? `Example Supplier ${supplierCounter}`, plantNames: ['North Plant'] },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteSupplierSchema.parse(response.body);
  }

  const COMPLETE = {
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    airMinPercent: 5,
    airMaxPercent: 8,
    maxAggregateSizeMm: 20,
    cementType: 'GU',
  };

  async function mix(
    spec: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<ConcreteMixDetail> {
    const response = await send(
      'post',
      `/api/projects/${h.projects.a}/concrete-mixes`,
      { idempotencyKey: newKey(), spec, ...extra },
      'pe',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteMixDetailSchema.parse(response.body);
  }

  async function approvedMix(mixNumber: string): Promise<ConcreteMixDetail> {
    const created = await mix({ supplierName: 'Example Ready-Mix', mixNumber, ...COMPLETE });
    const response = await send(
      'post',
      `/api/concrete-mixes/${created.id}/approve`,
      { idempotencyKey: newKey(), version: created.version, revisionId: created.draftRevision!.id },
      'pe',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteMixDetailSchema.parse(response.body);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'lab', 'disabled'] as const) {
      cookies[key] = await h.cookie(key);
    }
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // -------------------------------------------------------------------------------------------
  // Suppliers
  // -------------------------------------------------------------------------------------------

  it('Lab Managers and admins add and edit suppliers; every change is audited', async () => {
    const before = await tally();
    const byLm = await supplier('lm', 'Example Ready-Mix');
    expect(byLm).toMatchObject({
      name: 'Example Ready-Mix',
      plantNames: ['North Plant'],
      active: true,
      linkedMixCount: 0,
      createdBy: { userId: h.users.lm },
      version: 1,
    });
    const byAdmin = await supplier('admin', 'Sample Concrete Co');
    expect(byAdmin.createdBy.userId).toBe(h.users.admin);

    const edited = await send(
      'patch',
      `/api/concrete/suppliers/${byLm.id}`,
      { version: 1, plantNames: ['North Plant', 'South Plant'], reason: 'New plant' },
      'admin',
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(concreteSupplierSchema.parse(edited.body)).toMatchObject({
      plantNames: ['North Plant', 'South Plant'],
      version: 2,
    });
    expect(await tally()).toMatchObject({
      suppliers: before.suppliers! + 2,
      audit: before.audit! + 3,
    });
    const { rows } = await h.db.pool.query(
      `SELECT action, reason, before_values, after_values FROM audit_event
       WHERE entity_type = 'concrete_supplier' AND entity_id = $1 ORDER BY occurred_at, id`,
      [byLm.id],
    );
    expect(rows).toEqual([
      expect.objectContaining({ action: 'concrete_supplier.created' }),
      {
        action: 'concrete_supplier.updated',
        reason: 'New plant',
        before_values: { plantNames: ['North Plant'] },
        after_values: { plantNames: ['North Plant', 'South Plant'] },
      },
    ]);

    // Everyone reads the list (LAB included); inactive suppliers only on request.
    const off = await send(
      'patch',
      `/api/concrete/suppliers/${byAdmin.id}`,
      { version: 1, active: false },
      'lm',
    );
    expect(off.status).toBe(200);
    for (const as of ['tech', 'lab', 'pe'] as const) {
      const list = concreteSupplierListSchema.parse(
        (await get('/api/concrete/suppliers', as)).body,
      );
      expect(list.canManage).toBe(false);
      expect(list.items.map((s) => s.name)).toContain('Example Ready-Mix');
      expect(list.items.map((s) => s.name)).not.toContain('Sample Concrete Co');
    }
    const all = concreteSupplierListSchema.parse(
      (await get('/api/concrete/suppliers?includeInactive=true', 'lm')).body,
    );
    expect(all.canManage).toBe(true);
    expect(all.items.find((s) => s.id === byAdmin.id)).toMatchObject({ active: false });
  });

  it('refuses suppliers from anyone else before the body, and writes nothing', async () => {
    const existing = await supplier();
    const before = await tally();
    for (const as of ['tech', 'pe', 'lab', 'disabled', 'anonymous'] as const) {
      const created = await send('post', '/api/concrete/suppliers', { name: 'Nope' }, as);
      expect([401, 403], `${as} create`).toContain(created.status);
      const patched = await send(
        'patch',
        `/api/concrete/suppliers/${existing.id}`,
        { bogus: true },
        as,
      );
      expect([401, 403], `${as} patch`).toContain(patched.status);
    }
    expect(await tally()).toEqual(before);
  });

  it('a duplicate name is 409, a stale version conflicts, an unknown supplier is 404', async () => {
    const one = await supplier('lm', 'Duplicate Example Ltd');
    const dup = await send(
      'post',
      '/api/concrete/suppliers',
      { name: '  duplicate example ltd ' },
      'admin',
    );
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'supplier_exists' });
    const stale = await send(
      'patch',
      `/api/concrete/suppliers/${one.id}`,
      { version: 5, name: 'Renamed Example' },
      'lm',
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', current: { version: 1 } });
    const unknown = await send(
      'patch',
      '/api/concrete/suppliers/00000000-0000-4000-8000-0000000000ff',
      { version: 1 },
      'lm',
    );
    expect(unknown.status).toBe(404);
    const bad = await send('post', '/api/concrete/suppliers', { name: '' }, 'lm');
    expect(bad.status).toBe(400);
  });

  // -------------------------------------------------------------------------------------------
  // Holidays
  // -------------------------------------------------------------------------------------------

  it('the Alberta general holidays are seeded for 2026–2028; everyone reads them', async () => {
    for (const as of ['tech', 'lab', 'lm'] as const) {
      const list = companyHolidayListSchema.parse(
        (await get('/api/concrete/holidays?year=2026', as)).body,
      );
      expect(list.canManage).toBe(false);
      expect(list.items.map((x) => [x.holidayOn, x.name, x.source])).toEqual([
        ['2026-01-01', "New Year's Day", 'alberta_general'],
        ['2026-02-16', 'Alberta Family Day', 'alberta_general'],
        ['2026-04-03', 'Good Friday', 'alberta_general'],
        ['2026-05-18', 'Victoria Day', 'alberta_general'],
        ['2026-07-01', 'Canada Day', 'alberta_general'],
        ['2026-09-07', 'Labour Day', 'alberta_general'],
        ['2026-10-12', 'Thanksgiving Day', 'alberta_general'],
        ['2026-11-11', 'Remembrance Day', 'alberta_general'],
        ['2026-12-25', 'Christmas Day', 'alberta_general'],
      ]);
    }
    const next = companyHolidayListSchema.parse(
      (await get('/api/concrete/holidays?year=2027', 'admin')).body,
    );
    expect(next.canManage).toBe(true);
    expect(next.items.map((x) => x.holidayOn)).toEqual([
      '2027-01-01',
      '2027-02-15',
      '2027-03-26',
      '2027-05-24',
      '2027-07-01',
      '2027-09-06',
      '2027-10-11',
      '2027-11-11',
      '2027-12-25',
    ]);
    const all = companyHolidayListSchema.parse((await get('/api/concrete/holidays', 'tech')).body);
    expect(all.items).toHaveLength(27);
  });

  it('an admin adds, renames and removes a holiday; a removed one never comes back on re-seed', async () => {
    const before = await tally();
    const added = await send(
      'post',
      '/api/concrete/holidays',
      { holidayOn: '2026-12-26', name: 'Boxing Day' },
      'admin',
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const boxing = companyHolidaySchema.parse(added.body);
    expect(boxing).toMatchObject({
      holidayOn: '2026-12-26',
      source: 'company',
      createdBy: { userId: h.users.admin },
      version: 1,
    });
    const again = await send(
      'post',
      '/api/concrete/holidays',
      { holidayOn: '2026-12-26', name: 'Second' },
      'admin',
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'holiday_exists' });

    const renamed = await send(
      'patch',
      `/api/concrete/holidays/${boxing.id}`,
      { version: 1, name: 'Boxing Day (office closed)' },
      'admin',
    );
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(companyHolidaySchema.parse(renamed.body)).toMatchObject({ version: 2 });

    // A seeded holiday can be removed too (with a reason), and re-running the seed keeps it gone.
    const year = companyHolidayListSchema.parse(
      (await get('/api/concrete/holidays?year=2028', 'admin')).body,
    );
    const remembrance = year.items.find((x) => x.holidayOn === '2028-11-11')!;
    const noReason = await send(
      'post',
      `/api/concrete/holidays/${remembrance.id}/remove`,
      { version: remembrance.version, reason: '' },
      'admin',
    );
    expect(noReason.status).toBe(400);
    const removed = await send(
      'post',
      `/api/concrete/holidays/${remembrance.id}/remove`,
      { version: remembrance.version, reason: 'Fictional test: office open' },
      'admin',
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    await runSeed(h.db.pool, 'reference', 'test');
    const after = companyHolidayListSchema.parse(
      (await get('/api/concrete/holidays?year=2028', 'tech')).body,
    );
    expect(after.items.map((x) => x.holidayOn)).not.toContain('2028-11-11');
    const gone = await send(
      'patch',
      `/api/concrete/holidays/${remembrance.id}`,
      { version: 2, name: 'Back' },
      'admin',
    );
    expect(gone.status).toBe(404);
    // The date can be added again as a company holiday.
    const readded = await send(
      'post',
      '/api/concrete/holidays',
      { holidayOn: '2028-11-11', name: 'Remembrance Day' },
      'admin',
    );
    expect(readded.status).toBe(201);

    expect(await tally()).toMatchObject({
      holidays: before.holidays! + 2,
      audit: before.audit! + 4,
    });
    const { rows } = await h.db.pool.query(
      `SELECT action, reason FROM audit_event WHERE entity_type = 'company_holiday'
       AND entity_id = $1`,
      [remembrance.id],
    );
    expect(rows).toEqual([
      { action: 'company_holiday.removed', reason: 'Fictional test: office open' },
    ]);
  });

  it('only admins manage holidays: Lab Managers and everyone else get 403 and nothing changes', async () => {
    const list = companyHolidayListSchema.parse(
      (await get('/api/concrete/holidays?year=2027', 'admin')).body,
    );
    const target = list.items[0]!;
    const before = await tally();
    for (const as of ['lm', 'tech', 'pe', 'lab', 'disabled', 'anonymous'] as const) {
      const created = await send(
        'post',
        '/api/concrete/holidays',
        { holidayOn: '2027-08-02', name: 'Heritage Day' },
        as,
      );
      expect([401, 403], `${as} create`).toContain(created.status);
      const renamed = await send(
        'patch',
        `/api/concrete/holidays/${target.id}`,
        { version: target.version, name: 'X' },
        as,
      );
      expect([401, 403], `${as} rename`).toContain(renamed.status);
      const removed = await send(
        'post',
        `/api/concrete/holidays/${target.id}/remove`,
        { version: target.version, reason: 'x' },
        as,
      );
      expect([401, 403], `${as} remove`).toContain(removed.status);
    }
    expect(await tally()).toEqual(before);
    const invalid = await send(
      'post',
      '/api/concrete/holidays',
      { holidayOn: '2027-02-30', name: 'Not a date' },
      'admin',
    );
    expect(invalid.status).toBe(400);
  });

  // -------------------------------------------------------------------------------------------
  // Mixes: supplier link and draft discard
  // -------------------------------------------------------------------------------------------

  it('AC3: two suppliers with the same mix number on one project are both accepted', async () => {
    const first = await supplier('lm', 'AC3 First Supplier');
    const second = await supplier('lm', 'AC3 Second Supplier');
    const a = await mix(
      { supplierName: 'AC3 First Supplier', mixNumber: '25-MPA-01' },
      { supplierId: first.id },
    );
    const b = await mix(
      { supplierName: 'AC3 Second Supplier', mixNumber: '25-MPA-01' },
      { supplierId: second.id },
    );
    expect(a.supplier).toEqual({ id: first.id, name: 'AC3 First Supplier', active: true });
    expect(b.supplier).toEqual({ id: second.id, name: 'AC3 Second Supplier', active: true });
    // The same supplier and number twice is still refused (C03's rule is unchanged).
    const dup = await send(
      'post',
      `/api/projects/${h.projects.a}/concrete-mixes`,
      {
        idempotencyKey: newKey(),
        spec: { supplierName: 'ac3 first supplier', mixNumber: '25-mpa-01' },
      },
      'pe',
    );
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'mix_number_taken' });
    const listed = concreteSupplierSchema.parse(
      (await send('patch', `/api/concrete/suppliers/${first.id}`, { version: 1 }, 'lm')).body,
    );
    expect(listed.linkedMixCount).toBe(1);
  });

  it('links and unlinks a supplier without a new revision; an inactive or unknown one is refused', async () => {
    const listed = await supplier();
    const created = await mix({ supplierName: 'Free Text Supplier', mixNumber: 'LINK-1' });
    expect(created.supplier).toBeNull();
    const before = await tally();
    const linked = await send(
      'patch',
      `/api/concrete-mixes/${created.id}`,
      { idempotencyKey: newKey(), version: created.version, supplierId: listed.id },
      'pe',
    );
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    const after = concreteMixDetailSchema.parse(linked.body);
    expect(after.supplier).toMatchObject({ id: listed.id });
    // The free-text names stay as typed; no revision was made.
    expect(after.supplierName).toBe('Free Text Supplier');
    expect(await tally()).toMatchObject({
      revisions: before.revisions,
      mix_versions: before.mix_versions! + 1,
      audit: before.audit! + 1,
    });
    expect(after.history[0]).toMatchObject({
      action: 'concrete_mix.supplier_linked',
      before: { supplierId: null },
      after: { supplierId: listed.id },
    });
    const unlinked = await send(
      'patch',
      `/api/concrete-mixes/${created.id}`,
      { idempotencyKey: newKey(), version: after.version, supplierId: null },
      'pe',
    );
    expect(concreteMixDetailSchema.parse(unlinked.body).supplier).toBeNull();

    const inactive = await supplier();
    await send(
      'patch',
      `/api/concrete/suppliers/${inactive.id}`,
      { version: 1, active: false },
      'lm',
    );
    for (const supplierId of [inactive.id, '00000000-0000-4000-8000-0000000000fe']) {
      const refused = await send(
        'post',
        `/api/projects/${h.projects.a}/concrete-mixes`,
        {
          idempotencyKey: newKey(),
          spec: { supplierName: 'Refused Example', mixNumber: `R-${supplierId.slice(-2)}` },
          supplierId,
        },
        'pe',
      );
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'invalid_supplier' });
    }
  });

  it('AC2: discarding a draft keeps the approved revision unchanged, and is audited', async () => {
    const approved = await approvedMix('DISCARD-1');
    const effective = approved.effectiveRevision!;
    // Editing the approved mix opens draft revision 2 (D14), renaming it too.
    const drafted = concreteMixDetailSchema.parse(
      (
        await send(
          'patch',
          `/api/concrete-mixes/${approved.id}`,
          {
            idempotencyKey: newKey(),
            version: approved.version,
            spec: { specifiedStrengthMpa: 35, mixNumber: 'DISCARD-1B' },
          },
          'pe',
        )
      ).body,
    );
    expect(drafted).toMatchObject({ status: 'revision_pending', mixNumber: 'DISCARD-1B' });
    const draft = drafted.draftRevision!;
    const { rows: approvedRowBefore } = await h.db.pool.query(
      'SELECT row_to_json(r)::text AS row FROM concrete_mix_revision r WHERE id = $1',
      [effective.id],
    );

    // Only the Lead may discard; a wrong revision or stale version is refused without writing.
    const before = await tally();
    for (const as of ['lm', 'admin', 'tech', 'lab'] as const) {
      const refused = await send(
        'post',
        `/api/concrete-mixes/${drafted.id}/discard-draft`,
        { idempotencyKey: newKey(), version: drafted.version, revisionId: draft.id },
        as,
      );
      expect(refused.status, as).toBe(403);
    }
    const wrongRevision = await send(
      'post',
      `/api/concrete-mixes/${drafted.id}/discard-draft`,
      { idempotencyKey: newKey(), version: drafted.version, revisionId: effective.id },
      'pe',
    );
    expect(wrongRevision.status).toBe(422);
    expect(wrongRevision.body).toMatchObject({ code: 'revision_not_draft' });
    const stale = await send(
      'post',
      `/api/concrete-mixes/${drafted.id}/discard-draft`,
      { idempotencyKey: newKey(), version: drafted.version - 1, revisionId: draft.id },
      'pe',
    );
    expect(stale.status).toBe(409);
    expect(await tally()).toEqual(before);

    const key = newKey();
    const body = {
      idempotencyKey: key,
      version: drafted.version,
      revisionId: draft.id,
      note: 'Wrong strength',
    };
    const discarded = await send(
      'post',
      `/api/concrete-mixes/${drafted.id}/discard-draft`,
      body,
      'pe',
    );
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    const result = concreteMixDetailSchema.parse(discarded.body);
    expect(result).toMatchObject({
      status: 'approved',
      mixNumber: 'DISCARD-1',
      draftRevision: null,
      effectiveRevision: { id: effective.id, revisionNumber: 1, state: 'approved' },
    });
    expect(result.effectiveRevision).toEqual(effective);
    expect(result.revisions.map((r) => [r.revisionNumber, r.state])).toEqual([
      [2, 'discarded'],
      [1, 'approved'],
    ]);
    expect(result.revisions[0]).toMatchObject({
      discardedBy: { userId: h.users.pe },
      spec: { specifiedStrengthMpa: 35, mixNumber: 'DISCARD-1B' },
    });
    const { rows: approvedRowAfter } = await h.db.pool.query(
      'SELECT row_to_json(r)::text AS row FROM concrete_mix_revision r WHERE id = $1',
      [effective.id],
    );
    expect(approvedRowAfter).toEqual(approvedRowBefore);
    expect(result.history[0]).toMatchObject({
      action: 'concrete_mix.draft_discarded',
      changedBy: { userId: h.users.pe },
      note: 'Wrong strength',
      before: { draftRevision: 2, effectiveRevision: 1 },
      after: { draftRevision: null, effectiveRevision: 1 },
    });

    // An exact retry returns the same mix without a second event.
    const after = await tally();
    const retry = await send('post', `/api/concrete-mixes/${drafted.id}/discard-draft`, body, 'pe');
    expect(retry.status).toBe(200);
    expect(await tally()).toEqual(after);

    // A later edit opens revision 3 (numbers are never reused).
    const next = concreteMixDetailSchema.parse(
      (
        await send(
          'patch',
          `/api/concrete-mixes/${result.id}`,
          { idempotencyKey: newKey(), version: result.version, spec: { cementType: 'HE' } },
          'pe',
        )
      ).body,
    );
    expect(next.draftRevision).toMatchObject({ revisionNumber: 3, state: 'draft' });
  });

  it('an Unapproved mix keeps its only draft: discard is 409 and changes nothing', async () => {
    const draftOnly = await mix({ supplierName: 'Example Ready-Mix', mixNumber: 'DRAFT-ONLY' });
    const before = await tally();
    const response = await send(
      'post',
      `/api/concrete-mixes/${draftOnly.id}/discard-draft`,
      {
        idempotencyKey: newKey(),
        version: draftOnly.version,
        revisionId: draftOnly.draftRevision!.id,
      },
      'pe',
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'no_approved_revision' });
    expect(await tally()).toEqual(before);
  });
});
