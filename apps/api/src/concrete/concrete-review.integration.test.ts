import { randomUUID } from 'node:crypto';
import {
  concreteExceptionNoteListSchema,
  concreteFieldReportDetailSchema,
  concreteMixDetailSchema,
  concreteReportVersionListSchema,
  concreteReviewQueueSchema,
  type ConcreteFieldReportDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-V2-C28: the review queue (T1: filters and permissions), exception notes, the Mark reviewed
// rule (AC1), Return needing a comment (AC2) and the issue options. Real PostgreSQL, direct API
// calls. Fictional data only: DEMO-2601 (A) and DEMO-2602 (B), both led by Pat Example (`pe`);
// invented reviewers, suppliers and tickets.
describe.runIf(testDatabaseUrl)('concrete review queue and exceptions (MM-V2-C28)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  let rv: string;
  let rv2: string;

  const send = async (method: 'post' | 'patch', url: string, body: unknown, as: string) =>
    h
      .http()
      [method](url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as] ?? as)
      .send(body as object);
  const get = async (url: string, as: string) =>
    h
      .http()
      .get(url)
      .set('Cookie', cookies[as] ?? as);
  const reportPath = (id: string, rest = '') => `/api/concrete/field-reports/${id}${rest}`;

  async function person(name: string, initials: string) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', 'active') RETURNING id`,
      [name, initials],
    );
    const id = rows[0]!.id;
    const session = await h.app.get(SessionService).create(id, 'personal');
    cookies[id] = `${SESSION_COOKIE}=${session.token}`;
    return id;
  }

  const created = (r: { status: number; body: unknown }) =>
    expect(r.status, JSON.stringify(r.body)).toBe(201);

  async function designatedReviewer(name: string, initials: string, project: string) {
    const id = await person(name, initials);
    created(
      await send(
        'post',
        `/api/staff/${id}/reviewer-eligibility`,
        { scopeCode: 'concrete_field', reason: 'Certified', idempotencyKey: newKey() },
        'admin',
      ),
    );
    for (const p of [project]) {
      created(
        await send(
          'post',
          `/api/projects/${p}/team-members`,
          { userId: id, reason: 'On the project', idempotencyKey: newKey() },
          'admin',
        ),
      );
      const assigned = await send(
        'post',
        `/api/projects/${p}/reviewer-assignments`,
        {
          reviewerUserId: id,
          scopeCode: 'concrete_field',
          reason: 'Reviews field reports',
          idempotencyKey: newKey(),
        },
        'admin',
      );
      created(assigned);
      const assignment = (
        assigned.body as { active: { id: string; reviewer: { userId: string } }[] }
      ).active.find((a) => a.reviewer.userId === id)!.id;
      created(
        await send(
          'post',
          `/api/projects/${p}/reviewer-assignments/${assignment}/approval`,
          { idempotencyKey: newKey() },
          'pe',
        ),
      );
    }
    return id;
  }

  const SPEC = {
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    airMinPercent: 5,
    airMaxPercent: 8,
    maxAggregateSizeMm: 20,
    cementType: 'GU',
  };

  const completeFields = (slump = 90) => ({
    reportDate: '2026-11-08',
    contractorName: 'Example Builders',
    locationElements: ['Footing'],
    locationDescription: 'Grid A-3',
    supplierName: 'Example Ready-Mix',
    mixNumber: '0042',
    ticketNumber: `T-${randomUUID().slice(0, 8)}`,
    truckNumber: 'T-7',
    plantName: 'North Plant',
    batchedAt: '2026-11-08T15:00:00.000Z',
    loadVolumeM3: 8,
    cumulativeVolumeM3: 24,
    projectSpec: SPEC,
    ticketSpec: SPEC,
    arrivedAt: '2026-11-08T15:20:00.000Z',
    sampledAt: '2026-11-08T15:30:00.000Z',
    testedAt: '2026-11-08T15:35:00.000Z',
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
    specimensCast: false,
    resultsReportedToName: 'Sam Example',
    resultsReportedToCompany: 'Example Builders',
    readings: [
      { id: randomUUID(), test: 'slump', context: 'initial', value: slump },
      { id: randomUUID(), test: 'air', context: 'initial', value: 6 },
    ],
    attachmentRefs: [{ id: randomUUID(), kind: 'ticket_photo', fileName: 'ticket-0042.jpg' }],
  });

  async function draft(
    as = 'tech',
    fields: Record<string, unknown> = completeFields(),
    project = h.projects.a,
  ) {
    const response = await send(
      'post',
      `/api/concrete/projects/${project}/field-reports`,
      { idempotencyKey: newKey(), ...fields },
      as,
    );
    created(response);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  const command = (
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
  ) =>
    send(
      'post',
      reportPath(report.id, `/${action}`),
      { idempotencyKey: newKey(), version: report.version, ...extra },
      as,
    );

  async function ok(
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
  ) {
    const response = await command(action, report, as, extra);
    expect(response.status, `${action}: ${JSON.stringify(response.body)}`).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  const notePath = (report: ConcreteFieldReportDetail, versionNo?: number) =>
    reportPath(
      report.id,
      `/versions/${versionNo ?? report.lifecycle.latestVersion!.versionNo}/exception-notes`,
    );

  const document = (
    report: ConcreteFieldReportDetail,
    as: string,
    body: Record<string, unknown>,
    versionNo?: number,
  ) => send('post', notePath(report, versionNo), body, as);

  /** Document every exception the version was submitted with. */
  async function documentAll(report: ConcreteFieldReportDetail, as: string) {
    const version = await get(
      reportPath(report.id, `/versions/${report.lifecycle.latestVersion!.versionNo}`),
      as,
    );
    const warnings = (version.body as { snapshot: { warnings: { code: string; field: string }[] } })
      .snapshot.warnings;
    const seen = new Set<string>();
    for (const w of warnings) {
      const key = `${w.code}|${w.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      created(await document(report, as, { code: w.code, field: w.field, note: 'Accepted' }));
    }
  }

  const queue = async (query: string, as: string) => {
    const response = await get(`/api/concrete/review-queue${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteReviewQueueSchema.parse(response.body);
  };

  async function approvedMix(project: string) {
    const made = await send(
      'post',
      `/api/projects/${project}/concrete-mixes`,
      {
        idempotencyKey: newKey(),
        spec: {
          supplierName: 'Example Ready-Mix',
          mixNumber: `M-${randomUUID().slice(0, 6)}`,
          plantNames: ['North Plant'],
          ...SPEC,
          ticketDefaults: { slumpTargetMm: 80, slumpToleranceMm: 30, cementType: 'GU' },
        },
      },
      'pe',
    );
    created(made);
    const mix = concreteMixDetailSchema.parse(made.body);
    const approved = await send(
      'post',
      `/api/concrete-mixes/${mix.id}/approve`,
      { idempotencyKey: newKey(), version: mix.version, revisionId: mix.draftRevision!.id },
      'pe',
    );
    created(approved);
    return concreteMixDetailSchema.parse(approved.body);
  }

  async function writes(reportId: string) {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_report_exception_note WHERE field_report_id = $1) AS notes,
              (SELECT count(*)::int FROM concrete_report_transition WHERE field_report_id = $1) AS transitions,
              (SELECT count(*)::int FROM audit_event WHERE entity_id = $1) AS audit,
              (SELECT row_to_json(r)::text FROM concrete_field_report r WHERE id = $1) AS report`,
      [reportId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'jo', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    rv = await designatedReviewer('Riley Reviewer', 'RR', h.projects.a);
    rv2 = await designatedReviewer('Robin Second', 'RS', h.projects.a);
    // Jordan Smith (js) is an Authorized report issuer for field reports on A only.
    created(
      await send(
        'post',
        `/api/projects/${h.projects.a}/report-issuers`,
        {
          issuerUserId: h.users.js,
          scopeCode: 'concrete_field',
          reason: 'Signs field reports while the lead is away',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // T1: queue statuses, filters and who can act
  // ---------------------------------------------------------------------------------------------

  it('T1: one table in four statuses, with counts, filters and per-row authority', async () => {
    // Awaiting review on A (slump out of range) and on B; one returned; one reviewed; one issued.
    const awaitingA = await ok('submit', await draft('tech', completeFields(130)), 'tech');
    const awaitingB = await ok(
      'submit',
      await draft('tech', completeFields(), h.projects.b),
      'tech',
    );
    const returned = await ok('return', await ok('submit', await draft(), 'tech'), rv, {
      comment: 'The truck number is missing a digit',
    });
    const toReview = await ok('submit', await draft(), 'tech');
    await documentAll(toReview, rv);
    const reviewed = await ok('review', toReview, rv);
    const toIssue = await ok('submit', await draft(), 'tech');
    await documentAll(toIssue, rv);
    const issued = await ok('issue', await ok('review', toIssue, rv), 'pe', {
      includeMachineInfo: false,
    });
    // A draft never appears.
    await draft();

    const all = await queue('', 'pe');
    expect(all.counts).toEqual({
      awaiting_review: 2,
      returned: 1,
      reviewed_awaiting_issue: 1,
      issued: 1,
    });
    expect(all.items.map((r) => r.reportId)).toEqual([awaitingA.id, awaitingB.id]);
    const first = all.items[0]!;
    expect(first).toMatchObject({
      reportType: 'field',
      projectNumber: 'DEMO-2601',
      reportDate: '2026-11-08',
      technician: { userId: h.users.tech },
      status: 'awaiting_review',
      versionNo: 1,
      route: { kind: 'designated_reviewers', routedTo: null },
      documentedCount: 0,
      canAct: true,
    });
    expect(first.exceptions).toEqual(
      expect.arrayContaining([
        { code: 'slump_out_of_range', count: 1 },
        { code: 'unknown_mix', count: 1 },
      ]),
    );

    expect((await queue('?status=returned', 'pe')).items).toMatchObject([
      { reportId: returned.id, returnedBy: { userId: rv }, canAct: false },
    ]);
    expect((await queue('?status=reviewed_awaiting_issue', 'pe')).items).toMatchObject([
      { reportId: reviewed.id, reviewedBy: { userId: rv }, canAct: true },
    ]);
    expect((await queue('?status=issued', 'pe')).items).toMatchObject([
      { reportId: issued.id, issuedBy: { userId: h.users.pe }, canAct: false },
    ]);

    // Filters.
    expect((await queue(`?projectId=${h.projects.b}`, 'pe')).items.map((r) => r.reportId)).toEqual([
      awaitingB.id,
    ]);
    expect((await queue(`?technicianUserId=${h.users.js}`, 'pe')).total).toBe(0);
    expect((await queue('?submittedFrom=2099-01-01', 'pe')).counts.awaiting_review).toBe(0);
    expect((await queue('?exceptions=without', 'pe')).total).toBe(0);
    expect((await queue('?exceptions=with', 'pe')).total).toBe(2);
    expect((await queue('?reportType=field&pageSize=1&page=2', 'pe')).items).toMatchObject([
      { reportId: awaitingB.id },
    ]);
    const bad = await get('/api/concrete/review-queue?status=draft', 'pe');
    expect(bad.status).toBe(400);
    expect((await get('/api/concrete/review-queue?reportType=summary', 'pe')).status).toBe(400);
    // MM-V2-C39: strength reports are a report type (none submitted in this test).
    expect((await queue('?reportType=strength', 'pe')).total).toBe(0);

    // Who can act. rv reviews A only (not B); the technician never reviews their own report but
    // corrects it when returned; js issues on A; LAB and jo read only.
    const rvView = await queue('', rv);
    expect(rvView.items.map((r) => [r.reportId, r.canAct])).toEqual([
      [awaitingA.id, true],
      [awaitingB.id, false],
    ]);
    expect((await queue('?mine=true', rv)).items.map((r) => r.reportId)).toEqual([awaitingA.id]);
    expect((await queue('?mine=true', rv)).counts).toEqual({
      awaiting_review: 1,
      returned: 0,
      reviewed_awaiting_issue: 0,
      issued: 0,
    });
    const techMine = await queue('?mine=true&status=returned', 'tech');
    expect(techMine.items.map((r) => r.reportId)).toEqual([returned.id]);
    expect(techMine.counts.awaiting_review).toBe(0);
    expect((await queue('?status=reviewed_awaiting_issue&mine=true', 'js')).total).toBe(1);
    for (const who of ['lab', 'jo']) {
      const view = await queue('', who);
      expect(view.total, who).toBe(2);
      expect(
        view.items.every((r) => !r.canAct),
        who,
      ).toBe(true);
      expect((await queue('?mine=true', who)).total, who).toBe(0);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Exception notes and the Mark reviewed rule (AC1)
  // ---------------------------------------------------------------------------------------------

  it('AC1: Mark reviewed is refused until every exception is resolved or documented', async () => {
    const submitted = await ok('submit', await draft('tech', completeFields(130)), 'tech');
    const before = await writes(submitted.id);
    const refused = await command('review', submitted, rv);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('exceptions_unresolved');
    const fields = (refused.body.errors as { field: string }[]).map((e) => e.field);
    expect(fields).toHaveLength(2);
    expect(fields).toContain('mixNumber');
    expect(fields.some((field) => /^readings\..+\.value$/.test(field))).toBe(true);
    expect(await writes(submitted.id)).toEqual(before);

    const slump = submitted.review.warnings.find((w) => w.code === 'slump_out_of_range')!;
    const noted = await document(submitted, rv, {
      code: 'slump_out_of_range',
      field: slump.field,
      note: 'Engineer accepted the load at 130 mm',
    });
    created(noted);
    expect(concreteExceptionNoteListSchema.parse(noted.body).notes).toMatchObject([
      {
        versionNo: 1,
        code: 'slump_out_of_range',
        note: 'Engineer accepted the load at 130 mm',
        documentedBy: { userId: rv },
      },
    ]);
    // Still one open: the unknown mix.
    const stillOpen = await command('review', submitted, rv);
    expect(stillOpen.status).toBe(422);
    expect(stillOpen.body.errors).toMatchObject([{ field: 'mixNumber' }]);

    created(
      await document(submitted, rv, {
        code: 'unknown_mix',
        field: 'mixNumber',
        note: 'Mix confirmed with the supplier',
      }),
    );
    const reviewed = await ok('review', submitted, rv);
    expect(reviewed.lifecycle.state).toBe('reviewed');

    // The notes stay with the version; the audit trail has them.
    const listed = await get(notePath(submitted, 1), 'lab');
    expect(listed.status).toBe(200);
    expect(concreteExceptionNoteListSchema.parse(listed.body).notes).toHaveLength(2);
    const { rows: audit } = await h.db.pool.query<{ after: Record<string, unknown> }>(
      `SELECT after_values AS after FROM audit_event
       WHERE entity_id = $1 AND action = 'concrete_field_report.exception_documented'
       ORDER BY occurred_at, id`,
      [submitted.id],
    );
    expect(audit.map((a) => a.after.code)).toEqual(['slump_out_of_range', 'unknown_mix']);
  });

  it('an exception the live report no longer raises counts as resolved', async () => {
    const fields = completeFields();
    const mix = await approvedMix(h.projects.a);
    const clean = { ...fields, mixId: mix.id, mixNumber: mix.mixNumber };
    const earlier = await draft('tech', clean);
    const fresh = () => fields.readings.map((r) => ({ ...r, id: randomUUID() }));
    const later = await ok('submit', await draft('tech', { ...clean, readings: fresh() }), 'tech');
    expect(later.review.warnings.map((w) => w.code)).toEqual(['duplicate_ticket']);
    expect((await command('review', later, rv)).body.code).toBe('exceptions_unresolved');

    // The other report's ticket was a typo: corrected, so the duplicate is gone.
    expect(
      (
        await send(
          'patch',
          reportPath(earlier.id),
          { idempotencyKey: newKey(), version: earlier.version, ticketNumber: 'T-corrected' },
          'tech',
        )
      ).status,
    ).toBe(200);
    const reviewed = await ok('review', later, rv);
    expect(reviewed.lifecycle.state).toBe('reviewed');
    // A clean report has nothing to resolve and shows as "without exceptions".
    const plain = await ok(
      'submit',
      await draft('tech', {
        ...clean,
        readings: fresh(),
        ticketNumber: `T-${randomUUID().slice(0, 8)}`,
      }),
      'tech',
    );
    expect(plain.review.warnings).toEqual([]);
    expect((await queue('?exceptions=without', 'pe')).items.map((r) => r.reportId)).toContain(
      plain.id,
    );
  });

  it('who may document: reviewers on this report only, never its technician', async () => {
    const submitted = await ok('submit', await draft('tech', completeFields(130)), 'tech');
    const body = { code: 'unknown_mix', field: 'mixNumber', note: 'Confirmed' };
    const before = await writes(submitted.id);
    for (const who of ['lab', 'jo', 'tech', 'js']) {
      const refused = await document(submitted, who, body);
      expect(refused.status, who).toBe(403);
    }
    expect(await writes(submitted.id)).toEqual(before);

    // A reviewer's own report: never reviewed by them (owner decision 2026-11-08).
    const own = await ok('submit', await draft(rv, completeFields()), rv);
    const refused = await document(own, rv, body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('own_report');

    // Body and target checks.
    expect((await document(submitted, rv, { ...body, note: ' ' })).status).toBe(400);
    const unknown = await document(submitted, rv, { ...body, code: 'air_meter_flag' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('unknown_exception');
    expect((await document(submitted, rv, body, 7)).status).toBe(404);
    expect(
      (await send('post', reportPath(randomUUID(), '/versions/1/exception-notes'), body, rv))
        .status,
    ).toBe(404);

    // A retry of the same note is answered; another note for the same exception is refused.
    created(await document(submitted, rv, body));
    const retry = await document(submitted, rv, body);
    expect(retry.status).toBe(201);
    expect(concreteExceptionNoteListSchema.parse(retry.body).notes).toHaveLength(1);
    const other = await document(submitted, rv, { ...body, note: 'Something else' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('exception_already_documented');
  });

  it('notes belong to the version awaiting review: routed resubmissions and old versions', async () => {
    const submitted = await ok('submit', await draft('tech', completeFields(130)), 'tech');
    created(
      await document(submitted, rv, { code: 'unknown_mix', field: 'mixNumber', note: 'Known' }),
    );
    // AC2: Return needs a comment.
    const noComment = await command('return', submitted, rv);
    expect(noComment.status).toBe(400);
    const blank = await command('return', submitted, rv, { comment: '   ' });
    expect(blank.status).toBe(400);
    const returned = await ok('return', submitted, rv, { comment: 'Recheck the slump reading' });
    const resubmitted = await ok('resubmit', returned, 'tech');
    expect(resubmitted.lifecycle.latestVersion).toMatchObject({
      versionNo: 2,
      route: { kind: 'original_reviewer', routedTo: { userId: rv } },
    });

    // v1 is closed: nothing more is documented on it; v2 starts with no notes.
    const old = await document(
      resubmitted,
      rv,
      { code: 'unknown_mix', field: 'mixNumber', note: 'Again' },
      1,
    );
    expect(old.status).toBe(422);
    expect(old.body.code).toBe('version_not_awaiting_review');
    const v2Notes = await get(notePath(resubmitted, 2), 'pe');
    expect(concreteExceptionNoteListSchema.parse(v2Notes.body).notes).toEqual([]);

    // Routed to rv: another designated reviewer can't document it; the lead can.
    const routed = await document(resubmitted, rv2, {
      code: 'unknown_mix',
      field: 'mixNumber',
      note: 'Known',
    });
    expect(routed.status).toBe(403);
    expect(routed.body.code).toBe('routed_to_another_reviewer');
    created(
      await document(resubmitted, 'pe', { code: 'unknown_mix', field: 'mixNumber', note: 'Known' }),
    );
  });

  // ---------------------------------------------------------------------------------------------
  // Issue options
  // ---------------------------------------------------------------------------------------------

  it('issue records the issuer’s choices with the issued version', async () => {
    const submitted = await ok('submit', await draft(), 'tech');
    await documentAll(submitted, rv);
    const reviewed = await ok('review', submitted, rv);

    expect((await command('issue', reviewed, 'js', { includeMachineInfo: 'yes' })).status).toBe(
      400,
    );
    expect(
      (await command('issue', reviewed, 'js', { includeMachineInfo: true, includePhotos: true }))
        .status,
    ).toBe(400);
    // The technician never issues their own report (C09 refuses: no report.issue for them).
    expect((await command('issue', reviewed, 'tech', { includeMachineInfo: true })).status).toBe(
      403,
    );

    const issued = await ok('issue', reviewed, 'js', { includeMachineInfo: true });
    expect(issued.lifecycle.latestVersion?.issued).toMatchObject({
      by: { userId: h.users.js },
      source: 'report_issuer',
      includePhotos: false,
      includeMachineInfo: true,
    });
    const history = concreteReportVersionListSchema.parse(
      (await get(reportPath(submitted.id, '/versions'), 'lab')).body,
    );
    expect(history.versions[0]!.issued).toMatchObject({
      includePhotos: false,
      includeMachineInfo: true,
    });
    const { rows } = await h.db.pool.query<{ after: Record<string, unknown> }>(
      `SELECT after_values AS after FROM audit_event
       WHERE entity_id = $1 AND action = 'concrete_field_report.issued'`,
      [submitted.id],
    );
    expect(rows[0]!.after).toMatchObject({ includePhotos: false, includeMachineInfo: true });
  });

  // MM-V2-C38 (owner decision 2026-11-09): the issuer isn't forced to choose machine info.
  it('issue without a choice follows the project setting; unset leaves machine info out', async () => {
    // Settings rows are never deleted (C02), so set the value and put it back to unset after.
    const setMachineInfo = (value: boolean | null) =>
      h.db.pool.query(
        `INSERT INTO concrete_project_settings
           (project_id, include_machine_info, updated_by_user_id, updated_by_name_snapshot)
         VALUES ($1, $2, $3, 'Pat Example')
         ON CONFLICT (project_id) DO UPDATE
           SET include_machine_info = EXCLUDED.include_machine_info, updated_at = now(),
               version = concrete_project_settings.version + 1`,
        [h.projects.a, value, h.users.pe],
      );
    /** Issue a fresh report on A with project setting `setting` ('none' = no settings row). */
    const issueWith = async (setting: boolean | null | 'none', choice?: boolean) => {
      if (setting !== 'none') await setMachineInfo(setting);
      const submitted = await ok('submit', await draft(), 'tech');
      await documentAll(submitted, rv);
      const reviewed = await ok('review', submitted, rv);
      const issued = await ok(
        'issue',
        reviewed,
        'js',
        choice === undefined ? {} : { includeMachineInfo: choice },
      );
      const { rows } = await h.db.pool.query<{ stored: boolean; after: Record<string, unknown> }>(
        `SELECT v.issue_include_machine_info AS stored, a.after_values AS after
         FROM concrete_report_version v
         JOIN audit_event a
           ON a.entity_id = v.field_report_id AND a.action = 'concrete_field_report.issued'
         WHERE v.field_report_id = $1 AND v.state = 'issued'`,
        [submitted.id],
      );
      expect(rows).toHaveLength(1);
      // The issued record and its audit both say what was printed.
      expect(rows[0]!.after).toMatchObject({ includeMachineInfo: rows[0]!.stored });
      expect(issued.lifecycle.latestVersion?.issued?.includeMachineInfo).toBe(rows[0]!.stored);
      return rows[0]!.stored;
    };
    try {
      // AC3: setting unset and no choice → issued with machine info excluded, recorded as such.
      const { rows: existing } = await h.db.pool.query(
        `SELECT 1 FROM concrete_project_settings WHERE project_id = $1`,
        [h.projects.a],
      );
      if (existing.length === 0) expect(await issueWith('none')).toBe(false);
      expect(await issueWith(null)).toBe(false);
      expect(await issueWith(true)).toBe(true);
      expect(await issueWith(false)).toBe(false);
      // The issuer may still override the setting either way.
      expect(await issueWith(true, false)).toBe(false);
      expect(await issueWith(null, true)).toBe(true);
    } finally {
      await setMachineInfo(null);
    }
  });
});
