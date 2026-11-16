import {
  concreteFieldReportDetailSchema,
  concreteReceivingQueueSchema,
  concreteSetReceivingSchema,
  concreteSpecimenSetDetailSchema,
  concreteWorklistSchema,
  type ConcreteReceivingQueue,
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

// STRATA-120 (Kyle, 2026-11-12): sets with no casting time appear in Concrete › Receiving and can
// be received; their test dates stay unscheduled until the casting time is recorded, then derive
// once from it (America/Edmonton). Real PostgreSQL, direct API calls. Fictional data only:
// DEMO-2601 (A) and DEMO-2602 (B), both led by Pat Example `pe`; Alex Tester `tech` and Jordan
// Smith `js` do the field tests; Lee Manager `lm` (Lab Manager) collects and receives; LAB names
// the person receiving. Permanent numbers are attached with SQL, standing in for C18.
describe.runIf(testDatabaseUrl)('concrete receiving without a casting time (STRATA-120)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab';

  const get = (url: string, as: Caller = 'tech') => h.http().get(url).set('Cookie', cookies[as]!);
  const send = (method: 'post' | 'patch', url: string, body: unknown, as: Caller) =>
    h
      .http()
      [method](url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as]!)
      .send(body as object);

  async function castSet(
    projectId: string,
    castAt: string | null,
    as: PersonKey,
  ): Promise<ConcreteSpecimenSetDetail> {
    const report = await send(
      'post',
      `/api/concrete/projects/${projectId}/field-reports`,
      {
        idempotencyKey: newKey(),
        material: 'concrete',
        specimensCast: true,
        ...(castAt === null ? {} : { castAt }),
      },
      as,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
    const set = await send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      { idempotencyKey: newKey() },
      as,
    );
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(set.body);
  }

  async function queue(query: string, as: Caller = 'tech'): Promise<ConcreteReceivingQueue> {
    const response = await get(`/api/concrete/receiving-queue?${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteReceivingQueueSchema.parse(response.body);
  }

  const dates = async (setId: string) =>
    (
      await h.db.pool.query<{
        letter: string;
        age: string;
        target: string | null;
        hold: string | null;
      }>(
        `SELECT letter, assigned_age AS age, target_date::text AS target,
                hold_expires_on::text AS hold
         FROM concrete_specimen WHERE set_id = $1 ORDER BY letter`,
        [setId],
      )
    ).rows;

  async function tallies() {
    const { rows } = await h.db.pool.query<{ receipts: number; audit: number }>(
      `SELECT (SELECT count(*)::int FROM concrete_specimen_receipt) AS receipts,
              (SELECT count(*)::int FROM audit_event
               WHERE action = 'concrete_specimen.received') AS audit`,
    );
    return rows[0]!;
  }

  const receipt = (specimenId: string, body: Record<string, unknown>, as: Caller) =>
    send(
      'post',
      `/api/concrete/specimens/${specimenId}/receipt`,
      { receivedAt: '2026-11-08T10:00:00-06:00', massG: '3650.0', ...body },
      as,
    );

  // C1 (tech, A, cast 2 Nov), U1 (tech, A, no casting time), C2 (js, B, cast 3 Nov),
  // U2 (js, B, no casting time).
  let c1: ConcreteSpecimenSetDetail;
  let u1: ConcreteSpecimenSetDetail;
  let c2: ConcreteSpecimenSetDetail;
  let u2: ConcreteSpecimenSetDetail;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'js', 'lm', 'pe', 'lab'] as const)
      cookies[key] = await h.cookie(key);
    u1 = await castSet(h.projects.a, null, 'tech');
    c1 = await castSet(h.projects.a, '2026-11-02T09:00:00-06:00', 'tech');
    u2 = await castSet(h.projects.b, null, 'js');
    c2 = await castSet(h.projects.b, '2026-11-03T09:00:00-06:00', 'js');
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('lists sets without a casting time in the queue and its totals, after the cast ones', async () => {
    const asTech = await queue('stage=awaiting_pickup');
    expect(asTech.counts).toEqual({ awaiting_pickup: 4, awaiting_receiving: 0 });
    expect(asTech.total).toBe(4);
    expect(asTech.mineTotal).toBe(2);
    // My reports first, each section oldest casting first and no casting time last.
    expect(asTech.items.map((r) => [r.setId, r.mine])).toEqual([
      [c1.id, true],
      [u1.id, true],
      [c2.id, false],
      [u2.id, false],
    ]);
    const uncast = asTech.items.find((r) => r.setId === u1.id)!;
    expect(uncast).toMatchObject({ castAt: null, letters: ['A', 'B', 'C', 'D'], specimenCount: 4 });
    expect(asTech.items.find((r) => r.setId === c1.id)!.castAt).toBe('2026-11-02T15:00:00.000Z');

    // js's own reports come first for js; LAB did no field test.
    const asJs = await queue('stage=awaiting_pickup', 'js');
    expect(asJs.items.map((r) => r.setId)).toEqual([c2.id, u2.id, c1.id, u1.id]);
    const asLab = await queue('stage=awaiting_pickup', 'lab');
    expect([asLab.total, asLab.mineTotal]).toEqual([4, 0]);
    // A project filter counts its uncast set too.
    const onlyB = await queue(`stage=awaiting_pickup&projectId=${h.projects.b}`);
    expect([onlyB.counts.awaiting_pickup, onlyB.items.map((r) => r.setId)]).toEqual([
      2,
      [c2.id, u2.id],
    ]);
    // No test dates exist for the uncast sets.
    expect(await dates(u1.id)).toEqual([
      { letter: 'A', age: '7', target: null, hold: null },
      { letter: 'B', age: '28', target: null, hold: null },
      { letter: 'C', age: '28', target: null, hold: null },
      { letter: 'D', age: 'HOLD', target: null, hold: null },
    ]);
  });

  it('pages in a stable order across the null casting times: every set once', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const one = await queue(`stage=awaiting_pickup&pageSize=1&page=${page}`);
      expect(one.total).toBe(4);
      seen.push(...one.items.map((r) => r.setId));
    }
    expect(seen).toEqual([c1.id, u1.id, c2.id, u2.id]);
    const two = await queue('stage=awaiting_pickup&pageSize=2&page=2', 'js');
    expect(two.items.map((r) => r.setId)).toEqual([c1.id, u1.id]);
  });

  it('receives uncast specimens as lab staff (personal or LAB naming the receiver), once', async () => {
    const [a, b, c] = u1.specimens;
    const before = await tallies();
    // An ordinary internal user is refused; nothing is written.
    const denied = await receipt(a!.id, { idempotencyKey: newKey() }, 'tech');
    expect(denied.status).toBe(403);
    expect(await tallies()).toEqual(before);

    const body = { idempotencyKey: newKey() };
    const first = await receipt(a!.id, body, 'lm');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // An exact retry returns the same records without a second receipt.
    const retry = await receipt(a!.id, body, 'lm');
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    const row = concreteSetReceivingSchema
      .parse(first.body)
      .specimens.find((s) => s.specimenId === a!.id)!;
    expect(row.state).toBe('received');
    expect(row.receipt).toMatchObject({
      massG: '3650.0',
      receivedAt: '2026-11-08T16:00:00.000Z',
      receivedBy: { userId: h.users.lm },
      recordedBy: { userId: h.users.lm },
    });

    // LAB must name the actual receiver; naming one records them as the receiver only.
    expect((await receipt(b!.id, { idempotencyKey: newKey() }, 'lab')).status).toBe(400);
    const viaLab = await receipt(
      b!.id,
      { idempotencyKey: newKey(), receivedByUserId: h.users.lm },
      'lab',
    );
    expect(viaLab.status, JSON.stringify(viaLab.body)).toBe(201);
    expect(
      concreteSetReceivingSchema.parse(viaLab.body).specimens.find((s) => s.specimenId === b!.id)!
        .receipt,
    ).toMatchObject({ receivedBy: { userId: h.users.lm }, recordedBy: { userId: h.users.lab } });

    // Already received: 409, nothing new.
    const again = await receipt(a!.id, { idempotencyKey: newKey() }, 'lm');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_received');
    const after = await tallies();
    expect([after.receipts - before.receipts, after.audit - before.audit]).toEqual([2, 2]);

    // Received specimens leave the queue; the rest of the set stays awaiting pickup.
    const pickup = await queue('stage=awaiting_pickup');
    expect(pickup.items.find((r) => r.setId === u1.id)!.letters).toEqual(['C', 'D']);
    expect(pickup.total).toBe(4);
    // A pickup with no casting time to compare against is accepted too.
    const picked = await send(
      'post',
      `/api/concrete/specimen-sets/${u1.id}/pickup`,
      {
        idempotencyKey: newKey(),
        specimens: [{ id: c!.id, version: null }],
        complete: true,
        collectedByUserId: h.users.lm,
        collectedAt: '2026-11-08T08:00:00-06:00',
        curingMinC: '18.0',
        curingMaxC: '22.0',
      },
      'lm',
    );
    expect(picked.status, JSON.stringify(picked.body)).toBe(201);
    const receiving = await queue('stage=awaiting_receiving');
    expect(receiving.items.map((r) => [r.setId, r.castAt, r.letters])).toEqual([
      [u1.id, null, ['C']],
    ]);
    expect(receiving.counts).toEqual({ awaiting_pickup: 4, awaiting_receiving: 1 });

    // Receiving scheduled nothing: the test dates stay unset.
    expect((await dates(u1.id)).every((d) => d.target === null && d.hold === null)).toBe(true);
  });

  it('recording the casting time later derives the dates once (America/Edmonton), receipts kept', async () => {
    const before = await tallies();
    const { rows: receiptsBefore } = await h.db.pool.query(
      `SELECT r.id, r.received_at, r.mass_g::text FROM concrete_specimen_receipt r
       JOIN concrete_specimen sp ON sp.id = r.specimen_id WHERE sp.set_id = $1 ORDER BY r.id`,
      [u1.id],
    );
    const report = concreteFieldReportDetailSchema.parse(
      (await get(`/api/concrete/field-reports/${u1.fieldReportId}`)).body,
    );
    // 23:30 on 7 Nov in Edmonton (UTC-6) is 8 Nov in UTC: the casting date is 7 Nov.
    const saved = await send(
      'patch',
      `/api/concrete/field-reports/${u1.fieldReportId}`,
      { idempotencyKey: newKey(), version: report.version, castAt: '2026-11-07T23:30:00-06:00' },
      'tech',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await dates(u1.id)).toEqual([
      { letter: 'A', age: '7', target: '2026-11-14', hold: null },
      { letter: 'B', age: '28', target: '2026-12-05', hold: null },
      { letter: 'C', age: '28', target: '2026-12-05', hold: null },
      { letter: 'D', age: 'HOLD', target: null, hold: '2027-01-02' },
    ]);
    // No duplicate receipt, and the receipts are unchanged.
    expect(await tallies()).toEqual(before);
    const { rows: receiptsAfter } = await h.db.pool.query(
      `SELECT r.id, r.received_at, r.mass_g::text FROM concrete_specimen_receipt r
       JOIN concrete_specimen sp ON sp.id = r.specimen_id WHERE sp.set_id = $1 ORDER BY r.id`,
      [u1.id],
    );
    expect(receiptsAfter).toEqual(receiptsBefore);
    // The queue now shows the casting time; the worklist lists the 7-day break on its date.
    const receiving = await queue('stage=awaiting_receiving');
    expect(receiving.items.find((r) => r.setId === u1.id)!.castAt).toBe('2026-11-08T05:30:00.000Z');
    const worklist = concreteWorklistSchema.parse(
      (await get('/api/concrete/lab-worklist?view=today&on=2026-11-14')).body,
    );
    expect(worklist.groups.flatMap((g) => g.rows.map((r) => r.specimenId))).toContain(
      u1.specimens[0]!.id,
    );
  });

  it('a numbered set without a casting time gets it through the recorded casting correction', async () => {
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = 9, permanent_id = '26-09' WHERE id = $1`,
      [u2.id],
    );
    expect((await queue('stage=awaiting_pickup')).items.map((r) => r.setId)).toContain(u2.id);
    const received = await receipt(u2.specimens[0]!.id, { idempotencyKey: newKey() }, 'lm');
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    expect((await dates(u2.id)).every((d) => d.target === null)).toBe(true);

    const report = concreteFieldReportDetailSchema.parse(
      (await get(`/api/concrete/field-reports/${u2.fieldReportId}`, 'pe')).body,
    );
    const body = {
      idempotencyKey: newKey(),
      version: report.version,
      castAt: '2026-11-04T08:00:00-06:00',
      reason: 'Casting time read from the field sheet',
      confirm: true,
    };
    const corrected = await send(
      'post',
      `/api/concrete/field-reports/${u2.fieldReportId}/casting-correction`,
      body,
      'pe',
    );
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect((await dates(u2.id)).map((d) => d.target ?? d.hold)).toEqual([
      '2026-11-11',
      '2026-12-02',
      '2026-12-02',
      '2026-12-30',
    ]);
    const { rows } = await h.db.pool.query(
      `SELECT previous_cast_at FROM concrete_casting_correction WHERE field_report_id = $1`,
      [u2.fieldReportId],
    );
    expect(rows).toEqual([{ previous_cast_at: null }]);
    expect((await dates(c2.id)).map((d) => d.target ?? d.hold)).toEqual([
      '2026-11-10',
      '2026-12-01',
      '2026-12-01',
      '2026-12-29',
    ]);
  });

  it('leaves Void sets and Void reports out of the queue and its counts', async () => {
    const voidSet = await castSet(h.projects.a, null, 'tech');
    const voidReport = await castSet(h.projects.a, null, 'tech');
    const before = await queue('stage=awaiting_pickup');
    expect(before.items.map((r) => r.setId)).toEqual(
      expect.arrayContaining([voidSet.id, voidReport.id]),
    );
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = 31, permanent_id = '26-31',
         voided_at = now(), voided_by_user_id = $2,
         void_reason = 'Fictional void for the test' WHERE id = $1`,
      [voidSet.id, h.users.pe],
    );
    await h.db.pool.query(
      `UPDATE concrete_field_report SET workflow_state = 'void' WHERE id = $1`,
      [voidReport.fieldReportId],
    );
    const after = await queue('stage=awaiting_pickup');
    expect(after.items.map((r) => r.setId)).not.toContain(voidSet.id);
    expect(after.items.map((r) => r.setId)).not.toContain(voidReport.id);
    expect(after.counts.awaiting_pickup).toBe(before.counts.awaiting_pickup - 2);
    expect(after.total).toBe(after.items.length);
  });
});
