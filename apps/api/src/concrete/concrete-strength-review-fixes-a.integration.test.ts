import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteSearchSchema,
  concreteSpecimenSetDetailSchema,
  concreteStrengthReportDetailSchema,
  concreteStrengthTestsSchema,
  type ConcreteSpecimenSetDetail,
  type ConcreteStrengthReportDetail,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// Review fixes A (PR #154 / #159 cards, 2026-11-10 code review) on strength tests, exclusions and
// strength reports:
// - the exclusion command rechecks the reviewer's approval under the project and account locks;
// - only a completed result is excluded, and a result save never makes the excluding reviewer the
//   result's tester or entrant;
// - a version frozen before migration 0033 (no `flags`) still issues;
// - after an issue, a later age's new results can be excluded (issued specimens stay locked);
// - the project-wide strength tests are paged, so a failure past the first 500 sets is reachable;
// - search text shaped like a year-0 date is text, never a PostgreSQL date.
// Real PostgreSQL, fictional data: DEMO-2601 led by Pat Example `pe`; Lee Manager `lm` enters
// results (and, here, is also a designated strength reviewer); Riley Reviewer and Robin Second
// review; Jordan Smith `js` issues; Taylor Bench is a Lab Technician. Sets cast Monday 2 Nov 2026
// with the lab defaults: A 7 d, B and C 28 d, D HOLD.
describe.runIf(testDatabaseUrl)('concrete strength review fixes A', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  let rv: string;
  let rv2: string;
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

  async function fieldReport(castAt: string) {
    const report = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', specimensCast: true, castAt },
      'tech',
    );
    created(report);
    return concreteFieldReportDetailSchema.parse(report.body).id;
  }

  /** A set of the field report and its helpers (results entered as anyone, by letter). */
  async function strengthSet(reportId = fieldReportId) {
    const made = await send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      'tech',
    );
    created(made);
    const set: ConcreteSpecimenSetDetail = concreteSpecimenSetDetailSchema.parse(made.body);
    const base = `/api/concrete/specimen-sets/${set.id}/strength-report`;
    const specimen = (letter: string) => set.specimens.find((s) => s.letter === letter)!.id;
    const resultIds = new Map<string, string>();
    const resultVersions = new Map<string, number>();

    async function detail(as = 'lm'): Promise<ConcreteStrengthReportDetail> {
      const response = await h.get(base, cookies[as] ?? as);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return concreteStrengthReportDetailSchema.parse(response.body);
    }
    async function enter(
      letter: string,
      body: Record<string, unknown>,
      options: { as?: string; reason?: string; newAttempt?: boolean } = {},
    ) {
      const fresh = options.newAttempt === true || !resultIds.has(letter);
      const id = fresh ? randomUUID() : resultIds.get(letter)!;
      const response = await h
        .http()
        .put(`/api/concrete/specimens/${specimen(letter)}/test-results/${id}`)
        .set('Cookie', cookies[options.as ?? 'lm'] ?? options.as!)
        .set(CSRF_HEADER, '1')
        .send({
          idempotencyKey: newKey(),
          version: fresh ? 0 : resultVersions.get(letter)!,
          ...(options.reason ? { reason: options.reason } : {}),
          ...body,
        });
      if (response.status === 200) {
        resultIds.set(letter, id);
        resultVersions.set(letter, fresh ? 1 : resultVersions.get(letter)! + 1);
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
    const exclude = (letter: string, as: string, excluded = true, reason = 'Defective cap') =>
      h
        .http()
        .put(`/api/concrete/specimens/${specimen(letter)}/strength-exclusion`)
        .set('Cookie', cookies[as] ?? as)
        .set(CSRF_HEADER, '1')
        .send({ idempotencyKey: newKey(), excluded, reason });
    return { set, specimen, detail, enter, ok, exclude };
  }

  const complete = (testedOn: string, maxLoad = 410.2) => ({
    testedOn,
    maxLoad,
    heightReadings: [200.1, 200.3],
    diameterReadings: [100.2, 100.4],
    notes: 'Fictional break',
  });

  const exclusionRows = async (specimenId: string) =>
    (
      await h.db.pool.query(
        'SELECT sequence_no, action, user_id FROM concrete_strength_exclusion WHERE specimen_id = $1',
        [specimenId],
      )
    ).rows;
  const exclusionAudit = async (specimenId: string) =>
    (
      await h.db.pool.query(
        `SELECT action FROM audit_event WHERE entity_id = $1 AND action LIKE 'concrete_strength.%'`,
        [specimenId],
      )
    ).rows;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    rv = await person('Riley Reviewer', 'RR');
    rv2 = await person('Robin Second', 'RS');
    lt = await person('Taylor Bench', 'TB');
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_technician')`,
      [lt],
    );
    await strengthReviewer(rv);
    await strengthReviewer(rv2);
    // A Lab Manager who is also a designated strength reviewer (the card's failure case).
    await strengthReviewer(h.users.lm);
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
    fieldReportId = await fieldReport('2026-11-02T09:15:00-06:00');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('an approval ended while the exclusion waits on the project lock is honoured (403, nothing written)', async () => {
    const s = await strengthSet();
    expect((await s.enter('A', complete('2026-11-09'))).status).toBe(200);
    const blocker: PoolClient = await h.db.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM project WHERE id = $1 FOR UPDATE', [h.projects.a]);
      const ended = await blocker.query(
        `UPDATE project_review_approval
         SET ended_at = now(), ended_by_user_id = $2, ended_by_name_snapshot = 'Pat Example',
             end_reason = 'Withdrawn for the test', end_kind = 'withdrawn'
         WHERE reviewer_user_id = $1 AND project_id = $3 AND ended_at IS NULL`,
        [rv2, h.users.pe, h.projects.a],
      );
      expect(ended.rowCount).toBe(1);
      // Start the request, then wait until it is blocked on the project row.
      const pending = s.exclude('A', rv2).then((r) => r);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      let blocked = false;
      for (let i = 0; i < 4000 && !blocked; i += 1) {
        const { rows } = await h.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))`,
          [pid],
        );
        blocked = rows[0]!.n >= 1;
        if (!blocked) await new Promise((resolve) => setImmediate(resolve));
      }
      expect(blocked, 'the exclusion waited on the project lock').toBe(true);
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.status, JSON.stringify(response.body)).toBe(403);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect(await exclusionRows(s.specimen('A'))).toEqual([]);
    expect(await exclusionAudit(s.specimen('A'))).toEqual([]);
  });

  it('a reviewer never excludes a specimen before its result, nor then tests or enters it', async () => {
    const s = await strengthSet();
    // Exclude before entry: refused (the reviewer could otherwise enter the result themselves).
    for (const as of ['lm', rv]) {
      const early = await s.exclude('B', as);
      expect(early.status, JSON.stringify(early.body)).toBe(409);
      expect(early.body.code).toBe('result_not_complete');
    }
    expect(await exclusionRows(s.specimen('B'))).toEqual([]);
    // A partial entry isn't a completed result either.
    expect((await s.enter('B', { maxLoad: 800 }, { as: lt })).status).toBe(200);
    expect((await s.exclude('B', 'lm')).body.code).toBe('result_not_complete');

    // Taylor completes B; Lee (a reviewer, not its tester or entrant) excludes it.
    expect(
      (await s.enter('B', { ...complete('2026-11-30', 820.4), maxLoad: 800 }, { as: lt })).status,
    ).toBe(200);
    const done = await s.exclude('B', 'lm');
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    // Lee may not then correct it, replace it with a new attempt, or be named its tester.
    const correction = await s.enter('B', { maxLoad: 801 }, { as: 'lm', reason: 'Misread dial' });
    expect(correction.status, JSON.stringify(correction.body)).toBe(409);
    expect(correction.body.code).toBe('own_exclusion');
    const attempt = await s.enter('B', complete('2026-11-30', 815), { newAttempt: true });
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(409);
    expect(attempt.body.code).toBe('own_exclusion');
    const tester = await s.enter(
      'B',
      { testerUserId: h.users.lm },
      { as: lt, reason: 'Lee tested it' },
    );
    expect(tester.status, JSON.stringify(tester.body)).toBe(409);
    expect(tester.body.code).toBe('own_exclusion');
    const { rows: attempts } = await h.db.pool.query(
      `SELECT attempt_no, tester_user_id, max_load::float8 AS load FROM concrete_test_result
       WHERE specimen_id = $1`,
      [s.specimen('B')],
    );
    expect(attempts).toEqual([{ attempt_no: 1, tester_user_id: lt, load: 800 }]);

    // Someone else may still correct it; the exclusion stays Lee's, on a result Lee doesn't own.
    expect((await s.enter('B', { maxLoad: 801 }, { as: lt, reason: 'Misread dial' })).status).toBe(
      200,
    );
    const tests = concreteStrengthTestsSchema.parse(
      (await h.get(`/api/concrete/strength-tests?setId=${s.set.id}`, cookies.lab!)).body,
    );
    const b = tests.tests.find((l) => l.ageDays === 28)!.specimens.find((x) => x.letter === 'B')!;
    expect(b.excluded).toMatchObject({ by: { userId: h.users.lm } });
  });

  it('a version frozen before 0033 (no flags) issues: the PDF is stored, the snapshot and hash kept', async () => {
    const s = await strengthSet();
    expect((await s.enter('A', complete('2026-11-09'))).status).toBe(200);
    await s.ok('submit', 'lm');
    await s.ok('review', rv);
    // The row shape a version submitted before migration 0033 has: results without `flags`.
    const client = await h.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE concrete_report_version DISABLE TRIGGER USER');
      await client.query(
        `UPDATE concrete_report_version v
         SET snapshot = jsonb_set(v.snapshot, '{results}',
               (SELECT jsonb_agg(r - 'flags') FROM jsonb_array_elements(v.snapshot->'results') r))
         FROM concrete_strength_report sr
         WHERE sr.id = v.strength_report_id AND sr.specimen_set_id = $1`,
        [s.set.id],
      );
      await client.query('ALTER TABLE concrete_report_version ENABLE TRIGGER USER');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const frozen = async () =>
      (
        await h.db.pool.query<{ snapshot: string; sha: string }>(
          `SELECT v.snapshot::text AS snapshot, v.snapshot_sha256 AS sha
           FROM concrete_report_version v JOIN concrete_strength_report sr
             ON sr.id = v.strength_report_id
           WHERE sr.specimen_set_id = $1`,
          [s.set.id],
        )
      ).rows[0]!;
    const before = await frozen();
    expect(JSON.parse(before.snapshot).results[0]).not.toHaveProperty('flags');

    const issued = await s.ok('issue', 'js');
    expect(issued.state).toBe('issued');
    expect(issued.latestVersion!.issued!.file).not.toBeNull();
    const { rows: files } = await h.db.pool.query(
      `SELECT f.id FROM concrete_report_file f JOIN concrete_report_number n
         ON n.id = f.report_number_id
       WHERE n.report_kind = 'strength'
         AND n.subject_id = (SELECT id FROM concrete_strength_report WHERE specimen_set_id = $1)`,
      [s.set.id],
    );
    expect(files).toHaveLength(1);
    expect(await frozen()).toEqual(before);
  });

  it('after the 7-day issue, a reviewer may exclude a new 28-day result (the issued one stays locked)', async () => {
    const s = await strengthSet();
    expect((await s.enter('A', complete('2026-11-09'), { as: lt })).status).toBe(200);
    await s.ok('submit', 'lm');
    await s.ok('review', rv);
    await s.ok('issue', 'js');
    expect((await s.enter('B', complete('2026-11-30', 820.4), { as: lt })).status).toBe(200);
    expect((await s.enter('C', complete('2026-11-30', 815.9), { as: lt })).status).toBe(200);

    const seen = await s.detail(rv);
    expect(seen).toMatchObject({ state: 'issued', newResults: true, canExclude: true });
    expect(seen.excludableSpecimenIds).toEqual(
      expect.arrayContaining([s.specimen('B'), s.specimen('C')]),
    );
    expect(seen.excludableSpecimenIds).not.toContain(s.specimen('A'));
    // Lab staff without review authority are offered nothing.
    expect(await s.detail('tech')).toMatchObject({ canExclude: false, excludableSpecimenIds: [] });

    const excluded = await s.exclude('B', rv);
    expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
    const locked = await s.exclude('A', rv);
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('result_on_strength_report');
    // The issued version is untouched; the next submission reports C alone at 28 days.
    const after = await s.detail(rv);
    expect(after.latestVersion!.versionNo).toBe(seen.latestVersion!.versionNo);
    const b = after.preview.results.find((r) => r.specimenId === s.specimen('B'))!;
    expect(b.excluded).toMatchObject({ by: { userId: rv } });
  });

  it('a failure past the first 500 sets is reachable by paging; search treats year 0 as text', async () => {
    // 500 older sets with no results, on a report cast on a leap day (2024-02-29).
    const filler = await fieldReport('2026-10-01T09:15:00-06:00');
    await h.db.pool.query(
      `UPDATE concrete_field_report
       SET cast_at = '2024-02-29T09:15:00-07:00', ticket_number = '0000-01-01'
       WHERE id = $1`,
      [filler],
    );
    await h.db.pool.query(
      `INSERT INTO concrete_specimen_set (project_id, field_report_id)
       SELECT $1, $2 FROM generate_series(1, 500)`,
      [h.projects.a, filler],
    );
    // A failed 28-day test cast later (f′c 150 MPa: every fictional break is below it).
    const failingReport = await fieldReport('2026-11-03T09:15:00-06:00');
    const s = await strengthSet(failingReport);
    await h.db.pool.query(
      `UPDATE concrete_field_report
       SET project_spec = '{"specifiedStrengthMpa": 150, "specifiedStrengthAgeDays": 28}'
       WHERE id = $1`,
      [failingReport],
    );
    expect((await s.enter('B', complete('2026-12-01', 820.4))).status).toBe(200);
    expect((await s.enter('C', complete('2026-12-01', 815.9))).status).toBe(200);

    const page = async (extra = '') => {
      const response = await h.get(
        `/api/concrete/strength-tests?projectId=${h.projects.a}&failed=true${extra}`,
        cookies.lab!,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return concreteStrengthTestsSchema.parse(response.body);
    };
    const first = await page();
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.tests.some((l) => l.setId === s.set.id)).toBe(false);
    const failures = [...first.tests];
    let cursor = first.nextCursor;
    for (let pages = 0; cursor !== null && pages < 10; pages += 1) {
      const next = await page(`&after=${cursor}`);
      failures.push(...next.tests);
      cursor = next.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(failures.filter((l) => l.setId === s.set.id).map((l) => l.ageDays)).toEqual([28]);
    expect(failures.find((l) => l.setId === s.set.id)).toMatchObject({
      assessment: 'below_specified_minus_3_5',
      failed: true,
    });
    // A cursor that isn't a live set of the project is refused, never silently restarted.
    const bad = await h.get(
      `/api/concrete/strength-tests?projectId=${h.projects.a}&after=${randomUUID()}`,
      cookies.lab!,
    );
    expect(bad.status).toBe(400);

    // Year 0 is no PostgreSQL date: searched as text (a ticket here), never a 500.
    const search = async (q: string) => {
      const response = await h.get(
        `/api/concrete/search?q=${encodeURIComponent(q)}`,
        cookies.tech!,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return concreteSearchSchema.parse(response.body);
    };
    const yearZero = await search('0000-01-01');
    expect(yearZero.items.find((r) => r.fieldReportId === filler)?.matches).toEqual(['ticket']);
    // An ordinary leap day still searches casting dates.
    const leap = await search('2024-02-29');
    expect(leap.items.find((r) => r.fieldReportId === filler)?.matches).toEqual(['casting_date']);
  }, 120_000);
});
