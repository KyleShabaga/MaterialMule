import { createHash, randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteReportVersionDetailSchema,
  concreteReportVersionListSchema,
  concreteReviewQueueSchema,
  concreteSpecimenSetDetailSchema,
  concreteStrengthReportDetailSchema,
  concreteStrengthReportListSchema,
  concreteStrengthReportSnapshotSchema,
  type ConcreteSpecimenSetDetail,
  type ConcreteStrengthReportDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { REPORT_ISSUER_GRANT, REVIEW_APPROVAL } from '../project-access/grant-tables.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { endGrantDuring } from '../test-support/grant-race.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-V2-C39: strength reports on the C09 lifecycle (AC1–AC3): first age submitted, reviewed and
// issued; the next age a revision of the same report; issued versions and reported results
// frozen; nobody reviews or issues results they alone entered. Real PostgreSQL, fictional data:
// DEMO-2601 led by Pat Example `pe`; Lee Manager `lm` (Lab Manager) enters the results and is
// also a designated strength reviewer and issuer (so the own-results rule is what stops them);
// Riley Reviewer reviews; Jordan Smith `js` holds a strength issuer grant. The set is cast Monday
// 2 Nov 2026 with the lab defaults: A 7 d (target 9 Nov), B and C 28 d (30 Nov), D HOLD.
describe.runIf(testDatabaseUrl)('concrete strength reports (MM-V2-C39)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  let rv: string;
  let lt: string;
  let set: ConcreteSpecimenSetDetail;
  let reportNumber = '';
  const resultIds = new Map<string, string>();
  const resultVersions = new Map<string, number>();

  const send = (method: 'post' | 'patch', path: string, body: unknown, as: string) =>
    h.send(method, path, body, cookies[as] ?? as);
  const base = () => `/api/concrete/specimen-sets/${set.id}/strength-report`;

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

  /** A designated concrete_strength reviewer on A (eligible, member, assigned, lead-approved). */
  async function strengthReviewer(id: string) {
    created(
      await send(
        'post',
        `/api/staff/${id}/reviewer-eligibility`,
        { scopeCode: 'concrete_strength', reason: 'Certified', idempotencyKey: newKey() },
        'admin',
      ),
    );
    created(
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
        scopeCode: 'concrete_strength',
        reason: 'Reviews strength reports',
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
        `/api/projects/${h.projects.a}/reviewer-assignments/${assignment}/approval`,
        { idempotencyKey: newKey() },
        'pe',
      ),
    );
  }

  async function issuerGrant(id: string) {
    created(
      await send(
        'post',
        `/api/projects/${h.projects.a}/report-issuers`,
        {
          issuerUserId: id,
          scopeCode: 'concrete_strength',
          reason: 'Signs strength reports',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
    );
  }

  async function detail(as = 'lm'): Promise<ConcreteStrengthReportDetail> {
    const response = await h.get(base(), cookies[as]!);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteStrengthReportDetailSchema.parse(response.body);
  }

  async function enter(letter: string, body: Record<string, unknown>, reason?: string) {
    const specimen = set.specimens.find((s) => s.letter === letter)!;
    const id = resultIds.get(letter) ?? randomUUID();
    const response = await h
      .http()
      .put(`/api/concrete/specimens/${specimen.id}/test-results/${id}`)
      .set('Cookie', cookies.lm!)
      .set(CSRF_HEADER, '1')
      .send({
        idempotencyKey: newKey(),
        version: resultVersions.get(letter) ?? 0,
        ...(reason ? { reason } : {}),
        ...body,
      });
    if (response.status === 200) {
      resultIds.set(letter, id);
      resultVersions.set(letter, (resultVersions.get(letter) ?? 0) + 1);
    }
    return response;
  }

  const complete = (testedOn: string, maxLoad = 410.2) => ({
    testedOn,
    maxLoad,
    heightReadings: [200.1, 200.3],
    diameterReadings: [100.2, 100.4],
    notes: 'Fictional break',
  });

  async function command(
    action: string,
    as: string,
    extra: Record<string, unknown> = {},
    key = newKey(),
  ) {
    const version = (await detail('lm')).version;
    return send('post', `${base()}/${action}`, { idempotencyKey: key, version, ...extra }, as);
  }
  async function ok(action: string, as: string, extra: Record<string, unknown> = {}) {
    const response = await command(action, as, extra);
    expect(response.status, `${action}: ${JSON.stringify(response.body)}`).toBe(201);
    return concreteStrengthReportDetailSchema.parse(response.body);
  }

  async function versionDetail(no: number) {
    const response = await h.get(`${base()}/versions/${no}`, cookies.tech!);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const parsed = concreteReportVersionDetailSchema.parse(response.body);
    return { ...parsed, snapshot: concreteStrengthReportSnapshotSchema.parse(parsed.snapshot) };
  }

  /** The reviewer documents A's off-target test on a version (notes never carry forward). */
  async function documentA(versionNo: number) {
    created(
      await send(
        'post',
        `${base()}/versions/${versionNo}/exception-notes`,
        { code: 'strength_tested_off_target', field: 'results.A', note: 'Tested the next morning' },
        rv,
      ),
    );
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    rv = await person('Riley Reviewer', 'RR');
    lt = await person('Taylor Bench', 'TB');
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_technician')`,
      [lt],
    );
    await strengthReviewer(rv);
    await strengthReviewer(h.users.lm);
    await issuerGrant(h.users.js);
    await issuerGrant(h.users.lm);
    const report = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      {
        idempotencyKey: newKey(),
        material: 'concrete',
        specimensCast: true,
        castAt: '2026-11-02T09:15:00-06:00',
      },
      'tech',
    );
    created(report);
    const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
    const made = await send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      'tech',
    );
    created(made);
    set = concreteSpecimenSetDetailSchema.parse(made.body);
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = 7, permanent_id = '26-07' WHERE id = $1`,
      [set.id],
    );
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('before the first age is complete: not started, not submittable', async () => {
    const d = await detail();
    expect(d).toMatchObject({
      reportId: null,
      state: 'not_started',
      version: 0,
      submitBlocker: 'first_age_incomplete',
    });
    expect(d.allowedActions).toEqual([]);
    expect(d.preview.results.map((r) => [r.specimenLabel, r.assignedAge, r.status])).toEqual([
      ['26-07A', 7, 'not_yet_tested'],
      ['26-07B', 28, 'not_yet_tested'],
      ['26-07C', 28, 'not_yet_tested'],
      ['26-07D', 'HOLD', 'hold'],
    ]);
    const refused = await command('submit', 'lm');
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('first_age_incomplete');
    // Only lab staff submit (the guard: concrete_test.enter).
    expect((await command('submit', 'tech')).status).toBe(403);
  });

  it('AC1: the first complete age is submitted with a frozen snapshot', async () => {
    // Tested a day late (10 Nov, target 9 Nov): an exception the reviewer must clear.
    expect((await enter('A', complete('2026-11-10'))).status).toBe(200);
    const ready = await detail();
    expect(ready.submitBlocker).toBeNull();
    expect(ready.allowedActions).toContain('submit');
    // LAB names the performing person.
    const lab = await send(
      'post',
      `${base()}/submit`,
      { idempotencyKey: newKey(), version: 0 },
      'lab',
    );
    expect(lab.status).toBe(400);

    const submitted = await ok('submit', 'lm');
    expect(submitted).toMatchObject({ state: 'submitted', version: 1, reportNumber: null });
    expect(submitted.latestVersion).toMatchObject({
      versionNo: 1,
      state: 'submitted',
      revisionOfVersionNo: null,
      route: { kind: 'designated_reviewers' },
    });
    expect(submitted.selfReviewUserIds).toEqual([h.users.lm]);

    const v1 = await versionDetail(1);
    const { rows } = await h.db.pool.query<{ text: string; sha: string }>(
      `SELECT snapshot::text AS text, snapshot_sha256 AS sha FROM concrete_report_version
       WHERE strength_report_id = $1 AND version_no = 1`,
      [submitted.reportId],
    );
    expect(rows[0]!.sha).toBe(createHash('sha256').update(rows[0]!.text, 'utf8').digest('hex'));
    expect(v1.snapshotSha256).toBe(rows[0]!.sha);
    const s = v1.snapshot;
    expect(s).toMatchObject({ kind: 'strength', versionNo: 1, revNo: 0, revision: null });
    expect(s.set).toMatchObject({ identity: { permanentId: '26-07' }, castingDate: '2026-11-02' });
    expect(s.agesReported).toEqual([7]);
    expect(s.ages).toEqual([
      expect.objectContaining({
        ageDays: 7,
        testedCount: 1,
        complete: true,
        // MM-V2-C24 (P1): one specimen, 51.9 MPa (see A below). This report's specification
        // names no reference age, so nothing is assessed.
        averageStrength: 51.9,
        single: true,
        assessment: null,
      }),
      expect.objectContaining({ ageDays: 28, testedCount: 0, complete: false, assessment: null }),
    ]);
    const a = s.results.find((r) => r.letter === 'A')!;
    expect(a).toMatchObject({
      status: 'tested',
      reported: true,
      testedOn: '2026-11-10',
      actualAgeDays: 8,
      maxLoad: 410.2,
      heightReadings: [200.1, 200.3],
      // MM-V2-C24 (P1): d̄ = 100.3 mm, A = π × 100.3² / 4 = 7 901.18 mm² → 7 901 mm²,
      // L/D = 200.2 / 100.3 = 2.00 (no correction), f = 410.2 kN / 7 901.18 mm² = 51.92 → 51.9 MPa.
      strength: 51.9,
      area: 7901,
      calculationMethodVersion: 'P1',
      correctionFactor: 1,
      excluded: null,
      fractureType: null,
      remarks: 'Fictional break',
      testedBy: { userId: h.users.lm, initials: 'LM' },
    });
    expect(s.results.find((r) => r.letter === 'B')).toMatchObject({
      status: 'not_yet_tested',
      reported: false,
      targetDate: '2026-11-30',
      testedOn: null,
    });
    expect(s.results.find((r) => r.letter === 'D')).toMatchObject({ status: 'hold' });
    expect(s.warnings).toEqual([
      expect.objectContaining({ code: 'strength_tested_off_target', field: 'results.A' }),
    ]);
    expect(a.averageDiameter).toBeCloseTo(100.3, 10);
    expect(s.calculation.method).toMatchObject({
      version: 'P1',
      provisional: true,
      line: 'Calculation method P1 (provisional)',
    });
  });

  it('AC2: a reported result is locked while submitted; later ages stay open', async () => {
    const locked = await enter('A', { maxLoad: 999 }, 'Typo');
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('result_on_strength_report');
    expect(JSON.stringify(locked.body)).not.toContain('999');
    // MM-V2-C24: so is excluding it from its strength test (the lead reviews strength here).
    const specimenA = set.specimens.find((sp) => sp.letter === 'A')!;
    const exclusion = await h
      .http()
      .put(`/api/concrete/specimens/${specimenA.id}/strength-exclusion`)
      .set('Cookie', cookies.pe!)
      .set(CSRF_HEADER, '1')
      .send({ idempotencyKey: newKey(), excluded: true, reason: 'Defective specimen' });
    expect(exclusion.status, JSON.stringify(exclusion.body)).toBe(409);
    expect(exclusion.body.code).toBe('result_on_strength_report');
  });

  it('AC3: the sole tester / entrant never reviews or issues; queue and notes work', async () => {
    expect((await detail('lm')).allowedActions).not.toContain('review');
    const own = await command('review', 'lm');
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('own_report');
    // Documenting an exception is review work too.
    const ownNote = await send(
      'post',
      `${base()}/versions/1/exception-notes`,
      { code: 'strength_tested_off_target', field: 'results.A', note: 'Weekend' },
      'lm',
    );
    expect(ownNote.status).toBe(403);
    // A plain user holds no review authority.
    expect((await command('review', 'tech')).status).toBe(403);

    const queue = async (as: string) => {
      const response = await h.get(
        '/api/concrete/review-queue?status=awaiting_review&reportType=strength',
        cookies[as]!,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return concreteReviewQueueSchema.parse(response.body);
    };
    const row = (await queue(rv)).items.find((r) => r.setId === set.id)!;
    expect(row).toMatchObject({
      reportType: 'strength',
      setLabel: '26-07',
      versionNo: 1,
      canAct: true,
      exceptions: [{ code: 'strength_tested_off_target', count: 1 }],
      documentedCount: 0,
    });
    expect((await queue('lm')).items.find((r) => r.setId === set.id)!.canAct).toBe(false);

    const blocked = await command('review', rv);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('exceptions_unresolved');
    const note = await send(
      'post',
      `${base()}/versions/1/exception-notes`,
      { code: 'strength_tested_off_target', field: 'results.A', note: 'Tested the next morning' },
      rv,
    );
    created(note);
    const reviewed = await ok('review', rv);
    expect(reviewed.state).toBe('reviewed');

    expect((await command('issue', 'lm')).body.code).toBe('own_report');
    const issued = await ok('issue', 'js');
    expect(issued).toMatchObject({ state: 'issued', issueCount: 1, latestIssuedVersionNo: 1 });
    // MM-V2-C32: the CS number at first issue, and the PDF rendered and stored (Rev 0).
    expect(issued.reportNumber).toMatch(/^CS-[0-9]{4}-[0-9]{5}$/);
    expect(issued.latestVersion!.issued).toMatchObject({
      reportNumber: issued.reportNumber,
      file: { kind: 'strength', revisionNo: 0, supersedesFileId: null },
    });
    reportNumber = issued.reportNumber!;
    const file = issued.latestVersion!.issued!.file!;
    const download = await h
      .http()
      .get(`/api/concrete/report-files/${file.id}`)
      .set('Cookie', cookies.tech!)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(
      createHash('sha256')
        .update(download.body as Buffer)
        .digest('hex'),
    ).toBe(file.sha256);
  });

  it('AC1: a later age is Rev 1 of the same report; earlier versions never change', async () => {
    const v1Before = await versionDetail(1);
    expect((await command('submit', 'lm')).body.code).toBe('no_new_age');
    expect((await enter('B', complete('2026-11-30', 820.4))).status).toBe(200);
    // B alone doesn't complete 28 d.
    expect((await command('submit', 'lm')).body.code).toBe('no_new_age');
    expect((await enter('C', complete('2026-11-30', 815.9))).status).toBe(200);
    const ready = await detail();
    expect(ready).toMatchObject({ state: 'issued', newResults: true, submitBlocker: null });

    const submitted = await ok('submit', 'lm');
    expect(submitted.reportId).toBe(v1Before.reportId);
    expect(submitted.latestVersion).toMatchObject({ versionNo: 2, revisionOfVersionNo: 1 });
    const v2 = (await versionDetail(2)).snapshot;
    expect(v2.revNo).toBe(1);
    expect(v2.agesReported).toEqual([7, 28]);
    expect(v2.revision).toMatchObject({ supersedesVersionNo: 1, supersedesRevNo: 0 });
    expect(v2.revision!.reason).toContain('Added 28 d results');
    expect(v2.results.filter((r) => r.reported).map((r) => r.letter)).toEqual(['A', 'B', 'C']);

    await documentA(2);
    expect((await ok('review', rv)).state).toBe('reviewed');
    const issued = await ok('issue', 'js');
    expect(issued).toMatchObject({ issueCount: 2, latestIssuedVersionNo: 2, revised: true });
    // Rev 1 keeps the number and stores a new file that supersedes Rev 0's.
    expect(issued.reportNumber).toBe(reportNumber);
    expect(issued.latestVersion!.issued!.file).toMatchObject({ revisionNo: 1 });
    expect(issued.latestVersion!.issued!.file!.supersedesFileId).not.toBeNull();
    expect(await versionDetail(1)).toMatchObject({
      state: 'issued',
      snapshotSha256: v1Before.snapshotSha256,
    });

    // An issued version never changes in the database either.
    await expect(
      h.db.pool.query(
        `UPDATE concrete_report_version SET snapshot = '{}'::jsonb
         WHERE strength_report_id = $1 AND version_no = 2`,
        [issued.reportId],
      ),
    ).rejects.toMatchObject({ constraint: 'concrete_report_version_issued_frozen' });
  });

  it('AC2: correcting an issued result needs a revision; it shows as Rev 2', async () => {
    expect((await enter('B', { maxLoad: 821.4 }, 'Misread dial')).status).toBe(409);
    // Revise is review authority (or the version's issuer); lab staff can't.
    expect((await command('revise', lt, { comment: 'Lab staff' })).status).toBe(403);
    const revised = await ok('revise', rv, { comment: 'Corrected 26-07B maximum load' });
    expect(revised.state).toBe('draft');
    expect((await enter('B', { maxLoad: 821.4 }, 'Misread dial')).status).toBe(200);

    // Recall before review returns it to draft; the recalled version stays in the history.
    await ok('submit', 'lm');
    expect((await ok('recall', 'lm')).state).toBe('draft');
    const resubmitted = await ok('submit', 'lm');
    expect(resubmitted.latestVersion).toMatchObject({ versionNo: 4, revisionOfVersionNo: 2 });
    const v4 = (await versionDetail(4)).snapshot;
    expect(v4.revNo).toBe(2);
    expect(v4.revision!.reason).toBe('Corrected 26-07B maximum load');
    expect(v4.results.find((r) => r.letter === 'B')!.maxLoad).toBe(821.4);
    expect((await versionDetail(2)).snapshot.results.find((r) => r.letter === 'B')!.maxLoad).toBe(
      820.4,
    );

    // Return and resubmit: it goes back to the reviewer who returned it.
    expect((await ok('return', rv, { comment: 'Check the remarks' })).state).toBe('returned');
    const again = await ok('resubmit', 'lm');
    expect(again.latestVersion).toMatchObject({
      versionNo: 5,
      route: { kind: 'original_reviewer', routedTo: { userId: rv }, reason: 'resubmission' },
    });

    const history = await h.get(`${base()}/versions`, cookies.tech!);
    const list = concreteReportVersionListSchema.parse(history.body);
    expect(list.versions.map((v) => [v.versionNo, v.state])).toEqual([
      [1, 'issued'],
      [2, 'issued'],
      [3, 'recalled'],
      [4, 'returned'],
      [5, 'submitted'],
    ]);
    expect(list.transitions.map((t) => t.action)).toEqual([
      'submit',
      'review',
      'issue',
      'submit',
      'review',
      'issue',
      'revise',
      'submit',
      'recall',
      'submit',
      'return',
      'resubmit',
    ]);
    const { rows } = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE entity_type = 'concrete_strength_report'
       AND entity_id = $1 ORDER BY occurred_at, id`,
      [again.reportId],
    );
    expect(rows.map((r) => r.action)).toContain('concrete_strength_report.issued');
    expect(rows.map((r) => r.action)).toContain('concrete_strength_report.exception_documented');
  });

  it('commands are exactly-once and version-checked', async () => {
    await documentA(5);
    const key = newKey();
    const d = await detail();
    const first = await send(
      'post',
      `${base()}/review`,
      { idempotencyKey: key, version: d.version },
      rv,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const retry = await send(
      'post',
      `${base()}/review`,
      { idempotencyKey: key, version: d.version },
      rv,
    );
    expect(retry.status).toBe(201);
    expect(concreteStrengthReportDetailSchema.parse(retry.body).state).toBe('reviewed');
    const reused = await send(
      'post',
      `${base()}/issue`,
      { idempotencyKey: key, version: d.version + 1 },
      'js',
    );
    expect(reused.status).toBe(409);
    const stale = await send(
      'post',
      `${base()}/issue`,
      { idempotencyKey: newKey(), version: d.version },
      'js',
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('lists strength reports for the project and the lab workspace', async () => {
    const response = await h.get(
      `/api/concrete/strength-reports?projectId=${h.projects.a}`,
      cookies.lab!,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const list = concreteStrengthReportListSchema.parse(response.body);
    expect(list.items.find((i) => i.setId === set.id)).toMatchObject({
      state: 'reviewed',
      latestVersionNo: 5,
      issuedRevNo: 1,
      agesReported: [7, 28],
      identity: { permanentId: '26-07' },
    });
    const lab = concreteStrengthReportListSchema.parse(
      (await h.get('/api/concrete/strength-reports?needsLab=true', cookies.lm!)).body,
    );
    expect(lab.items.some((i) => i.setId === set.id)).toBe(false);
    const bad = await h.get('/api/concrete/strength-reports?state=nonsense', cookies.lm!);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('nonsense');
    expect((await h.http().get(base())).status).toBe(401);
  });

  // Review fix #134: a grant ending that commits before the final check wins (D09). These end
  // grants, so they run last.
  describe('a grant ending that commits before the final check wins', () => {
    const ender = { userId: '', initials: 'PE', displayName: 'Pat Example' };
    async function writes() {
      const { rows } = await h.db.pool.query(
        `SELECT (SELECT count(*)::int FROM concrete_report_exception_note n
                 JOIN concrete_strength_report r ON r.id = n.strength_report_id
                 WHERE r.specimen_set_id = $1) AS notes,
                (SELECT count(*)::int FROM concrete_report_transition t
                 JOIN concrete_strength_report r ON r.id = t.strength_report_id
                 WHERE r.specimen_set_id = $1) AS transitions,
                (SELECT count(*)::int FROM concrete_report_file f
                 JOIN concrete_report_version v ON v.id = f.report_version_id
                 JOIN concrete_strength_report r ON r.id = v.strength_report_id
                 WHERE r.specimen_set_id = $1) AS files,
                (SELECT row_to_json(r)::text FROM concrete_strength_report r WHERE r.specimen_set_id = $1)
                  AS report`,
        [set.id],
      );
      return rows[0];
    }

    it('exception note: the reviewer approval ended meanwhile refuses it; nothing is written', async () => {
      expect((await ok('return', rv, { comment: 'Recheck A' })).state).toBe('returned');
      // The resubmission is routed back to Riley, who returned it; Riley's approval ends.
      const again = await ok('resubmit', 'lm');
      const { rows } = await h.db.pool.query<{ id: string }>(
        `SELECT id FROM project_review_approval
         WHERE project_id = $1 AND reviewer_user_id = $2 AND scope_code = 'concrete_strength'
           AND ended_at IS NULL`,
        [h.projects.a, rv],
      );
      const before = await writes();
      const response = await endGrantDuring(
        h.db.pool,
        REVIEW_APPROVAL,
        rows[0]!.id,
        { ...ender, userId: h.users.pe },
        () =>
          send(
            'post',
            `${base()}/versions/${again.latestVersion!.versionNo}/exception-notes`,
            { code: 'strength_tested_off_target', field: 'results.A', note: 'Tested late' },
            rv,
          ),
        { end_kind: 'eligibility_lost' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body).toEqual({ code: 'forbidden' });
      expect(await writes()).toEqual(before);
    });

    it('issue: the issuer grant revoked meanwhile refuses it; no transition, file or audit', async () => {
      // Riley no longer reviews here: the lead documents and reviews instead.
      created(
        await send(
          'post',
          `${base()}/versions/${(await detail()).latestVersion!.versionNo}/exception-notes`,
          { code: 'strength_tested_off_target', field: 'results.A', note: 'Tested late' },
          'pe',
        ),
      );
      await ok('review', 'pe');
      const { rows } = await h.db.pool.query<{ id: string }>(
        `SELECT id FROM project_report_issuer_grant
         WHERE project_id = $1 AND issuer_user_id = $2 AND report_scope_code = 'concrete_strength'
           AND revoked_at IS NULL`,
        [h.projects.a, h.users.js],
      );
      const version = (await detail()).version;
      const before = await writes();
      const response = await endGrantDuring(
        h.db.pool,
        REPORT_ISSUER_GRANT,
        rows[0]!.id,
        { ...ender, userId: h.users.pe },
        () => send('post', `${base()}/issue`, { idempotencyKey: newKey(), version }, 'js'),
        { revocation_kind: 'ordinary' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body).toEqual({ code: 'forbidden' });
      expect(await writes()).toEqual(before);
      expect((await detail()).state).toBe('reviewed');
    });
  });
});
