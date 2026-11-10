import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteReportVersionDetailSchema,
  concreteSpecimenSetDetailSchema,
  concreteStrengthReportDetailSchema,
  concreteStrengthReportSnapshotSchema,
  type ConcreteSpecimenSetDetail,
  type ConcreteStrengthReportDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { pdfText } from '../test-support/pdf-text.js';
import { ConcreteReportOutputService } from './reports/concrete-report-output.service.js';
import { allocateReportNumber } from './reports/report-numbers.js';

// Review fixes on C39 strength reports (PR #151 cards, 2026-11-09 review):
// - issued results stay locked when a later-age submission is recalled or returned;
// - disposal authorization isn't removal: only a recorded removal shows Disposed;
// - the originating field report's CF number is frozen into the snapshot and printed;
// - (PR #152) the summary report's Pending review needs a complete entry, as everywhere else.
// Real PostgreSQL, fictional data: DEMO-2601 led by Pat Example `pe`; Lee Manager `lm` enters
// results; Riley Reviewer reviews; Jordan Smith `js` issues; Taylor Bench is a Lab Technician.
// Sets cast Monday 2 Nov 2026 with the lab defaults: A 7 d (9 Nov), B and C 28 d (30 Nov), D HOLD.
describe.runIf(testDatabaseUrl)('concrete strength report review fixes', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  let rv: string;
  let lt: string;
  let fieldReportId: string;

  const send = (method: 'post' | 'patch', path: string, body: unknown, as: string) =>
    h.send(method, path, body, cookies[as] ?? as);
  const created = (r: { status: number; body: unknown }) =>
    expect(r.status, JSON.stringify(r.body)).toBe(201);

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

  /** A strength set of the field report, numbered `26-NN`, and its helpers. */
  async function strengthSet(permanentNumber: number) {
    const made = await send(
      'post',
      `/api/concrete/field-reports/${fieldReportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      'tech',
    );
    created(made);
    const set: ConcreteSpecimenSetDetail = concreteSpecimenSetDetailSchema.parse(made.body);
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [set.id, permanentNumber, `26-${permanentNumber}`],
    );
    const base = `/api/concrete/specimen-sets/${set.id}/strength-report`;
    const specimen = (letter: string) => set.specimens.find((s) => s.letter === letter)!.id;
    const resultIds = new Map<string, string>();
    const resultVersions = new Map<string, number>();

    async function detail(): Promise<ConcreteStrengthReportDetail> {
      const response = await h.get(base, cookies.lm!);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return concreteStrengthReportDetailSchema.parse(response.body);
    }
    async function enter(letter: string, body: Record<string, unknown>, reason?: string) {
      const id = resultIds.get(letter) ?? randomUUID();
      const response = await h
        .http()
        .put(`/api/concrete/specimens/${specimen(letter)}/test-results/${id}`)
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
    async function ok(action: string, as: string, extra: Record<string, unknown> = {}) {
      const version = (await detail()).version;
      const response = await send(
        'post',
        `${base}/${action}`,
        { idempotencyKey: newKey(), version, ...extra },
        as,
      );
      expect(response.status, `${action}: ${JSON.stringify(response.body)}`).toBe(201);
      return concreteStrengthReportDetailSchema.parse(response.body);
    }
    async function versionSnapshot(no: number) {
      const response = await h.get(`${base}/versions/${no}`, cookies.tech!);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return concreteStrengthReportSnapshotSchema.parse(
        concreteReportVersionDetailSchema.parse(response.body).snapshot,
      );
    }
    return { set, specimen, detail, enter, ok, versionSnapshot };
  }

  const complete = (testedOn: string, maxLoad = 410.2) => ({
    testedOn,
    maxLoad,
    heightReadings: [200.1, 200.3],
    diameterReadings: [100.2, 100.4],
    notes: 'Fictional break',
  });

  const versionOf = async (specimenId: string) =>
    (
      await h.db.pool.query<{ version: number }>(
        'SELECT version FROM concrete_specimen WHERE id = $1',
        [specimenId],
      )
    ).rows[0]!.version;

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
    created(
      await send(
        'post',
        `/api/projects/${h.projects.a}/report-issuers`,
        {
          issuerUserId: h.users.js,
          scopeCode: 'concrete_strength',
          reason: 'Signs strength reports',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
    );
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
    fieldReportId = concreteFieldReportDetailSchema.parse(report.body).id;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('the CF number: blank before the field report is issued, then frozen and printed', async () => {
    const s = await strengthSet(41);
    expect((await s.detail()).preview.set.fieldReportNumber).toBeNull();
    // The field report's issue allocates its CF number (C32's allocator, in one transaction).
    const client = await h.db.pool.connect();
    let cf: string;
    try {
      await client.query('BEGIN');
      cf = (
        await allocateReportNumber(client, {
          kind: 'field',
          projectId: h.projects.a,
          subjectId: fieldReportId,
          userId: h.users.pe,
        })
      ).reportNumber;
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(cf).toMatch(/^CF-[0-9]{4}-[0-9]{5}$/);
    expect((await s.detail()).preview.set.fieldReportNumber).toBe(cf);

    expect((await s.enter('A', complete('2026-11-09'))).status).toBe(200);
    await s.ok('submit', 'lm');
    expect((await s.versionSnapshot(1)).set.fieldReportNumber).toBe(cf);
    await s.ok('review', rv);
    const issued = await s.ok('issue', 'js');
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
    expect(await pdfText(download.body as Buffer)).toContain(cf);
  });

  it('recalling or returning a later-age submission keeps the issued results locked', async () => {
    const s = await strengthSet(42);
    expect((await s.enter('A', complete('2026-11-09'))).status).toBe(200);
    await s.ok('submit', 'lm');
    await s.ok('review', rv);
    await s.ok('issue', 'js');
    expect((await s.enter('B', complete('2026-11-30', 820.4))).status).toBe(200);
    expect((await s.enter('C', complete('2026-11-30', 815.9))).status).toBe(200);
    await s.ok('submit', 'lm');

    // A Lab Technician has no revise authority, but may recall the later submission.
    expect(
      (
        await send(
          'post',
          `/api/concrete/specimen-sets/${s.set.id}/strength-report/revise`,
          {
            idempotencyKey: newKey(),
            version: (await s.detail()).version,
            comment: 'Lab staff',
          },
          lt,
        )
      ).status,
    ).toBe(403);
    expect((await s.ok('recall', lt)).state).toBe('draft');
    const locked = await s.enter('A', { maxLoad: 999 }, 'Typo');
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('result_on_strength_report');
    expect(JSON.stringify(locked.body)).not.toContain('999');
    // The new age can be corrected.
    expect((await s.enter('B', { maxLoad: 821.4 }, 'Misread dial')).status).toBe(200);
    // C24: excluding the issued result from its strength test is refused too.
    const exclusion = await h
      .http()
      .put(`/api/concrete/specimens/${s.specimen('A')}/strength-exclusion`)
      .set('Cookie', cookies.pe!)
      .set(CSRF_HEADER, '1')
      .send({ idempotencyKey: newKey(), excluded: true, reason: 'Defective specimen' });
    expect(exclusion.status, JSON.stringify(exclusion.body)).toBe(409);

    // Returned: the same.
    await s.ok('submit', 'lm');
    expect((await s.ok('return', rv, { comment: 'Check B' })).state).toBe('returned');
    expect((await s.enter('A', { maxLoad: 999 }, 'Typo')).status).toBe(409);
    expect((await s.enter('C', { maxLoad: 816.9 }, 'Misread dial')).status).toBe(200);
    await s.ok('resubmit', 'lm');
    await s.ok('review', rv);
    await s.ok('issue', 'js');

    // An authorized revise reopens the issued results.
    expect((await s.enter('A', { maxLoad: 411.2 }, 'Misread dial')).status).toBe(409);
    await s.ok('revise', rv, { comment: 'Corrected 26-42A maximum load' });
    expect((await s.enter('A', { maxLoad: 411.2 }, 'Misread dial')).status).toBe(200);
  });

  it('disposal authorization is not removal: only a recorded removal shows Disposed', async () => {
    const s = await strengthSet(43);
    expect((await s.enter('A', complete('2026-11-09'))).status).toBe(200);
    expect((await s.enter('B', complete('2026-11-30', 820.4))).status).toBe(200);
    // C untested with a failed-specimen hold (placed as C25 does), D on ordinary HOLD.
    await h.db.pool.query(
      `INSERT INTO concrete_specimen_failure_hold
         (project_id, specimen_id, reason, placed_by_user_id, placed_by_name_snapshot)
       SELECT project_id, id, 'Fictional low result', $2, 'Pat Example'
       FROM concrete_specimen WHERE id = $1`,
      [s.specimen('C'), h.users.pe],
    );
    const authorized = await send(
      'post',
      '/api/concrete/holds/authorize-disposal',
      {
        idempotencyKey: newKey(),
        items: [
          { specimenId: s.specimen('C'), version: await versionOf(s.specimen('C')) },
          { specimenId: s.specimen('D'), version: await versionOf(s.specimen('D')) },
        ],
        reason: 'Reviewed; dispose',
      },
      'pe',
    );
    expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);

    const pending = (await s.detail()).preview;
    const status = (p: typeof pending) =>
      Object.fromEntries(p.results.map((r) => [r.letter, r.status]));
    expect(status(pending)).toMatchObject({ C: 'not_yet_tested', D: 'hold' });
    // The 28 d age isn't complete while C awaits removal.
    expect(pending.ages.find((a) => a.ageDays === 28)).toMatchObject({ complete: false });

    const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const removed = await send(
      'post',
      '/api/concrete/disposal/record',
      { idempotencyKey: newKey(), specimenIds: [s.specimen('C'), s.specimen('D')], disposedAt: at },
      'lm',
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const after = (await s.detail()).preview;
    expect(status(after)).toMatchObject({ C: 'disposed', D: 'disposed' });
    expect(after.ages.find((a) => a.ageDays === 28)).toMatchObject({ complete: true });
  });

  it('summary report: a date and load alone stay untested; a complete entry is pending review', async () => {
    const s = await strengthSet(44);
    const summaryCell = async () => {
      const summary = await h.app
        .get(ConcreteReportOutputService)
        .summarySnapshot(h.db.pool, h.projects.a, {
          from: null,
          to: null,
          element: null,
          mixId: null,
        });
      return summary.rows.find((r) => r.setId === s.set.id)!.ages['7'];
    };
    expect(await summaryCell()).toEqual({ status: 'untested' });
    // A partial entry: no height or diameter readings.
    expect((await s.enter('A', { testedOn: '2026-11-09', maxLoad: 410.2 })).status).toBe(200);
    expect((await s.detail()).preview.results.find((r) => r.letter === 'A')!.status).toBe(
      'not_yet_tested',
    );
    expect(await summaryCell()).toEqual({ status: 'untested' });
    // The readings complete it (the tester is the entering person).
    expect(
      (
        await s.enter('A', {
          heightReadings: [200.1, 200.3],
          diameterReadings: [100.2, 100.4],
        })
      ).status,
    ).toBe(200);
    expect((await s.detail()).preview.results.find((r) => r.letter === 'A')!.status).toBe('tested');
    expect(await summaryCell()).toEqual({ status: 'pending_review' });
  });
});
