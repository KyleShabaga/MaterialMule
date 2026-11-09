import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteMixDetailSchema,
  concreteSpecimenSetDetailSchema,
  projectCapabilitiesSchema,
  type ConcreteFieldReportDetail,
  type ConcreteSpecimenSetDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { insertProject } from '../test-support/fixtures.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-V2-C08: package 1 foundation integration (card T1, AC1–AC3). One fictional scenario runs
// through the merged cards on real PostgreSQL, by direct API calls, and checks database and audit
// rows rather than status codes alone:
//   project → reviewers, issuer, delegate, concrete Lab Manager grant (C02, AO03, MISC-08)
//   → mix, Lead-only (C03) with a listed supplier (C37) → field report with the mix snapshot (C04)
//   → specimen sets and ages, holiday flag (C05, C37) → submit / return / resubmit / review /
//   issue (C09, C28, C29 notifications, C38 machine-info default) → pickup and receipt (C06) → test
//   result entry and correction (C07) → worklist and reschedule (C22, C38) → HOLD and disposal
//   (C26) → dashboard queues and search (C31).
// Two projects: A = DEMO-2601 led by Pat Example (`pe`); C = DEMO-2603 led by Jamie Song (`jo`).
// Actor types: the shared LAB account, an ordinary technician (`tech`, also the casting
// technician), a Lab Technician (`lt`), a Lab Manager with A's concrete grant (`lm`), a Lab
// Manager without it (`lm2`), an admin, an acceptance delegate, an Authorized report issuer
// (`js`), a designated concrete_field reviewer on A (`rv`) and each project's lead.
// Every name, number, ticket and reading is invented.

const CAST_AT = '2026-11-02T09:15:00-06:00'; // Monday 2 Nov 2026, America/Edmonton
const SPEC = {
  specifiedStrengthMpa: 32,
  slumpTargetMm: 80,
  slumpToleranceMm: 30,
  airMinPercent: 5,
  airMaxPercent: 8,
  maxAggregateSizeMm: 20,
  cementType: 'GU',
};

