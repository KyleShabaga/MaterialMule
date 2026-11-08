import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteFieldReportListSchema,
  concreteFieldReportVersionConflictResponseSchema,
  concreteMixDetailSchema,
  type ConcreteFieldReportDetail,
  type ConcreteMixDetail,
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

// MM-V2-C04: field-report records, snapshots and draft APIs (card AC1–AC5; test plan T2, T3) and
// C03's AC4 (manual ticket edits never touch the mix registry). Real PostgreSQL, direct API
// calls. Fictional data only: DEMO-2601 (A, led by Pat Example `pe`), DEMO-2602 (B), a project
// waiting for a lead (C); invented suppliers, tickets and people.
describe.runIf(testDatabaseUrl)('concrete field reports (MM-V2-C04)', () => {
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
  const reportsPath = (projectId: string) => `/api/concrete/projects/${projectId}/field-reports`;
  const reportPath = (id: string) => `/api/concrete/field-reports/${id}`;

  async function create(
    body: Record<string, unknown> = {},
    as: Caller = 'tech',
    projectId = h.projects.a,
  ): Promise<ConcreteFieldReportDetail> {
    const response = await send(
      'post',
      reportsPath(projectId),
      { idempotencyKey: newKey(), ...body },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  const save = (
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    body: Record<string, unknown>,
    as: Caller = 'tech',
    key = newKey(),
  ) =>
    send(
      'patch',
      reportPath(report.id),
      { idempotencyKey: key, version: report.version, ...body },
      as,
    );

  async function saved(
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    body: Record<string, unknown>,
    as: Caller = 'tech',
  ) {
    const response = await save(report, body, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  async function counts() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_field_report) AS reports,
              (SELECT coalesce(sum(version), 0)::int FROM concrete_field_report) AS versions,
              (SELECT count(*)::int FROM concrete_field_reading) AS readings,
              (SELECT count(*)::int FROM concrete_field_report_command) AS commands,
              (SELECT count(*)::int FROM audit_event WHERE entity_type = 'concrete_field_report') AS audit`,
    );
    return rows[0] as {
      reports: number;
      versions: number;
      readings: number;
      commands: number;
      audit: number;
    };
  }

  /** Every row of the mix registry, to prove field data never edits it (C03 AC4). */
  async function registry() {
    const out: Record<string, unknown[]> = {};
    for (const table of ['concrete_mix', 'concrete_mix_revision', 'concrete_mix_command']) {
      const { rows } = await h.db.pool.query(
        `SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY 1`,
      );
      out[table] = rows.map((r: { row: string }) => r.row);
    }
    return out;
  }

  const COMPLETE_SPEC = {
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    airMinPercent: 5,
    airMaxPercent: 8,
    maxAggregateSizeMm: 20,
    cementType: 'GU',
  };

  let mixCounter = 0;
  async function mix(approve: boolean, projectId = h.projects.a): Promise<ConcreteMixDetail> {
    mixCounter += 1;
    const created = await send(
      'post',
      `/api/projects/${projectId}/concrete-mixes`,
      {
        idempotencyKey: newKey(),
        spec: {
          supplierName: 'Example Ready-Mix',
          mixNumber: `0${mixCounter}42`,
          plantNames: ['North Plant'],
          ...COMPLETE_SPEC,
          ticketDefaults: { slumpTargetMm: 80, slumpToleranceMm: 30, cementType: 'GU' },
        },
      },
      'pe',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let detail = concreteMixDetailSchema.parse(created.body);
    if (approve) {
      const approved = await send(
        'post',
        `/api/concrete-mixes/${detail.id}/approve`,
        { idempotencyKey: newKey(), version: detail.version, revisionId: detail.draftRevision!.id },
        'pe',
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      detail = concreteMixDetailSchema.parse(approved.body);
    }
    return detail;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab', 'disabled'] as const) {
      cookies[key] = await h.cookie(key);
    }
    projectC = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO project (project_number, name, client)
         VALUES ('DEMO-2603', 'Fictional unled project', 'Example Client') RETURNING id`,
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // AC1: incomplete drafts save
  // ---------------------------------------------------------------------------------------------

  it('AC1: an empty draft saves; blanks stay null, completeness lists what review needs', async () => {
    const before = await counts();
    const report = await create();
    expect(report).toMatchObject({
      projectId: h.projects.a,
      projectNumber: 'DEMO-2601',
      client: 'Example Client',
      version: 1,
      createdBy: { userId: h.users.tech },
      technician: { userId: h.users.tech, initials: 'AT' },
      workflow: { state: 'draft', readyToSubmitAt: null, submittedAt: null },
      issuance: { status: 'not_issued', issueCount: 0 },
      mixSnapshot: null,
      canEdit: true,
    });
    expect(report.fields).toMatchObject({
      reportDate: null,
      material: null,
      specimensCast: null,
      timeLimitExceeded: null,
      loadVolumeM3: null,
      locationElements: [],
      readings: [],
    });
    expect(report.completeness.complete).toBe(false);
    expect(report.completeness.missingRequired).toEqual(
      expect.arrayContaining([
        'reportDate',
        'ticketNumber',
        'readings.slump.initial',
        'specimensCast',
      ]),
    );
    expect(report.review.missingRequired).toEqual(report.completeness.missingRequired);
    expect(report.review.deferredChecks.map((c) => c.owner)).toContain('C15');
    expect(await counts()).toEqual({
      ...before,
      reports: before.reports + 1,
      versions: before.versions + 1,
      commands: before.commands + 1,
      audit: before.audit + 1,
    });
    // Completeness is computed: nothing about it is stored.
    const { rows } = await h.db.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'concrete_field_report' AND table_schema = current_schema()
         AND column_name ~ '(complete|missing)'`,
    );
    expect(rows).toEqual([]);
  });

  it('AC1: a partial save keeps what was given; zero and No are values, blank is not', async () => {
    const report = await create({ supplierName: 'Example Ready-Mix', ticketNumber: '000777' });
    const next = await saved(report, {
      loadVolumeM3: 0,
      waterAdded: false,
      ambientTempC: -12.5,
      comments: '   ',
      ticketNumber: '',
    });
    expect(next.version).toBe(2);
    expect(next.fields).toMatchObject({
      supplierName: 'Example Ready-Mix',
      ticketNumber: null,
      loadVolumeM3: 0,
      waterAdded: false,
      ambientTempC: -12.5,
      comments: null,
    });
    expect(next.completeness.missingRequired).not.toContain('waterAdded');
    expect(next.completeness.missingRequired).toContain('ticketNumber');
  });

  // ---------------------------------------------------------------------------------------------
  // Authority and attribution (T2)
  // ---------------------------------------------------------------------------------------------

  it('T2: signed-out and disabled callers are refused; nothing is written', async () => {
    const before = await counts();
    for (const as of ['anonymous', 'disabled'] as const) {
      const response = await send(
        'post',
        reportsPath(h.projects.a),
        { idempotencyKey: newKey() },
        as,
      );
      expect(response.status).toBe(401);
    }
    expect(await counts()).toEqual(before);
  });

  it('T2: LAB must name the performing staff member, who is credited; LAB never is', async () => {
    const before = await counts();
    const missing = await send(
      'post',
      reportsPath(h.projects.a),
      { idempotencyKey: newKey() },
      'lab',
    );
    expect(missing.status).toBe(400);
    expect(missing.body.errors).toEqual([
      expect.objectContaining({ field: 'technicianUserId', code: 'required' }),
    ]);
    for (const person of [h.users.lab, h.users.noInitials, h.users.disabled, randomUUID()]) {
      const refused = await send(
        'post',
        reportsPath(h.projects.a),
        { idempotencyKey: newKey(), technicianUserId: person },
        'lab',
      );
      expect(refused.status, person).toBe(422);
      expect(refused.body.code).toBe('invalid_technician');
    }
    expect(await counts()).toEqual(before);

    const report = await create({ technicianUserId: h.users.tech }, 'lab');
    expect(report.createdBy.userId).toBe(h.users.lab);
    expect(report.technician?.userId).toBe(h.users.tech);
    const { rows } = await h.db.pool.query(
      `SELECT actor_user_id, actor_account_type, receiver_user_id FROM audit_event
       WHERE entity_type = 'concrete_field_report' AND entity_id = $1`,
      [report.id],
    );
    expect(rows).toEqual([
      {
        actor_user_id: h.users.lab,
        actor_account_type: 'shared_lab',
        receiver_user_id: h.users.tech,
      },
    ]);
  });

  it('T2: a personal account is its own technician and can’t name someone else', async () => {
    const response = await send(
      'post',
      reportsPath(h.projects.a),
      { idempotencyKey: newKey(), technicianUserId: h.users.js },
      'tech',
    );
    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({
      field: 'technicianUserId',
      code: 'not_allowed',
    });
    // Any internal user may draft on any project, whatever their project role.
    for (const as of ['js', 'lm', 'admin', 'pe'] as const) {
      const report = await create({}, as, h.projects.b);
      expect(report.technician?.userId).toBe(h.users[as]);
    }
  });

  it('CD-58: a person saves only their own drafts; LAB only for the draft’s technician', async () => {
    const report = await create({ supplierName: 'Example Ready-Mix' });
    const before = await counts();
    const other = await save(report, { truckNumber: 'T-9' }, 'js');
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('not_own_draft');
    const lead = await save(report, { truckNumber: 'T-9' }, 'pe');
    expect(lead.status).toBe(403);
    const labWrongPerson = await save(
      report,
      { truckNumber: 'T-9', technicianUserId: h.users.js },
      'lab',
    );
    expect(labWrongPerson.status).toBe(403);
    expect(labWrongPerson.body.code).toBe('not_own_draft');
    expect(await counts()).toEqual(before);
    // The read says who may save it.
    expect(
      concreteFieldReportDetailSchema.parse((await get(reportPath(report.id), 'js')).body).canEdit,
    ).toBe(false);

    const byLab = await saved(
      report,
      { truckNumber: 'T-9', technicianUserId: h.users.tech },
      'lab',
    );
    expect(byLab.fields.truckNumber).toBe('T-9');
    expect(byLab.technician?.userId).toBe(h.users.tech);
  });

  it('only drafts are saved here (submission and review are later cards)', async () => {
    const report = await create();
    await h.db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'submitted', submitted_at = now() WHERE id = $1`,
      [report.id],
    );
    const response = await save(report, { truckNumber: 'T-1' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('not_a_draft');
  });

  it('unknown project or report: 404; reads are open to every active session, LAB included', async () => {
    expect(
      (await send('post', reportsPath(randomUUID()), { idempotencyKey: newKey() }, 'tech')).status,
    ).toBe(404);
    expect((await get(reportPath(randomUUID()), 'tech')).status).toBe(404);
    const report = await create();
    for (const as of ['lab', 'js', 'admin'] as const) {
      expect((await get(reportPath(report.id), as)).status).toBe(200);
    }
    expect((await get(reportPath(report.id), 'anonymous')).status).toBe(401);
  });

  // ---------------------------------------------------------------------------------------------
  // AC2: retries
  // ---------------------------------------------------------------------------------------------

  it('AC2: a retried create with the same key and payload makes one report; a changed payload is refused', async () => {
    const key = newKey();
    const id = randomUUID();
    const body = {
      idempotencyKey: key,
      id,
      supplierName: 'Example Ready-Mix',
      ticketNumber: '000900',
    };
    const first = await send('post', reportsPath(h.projects.a), body, 'tech');
    expect(first.status).toBe(201);
    const before = await counts();
    const retry = await send('post', reportsPath(h.projects.a), body, 'tech');
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(id);
    expect(retry.body.version).toBe(1);
    expect(await counts()).toEqual(before);

    const changed = await send(
      'post',
      reportsPath(h.projects.a),
      { ...body, ticketNumber: '000901' },
      'tech',
    );
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('idempotency_key_reused');
    const otherUser = await send('post', reportsPath(h.projects.a), body, 'js');
    expect(otherUser.status).toBe(409);
    // The client id is the report's identity: a new key can't make a second report with it.
    const sameId = await send(
      'post',
      reportsPath(h.projects.a),
      { ...body, idempotencyKey: newKey() },
      'tech',
    );
    expect(sameId.status).toBe(409);
    expect(sameId.body.code).toBe('report_id_taken');
    expect(await counts()).toEqual(before);
  });

  it('AC2: a retried save returns the saved report without a second version or event', async () => {
    const report = await create();
    const key = newKey();
    const first = await save(report, { truckNumber: 'T-3' }, 'tech', key);
    expect(first.status).toBe(200);
    const before = await counts();
    const retry = await save(report, { truckNumber: 'T-3' }, 'tech', key);
    expect(retry.status).toBe(200);
    expect(retry.body.version).toBe(2);
    expect(await counts()).toEqual(before);
    const reused = await save(report, { truckNumber: 'T-4' }, 'tech', key);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');
  });

  it('an unchanged save keeps the version and writes no event', async () => {
    const report = await create({ truckNumber: 'T-5', batchedAt: '2026-11-08T08:00:00-07:00' });
    const before = await counts();
    const same = await saved(report, { truckNumber: 'T-5', batchedAt: '2026-11-08T15:00:00Z' });
    expect(same.version).toBe(1);
    const after = await counts();
    expect(after).toEqual({ ...before, commands: before.commands + 1 });
  });

  // ---------------------------------------------------------------------------------------------
  // AC4 (this card): stale versions
  // ---------------------------------------------------------------------------------------------

  it('AC4: an edit based on an old version is 409 with the current report; nothing is overwritten', async () => {
    const report = await create();
    const current = await saved(report, { truckNumber: 'T-10' });
    const before = await counts();
    const stale = await save(report, { truckNumber: 'T-STALE' });
    expect(stale.status).toBe(409);
    const body = concreteFieldReportVersionConflictResponseSchema.parse(stale.body);
    expect(body.current.version).toBe(current.version);
    expect(body.current.fields.truckNumber).toBe('T-10');
    expect(await counts()).toEqual(before);
  });

  // ---------------------------------------------------------------------------------------------
  // AC3: readings, snapshots, ordering (T3)
  // ---------------------------------------------------------------------------------------------

  it('AC3: slump plus several retests, air and spec columns stay distinct and ordered', async () => {
    const [s0, s1, s2, s3, a0, a1] = Array.from({ length: 6 }, () => randomUUID());
    const report = await create({
      projectSpec: { slumpTargetMm: 80, slumpToleranceMm: 30, airMinPercent: 5, airMaxPercent: 8 },
      ticketSpec: { slumpTargetMm: 100, slumpToleranceMm: 20 },
      readings: [
        { id: s0, test: 'slump', context: 'initial', value: 140 },
        { id: a0, test: 'air', context: 'initial', value: 4.2 },
        {
          id: s1,
          test: 'slump',
          context: 'retest',
          value: 120,
          measuredAt: '2026-11-08T15:40:00Z',
          note: 'after 10 min',
        },
        {
          id: s2,
          test: 'slump',
          context: 'retest',
          value: 100,
          measuredAt: '2026-11-08T15:50:00Z',
        },
        {
          id: s3,
          test: 'slump',
          context: 'after_superplasticizer',
          value: 180,
          measuredAt: '2026-11-08T16:05:00Z',
        },
        { id: a1, test: 'air', context: 'retest', value: 5.6, measuredAt: '2026-11-08T15:52:00Z' },
      ],
    });
    const read = concreteFieldReportDetailSchema.parse(
      (await get(reportPath(report.id), 'tech')).body,
    );
    expect(read.fields.readings.map((r) => [r.id, r.test, r.context, r.position, r.value])).toEqual(
      [
        [s0, 'slump', 'initial', 1, 140],
        [s1, 'slump', 'retest', 2, 120],
        [s2, 'slump', 'retest', 3, 100],
        [s3, 'slump', 'after_superplasticizer', 4, 180],
        [a0, 'air', 'initial', 1, 4.2],
        [a1, 'air', 'retest', 2, 5.6],
      ],
    );
    expect(read.fields.readings[1]!.note).toBe('after 10 min');
    expect(read.fields.projectSpec).toMatchObject({ slumpTargetMm: 80, slumpToleranceMm: 30 });
    expect(read.fields.ticketSpec).toMatchObject({
      slumpTargetMm: 100,
      slumpToleranceMm: 20,
      airMinPercent: null,
    });
    // Every out-of-range reading warns (80 ± 30 mm, 5–8 %); the in-range ones (100 mm, 5.6 %) don't.
    const warned = read.review.warnings
      .filter((w) => w.code.endsWith('_out_of_range'))
      .map((w) => w.field);
    expect(warned).toEqual([
      `readings.${s0}.value`,
      `readings.${s1}.value`,
      `readings.${s3}.value`,
      `readings.${a0}.value`,
    ]);
    expect(read.review.warnings.map((w) => w.code)).toContain('ticket_differs_from_spec');

    // Another retest is added; the initial and post-addition readings are never overwritten.
    const s4 = randomUUID();
    const next = await saved(read, {
      readings: [
        ...read.fields.readings.map(({ position: _p, ...r }) => r),
        { id: s4, test: 'slump', context: 'retest', value: 95, measuredAt: '2026-11-08T16:15:00Z' },
      ],
    });
    expect(
      next.fields.readings.filter((r) => r.test === 'slump').map((r) => [r.id, r.value]),
    ).toEqual([
      [s0, 140],
      [s1, 120],
      [s2, 100],
      [s3, 180],
      [s4, 95],
    ]);
    // A saved reading keeps its context: turning the initial reading into a retest is refused.
    const before = await counts();
    const relabel = await save(next, {
      readings: next.fields.readings.map(({ position: _p, ...r }) =>
        r.id === s0 ? { ...r, context: 'retest' } : r,
      ),
    });
    expect(relabel.status).toBe(422);
    expect(relabel.body.code).toBe('reading_identity_fixed');
    expect(await counts()).toEqual(before);
    // A reading id from another report is refused.
    const other = await create();
    const stolen = await save(other, {
      readings: [{ id: s0, test: 'slump', context: 'initial', value: 1 }],
    });
    expect(stolen.status).toBe(422);
    expect(stolen.body.code).toBe('reading_id_taken');
  });

  // ---------------------------------------------------------------------------------------------
  // Mix snapshots (C03 handoff) and AC5 flags
  // ---------------------------------------------------------------------------------------------

  it('a chosen mix is snapshotted; its defaults fill the spec columns only when asked', async () => {
    const approved = await mix(true);
    const report = await create({ mixId: approved.id, applyMixDefaults: true });
    expect(report.mixSnapshot).toMatchObject({
      mixId: approved.id,
      revisionId: approved.effectiveRevision!.id,
      revisionNumber: 1,
      revisionState: 'approved',
    });
    expect(report.fields).toMatchObject({
      mixId: approved.id,
      supplierName: 'Example Ready-Mix',
      mixNumber: approved.mixNumber,
      plantName: 'North Plant',
    });
    expect(report.fields.projectSpec).toMatchObject(COMPLETE_SPEC);
    expect(report.fields.ticketSpec).toMatchObject({
      slumpTargetMm: 80,
      cementType: 'GU',
      airMinPercent: null,
    });
    expect(report.manualSpecChanges).toEqual({ projectSpec: [], ticketSpec: [] });
    expect(report.review.warnings.map((w) => w.code)).not.toContain('unknown_mix');

    // Without applyMixDefaults, choosing a mix never replaces typed values.
    const typed = await create({ projectSpec: { slumpTargetMm: 75 } });
    const chosen = await saved(typed, { mixId: approved.id });
    expect(chosen.mixSnapshot?.mixId).toBe(approved.id);
    expect(chosen.fields.projectSpec.slumpTargetMm).toBe(75);
    expect(chosen.manualSpecChanges.projectSpec).toContain('slumpTargetMm');
  });

  it('C03 AC4: manual ticket edits on a report leave the registry mix unchanged', async () => {
    const approved = await mix(true);
    const report = await create({ mixId: approved.id, applyMixDefaults: true });
    const before = await registry();
    const edited = await saved(report, {
      ticketSpec: { slumpTargetMm: 120, cementType: 'HE', airMinPercent: 3 },
      projectSpec: { maxAggregateSizeMm: 14 },
      supplierName: 'Example Ready-Mix Ltd',
      mixNumber: '9999',
    });
    expect(edited.manualSpecChanges.ticketSpec).toEqual([
      'slumpTargetMm',
      'airMinPercent',
      'cementType',
    ]);
    expect(edited.manualSpecChanges.projectSpec).toEqual(['maxAggregateSizeMm']);
    expect(edited.mixSnapshot?.revisionId).toBe(approved.effectiveRevision!.id);
    expect(await registry()).toEqual(before);
    const reread = concreteMixDetailSchema.parse(
      (await get(`/api/concrete-mixes/${approved.id}`, 'pe')).body,
    );
    expect(reread.version).toBe(approved.version);
    expect(reread.effectiveRevision!.spec).toEqual(approved.effectiveRevision!.spec);
  });

  it('C03 AC5: a later registry edit never rewrites the saved snapshot', async () => {
    const approved = await mix(true);
    const report = await create({ mixId: approved.id, applyMixDefaults: true });
    const edit = await send(
      'patch',
      `/api/concrete-mixes/${approved.id}`,
      { idempotencyKey: newKey(), version: approved.version, spec: { slumpTargetMm: 120 } },
      'pe',
    );
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const read = concreteFieldReportDetailSchema.parse(
      (await get(reportPath(report.id), 'tech')).body,
    );
    expect(read.mixSnapshot).toEqual(report.mixSnapshot);
    expect(read.fields.projectSpec.slumpTargetMm).toBe(80);
  });

  it('AC5: an unknown or unapproved mix is flagged and the draft still saves', async () => {
    const unknown = await create({ supplierName: 'Fictional Concrete Co', mixNumber: 'X-1' });
    expect(unknown.review.warnings.map((w) => w.code)).toContain('unknown_mix');
    const draftMix = await mix(false);
    const unapproved = await create({ mixId: draftMix.id, applyMixDefaults: true });
    expect(unapproved.mixSnapshot?.revisionState).toBe('draft');
    expect(unapproved.review.warnings.map((w) => w.code)).toContain('unapproved_mix');
    // A mix from another project, or asking for defaults with no mix, is refused.
    const elsewhere = await mix(true, h.projects.b);
    const wrongProject = await send(
      'post',
      reportsPath(h.projects.a),
      { idempotencyKey: newKey(), mixId: elsewhere.id },
      'tech',
    );
    expect(wrongProject.status).toBe(422);
    expect(wrongProject.body.code).toBe('mix_not_in_project');
    const noMix = await save(unknown, { applyMixDefaults: true });
    expect(noMix.status).toBe(422);
    expect(noMix.body.code).toBe('no_mix_to_apply');
  });

  it('AC5 / CD-18: a repeated supplier and ticket warns with the other reports, and both save', async () => {
    const first = await create({ supplierName: 'Dup Ready-Mix', ticketNumber: '004411' });
    expect(first.duplicateTickets).toEqual([]);
    const second = await create(
      { supplierName: ' dup ready-mix ', ticketNumber: '004411' },
      'js',
      h.projects.b,
    );
    expect(second.duplicateTickets).toEqual([
      expect.objectContaining({ reportId: first.id, projectNumber: 'DEMO-2601' }),
    ]);
    expect(second.review.warnings.map((w) => w.code)).toContain('duplicate_ticket');
    const reread = concreteFieldReportDetailSchema.parse(
      (await get(reportPath(first.id), 'tech')).body,
    );
    expect(reread.duplicateTickets.map((d) => d.reportId)).toEqual([second.id]);
  });

  it('the air meter is evaluated against its calibration on the report date (C27); flags only warn', async () => {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO concrete_equipment (kind, identifier, created_by_user_id, created_by_name_snapshot,
                                       create_idempotency_key, create_request_hash,
                                       updated_by_user_id, updated_by_name_snapshot)
       VALUES ('air_meter', 'AM-DEMO-01', $1, 'Lee Manager', $2, 'h', $1, 'Lee Manager') RETURNING id`,
      [h.users.lm, randomUUID()],
    );
    const meter = rows[0]!.id;
    const report = await create({ airMeterEquipmentId: meter, reportDate: '2026-11-08' });
    expect(report.airMeterUse).toMatchObject({
      equipmentId: meter,
      useDate: '2026-11-08',
      flags: ['no_calibration_recorded'],
    });
    expect(report.review.warnings).toContainEqual(
      expect.objectContaining({ code: 'air_meter_flag', message: 'no_calibration_recorded' }),
    );
    const cleared = await saved(report, { airMeterEquipmentId: null });
    expect(cleared.airMeterUse).toBeNull();
    const notAMeter = await save(cleared, { airMeterEquipmentId: randomUUID() });
    expect(notAMeter.status).toBe(422);
    expect(notAMeter.body.code).toBe('not_an_air_meter');
  });

  // ---------------------------------------------------------------------------------------------
  // Audit, review routing, list
  // ---------------------------------------------------------------------------------------------

  it('audit: each save records only the changed fields, the version, actor and time', async () => {
    const report = await create({ truckNumber: 'T-20' });
    await saved(report, { truckNumber: 'T-21', comments: 'Pour paused for rain' });
    const { rows } = await h.db.pool.query(
      `SELECT action, actor_user_id, before_values, after_values FROM audit_event
       WHERE entity_type = 'concrete_field_report' AND entity_id = $1 ORDER BY occurred_at, id`,
      [report.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'concrete_field_report.draft_created',
      'concrete_field_report.draft_saved',
    ]);
    expect(rows[1]).toMatchObject({
      actor_user_id: h.users.tech,
      before_values: { version: 1, truckNumber: 'T-20', comments: null },
      after_values: { version: 2, truckNumber: 'T-21', comments: 'Pour paused for rain' },
    });
  });

  it('review routing (MISC-08, concrete_field): the lead now, blocked when nobody could review', async () => {
    const report = await create();
    expect(report.reviewRouting).toMatchObject({
      scope: 'concrete_field',
      designatedReviewers: [],
      leadProjectEngineer: { userId: h.users.pe },
      blocked: null,
    });
    const unled = await create({}, 'tech', projectC);
    expect(unled.reviewRouting).toMatchObject({
      leadProjectEngineer: null,
      blocked: 'no_reviewer',
    });
  });

  it('the project list is bounded, newest field date first, and filters by state and technician', async () => {
    const project = projectC;
    await create({ reportDate: '2026-11-01' }, 'tech', project);
    await create({ reportDate: '2026-11-05' }, 'js', project);
    const page = concreteFieldReportListSchema.parse(
      (await get(`${reportsPath(project)}?pageSize=2`, 'lab')).body,
    );
    expect(page.pageSize).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.items[0]!.reportDate).toBe('2026-11-05');
    const mine = concreteFieldReportListSchema.parse(
      (await get(`${reportsPath(project)}?technicianUserId=${h.users.js}`, 'tech')).body,
    );
    expect(mine.items.map((i) => i.technician?.userId)).toEqual([h.users.js]);
    expect((await get(`${reportsPath(project)}?pageSize=1000`, 'tech')).status).toBe(400);
  });
});
