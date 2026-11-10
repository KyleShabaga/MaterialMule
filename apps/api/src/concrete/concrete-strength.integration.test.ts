import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  concreteSpecimenSetDetailSchema,
  concreteStrengthExclusionStateSchema,
  concreteStrengthP1,
  concreteStrengthTestsSchema,
  concreteTestResultSaveResultSchema,
  concreteTestingTableSchema,
  type ConcreteSpecimenSetDetail,
  type ConcreteStrengthInputs,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorFor } from '../auth/auth.controller.js';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/policy.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { ConcreteTestResultsService } from './concrete-test-results.service.js';

// MM-V2-C24 (card test T2): provisional method P1 stored with each complete result, versioning
// (AC2), grouping per set and age, reviewer exclusion, the advisory assessment at the reference
// age only (AC3) and the running average. Real PostgreSQL, fictional data: DEMO-2601 led by Pat
// Example `pe` (the strength reviewer here); Lee Manager `lm` enters results. Four sets on one
// registry mix, f′c 25 MPa at 28 d; lab defaults A 7 d, B and C 28 d, D HOLD. All cylinders
// 100 mm × 200 mm (A = π × 100² / 4 = 7 853.98 mm², L/D 2.00, no correction), so
// strength = load / 7.85398: 90 kN → 11.46 → 11.5; 200 kN → 25.46 → 25.5;
// 180 kN → 22.92 → 22.9; 197.1 kN → 25.10 → 25.1.
describe.runIf(testDatabaseUrl)('concrete strength calculation (MM-V2-C24)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  const sets: ConcreteSpecimenSetDetail[] = [];
  const resultIds = new Map<string, string>();
  const resultVersions = new Map<string, number>();

  const specimenOf = (set: number, letter: string) =>
    sets[set]!.specimens.find((s) => s.letter === letter)!;

  async function enter(
    set: number,
    letter: string,
    body: Record<string, unknown>,
    reason?: string,
  ) {
    const key = `${set}${letter}`;
    const id = resultIds.get(key) ?? randomUUID();
    const response = await h
      .http()
      .put(`/api/concrete/specimens/${specimenOf(set, letter).id}/test-results/${id}`)
      .set('Cookie', cookies.lm!)
      .set(CSRF_HEADER, '1')
      .send({
        idempotencyKey: newKey(),
        version: resultVersions.get(key) ?? 0,
        ...(reason ? { reason } : {}),
        ...body,
      });
    if (response.status === 200) {
      resultIds.set(key, id);
      resultVersions.set(key, (resultVersions.get(key) ?? 0) + 1);
    }
    return response;
  }

  const cylinder = (testedOn: string, maxLoad: number) => ({
    testedOn,
    maxLoad,
    heightReadings: [200],
    diameterReadings: [100],
  });

  async function tests(query: string) {
    const response = await h.get(`/api/concrete/strength-tests?${query}`, cookies.lab!);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return concreteStrengthTestsSchema.parse(response.body);
  }
  const line = async (set: number, age: number) =>
    (await tests(`setId=${sets[set]!.id}`)).tests.find((l) => l.ageDays === age)!;

  const exclude = (set: number, letter: string, body: Record<string, unknown>, as = 'pe') =>
    h
      .http()
      .put(`/api/concrete/specimens/${specimenOf(set, letter).id}/strength-exclusion`)
      .set('Cookie', cookies[as]!)
      .set(CSRF_HEADER, '1')
      .send({ idempotencyKey: newKey(), ...body });

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'pe', 'admin', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    // A registry mix on the project (as C03 stores one).
    const mixId = randomUUID();
    const revisionId = randomUUID();
    const client = await h.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO concrete_mix (id, project_id, supplier_name, mix_number, draft_revision_id,
                                   created_by_user_id, created_by_name_snapshot)
         VALUES ($1, $2, 'Demo Ready-Mix', 'M-25-20', $3, $4, 'Pat Example')`,
        [mixId, h.projects.a, revisionId, h.users.pe],
      );
      await client.query(
        `INSERT INTO concrete_mix_revision (id, mix_id, project_id, revision_number, supplier_name,
                                            mix_number, created_by_user_id, created_by_name_snapshot)
         VALUES ($1, $2, $3, 1, 'Demo Ready-Mix', 'M-25-20', $4, 'Pat Example')`,
        [revisionId, mixId, h.projects.a, h.users.pe],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    for (const day of ['01', '02', '05', '06']) {
      const report = await h.send(
        'post',
        `/api/concrete/projects/${h.projects.a}/field-reports`,
        {
          idempotencyKey: newKey(),
          material: 'concrete',
          specimensCast: true,
          castAt: `2026-10-${day}T09:15:00-06:00`,
        },
        cookies.tech!,
      );
      expect(report.status, JSON.stringify(report.body)).toBe(201);
      const reportId = concreteFieldReportDetailSchema.parse(report.body).id;
      const made = await h.send(
        'post',
        `/api/concrete/field-reports/${reportId}/specimen-sets`,
        { idempotencyKey: newKey() },
        cookies.tech!,
      );
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      sets.push(concreteSpecimenSetDetailSchema.parse(made.body));
      // The registry mix and specification (set after the set is made, as C38 propagation would).
      await h.db.pool.query(
        `UPDATE concrete_field_report
         SET mix_id = $2::uuid, mix_snapshot = jsonb_build_object('mixId', $2::text),
             project_spec = '{"specifiedStrengthMpa": 25, "specifiedStrengthAgeDays": 28}'
         WHERE id = $1`,
        [reportId, mixId],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC1: a complete entry stores the P1 values (raw and rounded) with the method version', async () => {
    // Incomplete first: the version is fixed, nothing is calculated.
    const partial = await enter(0, 'A', { maxLoad: 90 });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    const draft = concreteTestResultSaveResultSchema.parse(partial.body).result;
    expect(draft).toMatchObject({ calculationMethodVersion: 'P1', calculation: null });

    const saved = await enter(0, 'A', {
      testedOn: '2026-10-08',
      heightReadings: [200],
      diameterReadings: [100],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const result = concreteTestResultSaveResultSchema.parse(saved.body).result;
    expect(result.calculation).toMatchObject({
      methodVersion: 'P1',
      provisional: true,
      area: 7854,
      correctionFactor: 1,
      strength: 11.5,
      flags: [],
    });
    expect(result.calculation!.strengthRaw).toBeCloseTo(11.4592, 4);
    const { rows } = await h.db.pool.query(
      `SELECT calculation_method_version, calc_area_raw::float8 AS area_raw, calc_area::float8 AS area,
              calc_strength_raw::float8 AS raw, calc_strength::float8 AS strength
       FROM concrete_test_result WHERE id = $1`,
      [result.id],
    );
    expect(rows[0]).toMatchObject({ calculation_method_version: 'P1', area: 7854, strength: 11.5 });
    expect(rows[0].area_raw).toBeCloseTo(7853.9816, 4);
    expect(rows[0].raw).toBeCloseTo(11.4592, 4);
  });

  it('AC3: the 7-day test is information only, however low against 28-day f′c', async () => {
    const seven = await line(0, 7);
    expect(seven).toMatchObject({
      complete: true,
      count: 1,
      average: 11.5,
      single: true,
      referenceAge: false,
      assessment: 'information_only',
      failed: false,
      methodVersions: ['P1'],
    });
    // The flag against f′c is shown (11.5 is below 50% of 25 MPa) but never assesses the test.
    expect(seven.specimens[0]!.flags).toEqual(['strength_below_half_specified']);
  });

  it('the testing table shows the stored strength and the flags', async () => {
    const { rows } = await h.db.pool.query<{ target: string }>(
      'SELECT target_date::text AS target FROM concrete_specimen WHERE id = $1',
      [specimenOf(0, 'A').id],
    );
    const response = await h.get(
      `/api/concrete/testing-table?on=${rows[0]!.target}&projectId=${h.projects.a}`,
      cookies.lab!,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const table = concreteTestingTableSchema.parse(response.body);
    const row = table.groups
      .flatMap((g) => g.rows)
      .find((r) => r.specimenId === specimenOf(0, 'A').id)!;
    expect(row.result!.calculation).toMatchObject({ strength: 11.5, methodVersion: 'P1' });
    expect(row.result!.strengthFlags).toEqual(['strength_below_half_specified']);
    expect(row.result!.excluded).toBe(false);
  });

  it('grouping: the 28-day test averages the set, assessed below specified (a failed result)', async () => {
    expect((await enter(0, 'B', cylinder('2026-10-29', 200))).status).toBe(200);
    // Only one of two specimens entered: the age isn't complete, no test yet.
    expect(await line(0, 28)).toMatchObject({ complete: false, average: null, assessment: null });
    expect((await enter(0, 'C', cylinder('2026-10-29', 180))).status).toBe(200);
    // (25.4648 + 22.9183) / 2 = 24.1916 → 24.2: below 25, not below 21.5.
    const test = await line(0, 28);
    expect(test).toMatchObject({
      complete: true,
      count: 2,
      average: 24.2,
      single: false,
      referenceAge: true,
      assessment: 'below_specified',
      runningAverage: null,
      failed: true,
    });
    const failed = await tests(`projectId=${h.projects.a}&failed=true`);
    expect(failed.method).toMatchObject({
      version: 'P1',
      line: 'Calculation method P1 (provisional)',
    });
    expect(failed.tests.map((l) => [l.setId, l.ageDays])).toEqual([[sets[0]!.id, 28]]);
  });

  it('exclusion: the reviewer strikes a specimen with a reason; it stays listed', async () => {
    // Not a reviewer of the project: refused before the body.
    for (const as of ['tech', 'lm', 'lab']) {
      const refused = await exclude(0, 'C', { excluded: true, reason: 'x' }, as);
      expect(refused.status, as).toBe(403);
    }
    // A reason is required.
    const noReason = await exclude(0, 'C', { excluded: true });
    expect(noReason.status).toBe(400);
    const blank = await exclude(0, 'C', { excluded: true, reason: '   ' });
    expect(blank.status).toBe(400);

    const done = await exclude(0, 'C', { excluded: true, reason: 'Defective specimen (cap)' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const state = concreteStrengthExclusionStateSchema.parse(done.body);
    expect(state.excluded).toMatchObject({
      reason: 'Defective specimen (cap)',
      by: { userId: h.users.pe },
    });
    expect((await exclude(0, 'C', { excluded: true, reason: 'again' })).body.code).toBe(
      'already_excluded',
    );
    // B alone: 25.5, a single specimen, meets.
    const test = await line(0, 28);
    expect(test).toMatchObject({
      count: 1,
      average: 25.5,
      single: true,
      assessment: 'meets_specified',
    });
    const c = test.specimens.find((s) => s.letter === 'C')!;
    expect(c).toMatchObject({ counted: false, complete: true });
    expect(c.excluded).toMatchObject({ reason: 'Defective specimen (cap)' });
    expect(c.calculation!.strength).toBe(22.9);
    const { rows: audit } = await h.db.pool.query(
      `SELECT action, reason FROM audit_event WHERE entity_id = $1 ORDER BY occurred_at`,
      [specimenOf(0, 'C').id],
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'concrete_strength.excluded',
          reason: 'Defective specimen (cap)',
        }),
      ]),
    );

    // Reinstated: back to the two-specimen average.
    const back = await exclude(0, 'C', { excluded: false, reason: 'Cap was fine on re-check' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(concreteStrengthExclusionStateSchema.parse(back.body).history).toHaveLength(2);
    expect(await line(0, 28)).toMatchObject({ count: 2, average: 24.2 });
  });

  it('running average: this and the previous two reference-age tests, same project and mix', async () => {
    // Set 2: 197.1 kN twice → 25.1, meets; only one earlier test, so no running average.
    expect((await enter(1, 'B', cylinder('2026-10-30', 197.1))).status).toBe(200);
    expect((await enter(1, 'C', cylinder('2026-10-30', 197.1))).status).toBe(200);
    expect(await line(1, 28)).toMatchObject({
      average: 25.1,
      runningAverage: null,
      assessment: 'meets_specified',
      failed: false,
    });
    // Set 3: 200 kN twice → 25.5, meets on its own; (25.5 + 25.1 + 24.2) / 3 = 24.93 → 24.9.
    expect((await enter(2, 'B', cylinder('2026-11-02', 200))).status).toBe(200);
    expect((await enter(2, 'C', cylinder('2026-11-02', 200))).status).toBe(200);
    expect(await line(2, 28)).toMatchObject({
      average: 25.5,
      runningAverage: 24.9,
      assessment: 'running_average_below_specified',
      failed: true,
    });
  });

  it('AC2: a new method version never changes stored results until deliberately recalculated', async () => {
    const before = await line(0, 7);
    // A later method version becomes current (test-only row; no calculator ships for it).
    const client = await h.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO concrete_calculation_method (method, version, name, provisional, source)
         VALUES ('compressive_strength', 'T2', 'Test-only method', true, 'integration test')`,
      );
      await client.query(
        `UPDATE concrete_calculation_method SET is_current = false WHERE version = 'P1'`,
      );
      await client.query(
        `UPDATE concrete_calculation_method SET is_current = true WHERE version = 'T2'`,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    try {
      // Stored results read the same.
      expect(await line(0, 7)).toEqual(before);
      // A correction recalculates with the result's own version (P1), not the current one.
      const corrected = await enter(0, 'A', { maxLoad: 95 }, 'Load misread');
      expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
      const result = concreteTestResultSaveResultSchema.parse(corrected.body).result;
      // 95 / 7.85398 = 12.10 → 12.1.
      expect(result.calculation).toMatchObject({ methodVersion: 'P1', strength: 12.1 });
      // A new attempt takes the current version, which has no calculator yet: refused.
      const fresh = await enter(3, 'A', cylinder('2026-10-13', 200));
      expect(fresh.status).toBe(409);
      expect(fresh.body.code).toBe('calculation_method_unavailable');

      // Deliberate recalculation with history.
      const { rows } = await h.db.pool.query<{ display_name: string; official_initials: string }>(
        'SELECT display_name, official_initials FROM app_user WHERE id = $1',
        [h.users.lm],
      );
      const lm: AuthUser = {
        userId: h.users.lm,
        sessionId: 'test',
        accountType: 'personal',
        status: 'active',
        roles: ['lab_manager'],
        displayName: rows[0]!.display_name,
        initials: rows[0]!.official_initials,
      };
      const t2 = (input: ConcreteStrengthInputs) => {
        const p1 = concreteStrengthP1(input)!;
        return { ...p1, strengthRaw: p1.strengthRaw! * 0.9, strength: 14.3 };
      };
      const recalculated = await h.app
        .get(ConcreteTestResultsService)
        .recalculate(
          resultIds.get('0A')!,
          { toVersion: 'T2', reason: 'Worksheet method adopted', idempotencyKey: newKey() },
          lm,
          actorFor(lm),
          null,
          { T2: t2 },
        );
      expect(recalculated).toMatchObject({
        calculationMethodVersion: 'T2',
        calculation: { methodVersion: 'T2', strength: 14.3 },
      });
      const last = recalculated.revisions.at(-1)!;
      expect(last).toMatchObject({ kind: 'recalculation', reason: 'Worksheet method adopted' });
      expect(last.changes.calculation).toMatchObject({
        before: { methodVersion: 'P1', strength: 12.1 },
        after: { methodVersion: 'T2', strength: 14.3 },
      });
      // The readings are untouched.
      expect(recalculated.maxLoad).toBe(95);
      // Other results keep P1.
      expect((await line(0, 28)).methodVersions).toEqual(['P1']);
    } finally {
      const restore = await h.db.pool.connect();
      try {
        await restore.query('BEGIN');
        await restore.query(
          `UPDATE concrete_calculation_method SET is_current = false WHERE version = 'T2'`,
        );
        await restore.query(
          `UPDATE concrete_calculation_method SET is_current = true WHERE version = 'P1'`,
        );
        await restore.query('COMMIT');
      } finally {
        restore.release();
      }
    }
  });
});