describe.runIf(testDatabaseUrl)('concrete foundation integration (MM-V2-C08)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  const people: Record<string, string> = {};
  let projectC: string;

  const send = (method: 'post' | 'patch' | 'put', url: string, body: unknown, as: string) =>
    h
      .http()
      [method](url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as]!)
      .send(body as object);
  const get = (url: string, as: string) => h.http().get(url).set('Cookie', cookies[as]!);
  const reportPath = (id: string, rest = '') => `/api/concrete/field-reports/${id}${rest}`;
  const expectStatus = (r: { status: number; body: unknown }, status: number, label = '') =>
    expect(r.status, `${label} ${JSON.stringify(r.body)}`).toBe(status);

  async function person(key: string, name: string, initials: string, roles: string[] = []) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', 'active') RETURNING id`,
      [name, initials],
    );
    const id = rows[0]!.id;
    for (const role of roles) {
      await h.db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        id,
        role,
      ]);
    }
    const session = await h.app.get(SessionService).create(id, 'personal');
    cookies[key] = `${SESSION_COOKIE}=${session.token}`;
    people[key] = id;
    return id;
  }

  /** Each listed caller gets `status` (403 by default) and nothing is written anywhere. */
  async function refusedFor(
    callers: string[],
    call: (as: string) => Promise<{ status: number; body: { code?: string } }>,
    status = 403,
  ) {
    const before = await fingerprint();
    for (const as of callers) {
      const response = await call(as);
      expect(response.status, `${as}: ${JSON.stringify(response.body)}`).toBe(status);
    }
    expect(await fingerprint()).toEqual(before);
  }

  /** A digest of every concrete, notification and audit table (refusals must change none). */
  async function fingerprint() {
    const { rows: tables } = await h.db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         AND (table_name LIKE 'concrete%' OR table_name IN ('audit_event', 'notification',
              'company_holiday', 'project_concrete_lab_manager_grant'))
       ORDER BY table_name`,
    );
    const { rows } = await h.db.pool.query<{ name: string; digest: string }>(
      tables
        .map(
          ({ table_name: t }) =>
            `SELECT '${t}' AS name,
                    md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS digest
             FROM "${t}" x`,
        )
        .join(' UNION ALL '),
    );
    return Object.fromEntries(rows.map((r) => [r.name, r.digest]));
  }

  /** Storage-unit tables: the concrete scenario must leave them exactly as they were (AC3). */
  async function storageUnitFingerprint() {
    const { rows } = await h.db.pool.query<{ digest: string }>(
      `SELECT md5(concat_ws('#',
         (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM storage_unit x),
         (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM receipt x),
         (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM storage_unit_annual_counter x),
         (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM storage_unit_hole_summary x)
       )) AS digest`,
    );
    return rows[0]!.digest;
  }

  async function audit(entityId: string) {
    const { rows } = await h.db.pool.query<{
      action: string;
      actor_user_id: string | null;
      actor_account_type: string | null;
      reason: string | null;
    }>(
      `SELECT action, actor_user_id, actor_account_type, reason FROM audit_event
       WHERE entity_id = $1 ORDER BY occurred_at, id`,
      [entityId],
    );
    return rows;
  }

  async function designateReviewer(id: string, project: string, lead: string) {
    const eligible = await send(
      'post',
      `/api/staff/${id}/reviewer-eligibility`,
      { scopeCode: 'concrete_field', reason: 'Certified field reviewer', idempotencyKey: newKey() },
      'admin',
    );
    expectStatus(eligible, 201, 'eligibility');
    expectStatus(
      await send(
        'post',
        `/api/projects/${project}/team-members`,
        { userId: id, reason: 'On the project', idempotencyKey: newKey() },
        'admin',
      ),
      201,
      'team',
    );
    const assigned = await send(
      'post',
      `/api/projects/${project}/reviewer-assignments`,
      {
        reviewerUserId: id,
        scopeCode: 'concrete_field',
        reason: 'Reviews field reports',
        idempotencyKey: newKey(),
      },
      'admin',
    );
    expectStatus(assigned, 201, 'assign');
    const assignment = (
      assigned.body as { active: { id: string; reviewer: { userId: string } }[] }
    ).active.find((a) => a.reviewer.userId === id)!.id;
    expectStatus(
      await send(
        'post',
        `/api/projects/${project}/reviewer-assignments/${assignment}/approval`,
        { idempotencyKey: newKey() },
        lead,
      ),
      201,
      'approval',
    );
  }

  const completeFields = (mix: { supplierName: string; mixNumber: string; id: string }) => ({
    reportDate: '2026-11-02',
    contractorName: 'Example Builders',
    locationElements: ['Footing'],
    locationDescription: 'Grid A-3',
    supplierName: mix.supplierName,
    mixNumber: mix.mixNumber,
    mixId: mix.id,
    ticketNumber: `T-${randomUUID().slice(0, 8)}`,
    truckNumber: 'T-7',
    plantName: 'North Plant',
    batchedAt: '2026-11-02T14:40:00.000Z',
    loadVolumeM3: 8,
    cumulativeVolumeM3: 24,
    projectSpec: SPEC,
    ticketSpec: SPEC,
    arrivedAt: '2026-11-02T14:55:00.000Z',
    sampledAt: '2026-11-02T15:00:00.000Z',
    testedAt: '2026-11-02T15:05:00.000Z',
    timeLimitExceeded: false,
    loadRejected: false,
    loadDecisionByName: 'Sam Example',
    loadDecisionByCompany: 'Example Builders',
    samplingLocation: 'chute',
    placementMethods: ['chute'],
    material: 'concrete',
    superplasticizerAdded: 'none',
    concreteTempC: 18,
    ambientTempC: -4,
    waterAdded: false,
    specimensCast: true,
    castAt: CAST_AT,
    resultsReportedToName: 'Sam Example',
    resultsReportedToCompany: 'Example Builders',
    readings: [
      { id: randomUUID(), test: 'slump', context: 'initial', value: 90 },
      { id: randomUUID(), test: 'air', context: 'initial', value: 6 },
    ],
    attachmentRefs: [{ id: randomUUID(), kind: 'ticket_photo', fileName: 'ticket-0042.jpg' }],
  });

  const command = (
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
    key = newKey(),
  ) =>
    send(
      'post',
      reportPath(report.id, `/${action}`),
      { idempotencyKey: key, version: report.version, ...extra },
      as,
    );

  async function ok(
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
  ) {
    const response = await command(action, report, as, extra);
    expectStatus(response, 201, action);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  async function documentAll(report: ConcreteFieldReportDetail, as: string) {
    const versionNo = report.lifecycle.latestVersion!.versionNo;
    const version = await get(reportPath(report.id, `/versions/${versionNo}`), as);
    const warnings = (version.body as { snapshot: { warnings: { code: string; field: string }[] } })
      .snapshot.warnings;
    const seen = new Set<string>();
    for (const w of warnings) {
      if (seen.has(`${w.code}|${w.field}`)) continue;
      seen.add(`${w.code}|${w.field}`);
      expectStatus(
        await send(
          'post',
          reportPath(report.id, `/versions/${versionNo}/exception-notes`),
          { code: w.code, field: w.field, note: 'Accepted by the reviewer' },
          as,
        ),
        201,
        'exception note',
      );
    }
  }

  const specimenVersion = async (id: string) =>
    (
      await h.db.pool.query<{ version: number }>(
        'SELECT version FROM concrete_specimen WHERE id = $1',
        [id],
      )
    ).rows[0]!.version;

  async function number(setId: string, n: number) {
    // Stand-in for the package 3 allocator (C18): the tests attach a number the way C05–C26 do.
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [setId, n, `26-${String(n).padStart(2, '0')}`],
    );
  }

  async function capabilities(project: string, as: string) {
    const response = await get(`/api/projects/${project}/capabilities`, as);
    expectStatus(response, 200, 'capabilities');
    const caps = projectCapabilitiesSchema.parse(response.body);
    return Object.fromEntries(
      caps.capabilities
        .filter((c) => c.action.startsWith('concrete'))
        .map((c) => [c.action, c.allowed]),
    );
  }

  // Shared state through the ordered scenario.
  let storageBefore: string;
  let mix: ReturnType<typeof concreteMixDetailSchema.parse>;
  let report: ConcreteFieldReportDetail;
  let set1: ConcreteSpecimenSetDetail; // mix ages 7/28/28/HOLD
  let set2: ConcreteSpecimenSetDetail; // HOLD/HOLD
  let set3: ConcreteSpecimenSetDetail; // 7 (missing at receiving)
  let reportC: ConcreteFieldReportDetail;
  let setC: ConcreteSpecimenSetDetail;
  let v1Sha: string;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'admin', 'js', 'jo', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
      people[key] = h.users[key];
    }
    await person('lt', 'Taylor Bench', 'TB', ['lab_technician']);
    await person('lm2', 'Morgan Manager', 'MOM', ['lab_manager']);
    await person('dd', 'Dana Delegate', 'DD');
    await person('rv', 'Riley Reviewer', 'RR');
    projectC = await insertProject(h.db.pool, 'DEMO-2603', h.users.jo);
    // A storage unit received on A before any concrete work, so AC3 compares real rows.
    await h.bucket({ hole: h.holes.a1 });
    storageBefore = await storageUnitFingerprint();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // Project set-up: reviewers, issuer, delegate and the concrete Lab Manager grant
  // ---------------------------------------------------------------------------------------------

  it('AC1 set-up: reviewer, issuer, delegate and the concrete LM grant are recorded with audit', async () => {
    await designateReviewer(people.rv!, h.projects.a, 'pe');
    expectStatus(
      await send(
        'post',
        `/api/projects/${h.projects.a}/report-issuers`,
        {
          issuerUserId: people.js,
          scopeCode: 'concrete_field',
          reason: 'Signs field reports while the lead is away',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
      201,
      'issuer',
    );
    expectStatus(
      await send(
        'post',
        `/api/projects/${h.projects.a}/acceptance-delegates`,
        { delegateUserId: people.dd, reason: 'Accepts lab tests', idempotencyKey: newKey() },
        'pe',
      ),
      201,
      'delegate',
    );
    // D13: only the lead or an admin grants it; the Lab Manager must hold the role.
    const grantBody = {
      labManagerUserId: people.lm,
      reason: 'Runs failed-specimen holds on DEMO-2601',
      idempotencyKey: newKey(),
    };
    await refusedFor(['lm', 'lm2', 'rv', 'js', 'dd', 'jo', 'tech', 'lab'], (as) =>
      send('post', `/api/projects/${h.projects.a}/concrete-lab-managers`, grantBody, as),
    );
    expectStatus(
      await send('post', `/api/projects/${h.projects.a}/concrete-lab-managers`, grantBody, 'pe'),
      201,
      'grant',
    );
    const { rows: grants } = await h.db.pool.query(
      `SELECT project_id, lab_manager_user_id, revoked_at FROM project_concrete_lab_manager_grant`,
    );
    expect(grants).toEqual([
      { project_id: h.projects.a, lab_manager_user_id: people.lm, revoked_at: null },
    ]);
    const { rows: grantAudit } = await h.db.pool.query(
      `SELECT actor_user_id, reason FROM audit_event
       WHERE action = 'project_concrete_lab_manager_grant.granted'`,
    );
    expect(grantAudit).toEqual([{ actor_user_id: people.pe, reason: grantBody.reason }]);

    // C38: the project's machine-info choice, by project.edit (the lead or an admin).
    await refusedFor(['lm', 'rv', 'js', 'dd', 'tech', 'jo'], (as) =>
      send(
        'patch',
        `/api/projects/${h.projects.a}/concrete-settings`,
        { version: 0, includeMachineInfo: true, reason: 'Clients want the machine' },
        as,
      ),
    );
    expectStatus(
      await send(
        'patch',
        `/api/projects/${h.projects.a}/concrete-settings`,
        { version: 0, includeMachineInfo: true, reason: 'Clients want the machine' },
        'pe',
      ),
      200,
      'settings',
    );
  });

  it('AC1: concrete capabilities per actor match the confirmed plan (no implicit authority)', async () => {
    const all = (allowed: boolean) => ({
      'concrete_mix.manage': allowed,
      'concrete_mix.approve': allowed,
      'concrete.review': allowed,
      'concrete_specimen.reschedule': allowed,
      'concrete_receiving_exception.resolve': allowed,
      'concrete_ordinary_hold.manage': allowed,
      'concrete_hold.manage': allowed,
    });
    expect(await capabilities(h.projects.a, 'pe')).toEqual(all(true));
    expect(await capabilities(h.projects.a, 'rv')).toEqual({
      ...all(false),
      'concrete.review': true,
      'concrete_specimen.reschedule': true,
      'concrete_receiving_exception.resolve': true,
    });
    // Grant LM on A: reschedule, exceptions and both HOLD kinds; never mixes or review.
    expect(await capabilities(h.projects.a, 'lm')).toEqual({
      ...all(false),
      'concrete_specimen.reschedule': true,
      'concrete_receiving_exception.resolve': true,
      'concrete_ordinary_hold.manage': true,
      'concrete_hold.manage': true,
    });
    // Role alone: ordinary HOLD only (C10/C26).
    expect(await capabilities(h.projects.a, 'lm2')).toEqual({
      ...all(false),
      'concrete_ordinary_hold.manage': true,
    });
    // Admin, delegate, issuer, lab technician and an ordinary technician: no concrete authority.
    for (const as of ['admin', 'dd', 'js', 'lt', 'tech']) {
      expect(await capabilities(h.projects.a, as), as).toEqual(all(false));
    }
    // Project boundaries: A's lead, reviewer and grant LM have nothing on C; C's lead has it all.
    expect(await capabilities(projectC, 'pe')).toEqual(all(false));
    expect(await capabilities(projectC, 'rv')).toEqual(all(false));
    expect(await capabilities(projectC, 'lm')).toEqual({
      ...all(false),
      'concrete_ordinary_hold.manage': true,
    });
    expect(await capabilities(projectC, 'jo')).toEqual(all(true));
    // LAB reads no capabilities at all (project_access.read is never LAB's).
    expect((await get(`/api/projects/${h.projects.a}/capabilities`, 'lab')).status).toBe(403);
  });

  // ---------------------------------------------------------------------------------------------
  // Supplier (C37) and mix (C03): Lead-only, with replay and stale-version proofs
  // ---------------------------------------------------------------------------------------------

  it('AC1/AC2: a listed supplier and a Lead-only mix; replays and stale versions write nothing', async () => {
    // Suppliers: Lab Manager or admin; never the lead, reviewer, issuer or LAB.
    const supplierBody = { name: 'Example Ready-Mix', plantNames: ['North Plant'] };
    await refusedFor(['pe', 'rv', 'js', 'dd', 'lt', 'tech', 'lab'], (as) =>
      send('post', '/api/concrete/suppliers', supplierBody, as),
    );
    const supplier = await send('post', '/api/concrete/suppliers', supplierBody, 'lm');
    expectStatus(supplier, 201, 'supplier');
    const supplierId = (supplier.body as { id: string }).id;

    const mixBody = {
      idempotencyKey: newKey(),
      supplierId,
      spec: {
        supplierName: 'Example Ready-Mix',
        mixNumber: 'M-0042',
        plantNames: ['North Plant'],
        ...SPEC,
        ticketDefaults: { slumpTargetMm: 80, slumpToleranceMm: 30, cementType: 'GU' },
        testAges: [7, 28, 28, 'HOLD'],
      },
    };
    // CD-52 / AO08: no admin, Lab Manager, grant LM, reviewer, issuer, delegate or other lead.
    await refusedFor(['admin', 'lm', 'lm2', 'rv', 'js', 'dd', 'jo', 'tech', 'lt', 'lab'], (as) =>
      send('post', `/api/projects/${h.projects.a}/concrete-mixes`, mixBody, as),
    );
    const made = await send('post', `/api/projects/${h.projects.a}/concrete-mixes`, mixBody, 'pe');
    expectStatus(made, 201, 'mix');
    const draft = concreteMixDetailSchema.parse(made.body);
    // AC2: the exact retry returns the same mix; no second mix or revision.
    const retried = await send(
      'post',
      `/api/projects/${h.projects.a}/concrete-mixes`,
      mixBody,
      'pe',
    );
    expect([200, 201]).toContain(retried.status);
    expect(concreteMixDetailSchema.parse(retried.body).id).toBe(draft.id);

    const approveBody = {
      idempotencyKey: newKey(),
      version: draft.version,
      revisionId: draft.draftRevision!.id,
    };
    await refusedFor(['admin', 'lm', 'rv', 'js', 'jo'], (as) =>
      send('post', `/api/concrete-mixes/${draft.id}/approve`, approveBody, as),
    );
    // A stale version is refused without writing.
    await refusedFor(
      ['pe'],
      (as) =>
        send(
          'post',
          `/api/concrete-mixes/${draft.id}/approve`,
          { ...approveBody, idempotencyKey: newKey(), version: draft.version + 5 },
          as,
        ),
      409,
    );
    const approved = await send(
      'post',
      `/api/concrete-mixes/${draft.id}/approve`,
      approveBody,
      'pe',
    );
    expectStatus(approved, 201, 'approve');
    mix = concreteMixDetailSchema.parse(approved.body);
    const { rows } = await h.db.pool.query(
      `SELECT m.supplier_id, m.effective_revision_id IS NOT NULL AS effective,
              (SELECT count(*)::int FROM concrete_mix WHERE project_id = $2) AS mixes,
              (SELECT json_agg(state ORDER BY revision_number) FROM concrete_mix_revision r
               WHERE r.mix_id = m.id) AS states
       FROM concrete_mix m WHERE m.id = $1`,
      [mix.id, h.projects.a],
    );
    expect(rows[0]).toEqual({
      supplier_id: supplierId,
      effective: true,
      mixes: 1,
      states: ['approved'],
    });
    expect((await audit(mix.id)).map((a) => [a.action, a.actor_user_id])).toEqual([
      ['concrete_mix.created', people.pe],
      ['concrete_mix.approved', people.pe],
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // Field report (C04), sets (C05) and the holiday flag (C37)
  // ---------------------------------------------------------------------------------------------

  it('AC1: the report keeps the mix snapshot; sets take the mix ages; LAB attribution is recorded', async () => {
    // C37: an admin adds a company holiday on the 28-day target (30 Nov 2026).
    await refusedFor(['lm', 'pe', 'lab'], (as) =>
      send(
        'post',
        '/api/concrete/holidays',
        { holidayOn: '2026-11-30', name: 'Fictional day' },
        as,
      ),
    );
    expectStatus(
      await send(
        'post',
        '/api/concrete/holidays',
        { holidayOn: '2026-11-30', name: 'Fictional company day' },
        'admin',
      ),
      201,
      'holiday',
    );

    const fields = completeFields({
      supplierName: 'Example Ready-Mix',
      mixNumber: 'M-0042',
      id: mix.id,
    });
    const key = newKey();
    const created = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: key, ...fields },
      'tech',
    );
    expectStatus(created, 201, 'report');
    report = concreteFieldReportDetailSchema.parse(created.body);
    // AC2: an exact retry returns the same report, and nothing new is written.
    const before = await fingerprint();
    const retry = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: key, ...fields },
      'tech',
    );
    expect([200, 201]).toContain(retry.status);
    expect(concreteFieldReportDetailSchema.parse(retry.body).id).toBe(report.id);
    expect(await fingerprint()).toEqual(before);

    const { rows: reportRows } = await h.db.pool.query(
      `SELECT project_id, created_by_user_id, technician_user_id, workflow_state, mix_id,
              mix_snapshot->>'revisionId' AS revision
       FROM concrete_field_report WHERE id = $1`,
      [report.id],
    );
    expect(reportRows[0]).toEqual({
      project_id: h.projects.a,
      created_by_user_id: people.tech,
      technician_user_id: people.tech,
      workflow_state: 'draft',
      mix_id: mix.id,
      revision: mix.effectiveRevision!.id,
    });

    // LAB drafts only while naming the performing technician (attribution, not authority).
    const labMissing = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete' },
      'lab',
    );
    // resolveActingPerson: LAB must name the person (400 technicianUserId required).
    expect(labMissing.status).toBe(400);
    const labMade = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', technicianUserId: people.tech },
      'lab',
    );
    expectStatus(labMade, 201, 'lab report');
    const labReportId = concreteFieldReportDetailSchema.parse(labMade.body).id;
    const { rows: labRows } = await h.db.pool.query(
      `SELECT created_by_user_id, technician_user_id FROM concrete_field_report WHERE id = $1`,
      [labReportId],
    );
    expect(labRows[0]).toEqual({
      created_by_user_id: h.users.lab,
      technician_user_id: people.tech,
    });
    expect((await audit(labReportId))[0]).toMatchObject({
      action: 'concrete_field_report.draft_created',
      actor_user_id: h.users.lab,
      actor_account_type: 'shared_lab',
    });
    // Own drafts only: another technician can't save this one.
    const foreign = await send(
      'patch',
      reportPath(report.id),
      { idempotencyKey: newKey(), version: report.version, contractorName: 'Someone else' },
      'js',
    );
    expect(foreign.status).toBe(403);

    // Sets: the mix's ages (C03 → C05), targets from the casting time, the holiday flag (C37).
    const setKey = newKey();
    const made1 = await send(
      'post',
      reportPath(report.id, '/specimen-sets'),
      { idempotencyKey: setKey, mouldSize: '100x200' },
      'tech',
    );
    expectStatus(made1, 201, 'set 1');
    set1 = concreteSpecimenSetDetailSchema.parse(made1.body);
    const setsBefore = await fingerprint();
    const again = await send(
      'post',
      reportPath(report.id, '/specimen-sets'),
      { idempotencyKey: setKey, mouldSize: '100x200' },
      'tech',
    );
    expect([200, 201]).toContain(again.status);
    expect(concreteSpecimenSetDetailSchema.parse(again.body).id).toBe(set1.id);
    expect(await fingerprint()).toEqual(setsBefore);
    expect(set1.specimens.map((s) => [s.letter, s.assignedAge, s.targetDate])).toEqual([
      ['A', 7, '2026-11-09'],
      ['B', 28, '2026-11-30'],
      ['C', 28, '2026-11-30'],
      ['D', 'HOLD', null],
    ]);
    expect(set1.specimens[1]!.flags).toContain('holiday_target');
    expect(set1.specimens[0]!.flags).not.toContain('holiday_target');

    const made2 = await send(
      'post',
      reportPath(report.id, '/specimen-sets'),
      {
        idempotencyKey: newKey(),
        mouldSize: '100x200',
        specimens: [
          { id: randomUUID(), age: 'HOLD' },
          { id: randomUUID(), age: 'HOLD' },
        ],
      },
      'tech',
    );
    expectStatus(made2, 201, 'set 2');
    set2 = concreteSpecimenSetDetailSchema.parse(made2.body);
    const made3 = await send(
      'post',
      reportPath(report.id, '/specimen-sets'),
      { idempotencyKey: newKey(), mouldSize: '100x200', specimens: [{ id: randomUUID(), age: 7 }] },
      'tech',
    );
    expectStatus(made3, 201, 'set 3');
    set3 = concreteSpecimenSetDetailSchema.parse(made3.body);

    // No permanent number is consumed by drafting (the allocator is package 3).
    const { rows: numbers } = await h.db.pool.query(
      `SELECT count(*)::int AS sets, count(permanent_number)::int AS numbered,
              count(temporary_id)::int AS temporary
       FROM concrete_specimen_set WHERE field_report_id = $1`,
      [report.id],
    );
    // Temporary IDs arrive with offline creation (package 2/3); nothing is allocated here.
    expect(numbers[0]).toEqual({ sets: 3, numbered: 0, temporary: 0 });

    // Project C: a report cast by Jordan Smith (js), for the boundary checks below.
    const madeC = await send(
      'post',
      `/api/concrete/projects/${projectC}/field-reports`,
      {
        idempotencyKey: newKey(),
        material: 'concrete',
        specimensCast: true,
        castAt: CAST_AT,
      },
      'js',
    );
    expectStatus(madeC, 201, 'report C');
    reportC = concreteFieldReportDetailSchema.parse(madeC.body);
    const setMadeC = await send(
      'post',
      reportPath(reportC.id, '/specimen-sets'),
      { idempotencyKey: newKey(), mouldSize: '100x200', specimens: [{ id: randomUUID(), age: 7 }] },
      'js',
    );
    expectStatus(setMadeC, 201, 'set C');
    setC = concreteSpecimenSetDetailSchema.parse(setMadeC.body);
  });

  // ---------------------------------------------------------------------------------------------
  // Lifecycle: submit, return (notification), resubmit, review, issue (C09, C28, C29, C38)
  // ---------------------------------------------------------------------------------------------

  it('AC1/AC2: submit → return → resubmit → review → issue, with routing, notices and snapshots', async () => {
    report = concreteFieldReportDetailSchema.parse((await get(reportPath(report.id), 'tech')).body);
    expect(report.completeness.missingRequired).toEqual([]);

    // AC2: a stale version is refused; the exact retry of a submit makes one version.
    await refusedFor(
      ['tech'],
      (as) => command('submit', { id: report.id, version: report.version + 3 }, as),
      409,
    );
    const key = newKey();
    const first = await command('submit', report, 'tech', {}, key);
    expectStatus(first, 201, 'submit');
    const afterSubmit = await fingerprint();
    const replay = await command('submit', report, 'tech', {}, key);
    expect([200, 201]).toContain(replay.status);
    expect(await fingerprint()).toEqual(afterSubmit);
    report = concreteFieldReportDetailSchema.parse(first.body);
    const { rows: v1 } = await h.db.pool.query<{ snapshot_sha256: string }>(
      `SELECT snapshot_sha256 FROM concrete_report_version
       WHERE field_report_id = $1 AND version_no = 1`,
      [report.id],
    );
    v1Sha = v1[0]!.snapshot_sha256;

    // Number the sets now (stand-in for C18) so C06/C22/C26 can act on them.
    await number(set1.id, 1);
    await number(set2.id, 2);
    await number(set3.id, 3);
    await number(setC.id, 4);

    // No self-review; no admin, Lab Manager, issuer, delegate, LAB or other lead review.
    await refusedFor(['tech', 'admin', 'lm', 'lm2', 'js', 'dd', 'jo', 'lt', 'lab'], (as) =>
      command('return', report, as, { comment: 'Not my report to return' }),
    );
    report = await ok('return', report, 'rv', { comment: 'Truck number is missing a digit' });
    // C29: the technician and the project's grant LM are told; never the reviewer, never lm2
    // (A has a grant, so not every Lab Manager), never email.
    const { rows: notices } = await h.db.pool.query<{ recipient_user_id: string; kind: string }>(
      `SELECT recipient_user_id, kind FROM notification WHERE concrete_field_report_id = $1`,
      [report.id],
    );
    expect(notices.map((n) => n.recipient_user_id).sort()).toEqual(
      [people.tech!, people.lm!].sort(),
    );
    expect(new Set(notices.map((n) => n.kind))).toEqual(new Set(['concrete_report.returned']));
    const { rows: outbox } = await h.db.pool.query('SELECT 1 FROM email_outbox');
    expect(outbox).toEqual([]);

    // Only the technician corrects and resubmits; it routes back to the reviewer who returned it.
    await refusedFor(['pe', 'rv', 'js'], (as) => command('resubmit', report, as));
    report = await ok('resubmit', report, 'tech');

    // C28: Mark reviewed needs every exception documented (none here: a listed approved mix).
    await documentAll(report, 'rv');
    // The lead may review too (AO08 Q3); here the reviewer it was routed back to does.
    await refusedFor(['admin', 'lm', 'js', 'dd', 'jo', 'tech'], (as) =>
      command('review', report, as),
    );
    report = await ok('review', report, 'rv');

    // Issue: the lead or the issuer grant; never the reviewer, admin, LM, delegate or other lead.
    await refusedFor(['rv', 'admin', 'lm', 'lm2', 'dd', 'jo', 'tech', 'lab'], (as) =>
      command('issue', report, as),
    );
    // C38: includeMachineInfo omitted → A's setting (true) is stored and audited.
    report = await ok('issue', report, 'js');
    expect(report.issuance.issueCount).toBe(1);
    const { rows: versions } = await h.db.pool.query(
      `SELECT version_no, state, issue_include_machine_info, snapshot_sha256
       FROM concrete_report_version WHERE field_report_id = $1 ORDER BY version_no`,
      [report.id],
    );
    expect(versions.map((v) => [v.version_no, v.state, v.issue_include_machine_info])).toEqual([
      [1, 'returned', null],
      [2, 'issued', true],
    ]);
    // The returned version's snapshot is never rewritten.
    expect(versions[0]!.snapshot_sha256).toBe(v1Sha);
    const { rows: transitions } = await h.db.pool.query(
      `SELECT action, actor_user_id FROM concrete_report_transition
       WHERE field_report_id = $1 ORDER BY created_at, id`,
      [report.id],
    );
    expect(transitions.map((t) => [t.action, t.actor_user_id])).toEqual([
      ['submit', people.tech],
      ['return', people.rv],
      ['resubmit', people.tech],
      ['review', people.rv],
      ['issue', people.js],
    ]);
    const actions = (await audit(report.id)).map((a) => [a.action, a.actor_user_id]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['concrete_field_report.submitted', people.tech],
        ['concrete_field_report.returned', people.rv],
        ['concrete_field_report.reviewed', people.rv],
        ['concrete_field_report.issued', people.js],
      ]),
    );
  });

  // ---------------------------------------------------------------------------------------------
  // Pickup and receipt (C06): lab staff only, LAB names the person
  // ---------------------------------------------------------------------------------------------

  it('AC1/AC2: pickup and receipt by lab staff; LAB names the actual collector and receiver', async () => {
    const specimens = set1.specimens.map((s) => ({ id: s.id, version: null }));
    const pickup = {
      idempotencyKey: newKey(),
      specimens,
      complete: true,
      collectedAt: '2026-11-03T08:30:00-06:00',
      curingMinC: 18.5,
      curingMaxC: 24,
    };
    // Lab staff only (C36): never an ordinary technician, admin, the lead or a reviewer.
    await refusedFor(['tech', 'admin', 'pe', 'rv', 'js'], (as) =>
      send('post', `/api/concrete/specimen-sets/${set1.id}/pickup`, pickup, as),
    );
    // LAB must name the collector.
    await refusedFor(
      ['lab'],
      (as) => send('post', `/api/concrete/specimen-sets/${set1.id}/pickup`, pickup, as),
      400,
    );
    const body = { ...pickup, collectedByUserId: people.lt };
    const done = await send('post', `/api/concrete/specimen-sets/${set1.id}/pickup`, body, 'lab');
    expectStatus(done, 201, 'pickup');
    const after = await fingerprint();
    const replay = await send('post', `/api/concrete/specimen-sets/${set1.id}/pickup`, body, 'lab');
    expect([200, 201]).toContain(replay.status);
    expect(await fingerprint()).toEqual(after);
    const { rows: pickups } = await h.db.pool.query(
      `SELECT count(*)::int AS n, array_agg(DISTINCT collected_by_user_id) AS collectors,
              bool_and(completed) AS completed
       FROM concrete_specimen_pickup WHERE specimen_id = ANY($1::uuid[])`,
      [set1.specimens.map((s) => s.id)],
    );
    expect(pickups[0]).toEqual({ n: 4, collectors: [people.lt], completed: true });

    // Receipts: Taylor (personal) for A–C; LAB naming Taylor for D.
    for (const s of set1.specimens.slice(0, 3)) {
      expectStatus(
        await send(
          'post',
          `/api/concrete/specimens/${s.id}/receipt`,
          { idempotencyKey: newKey(), receivedAt: '2026-11-03T10:00:00-06:00', massG: 3650.5 },
          'lt',
        ),
        201,
        `receipt ${s.letter}`,
      );
    }
    const d = set1.specimens[3]!;
    const labReceipt = {
      idempotencyKey: newKey(),
      receivedAt: '2026-11-03T10:05:00-06:00',
      massG: '3648.0',
    };
    await refusedFor(
      ['lab'],
      (as) => send('post', `/api/concrete/specimens/${d.id}/receipt`, labReceipt, as),
      400,
    );
    expectStatus(
      await send(
        'post',
        `/api/concrete/specimens/${d.id}/receipt`,
        { ...labReceipt, receivedByUserId: people.lt },
        'lab',
      ),
      201,
      'LAB receipt',
    );
    const { rows: receipts } = await h.db.pool.query(
      `SELECT r.received_by_user_id, r.recorded_by_user_id
       FROM concrete_specimen_receipt r WHERE r.specimen_id = $1`,
      [d.id],
    );
    expect(receipts).toEqual([
      { received_by_user_id: people.lt, recorded_by_user_id: h.users.lab },
    ]);
    const labAudit = (await audit(d.id)).find((a) => a.actor_account_type === 'shared_lab');
    expect(labAudit).toBeDefined();
  });

  it('AC1: receiving exceptions: the casting technician resolves own specimens only; boundaries hold', async () => {
    const record = (projectId: string, specimenId: string) =>
      send(
        'post',
        `/api/concrete/projects/${projectId}/receiving-exceptions`,
        { idempotencyKey: newKey(), kind: 'missing', specimenId },
        'lt',
      );
    const missingA = await record(h.projects.a, set3.specimens[0]!.id);
    expectStatus(missingA, 201, 'missing A');
    const missingC = await record(projectC, setC.specimens[0]!.id);
    expectStatus(missingC, 201, 'missing C');
    const idA = (missingA.body as { id: string }).id;
    const idC = (missingC.body as { id: string }).id;
    const resolve = (id: string, as: string) =>
      send(
        'post',
        `/api/concrete/receiving-exceptions/${id}/resolve`,
        { idempotencyKey: newKey(), disposition: 'Not cast', reason: 'Only two moulds on site' },
        as,
      );
    // No admin, lm2 (no grant), issuer, delegate or LAB; tech didn't cast C's specimen; A's lead,
    // reviewer and grant LM have no authority on C.
    await refusedFor(['admin', 'lm2', 'js', 'dd', 'lab', 'jo'], (as) => resolve(idA, as));
    await refusedFor(['tech', 'pe', 'rv', 'lm'], (as) => resolve(idC, as));
    // The casting technician of A's specimen resolves it (record technician, C10).
    expectStatus(await resolve(idA, 'tech'), 201, 'resolve A');
    expectStatus(await resolve(idC, 'jo'), 201, 'resolve C');
    const { rows } = await h.db.pool.query(
      `SELECT id, resolved_by_user_id FROM concrete_receiving_exception ORDER BY id`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.resolved_by_user_id]))).toEqual({
      [idA]: people.tech,
      [idC]: people.jo,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Test results (C07): entry and correction history, LAB attribution
  // ---------------------------------------------------------------------------------------------

  it('AC1/AC2: test results keep tester, entering person and account; corrections keep history', async () => {
    const a = set1.specimens[0]!.id;
    const resultId = randomUUID();
    const url = `/api/concrete/specimens/${a}/test-results/${resultId}`;
    const entry = { version: 0, testedOn: '2026-11-09', maxLoad: 412.5 };
    await refusedFor(['tech', 'admin', 'pe', 'rv', 'js', 'dd'], (as) =>
      send('put', url, { idempotencyKey: newKey(), ...entry }, as),
    );
    await refusedFor(
      ['lab'],
      (as) => send('put', url, { idempotencyKey: newKey(), ...entry }, as),
      400,
    );
    const key = newKey();
    const saved = await send(
      'put',
      url,
      { idempotencyKey: key, ...entry, enteredByUserId: people.lt },
      'lab',
    );
    expectStatus(saved, 200, 'result');
    const after = await fingerprint();
    const replay = await send(
      'put',
      url,
      { idempotencyKey: key, ...entry, enteredByUserId: people.lt },
      'lab',
    );
    expectStatus(replay, 200, 'replay');
    expect(await fingerprint()).toEqual(after);
    // Stale version: nothing written.
    await refusedFor(
      ['lt'],
      (as) => send('put', url, { idempotencyKey: newKey(), version: 0, maxLoad: 1 }, as),
      409,
    );
    // A saved value changes only with a reason.
    await refusedFor(
      ['lt'],
      (as) => send('put', url, { idempotencyKey: newKey(), version: 1, maxLoad: 409.1 }, as),
      422,
    );
    expectStatus(
      await send(
        'put',
        url,
        {
          idempotencyKey: newKey(),
          version: 1,
          maxLoad: 409.1,
          reason: 'Dial misread; rechecked the machine log',
        },
        'lm',
      ),
      200,
      'correction',
    );
    const { rows } = await h.db.pool.query(
      `SELECT revision_no, kind, account_user_id, account_type, entered_by_user_id, reason,
              changes->'maxLoad' AS max_load
       FROM concrete_test_result_revision WHERE result_id = $1 ORDER BY revision_no`,
      [resultId],
    );
    expect(rows).toEqual([
      {
        revision_no: 1,
        kind: 'initial',
        account_user_id: h.users.lab,
        account_type: 'shared_lab',
        entered_by_user_id: people.lt,
        reason: null,
        max_load: { before: null, after: 412.5 },
      },
      {
        revision_no: 2,
        kind: 'correction',
        account_user_id: people.lm,
        account_type: 'personal',
        entered_by_user_id: people.lm,
        reason: 'Dial misread; rechecked the machine log',
        max_load: { before: 412.5, after: 409.1 },
      },
    ]);
    const { rows: result } = await h.db.pool.query(
      `SELECT state, tester_user_id, version FROM concrete_test_result WHERE id = $1`,
      [resultId],
    );
    // Incomplete numerical result: still a draft (G2/G8 gate the calculation, C23).
    expect(result[0]).toEqual({ state: 'draft', tester_user_id: people.lt, version: 2 });
  });

  // ---------------------------------------------------------------------------------------------
  // Worklist and reschedule (C22, C38)
  // ---------------------------------------------------------------------------------------------

  it('AC1/AC2: reschedule by the lead, reviewer or grant LM only; replay and stale write nothing', async () => {
    const worklist = await get(
      `/api/concrete/lab-worklist?view=upcoming&projectId=${h.projects.a}&on=2026-11-03`,
      'lab',
    );
    expectStatus(worklist, 200, 'worklist');
    const listed = JSON.stringify(worklist.body);
    expect(listed).toContain(set1.specimens[0]!.id);

    const b = set1.specimens[1]!.id;
    const url = `/api/concrete/specimens/${b}/reschedule`;
    const body = async () => ({
      idempotencyKey: newKey(),
      version: await specimenVersion(b),
      newAge: 35,
      reason: 'Client asked for a 35-day break',
    });
    await refusedFor(['admin', 'lm2', 'js', 'dd', 'tech', 'lt', 'jo', 'lab'], async (as) =>
      send('post', url, await body(), as),
    );
    const stale = { ...(await body()), version: (await specimenVersion(b)) + 4 };
    await refusedFor(['lm'], (as) => send('post', url, stale, as), 409);
    const request = await body();
    expectStatus(await send('post', url, request, 'lm'), 201, 'reschedule');
    const after = await fingerprint();
    const replay = await send('post', url, request, 'lm');
    expect([200, 201]).toContain(replay.status);
    expect(await fingerprint()).toEqual(after);
    const { rows } = await h.db.pool.query(
      `SELECT previous_age, new_age, rescheduled_by_user_id, reason
       FROM concrete_specimen_reschedule WHERE specimen_id = $1`,
      [b],
    );
    expect(rows).toEqual([
      {
        previous_age: '28',
        new_age: '35',
        rescheduled_by_user_id: people.lm,
        reason: 'Client asked for a 35-day break',
      },
    ]);
    const { rows: specimen } = await h.db.pool.query(
      'SELECT assigned_age, target_date::text AS target FROM concrete_specimen WHERE id = $1',
      [b],
    );
    expect(specimen[0]).toEqual({ assigned_age: '35', target: '2026-12-07' });
    // A HOLD specimen is C26's, not a reschedule (409, nothing written).
    await refusedFor(
      ['pe'],
      async (as) =>
        send(
          'post',
          `/api/concrete/specimens/${set1.specimens[3]!.id}/reschedule`,
          {
            idempotencyKey: newKey(),
            version: await specimenVersion(set1.specimens[3]!.id),
            newAge: 56,
            reason: 'Wrong path',
          },
          as,
        ),
      409,
    );
  });

  // ---------------------------------------------------------------------------------------------
  // HOLD and disposal (C26)
  // ---------------------------------------------------------------------------------------------

  it('AC1/AC2: ordinary HOLD by the lead or any LM; failed hold needs the grant; disposal by lab staff', async () => {
    const [h1, h2] = set2.specimens.map((s) => s.id) as [string, string];
    const item = async (id: string) => [{ specimenId: id, version: await specimenVersion(id) }];

    // Ordinary HOLD → test: lm2 by role alone; never admin, reviewer, issuer, delegate, other lead.
    const schedule = async () => ({
      idempotencyKey: newKey(),
      items: await item(h1),
      newAge: 56,
      reason: 'Engineer wants a 56-day break',
    });
    await refusedFor(['admin', 'rv', 'js', 'dd', 'tech', 'lt', 'jo', 'lab'], async (as) =>
      send('post', '/api/concrete/holds/schedule-test', await schedule(), as),
    );
    const scheduled = await schedule();
    expectStatus(
      await send('post', '/api/concrete/holds/schedule-test', scheduled, 'lm2'),
      200,
      'schedule',
    );
    const after = await fingerprint();
    const replay = await send('post', '/api/concrete/holds/schedule-test', scheduled, 'lm2');
    expect(replay.status).toBe(200);
    expect(await fingerprint()).toEqual(after);
    const { rows: schedules } = await h.db.pool.query(
      `SELECT count(*)::int AS n FROM concrete_specimen_hold_schedule WHERE specimen_id = $1`,
      [h1],
    );
    expect(schedules[0]!.n).toBe(1);

    // Ordinary HOLD → disposal authorized by the lead, then removed by lab staff (LAB names who).
    const authorize = async (id: string) => ({
      idempotencyKey: newKey(),
      items: await item(id),
      reason: 'Not needed for testing',
    });
    expectStatus(
      await send('post', '/api/concrete/holds/authorize-disposal', await authorize(h2), 'pe'),
      200,
      'authorize',
    );
    const disposal = {
      idempotencyKey: newKey(),
      specimenIds: [h2],
      disposedAt: new Date(Date.now() + 30_000).toISOString(),
    };
    await refusedFor(['tech', 'pe', 'admin'], (as) =>
      send('post', '/api/concrete/disposal/record', disposal, as),
    );
    await refusedFor(
      ['lab'],
      (as) => send('post', '/api/concrete/disposal/record', disposal, as),
      400,
    );
    expectStatus(
      await send(
        'post',
        '/api/concrete/disposal/record',
        { ...disposal, performedByUserId: people.lt },
        'lab',
      ),
      200,
      'disposed',
    );
    const { rows: disposed } = await h.db.pool.query(
      `SELECT hold_kind, authorized_by_user_id, disposed_by_user_id, disposal_recorded_by_user_id
       FROM concrete_specimen_disposal WHERE specimen_id = $1`,
      [h2],
    );
    expect(disposed).toEqual([
      {
        hold_kind: 'ordinary',
        authorized_by_user_id: people.pe,
        disposed_by_user_id: people.lt,
        disposal_recorded_by_user_id: h.users.lab,
      },
    ]);
    expect((await audit(h2)).map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'concrete_specimen.disposal_authorized',
        'concrete_specimen.disposed',
      ]),
    );

    // Failed-specimen hold (C25 will place it; stand-in insert): the grant LM, not lm2 (D13).
    const c = set1.specimens[2]!.id;
    await h.db.pool.query(
      `INSERT INTO concrete_specimen_failure_hold
         (project_id, specimen_id, reason, placed_by_user_id, placed_by_name_snapshot)
       VALUES ($1, $2, 'Fictional low result', $3, 'Pat Example')`,
      [h.projects.a, c, people.pe],
    );
    await refusedFor(['lm2', 'admin', 'rv', 'js', 'jo'], async (as) =>
      send('post', '/api/concrete/holds/authorize-disposal', await authorize(c), as),
    );
    expectStatus(
      await send('post', '/api/concrete/holds/authorize-disposal', await authorize(c), 'lm'),
      200,
      'failed authorize',
    );
    const { rows: failed } = await h.db.pool.query(
      `SELECT hold_kind, authorized_by_user_id FROM concrete_specimen_disposal
       WHERE specimen_id = $1`,
      [c],
    );
    expect(failed).toEqual([{ hold_kind: 'failed', authorized_by_user_id: people.lm }]);
  });

  // ---------------------------------------------------------------------------------------------
  // Read side (C30, C31), history and the storage-unit regression
  // ---------------------------------------------------------------------------------------------

  it('AC1: dashboard queues, search and project tabs read the same records; LAB reads too', async () => {
    const search = await get('/api/concrete/search?q=26-01', 'lab');
    expectStatus(search, 200, 'search');
    expect(JSON.stringify(search.body)).toContain(report.id);
    const queue = await get(
      `/api/concrete/receiving-queue?stage=awaiting_pickup&projectId=${h.projects.a}`,
      'tech',
    );
    expectStatus(queue, 200, 'queue');
    // Set 1 is fully picked up; sets 2 and 3 still wait for pickup.
    expect(JSON.stringify(queue.body)).not.toContain(set1.id);
    const specimens = await get(
      `/api/concrete/projects/${h.projects.a}/specimens?pageSize=50`,
      'tech',
    );
    expectStatus(specimens, 200, 'specimens');
    expect(JSON.stringify(specimens.body)).toContain(set1.specimens[0]!.id);
    const holds = await get('/api/concrete/holds', 'lab');
    expectStatus(holds, 200, 'holds');
  });

  it('AC2: histories are append-only and the issued report and identifiers never moved', async () => {
    const { rows } = await h.db.pool.query(
      `SELECT r.workflow_state, r.issue_count,
              (SELECT json_agg(json_build_object('n', permanent_number, 'id', permanent_id,
                       'tmp', temporary_id) ORDER BY permanent_number)
               FROM concrete_specimen_set WHERE field_report_id = r.id) AS sets,
              (SELECT snapshot_sha256 FROM concrete_report_version
               WHERE field_report_id = r.id AND version_no = 1) AS v1
       FROM concrete_field_report r WHERE r.id = $1`,
      [report.id],
    );
    expect(rows[0]).toMatchObject({ workflow_state: 'reviewed', issue_count: 1, v1: v1Sha });
    const sets = rows[0]!.sets as { n: number; id: string; tmp: string }[];
    expect(sets.map((s) => [s.n, s.id])).toEqual([
      [1, '26-01'],
      [2, '26-02'],
      [3, '26-03'],
    ]);
    expect(sets.every((s) => s.tmp === null)).toBe(true);
    // Append-only histories refuse deletes and edits.
    for (const sql of [
      'DELETE FROM concrete_specimen_reschedule',
      'DELETE FROM concrete_test_result_revision',
      'UPDATE concrete_report_transition SET comment = NULL',
      'DELETE FROM concrete_specimen_disposal',
      'DELETE FROM audit_event',
    ]) {
      await expect(h.db.pool.query(sql), sql).rejects.toThrow();
    }
  });

  it('AC3: the concrete scenario left storage units, receipts and their ID counters unchanged', async () => {
    expect(await storageUnitFingerprint()).toBe(storageBefore);
    // A storage-unit bucket received after it still gets the next BKT number of its own series.
    const { rows: units } = await h.db.pool.query<{ readable_id: string }>(
      `SELECT readable_id FROM storage_unit ORDER BY readable_id`,
    );
    expect(units.every((u) => /^BKT-2026-\d{6}$/.test(u.readable_id))).toBe(true);
    // Concrete never writes storage-unit tables or IDs: no concrete set ID looks like one.
    const { rows: ids } = await h.db.pool.query(
      `SELECT count(*)::int AS n FROM concrete_specimen_set
       WHERE permanent_id ~ '^(BKT|ST|CRE|CT|SU)-' OR temporary_id ~ '^(BKT|ST|CRE|CT|SU)-'`,
    );
    expect(ids[0]!.n).toBe(0);
  });
});
