import {
  concreteFieldReportDetailSchema,
  concreteReceivingQueueSchema,
  concreteReviewQueueSchema,
  concreteSearchSchema,
  concreteSetReceivingSchema,
  concreteSpecimenSetDetailSchema,
  concreteWorklistSchema,
  type ConcreteReceivingQueue,
  type ConcreteSearch,
  type ConcreteSpecimenSetDetail,
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

// MM-V2-C31: the Concrete Lab workspace reads — the receiving queue (Awaiting pickup / Awaiting
// receiving, My reports first), Concrete search (ranking, every project shown, aliases) and the
// worklist's HOLD-due list behind the dashboard count (card AC1–AC3, test plan T1). Real
// PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A) and DEMO-2602 (B); Alex
// Tester `tech` and Jordan Smith `js` do the field tests; Lee Manager `lm` (Lab Manager) collects
// and receives. Permanent and temporary IDs are attached with SQL, standing in for C18 / C12.
describe.runIf(testDatabaseUrl)('concrete lab workspace and search (MM-V2-C31)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab' | 'anonymous';

  const get = async (url: string, as: Caller = 'tech') => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  const post = async (url: string, body: unknown, as: Caller) =>
    h
      .http()
      .post(url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as]!)
      .send(body as object);

  async function castSet(
    projectId: string,
    castAt: string,
    as: PersonKey,
  ): Promise<ConcreteSpecimenSetDetail> {
    const report = await post(
      `/api/concrete/projects/${projectId}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', specimensCast: true, castAt },
      as,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
    const set = await post(
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      as,
    );
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(set.body);
  }

  const setIds = async (setId: string, permanent: [number, string] | null, temporary?: string) =>
    h.db.pool.query(
      `UPDATE concrete_specimen_set
       SET permanent_number = $2, permanent_id = $3, temporary_id = coalesce($4, temporary_id)
       WHERE id = $1`,
      [setId, permanent?.[0] ?? null, permanent?.[1] ?? null, temporary ?? null],
    );

  async function queue(query: string, as: Caller = 'tech'): Promise<ConcreteReceivingQueue> {
    const response = await get(`/api/concrete/receiving-queue?${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteReceivingQueueSchema.parse(response.body);
  }
  async function search(q: string, as: Caller = 'tech', extra = ''): Promise<ConcreteSearch> {
    const response = await get(`/api/concrete/search?q=${encodeURIComponent(q)}${extra}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteSearchSchema.parse(response.body);
  }

  async function pickUp(set: ConcreteSpecimenSetDetail, letters: string[]) {
    const specimens = set.specimens
      .filter((s) => letters.includes(s.letter))
      .map((s) => ({ id: s.id, version: null }));
    const response = await post(
      `/api/concrete/specimen-sets/${set.id}/pickup`,
      {
        idempotencyKey: newKey(),
        specimens,
        complete: true,
        collectedByUserId: h.users.lm,
        collectedAt: '2026-11-03T08:00:00-06:00',
        curingMinC: '18.0',
        curingMaxC: '22.0',
      },
      'lm',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return concreteSetReceivingSchema.parse(response.body);
  }
  async function receive(set: ConcreteSpecimenSetDetail, letter: string) {
    const specimen = set.specimens.find((s) => s.letter === letter)!;
    const response = await post(
      `/api/concrete/specimens/${specimen.id}/receipt`,
      { idempotencyKey: newKey(), receivedAt: '2026-11-03T10:00:00-06:00', massG: '3650.0' },
      'lm',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  // A1 (tech, project A, set 26-05 / TMP-D07-001), B1 (js, project B, also 26-05),
  // A2 (js, project A, 26-06, ticket T-77821, Field ID FR-0042, mix 35MPA-A).
  let a1: ConcreteSpecimenSetDetail;
  let b1: ConcreteSpecimenSetDetail;
  let a2: ConcreteSpecimenSetDetail;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'js', 'lm', 'lab'] as const) cookies[key] = await h.cookie(key);
    a1 = await castSet(h.projects.a, '2026-11-02T09:00:00-06:00', 'tech');
    b1 = await castSet(h.projects.b, '2026-11-02T10:00:00-06:00', 'js');
    a2 = await castSet(h.projects.a, '2026-11-01T09:00:00-06:00', 'js');
    await setIds(a1.id, [5, '26-05'], 'TMP-D07-001');
    await setIds(b1.id, [5, '26-05']);
    await setIds(a2.id, [6, '26-06']);
    await h.db.pool.query(
      `UPDATE concrete_field_report
       SET ticket_number = 'T-77821', supplier_name = 'Demo Ready Mix', paper_field_id = 'FR-0042',
           mix_number = '35MPA-A'
       WHERE id = $1`,
      [a2.fieldReportId],
    );
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---- Receiving queue -------------------------------------------------------------------------

  it('lists every set awaiting pickup, the caller’s own field tests first, with counts', async () => {
    const asTech = await queue('stage=awaiting_pickup');
    expect(asTech.counts).toEqual({ awaiting_pickup: 3, awaiting_receiving: 0 });
    expect(asTech.total).toBe(3);
    expect(asTech.mineTotal).toBe(1);
    expect(asTech.items.map((r) => [r.identity.permanentId, r.projectNumber, r.mine])).toEqual([
      ['26-05', 'DEMO-2601', true],
      // Then the rest, oldest casting first; other people's work is never hidden.
      ['26-06', 'DEMO-2601', false],
      ['26-05', 'DEMO-2602', false],
    ]);
    expect(asTech.items[0]).toMatchObject({
      letters: ['A', 'B', 'C', 'D'],
      specimenCount: 4,
      technician: { name: 'Alex Tester' },
      reportState: 'draft',
    });

    const asJs = await queue('stage=awaiting_pickup', 'js');
    expect(asJs.mineTotal).toBe(2);
    expect(asJs.items.map((r) => [r.identity.permanentId, r.mine])).toEqual([
      ['26-06', true],
      ['26-05', true],
      ['26-05', false],
    ]);
    // LAB reads the same lab-wide list; it did no field test, so nothing is "mine".
    const asLab = await queue('', 'lab');
    expect(asLab.stage).toBe('awaiting_pickup');
    expect(asLab.mineTotal).toBe(0);
    expect(asLab.total).toBe(3);
  });

  it('AC3: a partial pickup splits a set across both lists; receipt takes it off', async () => {
    await pickUp(a1, ['A', 'B']);
    const pickup = await queue('stage=awaiting_pickup');
    const receiving = await queue('stage=awaiting_receiving');
    expect(pickup.counts).toEqual({ awaiting_pickup: 3, awaiting_receiving: 1 });
    expect(pickup.items.find((r) => r.setId === a1.id)?.letters).toEqual(['C', 'D']);
    expect(receiving.items.map((r) => [r.setId, r.letters])).toEqual([[a1.id, ['A', 'B']]]);
    // Each count is its list's length.
    expect(receiving.total).toBe(receiving.items.length);
    expect(pickup.total).toBe(pickup.items.length);

    await receive(a1, 'A');
    await receive(a1, 'B');
    const after = await queue('stage=awaiting_receiving');
    expect(after.counts.awaiting_receiving).toBe(0);
    expect(after.items).toEqual([]);
  });

  it('filters by project and pages', async () => {
    const onlyB = await queue(`stage=awaiting_pickup&projectId=${h.projects.b}`);
    expect(onlyB.items.map((r) => r.setId)).toEqual([b1.id]);
    expect(onlyB.counts.awaiting_pickup).toBe(1);
    const paged = await queue('stage=awaiting_pickup&pageSize=1&page=2', 'js');
    expect(paged.items.map((r) => r.setId)).toEqual([b1.id]);
    expect(paged.total).toBe(3);
  });

  it('refuses a bad stage and an unsigned caller', async () => {
    expect((await get('/api/concrete/receiving-queue?stage=everything')).status).toBe(400);
    expect((await get('/api/concrete/receiving-queue', 'anonymous')).status).toBe(401);
    expect((await get('/api/concrete/search?q=26-05', 'anonymous')).status).toBe(401);
  });

  // ---- Search ----------------------------------------------------------------------------------

  it('AC1: a set number in two projects lists both, each with its project', async () => {
    const result = await search('26-05');
    expect(result.projectCount).toBe(2);
    expect(result.items.map((r) => [r.projectNumber, r.matches[0]])).toEqual([
      // Both exact matches rank first; the later casting first between them.
      ['DEMO-2602', 'set_id'],
      ['DEMO-2601', 'set_id'],
    ]);
    for (const item of result.items) {
      expect(item.sets.find((s) => s.matched)?.identity.permanentId).toBe('26-05');
    }
    // A specimen ID searches its set and keeps the letter; still both projects.
    const specimen = await search('26-05B');
    expect(specimen.letter).toBe('B');
    expect(specimen.items.map((r) => r.projectNumber).sort()).toEqual(['DEMO-2601', 'DEMO-2602']);
    // Typed with an en dash, it still matches.
    expect((await search('26–05')).total).toBe(2);
  });

  it('AC2: a TMP ID finds the set by its alias, with both aliases shown', async () => {
    const result = await search('tmp-d07-001');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ projectNumber: 'DEMO-2601', matches: ['set_id'] });
    expect(result.items[0]!.sets.filter((s) => s.matched).map((s) => s.identity)).toEqual([
      { temporaryId: 'TMP-D07-001', permanentId: '26-05' },
    ]);
    expect((await search('TMP-D07-001A')).letter).toBe('A');
  });

  it('T1 ranking: exact ID, then ID prefix, then the other references', async () => {
    const prefix = await search('26-0');
    expect(prefix.items.map((r) => r.matches[0])).toEqual([
      'set_id_prefix',
      'set_id_prefix',
      'set_id_prefix',
    ]);
    const ticket = await search('t-778');
    expect(ticket.items.map((r) => [r.fieldReportId, r.matches])).toEqual([
      [a2.fieldReportId, ['ticket']],
    ]);
    expect(ticket.items[0]).toMatchObject({ ticketNumber: 'T-77821', supplierName: 'Demo Ready Mix' });
    expect((await search('FR-0042')).items[0]!.matches).toEqual(['field_id']);
    expect((await search('35mpa')).items[0]!.matches).toEqual(['mix']);
    const tech = await search('jordan');
    expect(tech.items.map((r) => r.fieldReportId).sort()).toEqual(
      [a2.fieldReportId, b1.fieldReportId].sort(),
    );
    expect(tech.items.every((r) => r.matches.includes('technician'))).toBe(true);
    // A project number lists that project's reports only.
    const project = await search('DEMO-2602');
    expect(project.items.map((r) => [r.fieldReportId, r.matches[0]])).toEqual([
      [b1.fieldReportId, 'project'],
    ]);
    // Casting date (America/Edmonton day of the casting time).
    const date = await search('2026-11-01');
    expect(date.items.map((r) => [r.fieldReportId, r.castingDate])).toEqual([
      [a2.fieldReportId, '2026-11-01'],
    ]);
    // A LIKE wildcard is a plain character, not "anything".
    expect((await search('%')).total).toBe(0);
    expect((await search('zzz-nothing')).items).toEqual([]);
  });

  it('T1 access: LAB reads the same results; bad input is 400; pages are bounded', async () => {
    expect((await search('26-05', 'lab')).total).toBe(2);
    expect((await get('/api/concrete/search')).status).toBe(400);
    expect((await get(`/api/concrete/search?q=${'x'.repeat(101)}`)).status).toBe(400);
    expect((await get('/api/concrete/search?q=26&pageSize=51')).status).toBe(400);
    const first = await search('26-0', 'tech', '&pageSize=2');
    const second = await search('26-0', 'tech', '&pageSize=2&page=2');
    expect([first.items.length, second.items.length, first.total]).toEqual([2, 1, 3]);
  });

  // ---- Dashboard counts --------------------------------------------------------------------------

  it('AC3: the HOLD-due count equals the HOLD-due list, and the review counts their lists', async () => {
    // Default schedules hold their last specimen; the hold-until date is casting + the duration.
    const { rows } = await h.db.pool.query<{ hold_expires_on: string }>(
      `SELECT min(hold_expires_on)::text AS hold_expires_on FROM concrete_specimen
       WHERE assigned_age = 'HOLD'`,
    );
    const on = rows[0]!.hold_expires_on;
    const all = concreteWorklistSchema.parse(
      (await get(`/api/concrete/lab-worklist?view=hold&on=${on}`)).body,
    );
    const due = concreteWorklistSchema.parse(
      (await get(`/api/concrete/lab-worklist?view=hold&holdDue=true&on=${on}`)).body,
    );
    expect(due.holdDue).toBe(true);
    expect(all.holdDue).toBe(false);
    expect(due.total).toBe(due.holdReviewDue);
    expect(due.total).toBeGreaterThan(0);
    expect(due.total).toBeLessThan(all.total);
    for (const row of due.groups.flatMap((g) => g.rows)) {
      expect(row.flags).toContain('hold_review_due');
    }
    expect(all.holdReviewDue).toBe(due.holdReviewDue);

    const review = concreteReviewQueueSchema.parse((await get('/api/concrete/review-queue')).body);
    expect(review.total).toBe(review.counts.awaiting_review);
  });

  it('leaves a Void set out of the queue; search still finds it, marked Void', async () => {
    const c = await castSet(h.projects.b, '2026-11-03T09:00:00-06:00', 'js');
    await setIds(c.id, [7, '26-07']);
    expect((await queue('stage=awaiting_pickup')).items.map((r) => r.setId)).toContain(c.id);
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET voided_at = now(), voided_by_user_id = $2,
         void_reason = 'Fictional void for the test' WHERE id = $1`,
      [c.id, h.users.pe],
    );
    expect((await queue('stage=awaiting_pickup')).items.map((r) => r.setId)).not.toContain(c.id);
    const found = await search('26-07');
    expect(found.items[0]!.sets).toEqual([
      expect.objectContaining({ setId: c.id, voided: true, matched: true }),
    ]);
  });
});
