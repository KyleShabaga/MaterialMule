import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteReceivingExceptionListSchema,
  concreteReceivingExceptionSchema,
  concreteReportReceivingSchema,
  concreteSetReceivingSchema,
  concreteSpecimenSetDetailSchema,
  type ConcreteSetReceiving,
  type ConcreteSpecimenSetDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-V2-C06: pickup and initial curing, lab receipt with one unmoulded mass, marker confirmation,
// receiving exceptions and blockers (card AC1–AC6; test plan T1–T3). Real PostgreSQL, direct API
// calls. Fictional data only: DEMO-2601 (A) and DEMO-2602 (B), both led by Pat Example `pe`;
// Alex Tester `tech` and Jamie Song `jo` cast sets; Lee Manager `lm` is a Lab Manager without a
// concrete grant; Taylor Bench `lt` is a Lab Technician; Jordan Smith `js` is a plain internal
// user. The curing range is a test fixture, not a CSA/ASTM value (CD-62 is unanswered).
describe.runIf(testDatabaseUrl)('concrete pickup and receiving (MM-V2-C06)', () => {
  let h: LabHarness;
  let ltId: string;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab' | 'lt';

  const send = (method: 'post' | 'put' | 'delete', url: string, body: unknown, as: Caller) =>
    h
      .http()
      [method](url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as]!)
      .send(body as object);
  const get = (url: string, as: Caller = 'lt') => h.http().get(url).set('Cookie', cookies[as]!);

  const CAST_AT = '2026-11-02T09:15:00-06:00';

  async function castSet(
    projectId: string,
    as: Caller = 'tech',
    ages?: (number | 'HOLD')[],
  ): Promise<ConcreteSpecimenSetDetail> {
    const report = await send(
      'post',
      `/api/concrete/projects/${projectId}/field-reports`,
      { idempotencyKey: newKey(), material: 'concrete', specimensCast: true, castAt: CAST_AT },
      as,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
    const set = await send(
      'post',
      `/api/concrete/field-reports/${reportId}/specimen-sets`,
      {
        idempotencyKey: newKey(),
        ...(ages ? { specimens: ages.map((age) => ({ id: randomUUID(), age })) } : {}),
      },
      as,
    );
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    return concreteSpecimenSetDetailSchema.parse(set.body);
  }

  let numberCounter = 0;
  async function attachNumber(set: ConcreteSpecimenSetDetail) {
    numberCounter += 1;
    await h.db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [set.id, numberCounter, `26-${String(numberCounter).padStart(2, '0')}`],
    );
  }

  async function receiving(setId: string): Promise<ConcreteSetReceiving> {
    const response = await get(`/api/concrete/specimen-sets/${setId}/receiving`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteSetReceivingSchema.parse(response.body);
  }

  const pickupBody = (
    specimens: { id: string; version: number | null }[],
    values: Record<string, unknown>,
  ) => ({ idempotencyKey: newKey(), specimens, ...values });

  const receive = (specimenId: string, massG: unknown, as: Caller = 'lt', extra = {}) =>
    send(
      'post',
      `/api/concrete/specimens/${specimenId}/receipt`,
      { idempotencyKey: newKey(), receivedAt: '2026-11-03T10:00:00-06:00', massG, ...extra },
      as,
    );

  async function tallies() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_specimen_pickup) AS pickups,
              (SELECT count(*)::int FROM concrete_specimen_receipt) AS receipts,
              (SELECT count(*)::int FROM concrete_receiving_exception) AS exceptions,
              (SELECT count(*)::int FROM concrete_set_marker_confirmation) AS confirmations,
              (SELECT count(*)::int FROM concrete_specimen_mass_correction) AS corrections,
              (SELECT count(*)::int FROM audit_event
               WHERE action LIKE 'concrete_specimen.%' OR action LIKE 'concrete_receiving%'
                  OR action LIKE 'concrete_specimen_set.markers%') AS audit`,
    );
    return rows[0] as {
      pickups: number;
      receipts: number;
      exceptions: number;
      confirmations: number;
      corrections: number;
      audit: number;
    };
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'js', 'jo', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Taylor Bench', 'TB', 'personal', 'active') RETURNING id`,
    );
    ltId = rows[0]!.id;
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_technician')`,
      [ltId],
    );
    const session = await h.app.get(SessionService).create(ltId, 'personal');
    cookies.lt = `${SESSION_COOKIE}=${session.token}`;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC1: Mark picked up needs collector, time and both curing readings; incomplete drafts save', async () => {
    const set = await castSet(h.projects.a);
    const [a, b] = set.specimens;
    const before = await tallies();
    const refused = await send(
      'post',
      `/api/concrete/specimen-sets/${set.id}/pickup`,
      pickupBody([{ id: a!.id, version: null }], {
        complete: true,
        collectedAt: '2026-11-03T08:30:00-06:00',
        curingMinC: '18.5',
      }),
      'lt',
    );
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('pickup_incomplete');
    expect(refused.body.errors.map((e: { field: string }) => e.field)).toEqual(['curingMaxC']);
    expect(await tallies()).toEqual(before);

    // The same data saves as an incomplete record; missing stays null, never 0.
    const saved = await send(
      'post',
      `/api/concrete/specimen-sets/${set.id}/pickup`,
      pickupBody([{ id: a!.id, version: null }], {
        complete: false,
        collectedAt: '2026-11-03T08:30:00-06:00',
        curingMinC: '18.5',
      }),
      'lt',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    let view = concreteSetReceivingSchema.parse(saved.body);
    const pickupA = view.specimens.find((s) => s.specimenId === a!.id)!.pickup!;
    expect(pickupA).toMatchObject({
      completed: false,
      curingMinC: '18.5',
      curingMaxC: null,
      collectedBy: { userId: ltId, initials: 'TB' },
      curingRange: null,
      curingFlags: null,
    });
    expect(view.specimens.find((s) => s.specimenId === a!.id)!.state).toBe('awaiting_pickup');

    // Completing it (A, plus B selected for the first time) records all four.
    const done = await send(
      'post',
      `/api/concrete/specimen-sets/${set.id}/pickup`,
      pickupBody(
        [
          { id: a!.id, version: pickupA.version },
          { id: b!.id, version: null },
        ],
        {
          complete: true,
          collectedAt: '2026-11-03T08:30:00-06:00',
          curingMinC: 18.5,
          curingMaxC: '24',
          curingBox: 'Box 3',
        },
      ),
      'lt',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    view = concreteSetReceivingSchema.parse(done.body);
    for (const id of [a!.id, b!.id]) {
      const row = view.specimens.find((s) => s.specimenId === id)!;
      expect(row.state).toBe('picked_up');
      expect(row.pickup).toMatchObject({ completed: true, curingMaxC: '24.0', curingBox: 'Box 3' });
    }
    // Partial pickup: C and D stay awaiting pickup and block submission.
    expect(view.blockers.find((x) => x.code === 'pickup_incomplete')!.specimenIds).toEqual(
      set.specimens.slice(2).map((s) => s.id),
    );

    // A stale version is a conflict and writes nothing.
    const stale = await send(
      'post',
      `/api/concrete/specimen-sets/${set.id}/pickup`,
      pickupBody([{ id: a!.id, version: pickupA.version }], { complete: false }),
      'lt',
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');

    // Pickup before casting is refused; more than one decimal is refused, not rounded.
    const early = await send(
      'post',
      `/api/concrete/specimen-sets/${set.id}/pickup`,
      pickupBody([{ id: set.specimens[2]!.id, version: null }], {
        complete: false,
        collectedAt: '2026-11-01T08:00:00-06:00',
      }),
      'lt',
    );
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('before_casting');
    const precise = await send(
      'post',
      `/api/concrete/specimen-sets/${set.id}/pickup`,
      pickupBody([{ id: set.specimens[2]!.id, version: null }], {
        complete: false,
        curingMinC: '18.55',
      }),
      'lt',
    );
    expect(precise.status).toBe(400);
  });

  it('AC2: 12345.6 g persists exactly with the actual receiver and time, once across retries', async () => {
    const set = await castSet(h.projects.a);
    const specimen = set.specimens[0]!;
    const body = {
      idempotencyKey: newKey(),
      receivedAt: '2026-11-03T10:05:00-06:00',
      receivedByUserId: ltId,
      massG: '12345.6',
    };
    const before = await tallies();
    const first = await send('post', `/api/concrete/specimens/${specimen.id}/receipt`, body, 'lab');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const retry = await send('post', `/api/concrete/specimens/${specimen.id}/receipt`, body, 'lab');
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    const after = await tallies();
    expect(after.receipts - before.receipts).toBe(1);
    expect(after.audit - before.audit).toBe(1);

    const row = concreteSetReceivingSchema
      .parse(first.body)
      .specimens.find((s) => s.specimenId === specimen.id)!;
    expect(row.state).toBe('received');
    expect(row.receipt).toMatchObject({
      massG: '12345.6',
      receivedAt: '2026-11-03T16:05:00.000Z',
      receivedBy: { userId: ltId, name: 'Taylor Bench' },
      recordedBy: { userId: h.users.lab },
    });
    const { rows } = await h.db.pool.query<{ mass: string; recorded: string; receiver: string }>(
      `SELECT mass_g::text AS mass, recorded_by_user_id AS recorded,
              received_by_user_id AS receiver
       FROM concrete_specimen_receipt WHERE specimen_id = $1`,
      [specimen.id],
    );
    expect(rows).toEqual([{ mass: '12345.6', recorded: h.users.lab, receiver: ltId }]);
    // LAB is the audited actor, the named person the receiver.
    const { rows: audit } = await h.db.pool.query(
      `SELECT actor_user_id, receiver_user_id FROM audit_event
       WHERE action = 'concrete_specimen.received' AND entity_id = $1`,
      [specimen.id],
    );
    expect(audit).toEqual([{ actor_user_id: h.users.lab, receiver_user_id: ltId }]);

    // The same key for a different request; a second receipt; excess precision.
    const reused = await send(
      'post',
      `/api/concrete/specimens/${specimen.id}/receipt`,
      { ...body, massG: '12345.7' },
      'lab',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');
    const again = await receive(specimen.id, '12000.0');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_received');
    const tooPrecise = await receive(set.specimens[1]!.id, '12345.67');
    expect(tooPrecise.status).toBe(400);
    const zero = await receive(set.specimens[1]!.id, 0);
    expect(zero.status).toBe(400);
    // LAB must name the actual receiver.
    const anonymousLab = await receive(set.specimens[1]!.id, '12000.0', 'lab');
    expect(anonymousLab.status).toBe(400);
    expect(await tallies()).toEqual(after);
  });

  it('AC3: partial arrivals and missing pickup data keep saved receipts and list what is outstanding', async () => {
    const set = await castSet(h.projects.a);
    const [a, b, c, d] = set.specimens;
    // A arrives with no pickup record at all: the receipt still saves.
    expect((await receive(a!.id, '12500.1')).status).toBe(201);
    expect((await receive(b!.id, 12480.4)).status).toBe(201);
    const view = await receiving(set.id);
    expect(view.specimens.map((s) => s.state)).toEqual([
      'received',
      'received',
      'awaiting_pickup',
      'awaiting_pickup',
    ]);
    expect(view.specimens[0]!.receipt!.massG).toBe('12500.1');
    expect(view.specimens[1]!.receipt!.massG).toBe('12480.4');
    const blockers = Object.fromEntries(view.blockers.map((x) => [x.code, x.specimenIds]));
    expect(blockers.pickup_incomplete).toEqual([a!.id, b!.id, c!.id, d!.id]);
    expect(blockers.not_received).toEqual([c!.id, d!.id]);
    expect(blockers.marker_confirmation_missing).toEqual([a!.id, b!.id]);

    // The report-level view gathers every set's blockers.
    const report = await get(`/api/concrete/field-reports/${set.fieldReportId}/receiving`);
    expect(report.status).toBe(200);
    const parsed = concreteReportReceivingSchema.parse(report.body);
    expect(parsed.blockers.every((x) => x.setId === set.id)).toBe(true);
    expect(parsed.blockers.map((x) => x.code)).toEqual(view.blockers.map((x) => x.code));

    // A plain internal user receives nothing, and nothing changes.
    const before = await tallies();
    const refused = await receive(c!.id, '12000.0', 'js');
    expect(refused.status).toBe(403);
    expect(await tallies()).toEqual(before);

    // Once lab records exist the draft set is no longer replaced or discarded wholesale.
    const discard = await h
      .http()
      .delete(`/api/concrete/specimen-sets/${set.id}`)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies.tech!)
      .send({ idempotencyKey: newKey(), version: set.version });
    expect(discard.status).toBe(409);
    expect(discard.body.code).toBe('set_has_receiving');
  });

  it('Pick up window: 24 h from casting by default, unverified, editable with a version', async () => {
    const set = await castSet(h.projects.a);
    let view = await receiving(set.id);
    expect(view.pickupWindow).toEqual({
      hours: 24,
      source: 'default',
      endsAt: '2026-11-03T15:15:00.000Z',
      verified: false,
      version: null,
    });
    const edited = await send(
      'put',
      `/api/concrete/specimen-sets/${set.id}/pickup-window`,
      { idempotencyKey: newKey(), version: null, hours: 36 },
      'lt',
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    view = concreteSetReceivingSchema.parse(edited.body);
    expect(view.pickupWindow).toMatchObject({ hours: 36, source: 'edited', version: 1 });
    // The window never becomes an actual pickup.
    expect(view.specimens.every((s) => s.pickup === null)).toBe(true);
    const stale = await send(
      'put',
      `/api/concrete/specimen-sets/${set.id}/pickup-window`,
      { idempotencyKey: newKey(), version: null, hours: 48 },
      'lt',
    );
    expect(stale.status).toBe(409);
  });

  it('AC4: an out-of-range reading against a fixture range is flagged without blocking, and notifies', async () => {
    // Before any range is configured, readings are stored unchecked.
    const unchecked = await castSet(h.projects.b);
    const plain = await send(
      'post',
      `/api/concrete/specimen-sets/${unchecked.id}/pickup`,
      pickupBody([{ id: unchecked.specimens[0]!.id, version: null }], {
        complete: true,
        collectedAt: '2026-11-03T08:00:00-06:00',
        curingMinC: '2.0',
        curingMaxC: '40.0',
      }),
      'lm',
    );
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    const plainRow = concreteSetReceivingSchema.parse(plain.body).specimens[0]!;
    expect(plainRow.pickup).toMatchObject({ curingRange: null, curingFlags: null });
    expect(concreteSetReceivingSchema.parse(plain.body).currentCuringRange).toBeNull();

    // A verified-range fixture (not a CSA/ASTM value).
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO concrete_curing_standard (specification, edition, min_c, max_c, created_by_user_id)
       VALUES ('FIXTURE-SPEC', 'test fixture', 16.0, 27.0, $1) RETURNING id`,
      [h.users.lm],
    );
    const rangeId = rows[0]!.id;
    try {
      const set = await castSet(h.projects.b);
      const [a] = set.specimens;
      const notesBefore = await h.db.pool.query(
        `SELECT count(*)::int AS n FROM notification WHERE kind = 'concrete_curing.out_of_range'`,
      );
      const flagged = await send(
        'post',
        `/api/concrete/specimen-sets/${set.id}/pickup`,
        pickupBody([{ id: a!.id, version: null }], {
          complete: true,
          collectedAt: '2026-11-03T08:00:00-06:00',
          curingMinC: '15.0',
          curingMaxC: '22.0',
        }),
        'lt',
      );
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
      let view = concreteSetReceivingSchema.parse(flagged.body);
      const pickup = view.specimens[0]!.pickup!;
      expect(pickup).toMatchObject({
        completed: true,
        curingFlags: ['min_below_range'],
        curingRange: { id: rangeId, minC: '16.0', maxC: '27.0', specification: 'FIXTURE-SPEC' },
        curingResolution: null,
      });
      expect(view.issuanceGates).toEqual([
        { code: 'curing_out_of_range_unresolved', specimenIds: [a!.id], exceptionIds: [] },
      ]);
      // Not a submission blocker: A's pickup is complete.
      expect(view.blockers.find((x) => x.code === 'pickup_incomplete')!.specimenIds).not.toContain(
        a!.id,
      );
      // The lead is notified in-app (the actor never is).
      const { rows: notes } = await h.db.pool.query(
        `SELECT recipient_user_id, concrete_field_report_id FROM notification
         WHERE kind = 'concrete_curing.out_of_range' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(notes).toEqual([
        { recipient_user_id: h.users.pe, concrete_field_report_id: set.fieldReportId },
      ]);
      const notesAfter = await h.db.pool.query(
        `SELECT count(*)::int AS n FROM notification WHERE kind = 'concrete_curing.out_of_range'`,
      );
      expect(notesAfter.rows[0].n - notesBefore.rows[0].n).toBe(1);
      // Receipt is not blocked.
      expect((await receive(a!.id, '12345.0')).status).toBe(201);

      // Resolution: lead or designated reviewer only, personal account.
      const resolve = (as: Caller, version: number) =>
        send(
          'post',
          `/api/concrete/specimens/${a!.id}/curing-resolution`,
          { idempotencyKey: newKey(), version, note: 'Box heater checked; readings noted' },
          as,
        );
      for (const as of ['js', 'lab', 'lt', 'lm'] as const) {
        const response = await resolve(as, pickup.version);
        expect(response.status, as).toBe(403);
      }
      const resolved = await resolve('pe', pickup.version);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
      view = concreteSetReceivingSchema.parse(resolved.body);
      expect(view.issuanceGates).toEqual([]);
      expect(view.specimens[0]!.pickup).toMatchObject({
        curingFlags: ['min_below_range'],
        curingMinC: '15.0',
        curingResolution: {
          by: { userId: h.users.pe },
          note: 'Box heater checked; readings noted',
        },
      });

      // A newer range never rewrites the check stored with an existing pickup.
      await h.db.pool.query(
        `UPDATE concrete_curing_standard SET retired_at = now(), retired_by_user_id = $2
         WHERE id = $1`,
        [rangeId, h.users.lm],
      );
      await h.db.pool.query(
        `INSERT INTO concrete_curing_standard (specification, edition, min_c, max_c, created_by_user_id)
         VALUES ('FIXTURE-SPEC', 'test fixture 2', 10.0, 30.0, $1)`,
        [h.users.lm],
      );
      view = await receiving(set.id);
      expect(view.specimens[0]!.pickup!.curingRange!.id).toBe(rangeId);
      expect(view.currentCuringRange!.edition).toBe('test fixture 2');
    } finally {
      await h.db.pool.query(
        `UPDATE concrete_curing_standard SET retired_at = now(), retired_by_user_id = $1
         WHERE retired_at IS NULL`,
        [h.users.lm],
      );
    }
  });

  it('AC5: exceptions are resolved only by the lead, a reviewer, a grant Lab Manager or the casting technician', async () => {
    const mine = await castSet(h.projects.a, 'tech');
    const theirs = await castSet(h.projects.a, 'jo');
    const record = async (body: Record<string, unknown>, as: Caller = 'lt') => {
      const response = await send(
        'post',
        `/api/concrete/projects/${h.projects.a}/receiving-exceptions`,
        { idempotencyKey: newKey(), ...body },
        as,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return concreteReceivingExceptionSchema.parse(response.body);
    };
    const missing = await record({ kind: 'missing', specimenId: mine.specimens[3]!.id });
    expect(missing).toMatchObject({ setId: mine.id, reportedBy: { userId: ltId } });
    // Missing blocks submission until a disposition is recorded.
    let view = await receiving(mine.id);
    expect(view.blockers.find((x) => x.code === 'missing_unresolved')!.exceptionIds).toEqual([
      missing.id,
    ]);
    const duplicate = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/receiving-exceptions`,
      { idempotencyKey: newKey(), kind: 'missing', specimenId: mine.specimens[3]!.id },
      'lt',
    );
    expect(duplicate.status).toBe(409);

    const resolve = (id: string, as: Caller, extra: Record<string, unknown> = {}) =>
      send(
        'post',
        `/api/concrete/receiving-exceptions/${id}/resolve`,
        {
          idempotencyKey: newKey(),
          disposition: 'Lost in transit',
          reason: 'Not in the cooler',
          ...extra,
        },
        as,
      );
    const before = await tallies();
    // LAB naming any person, a plain user, a Lab Technician, a Lab Manager without the grant and
    // the technician of another set are all refused, and nothing changes.
    for (const as of ['lab', 'js', 'lt', 'lm', 'jo'] as const) {
      const response = await resolve(
        missing.id,
        as,
        as === 'lab' ? { personUserId: h.users.pe } : {},
      );
      expect(response.status, as).toBe(403);
      expect(response.body.code).toBe('forbidden');
    }
    expect(await tallies()).toEqual(before);
    // The casting technician resolves a specimen they cast.
    const resolved = await resolve(missing.id, 'tech');
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
    expect(concreteReceivingExceptionSchema.parse(resolved.body).resolution).toMatchObject({
      by: { userId: h.users.tech },
      source: 'record_technician',
      disposition: 'Lost in transit',
      reason: 'Not in the cooler',
    });
    const twice = await resolve(missing.id, 'pe');
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('already_resolved');
    view = await receiving(mine.id);
    expect(view.specimens[3]!.state).toBe('missing_resolved');
    expect(view.blockers.find((x) => x.code === 'missing_unresolved')).toBeUndefined();
    expect(view.blockers.find((x) => x.code === 'not_received')!.specimenIds).not.toContain(
      mine.specimens[3]!.id,
    );

    // An unmatched specimen arrives weighed; jo's technician authority doesn't cover tech's set.
    const unmatched = await record(
      {
        kind: 'unmatched',
        observedMarking: '26-?? A (smudged)',
        receivedAt: '2026-11-03T11:00:00-06:00',
        massG: '12399.9',
      },
      'lt',
    );
    expect(unmatched).toMatchObject({ massG: '12399.9', receivedBy: { userId: ltId } });
    const crossTech = await resolve(unmatched.id, 'jo', {
      disposition: 'Matched',
      matchedSpecimenId: mine.specimens[0]!.id,
    });
    expect(crossTech.status).toBe(403);
    // The lead confirms it as tech's specimen A: its receipt becomes A's, linked to the record.
    const matched = await resolve(unmatched.id, 'pe', {
      disposition: 'Matched',
      reason: 'Letter A visible under the smudge',
      matchedSpecimenId: mine.specimens[0]!.id,
    });
    expect(matched.status, JSON.stringify(matched.body)).toBe(201);
    expect(concreteReceivingExceptionSchema.parse(matched.body).resolution).toMatchObject({
      source: 'lead_project_engineer',
      matchedSpecimenId: mine.specimens[0]!.id,
    });
    view = await receiving(mine.id);
    expect(view.specimens[0]!.receipt).toMatchObject({
      massG: '12399.9',
      fromExceptionId: unmatched.id,
      receivedBy: { userId: ltId },
    });

    // An extra specimen naming jo's set blocks it as unresolved identity until reconciled.
    const extra = await record({ kind: 'extra', setId: theirs.id, observedMarking: 'TMP? E' });
    view = await receiving(theirs.id);
    expect(view.blockers.find((x) => x.code === 'identity_unresolved')!.exceptionIds).toEqual([
      extra.id,
    ]);
    const list = await get(
      `/api/concrete/projects/${h.projects.a}/receiving-exceptions?status=open`,
    );
    expect(list.status).toBe(200);
    expect(concreteReceivingExceptionListSchema.parse(list.body).items.map((e) => e.id)).toEqual([
      extra.id,
    ]);
    // A plain internal user records nothing.
    const refused = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/receiving-exceptions`,
      { idempotencyKey: newKey(), kind: 'extra', setId: theirs.id },
      'js',
    );
    expect(refused.status).toBe(403);
  });

  it('AC6: a later arrival is not covered by an earlier marker confirmation', async () => {
    const set = await castSet(h.projects.a);
    const [a, b, c] = set.specimens;
    expect((await receive(a!.id, '12000.0')).status).toBe(201);
    const confirm = (as: Caller = 'lt', extra = {}) =>
      send(
        'post',
        `/api/concrete/specimen-sets/${set.id}/marker-confirmation`,
        { idempotencyKey: newKey(), confirmedAt: '2026-11-03T12:00:00-06:00', ...extra },
        as,
      );
    // No permanent ID yet: nothing to write with a marker.
    const early = await confirm();
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('set_not_numbered');
    await attachNumber(set);
    expect((await receive(b!.id, '12000.0')).status).toBe(201);
    const first = await confirm();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    let view = concreteSetReceivingSchema.parse(first.body);
    expect(view.markerConfirmations).toHaveLength(1);
    expect(view.markerConfirmations[0]).toMatchObject({
      specimenIds: [a!.id, b!.id],
      confirmedBy: { userId: ltId },
    });
    expect(view.blockers.find((x) => x.code === 'marker_confirmation_missing')).toBeUndefined();

    // C arrives later: the earlier confirmation does not cover it.
    expect((await receive(c!.id, '12000.0')).status).toBe(201);
    view = await receiving(set.id);
    expect(view.specimens[2]!.markerConfirmationId).toBeNull();
    expect(
      view.blockers.find((x) => x.code === 'marker_confirmation_missing')!.specimenIds,
    ).toEqual([c!.id]);
    // LAB confirms naming the person; it covers C only.
    const second = await confirm('lab', { confirmedByUserId: h.users.lm });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    view = concreteSetReceivingSchema.parse(second.body);
    expect(view.markerConfirmations[1]).toMatchObject({
      specimenIds: [c!.id],
      confirmedBy: { userId: h.users.lm },
      recordedBy: { userId: h.users.lab },
    });
    const nothing = await confirm();
    expect(nothing.status).toBe(409);
    expect(nothing.body.code).toBe('nothing_to_confirm');
  });

  it('CD-46: mass corrections need lab staff on a personal account, a reason and the current version', async () => {
    const set = await castSet(h.projects.a);
    const specimen = set.specimens[0]!;
    const received = concreteSetReceivingSchema.parse((await receive(specimen.id, '12345.6')).body);
    const version = received.specimens[0]!.receipt!.version;
    const correct = (as: Caller, body: Record<string, unknown>) =>
      send('post', `/api/concrete/specimens/${specimen.id}/mass-correction`, body, as);
    const base = { idempotencyKey: newKey(), version, massG: '12354.6', reason: 'Digits swapped' };
    const lab = await correct('lab', { ...base, idempotencyKey: newKey() });
    expect(lab.status).toBe(403);
    expect(lab.body.code).toBe('personal_account_required');
    const plain = await correct('js', { ...base, idempotencyKey: newKey() });
    expect(plain.status).toBe(403);
    const noReason = await correct('lt', { ...base, idempotencyKey: newKey(), reason: ' ' });
    expect(noReason.status).toBe(400);

    const done = await correct('lt', base);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const retry = await correct('lt', base);
    expect(retry.body).toEqual(done.body);
    const receipt = concreteSetReceivingSchema.parse(done.body).specimens[0]!.receipt!;
    expect(receipt).toMatchObject({ massG: '12354.6', version: version + 1 });
    expect(receipt.corrections).toEqual([
      expect.objectContaining({
        previousMassG: '12345.6',
        newMassG: '12354.6',
        reason: 'Digits swapped',
        by: expect.objectContaining({ userId: ltId }),
      }),
    ]);
    const stale = await correct('lm', { ...base, idempotencyKey: newKey(), massG: '12000.0' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('reads: unknown sets are 404, and LAB reads receiving', async () => {
    expect((await get(`/api/concrete/specimen-sets/${randomUUID()}/receiving`)).status).toBe(404);
    expect((await get(`/api/concrete/specimen-sets/not-an-id/receiving`)).status).toBe(404);
    const set = await castSet(h.projects.b);
    expect((await get(`/api/concrete/specimen-sets/${set.id}/receiving`, 'lab')).status).toBe(200);
  });
});
