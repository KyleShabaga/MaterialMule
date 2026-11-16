import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteSpecimenSetDetailSchema,
  concreteTestingTableSchema,
  concreteWorklistSchema,
  type ConcreteSpecimenSetDetail,
  type ConcreteTestingTable,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-V2-C23: the daily testing table read (today, Include overdue, numeric set order, entry
// completeness) and C22's tested condition. Real PostgreSQL. Fictional data only: DEMO-2601 led
// by Pat Example `pe`; Lee Manager `lm` (Lab Manager) enters results; Alex Tester `tech` reads.
// Sets cast Monday 2 Nov 2026: 7 d target 9 Nov (A), 28 d target 30 Nov (B, C), D is HOLD.
describe.runIf(testDatabaseUrl)('concrete testing table (MM-V2-C23)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};

  const get = (url: string, as: 'tech' | 'lm' | 'pe' | 'lab' | 'anonymous' = 'tech') => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };

  async function table(query: string): Promise<ConcreteTestingTable> {
    const response = await get(`/api/concrete/testing-table?${query}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteTestingTableSchema.parse(response.body);
  }
  const labels = (t: ConcreteTestingTable) =>
    t.groups.flatMap((g) => g.rows.map((r) => r.identity.permanentId ?? r.identity.temporaryId));

  async function castSet(): Promise<ConcreteSpecimenSetDetail> {
    const report = await h.send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      {
        idempotencyKey: newKey(),
        material: 'concrete',
        specimensCast: true,
        castAt: '2026-11-02T09:15:00-06:00',
      },
      cookies.tech!,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
    const set = await h.send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      cookies.tech!,
    );
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(set.body);
  }
  async function number(set: ConcreteSpecimenSetDetail, n: number) {
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [set.id, n, `26-${String(n).padStart(2, '0')}`],
    );
  }
  async function enter(specimenId: string, body: Record<string, unknown>) {
    const response = await h
      .http()
      .put(`/api/concrete/specimens/${specimenId}/test-results/${randomUUID()}`)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies.lm!)
      .send({ idempotencyKey: newKey(), version: 0, ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  let ten: ConcreteSpecimenSetDetail;
  let two: ConcreteSpecimenSetDetail;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'lab'] as const) cookies[key] = await h.cookie(key);
    // Created in this order so the text order of IDs (26-10 before 26-2…) would be wrong.
    ten = await castSet();
    two = await castSet();
    await number(ten, 10);
    await number(two, 2);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('T1: lists today’s breaks grouped by project, numeric set number then letter', async () => {
    const t = await table('on=2026-11-30');
    expect(t).toMatchObject({ today: '2026-11-30', includeOverdue: false, total: 4, completed: 0 });
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0]!.projectNumber).toBe('DEMO-2601');
    expect(labels(t)).toEqual(['26-02B', '26-02C', '26-10B', '26-10C']);
    const row = t.groups[0]!.rows[0]!;
    expect(row).toMatchObject({
      assignedAge: 28,
      actualAge: 28,
      targetDate: '2026-11-30',
      daysOverdue: null,
      result: null,
      complete: false,
    });
  });

  it('AC4: Include overdue adds overdue rows, flagged, with their targets unchanged', async () => {
    const before = await h.db.pool.query(
      'SELECT id, target_date::text, version FROM concrete_specimen ORDER BY id',
    );
    const t = await table('on=2026-11-30&includeOverdue=true');
    expect(labels(t)).toEqual(['26-02A', '26-02B', '26-02C', '26-10A', '26-10B', '26-10C']);
    const overdue = t.groups[0]!.rows.find((r) => r.identity.permanentId === '26-02A')!;
    expect(overdue).toMatchObject({ targetDate: '2026-11-09', daysOverdue: 21 });
    expect(overdue.flags).toContain('overdue');
    const after = await h.db.pool.query(
      'SELECT id, target_date::text, version FROM concrete_specimen ORDER BY id',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('counts a row complete only with every entry field; incomplete rows stay listed', async () => {
    const [a2, b2] = [two.specimens[0]!.id, two.specimens[1]!.id];
    await enter(b2, { maxLoad: 412.5 });
    await enter(a2, {
      testedOn: '2026-11-30',
      maxLoad: 300.1,
      heightReadings: [203.2],
      diameterReadings: [101.6, 101.8],
    });
    const t = await table('on=2026-11-30&includeOverdue=true');
    expect(t.total).toBe(6);
    expect(t.completed).toBe(1);
    const byLabel = new Map(t.groups[0]!.rows.map((r) => [r.identity.permanentId, r]));
    expect(byLabel.get('26-02B')).toMatchObject({ complete: false });
    expect(byLabel.get('26-02B')!.result).toMatchObject({ maxLoad: 412.5, version: 1 });
    expect(byLabel.get('26-02B')!.result!.tester?.initials).toBe('LM');
    const done = byLabel.get('26-02A')!;
    expect(done.complete).toBe(true);
    expect(done.actualAge).toBe(28);
    expect(done.result).toMatchObject({
      testedOn: '2026-11-30',
      diameterReadings: [101.6, 101.8],
      units: { load: 'kN', dimension: 'mm', provisional: true },
    });
    expect(Date.parse(done.result!.enteredAt)).not.toBeNaN();
  });

  it('a specimen tested before today leaves the overdue rows and C22’s Overdue view', async () => {
    const t = await table('on=2026-12-01&includeOverdue=true');
    expect(labels(t)).toEqual(['26-02B', '26-02C', '26-10A', '26-10B', '26-10C']);
    const worklist = await get('/api/concrete/lab-worklist?view=overdue&on=2026-12-01');
    expect(worklist.status).toBe(200);
    const ids = concreteWorklistSchema
      .parse(worklist.body)
      .groups.flatMap((g) => g.rows.map((r) => r.identity.permanentId));
    expect(ids).not.toContain('26-02A');
    expect(ids).toContain('26-02B');
  });

  it('refuses to reschedule a specimen with a complete test entry', async () => {
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM concrete_specimen WHERE id = $1',
      [two.specimens[0]!.id],
    );
    const response = await h.send(
      'post',
      `/api/concrete/specimens/${two.specimens[0]!.id}/reschedule`,
      { idempotencyKey: newKey(), version: rows[0]!.version, newAge: 56, reason: 'Late' },
      cookies.pe!,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe('tested_specimen');
  });

  it('reads with inventory.read (LAB included); refuses anonymous callers and bad queries', async () => {
    expect((await get('/api/concrete/testing-table?on=2026-11-30', 'lab')).status).toBe(200);
    expect((await get('/api/concrete/testing-table', 'anonymous')).status).toBe(401);
    const bad = await get('/api/concrete/testing-table?includeOverdue=maybe');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('maybe');
  });

  it('STRATA-95: specimenIds lists just that selection, whatever its target date', async () => {
    const [a10, b10, c10, d10] = ten.specimens.map((sp) => sp.id);
    // On 5 Nov nothing is due; the selection still lists its scheduled specimens (A 9 Nov,
    // B 30 Nov), never the HOLD one (D), each with its own target.
    const t = await table(`on=2026-11-05&specimenIds=${[a10, b10, d10].join(',')}`);
    expect(labels(t)).toEqual(['26-10A', '26-10B']);
    expect(t.groups[0]!.rows.map((r) => [r.targetDate, r.daysOverdue])).toEqual([
      ['2026-11-09', null],
      ['2026-11-30', null],
    ]);
    expect(t.total).toBe(2);
    // An overdue selected specimen is flagged as usual; unselected ones stay out.
    const late = await table(`on=2026-12-01&specimenIds=${c10}`);
    expect(labels(late)).toEqual(['26-10C']);
    expect(late.groups[0]!.rows[0]!.daysOverdue).toBe(1);
    // The project list is the usual one; bad selections are 400.
    expect(late.projects.map((p) => p.projectNumber)).toEqual(
      t.projects.map((p) => p.projectNumber),
    );
    expect((await get(`/api/concrete/testing-table?specimenIds=not-an-id`)).status).toBe(400);
    expect((await get(`/api/concrete/testing-table?specimenIds=,`)).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, () => randomUUID()).join(',');
    expect((await get(`/api/concrete/testing-table?specimenIds=${tooMany}`)).status).toBe(400);
  });

  it('lists every project whatever the row limit, and reads a chosen project on its own', async () => {
    // Cast Monday 7 Dec 2026: on 4 Jan 2027 (with overdue) each set lists A (7 d, overdue), B
    // and C (28 d). 168 sets in DEMO-2601 fill the 500-row limit; DEMO-2602 comes after it.
    const castOn = async (projectId: string) => {
      const report = await h.send(
        'post',
        `/api/concrete/projects/${projectId}/field-reports`,
        {
          idempotencyKey: newKey(),
          material: 'concrete',
          specimensCast: true,
          castAt: '2026-12-07T09:15:00-07:00',
        },
        cookies.tech!,
      );
      expect(report.status, JSON.stringify(report.body)).toBe(201);
      return concreteFieldReportDetailSchema.parse(report.body).id;
    };
    const addSet = async (reportId: string) => {
      const set = await h.send(
        'post',
        `/api/concrete/field-reports/${reportId}/specimen-sets`,
        { idempotencyKey: newKey() },
        cookies.tech!,
      );
      expect(set.status, JSON.stringify(set.body)).toBe(201);
      return concreteSpecimenSetDetailSchema.parse(set.body);
    };
    const bulk = await castOn(h.projects.a);
    for (let i = 0; i < 168; i += 1) await addSet(bulk);
    const other = await addSet(await castOn(h.projects.b));

    const all = await table('on=2027-01-04&includeOverdue=true');
    expect(all.truncated).toBe(true);
    expect(all.groups.map((g) => g.projectNumber)).toEqual(['DEMO-2601']);
    expect(all.projects.map((p) => p.projectNumber)).toEqual(['DEMO-2601', 'DEMO-2602']);

    const chosen = await table(`on=2027-01-04&includeOverdue=true&projectId=${h.projects.b}`);
    expect(chosen.truncated).toBe(false);
    expect(chosen.groups.map((g) => g.projectNumber)).toEqual(['DEMO-2602']);
    expect(chosen.groups[0]!.rows.map((r) => r.specimenId).sort()).toEqual(
      other.specimens
        .filter((sp) => sp.assignedAge !== 'HOLD')
        .map((sp) => sp.id)
        .sort(),
    );
    // The list of projects never narrows to the chosen one.
    expect(chosen.projects.map((p) => p.projectNumber)).toEqual(['DEMO-2601', 'DEMO-2602']);
  }, 180_000);
});
