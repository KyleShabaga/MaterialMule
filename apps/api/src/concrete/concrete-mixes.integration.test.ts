import {
  concreteMixDetailSchema,
  concreteMixListSchema,
  concreteMixSuppliersSchema,
  concreteMixVersionConflictResponseSchema,
  projectCapabilitiesSchema,
  type ConcreteMixDetail,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-V2-C03: project concrete mixes, Lead Project Engineer approval and specification history
// (card AC1–AC5; test plan T2, T3). Real PostgreSQL, direct API calls. Fictional data only:
// DEMO-2601 (A, led by Pat Example `pe`), DEMO-2602 (B, led here by Jordan Smith `js`) and a
// project waiting for a lead (C); invented suppliers such as "Example Ready-Mix".
describe.runIf(testDatabaseUrl)('concrete mixes (MM-V2-C03)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  let projectC: string;

  type Caller = PersonKey | 'lab' | 'anonymous';

  const get = async (url: string, as: Caller) => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  const send = async (method: 'post' | 'patch', url: string, body: unknown, as: Caller) => {
    const req = h.http()[method](url).set(CSRF_HEADER, '1');
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req.send(body as object);
  };
  const projectId = (p: 'a' | 'b' | 'c') => (p === 'c' ? projectC : h.projects[p]);
  const mixesPath = (p: 'a' | 'b' | 'c') => `/api/projects/${projectId(p)}/concrete-mixes`;

  const COMPLETE = {
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    airMinPercent: 5,
    airMaxPercent: 8,
    maxAggregateSizeMm: 20,
    cementType: 'GU',
  };

  let mixCounter = 0;
  /** A new mix on `project` through the API (as its lead), checked 201. */
  async function create(
    spec: Record<string, unknown> = {},
    project: 'a' | 'b' = 'a',
    as: Caller = project === 'a' ? 'pe' : 'js',
  ): Promise<ConcreteMixDetail> {
    mixCounter += 1;
    const response = await send(
      'post',
      mixesPath(project),
      {
        idempotencyKey: newKey(),
        spec: { supplierName: 'Example Ready-Mix', mixNumber: `M-${mixCounter}`, ...spec },
      },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteMixDetailSchema.parse(response.body);
  }

  const edit = (
    mix: ConcreteMixDetail,
    spec: Record<string, unknown>,
    as: Caller = 'pe',
    key = newKey(),
  ) =>
    send(
      'patch',
      `/api/concrete-mixes/${mix.id}`,
      { idempotencyKey: key, version: mix.version, spec },
      as,
    );

  const approve = (mix: ConcreteMixDetail, as: Caller = 'pe', key = newKey()) =>
    send(
      'post',
      `/api/concrete-mixes/${mix.id}/approve`,
      { idempotencyKey: key, version: mix.version, revisionId: mix.draftRevision?.id ?? mix.id },
      as,
    );

  async function approved(spec: Record<string, unknown> = {}, project: 'a' | 'b' = 'a') {
    const mix = await create({ ...COMPLETE, ...spec }, project);
    const response = await approve(mix, project === 'a' ? 'pe' : 'js');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteMixDetailSchema.parse(response.body);
  }

  async function counts() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_mix) AS mixes,
              (SELECT coalesce(sum(version), 0)::int FROM concrete_mix) AS versions,
              (SELECT count(*)::int FROM concrete_mix_revision) AS revisions,
              (SELECT count(*)::int FROM concrete_mix_revision WHERE state = 'approved') AS approved,
              (SELECT count(*)::int FROM concrete_mix_command) AS commands,
              (SELECT count(*)::int FROM audit_event) AS audit`,
    );
    return rows[0];
  }

  /** Every row of the other concrete tables, to prove mix writes never touch them (AC4, AC5). */
  async function downstream() {
    const out: Record<string, unknown[]> = {};
    for (const table of [
      'concrete_field_report',
      'concrete_specimen_set',
      'concrete_specimen',
      'concrete_project_settings',
    ]) {
      const { rows } = await h.db.pool.query(
        `SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY 1`,
      );
      out[table] = rows.map((r: { row: string }) => r.row);
    }
    return out;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab', 'disabled'] as const) {
      cookies[key] = await h.cookie(key);
    }
    await h.db.pool.query('UPDATE project SET lead_project_engineer_user_id = $2 WHERE id = $1', [
      h.projects.b,
      h.users.js,
    ]);
    projectC = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO project (project_number, name, client)
         VALUES ('DEMO-2603', 'Fictional unled project', 'Example Client') RETURNING id`,
      )
    ).rows[0]!.id;
    // A fictional field report with a set and specimens, to prove mix writes leave them alone.
    const report = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
         RETURNING id`,
        [h.projects.a, h.users.tech],
      )
    ).rows[0]!.id;
    const set = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO concrete_specimen_set (project_id, field_report_id) VALUES ($1, $2)
         RETURNING id`,
        [h.projects.a, report],
      )
    ).rows[0]!.id;
    for (const letter of ['A', 'B', 'C', 'D']) {
      await h.db.pool.query(
        `INSERT INTO concrete_specimen (project_id, set_id, letter, assigned_age) VALUES ($1, $2, $3, '28')`,
        [h.projects.a, set, letter],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // AC1: create and defaults
  // ---------------------------------------------------------------------------------------------

  it('AC1: the project’s lead creates a mix: Unapproved draft revision 1, ages 7/28/28/HOLD, no strength age', async () => {
    const before = await counts();
    const mix = await create({ mixNumber: '0042', plantNames: ['North Plant'] });
    expect(mix).toMatchObject({
      projectId: h.projects.a,
      projectNumber: 'DEMO-2601',
      supplierName: 'Example Ready-Mix',
      mixNumber: '0042',
      status: 'unapproved',
      effectiveRevision: null,
      version: 1,
      copiedFrom: null,
      canManage: true,
      canApprove: true,
    });
    expect(mix.draftRevision).toMatchObject({
      revisionNumber: 1,
      state: 'draft',
      approvedAt: null,
      createdBy: { userId: h.users.pe },
    });
    expect(mix.draftRevision!.spec).toMatchObject({
      testAges: [7, 28, 28, 'HOLD'],
      specifiedStrengthAgeDays: null,
      specifiedStrengthMpa: null,
      specAdmixtures: { declaration: null, items: [] },
    });
    expect(mix.draftRevision!.missingForApproval).toContain('specifiedStrengthMpa');
    expect(mix.history.map((e) => e.action)).toEqual(['concrete_mix.created']);
    expect(await counts()).toEqual({
      ...before,
      mixes: before.mixes + 1,
      versions: before.versions + 1,
      revisions: before.revisions + 1,
      commands: before.commands + 1,
      audit: before.audit + 1,
    });
    // Repeated ages and HOLD stay distinct; a given strength age is kept beside the strength.
    const custom = await create({
      testAges: [7, 28, 28, 28, 'HOLD'],
      specifiedStrengthAgeDays: 56,
    });
    expect(custom.draftRevision!.spec.testAges).toEqual([7, 28, 28, 28, 'HOLD']);
    expect(custom.draftRevision!.spec.specifiedStrengthAgeDays).toBe(56);
  });

  it('a new mix starts from the project’s own default ages when its settings set them (C02)', async () => {
    const settings = await send(
      'patch',
      `/api/projects/${h.projects.b}/concrete-settings`,
      { version: 0, defaultSpecimenAges: [7, 28, 56, 'HOLD'] },
      'js',
    );
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const mix = await create({}, 'b');
    expect(mix.draftRevision!.spec.testAges).toEqual([7, 28, 56, 'HOLD']);
  });

  it('validation: supplier and mix number are required; bad values are 400 with nothing written', async () => {
    const before = await counts();
    for (const spec of [
      { mixNumber: '1' },
      { supplierName: 'S', mixNumber: '1', airMinPercent: 8, airMaxPercent: 5 },
      { supplierName: 'S', mixNumber: '1', slumpToleranceMm: -3 },
      { supplierName: 'S', mixNumber: '1', testAges: [] },
    ]) {
      const response = await send('post', mixesPath('a'), { idempotencyKey: newKey(), spec }, 'pe');
      expect(response.status, JSON.stringify(spec)).toBe(400);
      expect(response.body.code).toBe('validation_failed');
    }
    expect(await counts()).toEqual(before);
  });

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  it('every active session reads mixes (as the project); only the lead sees manage/approve', async () => {
    const mix = await create({ supplierName: 'Reader Supplier', plantNames: ['East Plant'] });
    for (const caller of ['lab', 'tech', 'lm', 'admin', 'pe', 'js'] as const) {
      const list = await get(`${mixesPath('a')}?supplier=reader%20supplier`, caller);
      expect(list.status, caller).toBe(200);
      const parsed = concreteMixListSchema.parse(list.body);
      expect(parsed.items.map((i) => i.id)).toEqual([mix.id]);
      expect(parsed.canManage, caller).toBe(caller === 'pe');
      expect(parsed.canApprove, caller).toBe(caller === 'pe');
      const detail = await get(`/api/concrete-mixes/${mix.id}`, caller);
      expect(detail.status, caller).toBe(200);
      expect(concreteMixDetailSchema.parse(detail.body).canManage).toBe(caller === 'pe');
    }
    for (const caller of ['anonymous', 'disabled'] as const) {
      expect((await get(mixesPath('a'), caller)).status).toBe(401);
      expect((await get(`/api/concrete-mixes/${mix.id}`, caller)).status).toBe(401);
    }
    expect((await get(`/api/concrete-mixes/${newKey()}`, 'tech')).status).toBe(404);
    expect((await get('/api/concrete-mixes/not-a-uuid', 'tech')).status).toBe(404);
    expect((await get(`/api/projects/${newKey()}/concrete-mixes`, 'tech')).status).toBe(404);
  });

  it('supplier-filtered lists are bounded and searchable; the supplier list gives plants', async () => {
    await create({ supplierName: 'Filter Supplier', mixNumber: 'F-1', plantNames: ['West'] });
    await create({
      supplierName: 'filter supplier',
      mixNumber: 'F-2',
      plantNames: ['West', 'South'],
    });
    const filtered = concreteMixListSchema.parse(
      (await get(`${mixesPath('a')}?supplier=FILTER%20SUPPLIER&pageSize=1`, 'tech')).body,
    );
    expect(filtered).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(filtered.items).toHaveLength(1);
    const searched = concreteMixListSchema.parse(
      (await get(`${mixesPath('a')}?search=f-2`, 'tech')).body,
    );
    expect(searched.items.map((i) => i.mixNumber)).toEqual(['F-2']);
    expect((await get(`${mixesPath('a')}?pageSize=1000`, 'tech')).status).toBe(400);
    const suppliers = concreteMixSuppliersSchema.parse(
      (await get(`/api/projects/${h.projects.a}/concrete-mix-suppliers`, 'lab')).body,
    );
    expect(
      suppliers.suppliers.find((s) => s.supplierName.toLowerCase() === 'filter supplier'),
    ).toEqual({ supplierName: 'Filter Supplier', mixCount: 2, plantNames: ['South', 'West'] });
    expect(suppliers.truncated).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // AC2: authority
  // ---------------------------------------------------------------------------------------------

  it('AC2: only the destination project’s lead creates, edits, copies or approves; refusals write nothing', async () => {
    const draft = await create(COMPLETE);
    const source = await approved({}, 'b');
    const before = await counts();
    const callers: [Caller, number][] = [
      ['anonymous', 401],
      ['disabled', 401],
      ['lab', 403],
      ['tech', 403],
      ['lm', 403],
      // An admin holds project settings authority but never mixes (AO08 Q4).
      ['admin', 403],
      // js leads B, not A: another project's lead.
      ['js', 403],
    ];
    for (const [caller, status] of callers) {
      for (const response of [
        await send(
          'post',
          mixesPath('a'),
          { idempotencyKey: newKey(), spec: { supplierName: 'S', mixNumber: 'x' } },
          caller,
        ),
        // Refused before the body is read (403 before 400).
        await send('post', mixesPath('a'), { bogus: true }, caller),
        await edit(draft, { cementType: 'HE' }, caller),
        await approve(draft, caller),
        await send(
          'post',
          `${mixesPath('a')}/copy`,
          { idempotencyKey: newKey(), sourceMixId: source.id },
          caller,
        ),
      ]) {
        expect(response.status, `${caller} ${JSON.stringify(response.body)}`).toBe(status);
      }
    }
    // A project waiting for a lead: nobody, admin included.
    for (const caller of ['admin', 'pe', 'lm'] as const) {
      const response = await send(
        'post',
        mixesPath('c'),
        { idempotencyKey: newKey(), spec: { supplierName: 'S', mixNumber: 'x' } },
        caller,
      );
      expect(response.status, caller).toBe(403);
    }
    // An unknown mix: 404 for someone who leads a project, 403 for anyone else (AO03 order).
    expect((await send('patch', `/api/concrete-mixes/${newKey()}`, {}, 'pe')).status).toBe(404);
    for (const caller of ['tech', 'lab', 'admin'] as const) {
      expect((await send('patch', `/api/concrete-mixes/${newKey()}`, {}, caller)).status).toBe(403);
    }
    expect(await counts()).toEqual(before);
  });

  it('the capability list reports the mix actions from the same rule the routes enforce', async () => {
    const caps = async (project: 'a' | 'c', as: Caller) =>
      projectCapabilitiesSchema
        .parse((await get(`/api/projects/${projectId(project)}/capabilities`, as)).body)
        .capabilities.filter((c) => c.action.startsWith('concrete_mix'));
    expect(await caps('a', 'pe')).toEqual([
      {
        action: 'concrete_mix.manage',
        allowed: true,
        sources: ['lead_project_engineer'],
        blocked: null,
      },
      {
        action: 'concrete_mix.approve',
        allowed: true,
        sources: ['lead_project_engineer'],
        blocked: null,
      },
    ]);
    for (const caller of ['admin', 'lm', 'js'] as const) {
      for (const entry of await caps('a', caller)) {
        expect(entry, caller).toMatchObject({
          allowed: false,
          blocked: { code: 'not_permitted', grantedBy: ['lead_project_engineer'] },
        });
      }
    }
    for (const entry of await caps('c', 'admin')) {
      expect(entry.blocked?.code).toBe('no_lead_project_engineer');
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Editing, approval and D14 revisions
  // ---------------------------------------------------------------------------------------------

  it('editing a draft changes it in place, audits only changed fields and steps the version', async () => {
    const mix = await create({ cementType: 'GU' });
    const response = await edit(mix, { cementType: 'HE', slumpTargetMm: 100, plantNames: [] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = concreteMixDetailSchema.parse(response.body);
    expect(after.version).toBe(2);
    expect(after.revisions.map((r) => r.revisionNumber)).toEqual([1]);
    expect(after.draftRevision!.spec).toMatchObject({ cementType: 'HE', slumpTargetMm: 100 });
    expect(after.history[0]).toMatchObject({
      action: 'concrete_mix.draft_edited',
      changedBy: { userId: h.users.pe },
      before: { revision: 1, cementType: 'GU', slumpTargetMm: null },
      after: { revision: 1, cementType: 'HE', slumpTargetMm: 100 },
    });
    // plantNames was already [] so it isn't listed as changed.
    expect(after.history[0]!.after).not.toHaveProperty('plantNames');
    // A no-op edit writes no revision, version or audit.
    const before = await counts();
    const noop = await edit(after, { cementType: 'HE' });
    expect(noop.status).toBe(200);
    expect(concreteMixDetailSchema.parse(noop.body).version).toBe(2);
    expect({ ...(await counts()), commands: before.commands }).toEqual(before);
  });

  it('approval needs a complete specification and the named open draft', async () => {
    const mix = await create({ ...COMPLETE, cementType: null, specifiedStrengthMpa: null });
    const incomplete = await approve(mix);
    expect(incomplete.status).toBe(422);
    expect(incomplete.body).toMatchObject({ code: 'incomplete_for_approval' });
    expect(incomplete.body.errors.map((e: { field: string }) => e.field)).toEqual([
      'spec.specifiedStrengthMpa',
      'spec.cementType',
    ]);
    const wrong = await send(
      'post',
      `/api/concrete-mixes/${mix.id}/approve`,
      { idempotencyKey: newKey(), version: mix.version, revisionId: newKey() },
      'pe',
    );
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('revision_not_draft');

    const filled = concreteMixDetailSchema.parse(
      (await edit(mix, { cementType: 'GU', specifiedStrengthMpa: 30 })).body,
    );
    const ok = await approve(filled);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const result = concreteMixDetailSchema.parse(ok.body);
    expect(result).toMatchObject({ status: 'approved', draftRevision: null });
    expect(result.effectiveRevision).toMatchObject({
      revisionNumber: 1,
      state: 'approved',
      approvedBy: { userId: h.users.pe },
    });
    expect(result.history[0]).toMatchObject({
      action: 'concrete_mix.approved',
      before: { effectiveRevision: null },
      after: { effectiveRevision: 1 },
    });
    // Approving again: nothing is a draft any more.
    expect((await approve(result)).status).toBe(422);
  });

  it('D14 / AC5: editing an approved mix makes draft revision 2; revision 1 stays in effect, unchanged, until the lead approves', async () => {
    const mix = await approved({ specifiedStrengthMpa: 32 });
    const effective = mix.effectiveRevision!;
    const reportsBefore = await downstream();

    const drafted = concreteMixDetailSchema.parse(
      (await edit(mix, { specifiedStrengthMpa: 35, testAges: [7, 28, 56, 'HOLD'] })).body,
    );
    expect(drafted.status).toBe('revision_pending');
    expect(drafted.effectiveRevision).toEqual(effective);
    expect(drafted.draftRevision).toMatchObject({ revisionNumber: 2, state: 'draft' });
    expect(drafted.draftRevision!.spec).toMatchObject({
      ...effective.spec,
      specifiedStrengthMpa: 35,
      testAges: [7, 28, 56, 'HOLD'],
    });
    expect(drafted.history[0]).toMatchObject({
      action: 'concrete_mix.revision_drafted',
      before: { revision: 1, specifiedStrengthMpa: 32 },
      after: { revision: 2, specifiedStrengthMpa: 35 },
    });
    // Editing the pending draft again changes revision 2 only.
    const again = concreteMixDetailSchema.parse((await edit(drafted, { cementType: 'HE' })).body);
    expect(again.revisions.map((r) => r.revisionNumber)).toEqual([2, 1]);
    expect(again.effectiveRevision).toEqual(effective);

    const approvedTwo = concreteMixDetailSchema.parse((await approve(again)).body);
    expect(approvedTwo.status).toBe('approved');
    expect(approvedTwo.effectiveRevision).toMatchObject({ revisionNumber: 2 });
    const old = approvedTwo.revisions.find((r) => r.revisionNumber === 1)!;
    // The superseded revision keeps exactly what was approved: a stable reference for snapshots.
    expect({
      ...old,
      state: 'approved',
      supersededAt: null,
      updatedAt: effective.updatedAt,
    }).toEqual(effective);
    expect(old.state).toBe('superseded');
    // AC5: no report, set, specimen or project setting changed.
    expect(await downstream()).toEqual(reportsBefore);
  });

  it('AC4: changing a field report never changes the registry mix', async () => {
    const mix = await approved();
    const before = await counts();
    // The only field-report write path that exists today is the record itself (C04 adds mix
    // fields and the ticket column); writing it leaves every mix row alone.
    await h.db.pool.query(
      `UPDATE concrete_field_report SET technician_user_id = $1, version = version + 1,
              updated_at = now()
       WHERE project_id = $2`,
      [h.users.tech, h.projects.a],
    );
    expect(await counts()).toEqual(before);
    const reread = concreteMixDetailSchema.parse(
      (await get(`/api/concrete-mixes/${mix.id}`, 'tech')).body,
    );
    expect(reread.effectiveRevision).toEqual(mix.effectiveRevision);
    expect(reread.version).toBe(mix.version);
  });

  it('a stale version is 409 with the current mix; nothing is written', async () => {
    const mix = await create();
    const moved = concreteMixDetailSchema.parse((await edit(mix, { cementType: 'GU' })).body);
    const before = await counts();
    const stale = await edit(mix, { cementType: 'HE' });
    expect(stale.status).toBe(409);
    const body = concreteMixVersionConflictResponseSchema.parse(stale.body);
    expect(body.current.version).toBe(moved.version);
    const staleApprove = await approve({ ...moved, version: 1 });
    expect(staleApprove.status).toBe(409);
    expect(await counts()).toEqual(before);
  });

  it('exact retries return the current mix without a second revision or event; a reused key is 409', async () => {
    const key = newKey();
    const body = {
      idempotencyKey: key,
      spec: { supplierName: 'Retry Supplier', mixNumber: 'R-1' },
    };
    const first = await send('post', mixesPath('a'), body, 'pe');
    expect(first.status).toBe(201);
    const before = await counts();
    const retry = await send('post', mixesPath('a'), body, 'pe');
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(await counts()).toEqual(before);
    const reused = await send(
      'post',
      mixesPath('a'),
      { ...body, spec: { ...body.spec, mixNumber: 'R-2' } },
      'pe',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');

    const mix = concreteMixDetailSchema.parse(first.body);
    const editKey = newKey();
    const edited = await edit(mix, { cementType: 'GU' }, 'pe', editKey);
    expect(edited.status).toBe(200);
    const afterEdit = await counts();
    const editRetry = await edit(mix, { cementType: 'GU' }, 'pe', editKey);
    expect(editRetry.status).toBe(200);
    expect(editRetry.body.version).toBe(edited.body.version);
    expect(await counts()).toEqual(afterEdit);
    expect((await edit(mix, { cementType: 'HE' }, 'pe', editKey)).status).toBe(409);
    // Duplicate supplier + mix number in the project.
    const dup = await send(
      'post',
      mixesPath('a'),
      { idempotencyKey: newKey(), spec: { supplierName: 'retry supplier', mixNumber: 'r-1' } },
      'pe',
    );
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('mix_number_taken');
  });

  // ---------------------------------------------------------------------------------------------
  // AC3: copy
  // ---------------------------------------------------------------------------------------------

  it('AC3: copying an approved mix makes an Unapproved destination mix with provenance; the source is unchanged', async () => {
    const source = await approved({
      supplierName: 'Copy Supplier',
      mixNumber: 'C-1',
      plantNames: ['North'],
    });
    const sourceBefore = (await get(`/api/concrete-mixes/${source.id}`, 'pe')).body;
    const response = await send(
      'post',
      `${mixesPath('b')}/copy`,
      { idempotencyKey: newKey(), sourceMixId: source.id, note: 'Same supplier on B' },
      'js',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const copy = concreteMixDetailSchema.parse(response.body);
    expect(copy).toMatchObject({
      projectId: h.projects.b,
      status: 'unapproved',
      effectiveRevision: null,
      supplierName: 'Copy Supplier',
      mixNumber: 'C-1',
      copiedFrom: {
        projectId: h.projects.a,
        projectNumber: 'DEMO-2601',
        mixId: source.id,
        revisionId: source.effectiveRevision!.id,
        revisionNumber: 1,
      },
    });
    expect(copy.draftRevision!.spec).toEqual(source.effectiveRevision!.spec);
    expect(copy.draftRevision!.createdBy.userId).toBe(h.users.js);
    expect(copy.history[0]).toMatchObject({
      action: 'concrete_mix.copied',
      note: 'Same supplier on B',
    });
    // The source, its approval and version are untouched.
    expect((await get(`/api/concrete-mixes/${source.id}`, 'pe')).body).toEqual(sourceBefore);
    // Only B's lead approves the copy.
    expect((await approve(copy, 'pe')).status).toBe(403);
    expect((await approve(copy, 'js')).status).toBe(201);
    // Copying the same mix into B again collides with the copy's supplier and number.
    const again = await send(
      'post',
      `${mixesPath('b')}/copy`,
      { idempotencyKey: newKey(), sourceMixId: source.id },
      'js',
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('mix_number_taken');
    // An unknown source or a revision of another mix is refused.
    const unknown = await send(
      'post',
      `${mixesPath('b')}/copy`,
      { idempotencyKey: newKey(), sourceMixId: newKey() },
      'js',
    );
    expect(unknown.status).toBe(422);
    const other = await create();
    const wrongRevision = await send(
      'post',
      `${mixesPath('b')}/copy`,
      {
        idempotencyKey: newKey(),
        sourceMixId: source.id,
        sourceRevisionId: other.draftRevision!.id,
      },
      'js',
    );
    expect(wrongRevision.status).toBe(422);
    expect(wrongRevision.body.code).toBe('invalid_source_revision');
  });

  // ---------------------------------------------------------------------------------------------
  // D09: first commit wins
  // ---------------------------------------------------------------------------------------------

  describe('D09 lock order', () => {
    let blocker: PoolClient;

    async function waiters(n: number) {
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      for (let i = 0; i < 2000; i += 1) {
        const { rows } = await h.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))`,
          [pid],
        );
        if (rows[0]!.n >= n) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`fewer than ${n} waited on the blocker`);
    }

    it('a lead change that commits first wins: the waiting mix edit is refused and writes nothing', async () => {
      const mix = await create();
      blocker = await h.db.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('UPDATE project SET lead_project_engineer_user_id = $2 WHERE id = $1', [
          h.projects.a,
          h.users.js,
        ]);
        const before = await counts();
        const pending = edit(mix, { cementType: 'HE' });
        await waiters(1);
        await blocker.query('COMMIT');
        const response = await pending;
        expect(response.status, JSON.stringify(response.body)).toBe(403);
        expect(await counts()).toEqual(before);
      } finally {
        await h.db.pool.query(
          'UPDATE project SET lead_project_engineer_user_id = $2 WHERE id = $1',
          [h.projects.a, h.users.pe],
        );
        blocker.release();
      }
    });

    it('an approval that commits first stays: a lead change waits for it', async () => {
      const mix = await create(COMPLETE);
      blocker = await h.db.pool.connect();
      try {
        await blocker.query('BEGIN');
        // Hold the mix row as an in-flight write would; the approval queues behind it.
        await blocker.query('SELECT id FROM concrete_mix WHERE id = $1 FOR UPDATE', [mix.id]);
        const pending = approve(mix);
        await waiters(1);
        await blocker.query('COMMIT');
        const response = await pending;
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(response.body.effectiveRevision.approvedBy.userId).toBe(h.users.pe);
      } finally {
        blocker.release();
      }
    });
  });
});
