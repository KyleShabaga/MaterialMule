import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteReportVersionDetailSchema,
  concreteReportVersionListSchema,
  projectCapabilitiesSchema,
  type ConcreteFieldReportDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { REPORT_ISSUER_GRANT, REVIEWER_ASSIGNMENT } from '../project-access/grant-tables.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { endGrantDuring } from '../test-support/grant-race.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-V2-C09: report versions and the review / issue lifecycle, field-report path (card AC1–AC5;
// test plan T2, T3). Real PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A, led
// by Pat Example `pe`), invented reviewers, suppliers and tickets.
describe.runIf(testDatabaseUrl)('concrete report lifecycle (MM-V2-C09)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  /** Designated field reviewers on A (eligible, accepted member, assigned, lead-approved). */
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

  async function designatedReviewer(name: string, initials: string) {
    const id = await person(name, initials);
    const ok = (r: { status: number; body: unknown }) =>
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    ok(
      await send(
        'post',
        `/api/staff/${id}/reviewer-eligibility`,
        { scopeCode: 'concrete_field', reason: 'Certified', idempotencyKey: newKey() },
        'admin',
      ),
    );
    ok(
      await send(
        'post',
        `/api/projects/${h.projects.a}/team-members`,
        { userId: id, reason: 'On the project', idempotencyKey: newKey() },
        'admin',
      ),
    );
    const assigned = await send(
      'post',
      `/api/projects/${h.projects.a}/reviewer-assignments`,
      {
        reviewerUserId: id,
        scopeCode: 'concrete_field',
        reason: 'Reviews field reports',
        idempotencyKey: newKey(),
      },
      'admin',
    );
    ok(assigned);
    const assignment = (
      assigned.body as { active: { id: string; reviewer: { userId: string } }[] }
    ).active.find((a) => a.reviewer.userId === id)!.id;
    ok(
      await send(
        'post',
        `/api/projects/${h.projects.a}/reviewer-assignments/${assignment}/approval`,
        { idempotencyKey: newKey() },
        'pe',
      ),
    );
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

  /** Every field the final review needs (C04's list), fictional values. */
  const completeFields = () => ({
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
      { id: randomUUID(), test: 'slump', context: 'initial', value: 90 },
      { id: randomUUID(), test: 'air', context: 'initial', value: 6 },
    ],
    attachmentRefs: [{ id: randomUUID(), kind: 'ticket_photo', fileName: 'ticket-0042.jpg' }],
  });

  async function completeReport(
    as = 'tech',
    fields: Record<string, unknown> = completeFields(),
    requireComplete = true,
  ) {
    const created = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), ...fields },
      as,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const report = concreteFieldReportDetailSchema.parse(created.body);
    if (requireComplete) expect(report.completeness.missingRequired).toEqual([]);
    return report;
  }

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
      {
        idempotencyKey: key,
        version: report.version,
        // MM-V2-C28: an explicit machine-info choice (optional since C38; omitted = project setting).
        ...(action === 'issue' ? { includeMachineInfo: false } : {}),
        ...extra,
      },
      as,
    );

  /**
   * MM-V2-C28: Mark reviewed needs every exception on the version resolved or documented. These
   * C09 tests are about the lifecycle, so the setup records the notes directly (no audit event).
   */
  const documentExceptions = (reportId: string) =>
    h.db.pool.query(
      `INSERT INTO concrete_report_exception_note
         (project_id, field_report_id, version_id, code, field, note, documented_by_user_id)
       SELECT v.project_id, v.field_report_id, v.id, w->>'code', w->>'field',
              'Documented in test setup', $2
       FROM concrete_report_version v
       CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.snapshot->'warnings', '[]')) w
       WHERE v.field_report_id = $1 AND v.state = 'submitted'
       ON CONFLICT DO NOTHING`,
      [reportId, h.users.pe],
    );

  async function ok(
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
  ) {
    if (action === 'review') await documentExceptions(report.id);
    const response = await command(action, report, as, extra);
    expect(response.status, `${action}: ${JSON.stringify(response.body)}`).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  async function versions(reportId: string) {
    return concreteReportVersionListSchema.parse(
      (await get(reportPath(reportId, '/versions'), 'tech')).body,
    );
  }

  async function storedSnapshot(versionId: string) {
    const { rows } = await h.db.pool.query<{ text: string; hash: string; row: string }>(
      `SELECT snapshot::text AS text, snapshot_sha256 AS hash, row_to_json(v)::text AS row
       FROM concrete_report_version v WHERE id = $1`,
      [versionId],
    );
    return rows[0]!;
  }

  async function counts(reportId: string) {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_report_version WHERE field_report_id = $1) AS versions,
              (SELECT count(*)::int FROM concrete_report_transition WHERE field_report_id = $1) AS transitions,
              (SELECT count(*)::int FROM audit_event WHERE entity_id = $1) AS audit,
              (SELECT row_to_json(r)::text FROM concrete_field_report r WHERE id = $1) AS report`,
      [reportId],
    );
    return rows[0] as { versions: number; transitions: number; audit: number; report: string };
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'jo', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    rv = await designatedReviewer('Riley Reviewer', 'RR');
    rv2 = await designatedReviewer('Robin Second', 'RS');
    // Jordan Smith (js) holds an Authorized report issuer grant for field reports on A.
    const granted = await send(
      'post',
      `/api/projects/${h.projects.a}/report-issuers`,
      {
        issuerUserId: h.users.js,
        scopeCode: 'concrete_field',
        reason: 'Signs field reports while the lead is away',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // T2: the full path
  // ---------------------------------------------------------------------------------------------

  it('T2/AC1/AC4: submit → return → resubmit → review → issue → revise → submit → issue', async () => {
    const draft = await completeReport();
    expect(draft.lifecycle).toMatchObject({
      state: 'draft',
      latestVersion: null,
      allowedActions: ['submit'],
    });

    const submitted = await ok('submit', draft, 'tech');
    expect(submitted.workflow.state).toBe('submitted');
    expect(submitted.canEdit).toBe(false);
    expect(submitted.lifecycle.latestVersion).toMatchObject({
      versionNo: 1,
      state: 'submitted',
      route: { kind: 'designated_reviewers', routedTo: null },
      submittedStaff: { userId: h.users.tech },
    });
    expect(submitted.lifecycle.allowedActions).toEqual(['recall']);
    const v1 = submitted.lifecycle.latestVersion!;
    const v1Stored = await storedSnapshot(v1.id);

    // AC1: a submitted report can't be edited.
    const edit = await send(
      'patch',
      reportPath(draft.id),
      { idempotencyKey: newKey(), version: submitted.version, truckNumber: 'T-9' },
      'tech',
    );
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('not_a_draft');

    // A reviewer returns it with a comment; v1 stays as submitted.
    expect((await command('return', submitted, rv)).status).toBe(400);
    const returned = await ok('return', submitted, rv, { comment: 'Ticket truck number is wrong' });
    expect(returned.workflow.state).toBe('returned');
    // The reviewer can't edit it; its technician can.
    expect(returned.canEdit).toBe(false);
    expect(
      concreteFieldReportDetailSchema.parse((await get(reportPath(draft.id), 'tech')).body).canEdit,
    ).toBe(true);
    expect(returned.lifecycle.latestVersion).toMatchObject({
      state: 'returned',
      closed: { kind: 'returned', by: { userId: rv }, comment: 'Ticket truck number is wrong' },
    });
    expect((await storedSnapshot(v1.id)).text).toBe(v1Stored.text);

    // The technician corrects and resubmits explicitly: it goes back to the same reviewer.
    const corrected = concreteFieldReportDetailSchema.parse(
      (
        await send(
          'patch',
          reportPath(draft.id),
          { idempotencyKey: newKey(), version: returned.version, truckNumber: 'T-9' },
          'tech',
        )
      ).body,
    );
    expect(corrected.workflow.state).toBe('returned');
    expect(corrected.fields.truckNumber).toBe('T-9');
    expect((await command('submit', corrected, 'tech')).body.code).toBe('invalid_transition');
    const resubmitted = await ok('resubmit', corrected, 'tech');
    expect(resubmitted.lifecycle.latestVersion).toMatchObject({
      versionNo: 2,
      revisionOfVersionNo: null,
      route: { kind: 'original_reviewer', routedTo: { userId: rv }, reason: 'resubmission' },
    });

    // Routed: another designated reviewer can't take it; the original reviewer reviews.
    const other = await command('review', resubmitted, rv2);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('routed_to_another_reviewer');
    const reviewed = await ok('review', resubmitted, rv);
    expect(reviewed.lifecycle).toMatchObject({ state: 'reviewed', reviewCounted: true });
    expect(reviewed.lifecycle.latestVersion?.review).toMatchObject({
      reviewedBy: { userId: rv },
      source: 'designated_reviewer',
      counted: true,
    });

    // The lead issues v2.
    // Recall only before review.
    expect((await command('recall', reviewed, 'tech')).body.code).toBe('invalid_transition');
    const issued = await ok('issue', reviewed, 'pe');
    expect(issued.lifecycle.state).toBe('issued');
    expect(issued.issuance).toMatchObject({
      status: 'issued',
      issueCount: 1,
      lastIssuedVersion: 2,
      lastIssuedByUserId: h.users.pe,
    });
    expect(issued.lifecycle.revised).toBe(false);
    expect(issued.lifecycle.latestVersion?.issued).toMatchObject({
      source: 'lead_project_engineer',
    });
    const v2 = issued.lifecycle.latestVersion!;
    const v2Stored = await storedSnapshot(v2.id);
    expect((await command('issue', issued, 'pe')).body.code).toBe('invalid_transition');
    expect((await command('return', issued, rv, { comment: 'Late' })).body.code).toBe(
      'invalid_transition',
    );

    // A correction after issue: a linked revision; the issued original stays byte-identical.
    const revising = await ok('revise', issued, rv, { comment: 'Ambient temperature misread' });
    expect(revising.lifecycle).toMatchObject({ state: 'draft', revised: true });
    expect(revising.issuance.issueCount).toBe(1);
    const fixed = concreteFieldReportDetailSchema.parse(
      (
        await send(
          'patch',
          reportPath(draft.id),
          { idempotencyKey: newKey(), version: revising.version, ambientTempC: -6 },
          'tech',
        )
      ).body,
    );
    const v3Submitted = await ok('submit', fixed, 'tech');
    expect(v3Submitted.lifecycle.latestVersion).toMatchObject({
      versionNo: 3,
      revisionOfVersionNo: 2,
      route: { kind: 'designated_reviewers' },
    });
    const v3Reviewed = await ok('review', v3Submitted, rv2);
    const v3Issued = await ok('issue', v3Reviewed, 'js');
    expect(v3Issued.issuance).toMatchObject({ issueCount: 2, lastIssuedVersion: 3 });
    expect(v3Issued.lifecycle.latestVersion?.issued).toMatchObject({
      by: { userId: h.users.js },
      source: 'report_issuer',
    });
    expect(v3Issued.lifecycle.revised).toBe(true);

    // AC4: the original issued version, row and snapshot, are exactly as issued.
    expect(await storedSnapshot(v2.id)).toEqual(v2Stored);
    const v2Detail = concreteReportVersionDetailSchema.parse(
      (await get(reportPath(draft.id, '/versions/2'), 'lab')).body,
    );
    expect(v2Detail).toMatchObject({ state: 'issued', snapshotSha256: v2Stored.hash });
    expect((v2Detail.snapshot as { fields: { ambientTempC: number } }).fields.ambientTempC).toBe(
      -4,
    );
    expect((v2Detail.snapshot as { fields: { truckNumber: string } }).fields.truckNumber).toBe(
      'T-9',
    );

    const history = await versions(draft.id);
    expect(history.versions.map((v) => [v.versionNo, v.state])).toEqual([
      [1, 'returned'],
      [2, 'issued'],
      [3, 'issued'],
    ]);
    expect(history.transitions.map((t) => t.action)).toEqual([
      'submit',
      'return',
      'resubmit',
      'review',
      'issue',
      'revise',
      'submit',
      'review',
      'issue',
    ]);
    expect(history.transitions[1]).toMatchObject({ comment: 'Ticket truck number is wrong' });
    expect(history.transitions[2]).toMatchObject({
      routeKind: 'original_reviewer',
      routedTo: { userId: rv },
    });

    // One audit event per transition, with version and routing.
    const { rows: audit } = await h.db.pool.query<{
      action: string;
      after: Record<string, unknown>;
    }>(
      `SELECT action, after_values AS after FROM audit_event WHERE entity_id = $1 AND action NOT LIKE '%draft%'
       ORDER BY occurred_at, id`,
      [draft.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'concrete_field_report.submitted',
      'concrete_field_report.returned',
      'concrete_field_report.resubmitted',
      'concrete_field_report.reviewed',
      'concrete_field_report.issued',
      'concrete_field_report.revised',
      'concrete_field_report.submitted',
      'concrete_field_report.reviewed',
      'concrete_field_report.issued',
    ]);
    expect(audit[2]!.after).toMatchObject({
      reportVersionNo: 2,
      routeKind: 'original_reviewer',
      routedToUserId: rv,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Recall, retries, conflicts, validation
  // ---------------------------------------------------------------------------------------------

  it('AC1: the technician recalls a submitted report; the version stays as submitted', async () => {
    const draft = await completeReport();
    const submitted = await ok('submit', draft, 'tech');
    const v1 = submitted.lifecycle.latestVersion!;
    const before = await storedSnapshot(v1.id);
    for (const who of [rv, 'pe', 'lm', 'admin', 'lab']) {
      const refused = await command('recall', submitted, who);
      expect(refused.status, who).toBe(403);
    }
    const recalled = await ok('recall', submitted, 'tech');
    expect(recalled.lifecycle).toMatchObject({
      state: 'draft',
      latestVersion: { state: 'recalled' },
    });
    expect(recalled.workflow).toMatchObject({ state: 'draft', submittedAt: null });
    expect(recalled.canEdit).toBe(true);
    const after = await storedSnapshot(v1.id);
    expect(after.text).toBe(before.text);
    expect(after.hash).toBe(before.hash);
    // Submitting again makes v2, routed afresh.
    const again = await ok('submit', recalled, 'tech');
    expect(again.lifecycle.latestVersion).toMatchObject({
      versionNo: 2,
      route: { kind: 'designated_reviewers' },
    });
    // Recall is refused once reviewed.
    const reviewed = await ok('review', again, rv);
    expect((await command('recall', reviewed, 'tech')).body.code).toBe('invalid_transition');
  });

  it('T2: exact retries change nothing; key reuse, stale versions and double submission are refused', async () => {
    const draft = await completeReport();
    const key = newKey();
    const first = await command('submit', draft, 'tech', {}, key);
    expect(first.status).toBe(201);
    const snapshot = await counts(draft.id);
    const retry = await command('submit', draft, 'tech', {}, key);
    expect(retry.status).toBe(201);
    expect(concreteFieldReportDetailSchema.parse(retry.body).version).toBe(first.body.version);
    expect(await counts(draft.id)).toEqual(snapshot);

    // The same key for another request.
    const reused = await command('recall', first.body, 'tech', {}, key);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');

    // A stale version.
    const stale = await command('review', draft, rv);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(concreteFieldReportDetailSchema.parse(stale.body.current).workflow.state).toBe(
      'submitted',
    );
    expect(await counts(draft.id)).toEqual(snapshot);

    // Two submissions racing with different keys: exactly one version.
    const other = await completeReport();
    const raced = await Promise.all([
      command('submit', other, 'tech'),
      command('submit', other, 'tech'),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await counts(other.id)).versions).toBe(1);
  });

  it('an incomplete report is not submitted; no version, transition or event is written', async () => {
    const created = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), reportDate: '2026-11-08' },
      'tech',
    );
    const draft = concreteFieldReportDetailSchema.parse(created.body);
    const before = await counts(draft.id);
    const refused = await command('submit', draft, 'tech');
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('incomplete_for_review');
    expect(refused.body.errors.map((e: { field: string }) => e.field)).toContain('contractorName');
    expect(await counts(draft.id)).toEqual(before);
  });

  // ---------------------------------------------------------------------------------------------
  // AC2, AC3: routing and fresh review
  // ---------------------------------------------------------------------------------------------

  it("AC2: a Lab Manager's correction routes to the Lead Project Engineer, not to that Lab Manager or the reviewer", async () => {
    const draft = await completeReport('lm');
    const submitted = await ok('submit', draft, 'lm');
    const returned = await ok('return', submitted, rv, { comment: 'Air reading time missing' });
    expect(returned.lifecycle.labManagerCorrection).toBe(false);
    const corrected = concreteFieldReportDetailSchema.parse(
      (
        await send(
          'patch',
          reportPath(draft.id),
          { idempotencyKey: newKey(), version: returned.version, comments: 'Air re-read on site' },
          'lm',
        )
      ).body,
    );
    expect(corrected.lifecycle.labManagerCorrection).toBe(true);
    const resubmitted = await ok('resubmit', corrected, 'lm');
    expect(resubmitted.lifecycle.latestVersion?.route).toMatchObject({
      kind: 'lead_project_engineer',
      routedTo: { userId: h.users.pe },
      reason: 'lab_manager_correction',
    });
    expect(resubmitted.lifecycle.labManagerCorrection).toBe(false);
    for (const who of [rv, rv2, 'lm']) {
      expect((await command('review', resubmitted, who)).status, who).toBe(403);
    }
    const reviewed = await ok('review', resubmitted, 'pe');
    expect(reviewed.lifecycle.latestVersion?.review?.source).toBe('lead_project_engineer');
  });

  it('a resubmission whose original reviewer can no longer review goes to the lead (owner decision)', async () => {
    const leaving = await designatedReviewer('Lee Leaving', 'LL');
    const draft = await completeReport();
    const submitted = await ok('submit', draft, 'tech');
    const returned = await ok('return', submitted, leaving, { comment: 'Batch time missing' });
    await h.db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [leaving]);
    const resubmitted = await ok('resubmit', returned, 'tech');
    expect(resubmitted.lifecycle.latestVersion?.route).toMatchObject({
      kind: 'lead_project_engineer',
      reason: 'original_reviewer_unavailable',
    });
  });

  it('AC3: returning a reviewed report clears its review; it needs a fresh review', async () => {
    const draft = await completeReport();
    const reviewed = await ok('review', await ok('submit', draft, 'tech'), rv);
    expect(reviewed.lifecycle.reviewCounted).toBe(true);
    const returned = await ok('return', reviewed, rv, { comment: 'Location grid is wrong' });
    expect(returned.lifecycle.reviewCounted).toBe(false);
    expect(returned.lifecycle.latestVersion?.review).toMatchObject({
      reviewedBy: { userId: rv },
      counted: false,
    });
    expect((await command('issue', returned, 'pe')).body.code).toBe('invalid_transition');
    const resubmitted = await ok('resubmit', returned, 'tech');
    expect(resubmitted.lifecycle.reviewCounted).toBe(false);
    expect((await command('issue', resubmitted, 'pe')).body.code).toBe('invalid_transition');
    const history = await versions(draft.id);
    expect(history.versions[0]?.review?.counted).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // T3 / AC5: permissions
  // ---------------------------------------------------------------------------------------------

  it('AC5: LAB and non-reviewers get 403 for review, return, issue and revise; nothing changes', async () => {
    const draft = await completeReport();
    const submitted = await ok('submit', draft, 'tech');
    const before = await counts(draft.id);
    for (const who of ['lab', 'tech', 'js', 'jo', 'lm', 'admin']) {
      for (const action of ['review', 'return']) {
        const response = await command(action, submitted, who, { comment: 'Not mine to return' });
        expect(response.status, `${who} ${action}`).toBe(403);
      }
    }
    const reviewed = await ok('review', submitted, rv);
    const afterReview = await counts(draft.id);
    for (const who of ['lab', 'tech', rv, rv2, 'lm', 'admin', 'jo']) {
      const response = await command('issue', reviewed, who);
      expect(response.status, `${who} issue`).toBe(403);
      expect(response.body).toEqual({ code: 'forbidden' });
    }
    expect(await counts(draft.id)).toEqual(afterReview);
    expect(afterReview.transitions).toBe(before.transitions + 1);
    const issued = await ok('issue', reviewed, 'js');
    for (const who of ['lab', 'tech', 'lm', 'admin', 'jo']) {
      expect((await command('revise', issued, who, { comment: 'Change it' })).status, who).toBe(
        403,
      );
    }
  });

  it('LAB submits with the performing staff member attributed; only for that report technician', async () => {
    const draft = await completeReport('lab', {
      ...completeFields(),
      technicianUserId: h.users.tech,
    });
    const missing = await command('submit', draft, 'lab');
    expect(missing.status).toBe(400);
    const wrong = await command('submit', draft, 'lab', { technicianUserId: h.users.jo });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('not_own_report');
    const submitted = await ok('submit', draft, 'lab', { technicianUserId: h.users.tech });
    expect(submitted.lifecycle.latestVersion).toMatchObject({
      submittedBy: { userId: h.users.lab },
      submittedStaff: { userId: h.users.tech },
    });
    const { rows } = await h.db.pool.query(
      `SELECT staff_user_id, actor_user_id FROM concrete_report_transition WHERE field_report_id = $1`,
      [draft.id],
    );
    expect(rows).toEqual([{ staff_user_id: h.users.tech, actor_user_id: h.users.lab }]);
    // Someone else's report, from a personal account.
    const notMine = await command('submit', await completeReport(), 'jo');
    expect(notMine.status).toBe(403);
    expect(notMine.body.code).toBe('not_own_report');
  });

  it('unknown report: 403 without review standing anywhere, 404 for those with it', async () => {
    const ghost = { id: randomUUID(), version: 1 };
    expect((await command('review', ghost, 'jo')).body).toEqual({ code: 'forbidden' });
    expect((await command('issue', ghost, 'lab')).status).toBe(403);
    expect((await command('review', ghost, 'pe')).status).toBe(404);
    expect((await command('review', ghost, rv)).status).toBe(404);
    expect((await command('submit', ghost, 'tech')).status).toBe(404);
  });

  it('C05: sets are frozen in the snapshot; a recorded casting correction still applies after submit; returned sets edit', async () => {
    const castAt = '2026-11-08T15:40:00.000Z';
    // Specimens cast: incomplete until it has a set.
    const draft = await completeReport(
      'tech',
      { ...completeFields(), specimensCast: true, castAt },
      false,
    );
    const created = await send(
      'post',
      reportPath(draft.id, '/specimen-sets'),
      { idempotencyKey: newKey() },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const setId = (created.body as { id: string }).id;
    const ready = concreteFieldReportDetailSchema.parse(
      (await get(reportPath(draft.id), 'tech')).body,
    );
    expect(ready.completeness.missingRequired).toEqual([]);
    const submitted = await ok('submit', ready, 'tech');
    const v1 = concreteReportVersionDetailSchema.parse(
      (await get(reportPath(draft.id, '/versions/1'), 'tech')).body,
    );
    const frozenSets = v1.snapshot.specimenSets as { id: string; canEdit?: boolean }[];
    expect(frozenSets.map((set) => set.id)).toEqual([setId]);
    expect(frozenSets[0]).not.toHaveProperty('canEdit');

    // Stand-in for C18: number the set, then the lead records a casting correction (C05 AC5).
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = 901, permanent_id = '26-901',
         temporary_id = 'TMP-D09-901' WHERE id = $1`,
      [setId],
    );
    const corrected = await send(
      'post',
      reportPath(draft.id, '/casting-correction'),
      {
        idempotencyKey: newKey(),
        version: submitted.version,
        castAt: '2026-11-08T16:10:00.000Z',
        reason: 'Casting time misread from the field sheet',
        confirm: true,
      },
      'pe',
    );
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    // The submitted version keeps the casting time as submitted.
    const after = concreteReportVersionDetailSchema.parse(
      (await get(reportPath(draft.id, '/versions/1'), 'tech')).body,
    );
    expect((after.snapshot.fields as { castAt: string }).castAt).toBe(castAt);
    expect(after.snapshotSha256).toBe(v1.snapshotSha256);

    // Set edits are refused while submitted and allowed once returned for correction.
    const current = concreteFieldReportDetailSchema.parse(
      (await get(reportPath(draft.id), 'tech')).body,
    );
    const setVersion = async () =>
      ((await get(`/api/concrete/specimen-sets/${setId}`, 'tech')).body as { version: number })
        .version;
    const editSet = async () =>
      send(
        'patch',
        `/api/concrete/specimen-sets/${setId}`,
        { idempotencyKey: newKey(), version: await setVersion(), mouldSize: '100x200' },
        'tech',
      );
    expect((await editSet()).body).toMatchObject({ code: 'not_a_draft' });
    await ok('return', current, rv, { comment: 'Mould size is wrong' });
    const edited = await editSet();
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // Owner decisions 2026-11-08: self-review, revision authority, routing, returned edits
  // ---------------------------------------------------------------------------------------------

  it('self-review: the technician never reviews or issues their own report, even as reviewer or lead', async () => {
    // A designated reviewer's own report.
    const ownByReviewer = await ok('submit', await completeReport(rv), rv);
    const before = await counts(ownByReviewer.id);
    const refused = await command('review', ownByReviewer, rv);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: 'own_report' });
    expect(ownByReviewer.lifecycle.allowedActions).not.toContain('review');
    expect(await counts(ownByReviewer.id)).toEqual(before);
    await ok('review', ownByReviewer, rv2);

    // The lead's own report: neither review nor issue by the lead.
    const ownByLead = await ok('submit', await completeReport('pe'), 'pe');
    expect((await command('review', ownByLead, 'pe')).body).toEqual({ code: 'own_report' });
    const reviewed = await ok('review', ownByLead, rv);
    const beforeIssue = await counts(ownByLead.id);
    const selfIssue = await command('issue', reviewed, 'pe');
    expect(selfIssue.status).toBe(403);
    expect(selfIssue.body).toEqual({ code: 'own_report' });
    expect(await counts(ownByLead.id)).toEqual(beforeIssue);
    const issued = await ok('issue', reviewed, 'js');
    expect(issued.issuance.issueCount).toBe(1);
  });

  it('revision after issue: the lead, a designated reviewer or the issuer of record, with a reason', async () => {
    // Issued by Jordan (an issuer grant): Jordan may revise it.
    const byIssuer = await ok(
      'issue',
      await ok('review', await ok('submit', await completeReport(), 'tech'), rv),
      'js',
    );
    expect(byIssuer.lifecycle.allowedActions).toContain('revise');
    expect((await command('revise', byIssuer, 'js')).status).toBe(400);
    const revisedByIssuer = await ok('revise', byIssuer, 'js', { comment: 'Plant name corrected' });
    expect(revisedByIssuer.lifecycle.state).toBe('draft');

    // Issued by the lead: an issuer grant alone is not enough; the lead or a reviewer may.
    const byLead = await ok(
      'issue',
      await ok('review', await ok('submit', await completeReport(), 'tech'), rv),
      'pe',
    );
    const before = await counts(byLead.id);
    for (const who of ['js', 'tech', 'lm', 'admin', 'jo', 'lab']) {
      const refused = await command('revise', byLead, who, { comment: 'Not mine to revise' });
      expect(refused.status, who).toBe(403);
    }
    expect(await counts(byLead.id)).toEqual(before);
    await ok('revise', byLead, rv2, { comment: 'Location corrected' });

    const again = await ok(
      'issue',
      await ok('review', await ok('submit', await completeReport(), 'tech'), rv),
      'js',
    );
    await ok('revise', again, 'pe', { comment: 'Ambient temperature corrected' });
  });

  it('a resubmission whose original reviewer is no longer designated goes to the lead', async () => {
    const leaving = await designatedReviewer('Lou Removed', 'LR');
    const draft = await completeReport();
    const returned = await ok('return', await ok('submit', draft, 'tech'), leaving, {
      comment: 'Ticket photo unreadable',
    });
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM project_reviewer_assignment
       WHERE reviewer_user_id = $1 AND removed_at IS NULL`,
      [leaving],
    );
    const removed = await h
      .http()
      .delete(`/api/projects/${h.projects.a}/reviewer-assignments/${rows[0]!.id}`)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies.admin!)
      .send({ reason: 'Moved to another office' });
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
    const resubmitted = await ok('resubmit', returned, 'tech');
    expect(resubmitted.lifecycle.latestVersion?.route).toMatchObject({
      kind: 'lead_project_engineer',
      routedTo: { userId: h.users.pe },
      reason: 'original_reviewer_unavailable',
    });
    expect((await command('review', resubmitted, leaving)).status).toBe(403);
    await ok('review', resubmitted, 'pe');
  });

  it('only the technician edits a returned report; a Lab Manager may not edit another person report', async () => {
    const returned = await ok('return', await ok('submit', await completeReport(), 'tech'), rv, {
      comment: 'Truck number missing a digit',
    });
    const refused = await send(
      'patch',
      reportPath(returned.id),
      { idempotencyKey: newKey(), version: returned.version, truckNumber: 'T-77' },
      'lm',
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: 'not_own_draft' });
    const current = concreteFieldReportDetailSchema.parse(
      (await get(reportPath(returned.id), 'lm')).body,
    );
    expect(current.canEdit).toBe(false);
    expect(current.lifecycle.labManagerCorrection).toBe(false);
  });

  it('capabilities list field review and issue as the commands check them', async () => {
    const caps = async (as: string) =>
      Object.fromEntries(
        projectCapabilitiesSchema
          .parse((await get(`/api/projects/${h.projects.a}/capabilities`, as)).body)
          .capabilities.filter((c) => c.action === 'concrete.review' || c.action === 'report.issue')
          .map((c) => [c.action, c.allowed]),
      );
    expect(await caps(rv)).toEqual({ 'concrete.review': true, 'report.issue': false });
    expect(await caps('js')).toEqual({ 'concrete.review': false, 'report.issue': true });
    expect(await caps('pe')).toEqual({ 'concrete.review': true, 'report.issue': true });
    expect(await caps('tech')).toEqual({ 'concrete.review': false, 'report.issue': false });
  });

  it('review fix #141: an unresolved curing flag stops issue (no number, file or audit) until resolved', async () => {
    // A verified-range fixture (not a CSA/ASTM value), retired afterwards.
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO concrete_curing_standard (specification, edition, min_c, max_c, created_by_user_id)
       VALUES ('FIXTURE-SPEC', 'test fixture', 16.0, 27.0, $1) RETURNING id`,
      [h.users.lm],
    );
    try {
      const draft = await completeReport(
        'tech',
        { ...completeFields(), specimensCast: true, castAt: '2026-11-08T15:40:00.000Z' },
        false,
      );
      const made = await send(
        'post',
        reportPath(draft.id, '/specimen-sets'),
        { idempotencyKey: newKey() },
        'tech',
      );
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const set = made.body as { id: string; specimens: { id: string }[] };
      const specimen = set.specimens[0]!.id;
      const flagged = await send(
        'post',
        `/api/concrete/specimen-sets/${set.id}/pickup`,
        {
          idempotencyKey: newKey(),
          specimens: [{ id: specimen, version: null }],
          complete: true,
          collectedAt: '2026-11-09T08:00:00-06:00',
          curingMinC: '15.0',
          curingMaxC: '22.0',
        },
        'lm',
      );
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
      const ready = concreteFieldReportDetailSchema.parse(
        (await get(reportPath(draft.id), 'tech')).body,
      );
      const reviewed = await ok('review', await ok('submit', ready, 'tech'), rv);

      const before = await counts(reviewed.id);
      const refused = await command('issue', reviewed, 'pe');
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'issuance_gated',
        errors: [{ field: 'curing_out_of_range_unresolved', code: 'issuance_gated' }],
      });
      expect(await counts(reviewed.id)).toEqual(before);
      const { rows: output } = await h.db.pool.query(
        `SELECT (SELECT count(*)::int FROM concrete_report_file f
                 JOIN concrete_report_version v ON v.id = f.report_version_id
                 WHERE v.field_report_id = $1) AS files,
                (SELECT count(*)::int FROM concrete_report_number WHERE subject_id = $1) AS numbers`,
        [reviewed.id],
      );
      expect(output[0]).toEqual({ files: 0, numbers: 0 });

      // The lead resolves the flag; then the same report issues.
      const { rows: pickup } = await h.db.pool.query<{ version: number }>(
        'SELECT version FROM concrete_specimen_pickup WHERE specimen_id = $1',
        [specimen],
      );
      const resolved = await send(
        'post',
        `/api/concrete/specimens/${specimen}/curing-resolution`,
        { idempotencyKey: newKey(), version: pickup[0]!.version, note: 'Box heater checked' },
        'pe',
      );
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
      const issued = await ok('issue', reviewed, 'pe');
      expect(issued.issuance.issueCount).toBe(1);
    } finally {
      await h.db.pool.query(
        `UPDATE concrete_curing_standard SET retired_at = now(), retired_by_user_id = $2
         WHERE id = $1`,
        [rows[0]!.id, h.users.lm],
      );
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Review fix #134: a revocation that commits first wins (D09); these end grants, so they run last
  // ---------------------------------------------------------------------------------------------

  describe('a grant ending that commits before the final check wins', () => {
    const ender = () => ({ userId: h.users.pe, initials: 'PE', displayName: 'Pat Example' });

    async function activeGrant(table: string, column: string, userId: string) {
      const ended = table === 'project_report_issuer_grant' ? 'revoked_at' : 'removed_at';
      const { rows } = await h.db.pool.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE project_id = $1 AND ${column} = $2 AND ${ended} IS NULL`,
        [h.projects.a, userId],
      );
      return rows[0]!.id;
    }

    async function issueOutput(reportId: string) {
      const { rows } = await h.db.pool.query(
        `SELECT (SELECT count(*)::int FROM concrete_report_file f
                 JOIN concrete_report_version v ON v.id = f.report_version_id
                 WHERE v.field_report_id = $1) AS files,
                (SELECT count(*)::int FROM concrete_report_version
                 WHERE field_report_id = $1 AND (state = 'issued' OR report_number_id IS NOT NULL))
                  AS issued`,
        [reportId],
      );
      return rows[0];
    }

    it('issue: the issuer grant revoked meanwhile refuses it; no version, number, file or audit', async () => {
      const reviewed = await ok('review', await ok('submit', await completeReport(), 'tech'), rv);
      const before = await counts(reviewed.id);
      const response = await endGrantDuring(
        h.db.pool,
        REPORT_ISSUER_GRANT,
        await activeGrant('project_report_issuer_grant', 'issuer_user_id', h.users.js),
        ender(),
        () => command('issue', reviewed, 'js'),
        { revocation_kind: 'ordinary' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(await counts(reviewed.id)).toEqual(before);
      expect(await issueOutput(reviewed.id)).toEqual({ files: 0, issued: 0 });
    });

    it('review: the reviewer assignment removed meanwhile refuses it; nothing is written', async () => {
      const rv3 = await designatedReviewer('Casey Third', 'CT');
      const submitted = await ok('submit', await completeReport(), 'tech');
      await documentExceptions(submitted.id);
      const before = await counts(submitted.id);
      const response = await endGrantDuring(
        h.db.pool,
        REVIEWER_ASSIGNMENT,
        await activeGrant('project_reviewer_assignment', 'reviewer_user_id', rv3),
        ender(),
        () => command('review', submitted, rv3),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(await counts(submitted.id)).toEqual(before);
    });
  });
});
