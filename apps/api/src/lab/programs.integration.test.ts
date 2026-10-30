import {
  labProgramListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  labSourceListSchema,
  type LabProgram,
  type LabProgramReview,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG } from '../test-support/fixtures.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  line,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-T23 testing programs: scope freezing (AC1/AC2), sources, G/S unknowns, sample identity
// (AC3), retirement history (AC4), LAB attribution (AC5, AC8), link checker (AC6), concurrency
// and idempotency (AC9). Real PostgreSQL; fictional data only.
describe.runIf(testDatabaseUrl)('lab programs API (MM-T23)', () => {
  let h: LabHarness;
  let moisture: string;
  let atterberg: string;

  type As = PersonKey | 'lab' | string;

  async function createDraft(as: As, lines: unknown[], extra: Record<string, unknown> = {}) {
    const response = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects.a, idempotencyKey: newKey(), lines, ...extra },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return labProgramSchema.parse(response.body);
  }

  async function review(id: string, as: As = 'tech'): Promise<LabProgramReview> {
    const response = await h.get(`/api/lab-programs/${id}/review`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return labProgramReviewSchema.parse(response.body);
  }

  function coverageOf(r: LabProgramReview) {
    return r.lines.map((l) => ({
      lineId: l.lineId,
      unitIds: l.coverage.map((c) => c.storageUnitId),
    }));
  }

  async function submit(program: LabProgram, as: As = 'tech', extra: Record<string, unknown> = {}) {
    const r = await review(program.id, as);
    return h.send(
      'post',
      `/api/lab-programs/${program.id}/submit`,
      { version: program.version, idempotencyKey: newKey(), coverage: coverageOf(r), ...extra },
      as,
    );
  }

  async function submitted(lines: unknown[], as: As = 'tech', extra: Record<string, unknown> = {}) {
    const draft = await createDraft(as, lines, extra);
    const response = await submit(draft, as, extra);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return labProgramSchema.parse(response.body);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (
      await h.testType(
        'DEMO-MC',
        'Moisture content of soil (fictional demo entry)',
        'Moisture Content',
      )
    ).id;
    atterberg = (
      await h.testType('DEMO_ATT-LL', 'Atterberg limits, liquid and plastic limit (fictional)')
    ).id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('AC1/AC2 (T3): ALL freezes exactly the units received at submission; later receipts never join', async () => {
    const hole = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-11') RETURNING id`,
        [h.projects.a],
      )
    ).rows[0]!.id;
    const u14 = await h.bucket({
      hole,
      summary: { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
    });
    const u15 = await h.bucket({ hole });
    const draft = await createDraft('tech', [
      line({ kind: 'test_hole', id: hole }, 'all', [moisture]),
    ]);

    const before = await review(draft.id);
    expect(before.ready).toBe(true);
    expect(before.lines[0]!.coverage.map((c) => c.readableId)).toEqual([
      u14.readableId,
      u15.readableId,
    ]);
    expect(before.lines[0]!.coverage[0]).toMatchObject({
      included: true,
      matchingBasis: 'hole_summary',
      contents: 'TH26-11: G1–S12',
      receiptId: u14.receiptId,
    });

    const response = await submit(draft);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const program = labProgramSchema.parse(response.body);
    expect(program).toMatchObject({ status: 'submitted', priority: 'normal' });
    expect(program.programNumber).toMatch(/^LP-\d{4}-\d{4}$/);
    expect(program.lines[0]!.requests).toMatchObject([
      { code: 'DEMO-MC', name: 'Moisture Content', status: 'requested' },
    ]);
    expect(program.lines[0]!.coverage.map((c) => c.readableId)).toEqual([
      u14.readableId,
      u15.readableId,
    ]);
    expect(program.lines[0]!.source).toMatchObject({ kind: 'test_hole', label: 'TH26-11' });

    // AC2: a third bucket arrives after submission.
    await h.bucket({ hole });
    const later = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}`, 'tech')).body,
    );
    expect(later.lines[0]!.coverage.map((c) => c.readableId)).toEqual([
      u14.readableId,
      u15.readableId,
    ]);
    const { rows } = await h.db.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM program_scope_snapshot WHERE program_id = $1',
      [program.id],
    );
    expect(rows[0]!.count).toBe(2);
  });

  it('refuses to freeze coverage nobody reviewed: a receipt between review and submit → 409 coverage_changed', async () => {
    const hole = h.holes.a2;
    await h.bucket({ hole });
    const draft = await createDraft('tech', [
      line({ kind: 'test_hole', id: hole }, 'all', [moisture]),
    ]);
    const seen = await review(draft.id);
    await h.bucket({ hole });
    const response = await h.send(
      'post',
      `/api/lab-programs/${draft.id}/submit`,
      { version: draft.version, idempotencyKey: newKey(), coverage: coverageOf(seen) },
      'tech',
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('coverage_changed');
    expect(response.body.review.lines[0].coverage).toHaveLength(seen.lines[0]!.coverage.length + 1);
    const again = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${draft.id}`, 'tech')).body,
    );
    expect(again.status).toBe('draft');
  });

  it('Grabs/SPT: every unit is G/S-unknown; only reviewed inclusions are covered and exclusions are frozen too', async () => {
    const hole = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-12') RETURNING id`,
        [h.projects.a],
      )
    ).rows[0]!.id;
    // A G-only sample range is still not a structured classification.
    const gOnly = await h.bucket({
      hole,
      summary: { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'G5' },
    });
    const other = await h.bucket({ hole, summary: { type: 'all' } });
    const tube = await h.tube({ holeId: hole, sampleReference: 'S3' });

    const draft = await createDraft('tech', [
      line({ kind: 'test_hole', id: hole }, 'grabs', [moisture], { unitIds: [gOnly.id] }),
    ]);
    const r = await review(draft.id);
    expect(r.lines[0]!.unknownClassificationCount).toBe(3);
    expect(r.lines[0]!.coverage.map((c) => [c.readableId, c.included, c.matchingBasis])).toEqual([
      [gOnly.readableId, true, 'reviewed_included'],
      [other.readableId, false, 'unknown_classification_excluded'],
      [tube.readableId, false, 'unknown_classification_excluded'],
    ]);
    const response = await submit(draft);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const program = labProgramSchema.parse(response.body);
    expect(program.lines[0]!.coverage.filter((c) => c.included).map((c) => c.readableId)).toEqual([
      gOnly.readableId,
    ]);
    expect(program.lines[0]!.coverage).toHaveLength(3);
  });

  it('standalone sources: equal free text stays two sources, ALL covers only the chosen tube, no hole is fabricated', async () => {
    const holesBefore = (await h.db.pool.query('SELECT id FROM test_hole')).rowCount;
    const t1 = await h.tube({ location: 'Embankment Location 03', sampleReference: 'T5' });
    const t2 = await h.tube({ location: 'Embankment Location 03', sampleReference: 'T6' });
    const group = await h.bulkGroup({
      location: 'Embankment Location 03',
      sampleReference: 'B1',
      depthFrom: 1.5,
      buckets: 2,
    });

    const sources = labSourceListSchema.parse(
      (await h.get(`/api/projects/${h.projects.a}/lab-sources`, 'lab')).body,
    );
    const standalone = sources.filter((s) => s.kind !== 'test_hole');
    expect(standalone.map((s) => s.id)).toEqual(
      expect.arrayContaining([t1.id, t2.id, group.groupId]),
    );
    expect(standalone.find((s) => s.id === t1.id)!.label).toBe(
      `Embankment Location 03: T5 · ${t1.readableId} (Shelby tube)`,
    );
    expect(standalone.find((s) => s.id === group.groupId)!.label).toBe(
      'Embankment Location 03: B1 at 1.5 m (bulk sample)',
    );

    const program = await submitted([
      line({ kind: 'standalone_unit', id: t1.id }, 'all', [moisture]),
      line({ kind: 'standalone_bulk_group', id: group.groupId }, 'all', [moisture]),
    ]);
    expect(program.lines[0]!.coverage.map((c) => [c.readableId, c.matchingBasis])).toEqual([
      [t1.readableId, 'standalone_unit'],
    ]);
    expect(program.lines[1]!.coverage.map((c) => c.readableId)).toEqual(
      group.members.map((m) => m.readableId),
    );
    // A bucket joining the group later doesn't extend the frozen line.
    await h.joinGroup(group.groupId);
    const later = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}`, 'tech')).body,
    );
    expect(later.lines[1]!.coverage).toHaveLength(2);
    expect((await h.db.pool.query('SELECT id FROM test_hole')).rowCount).toBe(holesBefore);
  });

  it('rejects wrong-project and wrong-kind sources and units that are not from the source (422)', async () => {
    const otherProjectHole = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: h.holes.b1 }, 'all', [moisture])],
      },
      'tech',
    );
    expect(otherProjectHole.status).toBe(422);
    expect(otherProjectHole.body.code).toBe('source_not_in_project');

    // A tube with a test-hole source isn't a standalone source.
    const holeTube = await h.tube({ holeId: h.holes.a1 });
    const wrongKind = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'standalone_unit', id: holeTube.id }, 'all', [moisture])],
      },
      'tech',
    );
    expect(wrongKind.status).toBe(422);

    const elsewhere = await h.bucket({ hole: h.holes.a2 });
    const stray = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [
          line({ kind: 'test_hole', id: h.holes.a1 }, 'specific', [atterberg], {
            sampleLabel: 'G3',
            depthMode: 'point',
            depthFrom: 7.5,
            depthUnit: 'ft',
            unitIds: [elsewhere.id],
          }),
        ],
      },
      'tech',
    );
    expect(stray.status).toBe(422);
    expect(stray.body.code).toBe('unit_not_in_source');
    const { rows } = await h.db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM lab_program WHERE project_id = $1 AND status = 'draft'
       AND created_by_account_user_id = $2 AND NOT EXISTS (SELECT 1 FROM test_line l WHERE l.program_id = lab_program.id)`,
      [h.projects.a, h.users.tech],
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('T2: line validation per scope', async () => {
    const shape = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [
          line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture], { sampleLabel: 'G3' }),
        ],
      },
      'tech',
    );
    expect(shape.status).toBe(400);
    expect(shape.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'lines.0.sampleLabel' })]),
    );

    const draft = await createDraft('tech', [
      line({ kind: 'test_hole', id: h.holes.a1 }, 'specific', [], { sampleLabel: 'G3' }),
      line(null, 'all', [moisture]),
    ]);
    const r = await review(draft.id);
    expect(r.ready).toBe(false);
    expect(r.lines[0]!.problems.map((p) => p.field).sort()).toEqual(
      ['depthFrom', 'depthMode', 'depthUnit', 'testTypeIds'].sort(),
    );
    expect(r.lines[1]!.problems.map((p) => p.field)).toEqual(['source']);
    const response = await submit(draft);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('not_ready');
  });

  it('AC3 (T1): G3 at 7.5 ft and 8 ft in one hole warns until acknowledged; S3 and G3 elsewhere do not', async () => {
    const hole = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-13') RETURNING id`,
        [h.projects.a],
      )
    ).rows[0]!.id;
    const specific = (holeId: string, label: string, depth: number, extra = {}) =>
      line({ kind: 'test_hole', id: holeId }, 'specific', [atterberg], {
        sampleLabel: label,
        depthMode: 'point',
        depthFrom: depth,
        depthUnit: 'ft',
        ...extra,
      });
    await submitted([specific(hole, 'G3', 7.5)]);

    const s3 = await createDraft('tech', [specific(hole, 'S3', 8), specific(h.holes.a2, 'g3', 8)]);
    expect((await review(s3.id)).lines.map((l) => l.discrepancy)).toEqual([null, null]);

    const draft = await createDraft('tech', [specific(hole, 'g3', 8)]);
    const warned = await review(draft.id);
    expect(warned.ready).toBe(false);
    expect(warned.lines[0]!.discrepancy).toMatchObject({
      depths: ['8 ft', '7.5 ft'],
      acknowledged: false,
      others: [{ depth: '7.5 ft', lineNumber: 1 }],
    });
    const acknowledged = await h.send(
      'patch',
      `/api/lab-programs/${draft.id}`,
      {
        version: draft.version,
        lines: [
          { ...specific(hole, 'g3', 8), id: draft.lines[0]!.id, acknowledgedDepths: ['7.5 ft'] },
        ],
      },
      'tech',
    );
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    const after = await review(draft.id);
    expect(after.lines[0]!.discrepancy!.acknowledged).toBe(true);
    expect(after.ready).toBe(true);
  });

  it('AC4 (T4): a retired or edited test leaves submitted requests unchanged and leaves new selection', async () => {
    const test = await h.testType('DEMO-SG', 'Specific gravity of soil solids (fictional)');
    const program = await submitted([
      line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [test.id]),
    ]);
    const edited = await h.send(
      'patch',
      `/api/test-types/${test.id}`,
      { version: test.version, description: 'Renamed description (fictional)' },
      'lm',
    );
    expect(edited.status).toBe(200);
    const retired = await h.send(
      'post',
      `/api/test-types/${test.id}/retire`,
      { version: edited.body.version },
      'lm',
    );
    expect(retired.status).toBe(200);
    expect(retired.body.active).toBe(false);

    const shown = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}`, 'tech')).body,
    );
    expect(shown.lines[0]!.requests[0]).toMatchObject({
      code: 'DEMO-SG',
      description: 'Specific gravity of soil solids (fictional)',
    });
    const newPick = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [test.id])],
      },
      'tech',
    );
    expect(newPick.status).toBe(422);
    expect(newPick.body.code).toBe('retired_tests');
  });

  it('retirement between draft and submission is reported and blocks submission', async () => {
    const test = await h.testType('DEMO-HYD', 'Hydrometer analysis (fictional)');
    const draft = await createDraft('tech', [
      line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [test.id]),
    ]);
    await h.send('post', `/api/test-types/${test.id}/retire`, { version: test.version }, 'lm');
    const r = await review(draft.id);
    expect(r.ready).toBe(false);
    expect(r.lines[0]!.retiredTests.map((t) => t.code)).toEqual(['DEMO-HYD']);
    expect((await submit(draft)).status).toBe(422);
  });

  it('AC5 (T5): LAB needs a valid Requested by on every action and is recorded as LAB for that person', async () => {
    const body = {
      projectId: h.projects.a,
      lines: [line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture])],
    };
    const missing = await h.send(
      'post',
      '/api/lab-programs',
      { ...body, idempotencyKey: newKey() },
      'lab',
    );
    expect(missing.status).toBe(400);
    expect(missing.body.errors[0]).toMatchObject({ field: 'requestedByUserId', code: 'required' });
    for (const invalid of [h.users.lab, h.users.disabled, h.users.noInitials]) {
      const response = await h.send(
        'post',
        '/api/lab-programs',
        { ...body, idempotencyKey: newKey(), requestedByUserId: invalid },
        'lab',
      );
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('requested_by_invalid');
    }

    const draft = await createDraft('lab', body.lines, { requestedByUserId: h.users.js });
    expect(draft.createdBy).toMatchObject({ accountType: 'shared_lab', name: 'LAB' });
    expect(draft.requestedBy).toMatchObject({
      userId: h.users.js,
      initials: 'JS',
      name: 'Jordan Smith',
    });

    // Editing without the person is refused; submitting needs the same person the draft names.
    const edit = await h.send(
      'patch',
      `/api/lab-programs/${draft.id}`,
      { version: draft.version, notes: 'x' },
      'lab',
    );
    expect(edit.status).toBe(400);
    const mismatch = await submit(draft, 'lab', { requestedByUserId: h.users.jo });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('requested_by_mismatch');

    const response = await submit(draft, 'lab', { requestedByUserId: h.users.js });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const program = labProgramSchema.parse(response.body);
    expect(program.submittedBy).toMatchObject({ accountType: 'shared_lab', userId: h.users.lab });
    expect(program.submittedFor).toMatchObject({ userId: h.users.js, initials: 'JS' });
    const { rows } = await h.db.pool.query(
      `SELECT action, actor_user_id, actor_account_type, receiver_user_id, receiver_initials_snapshot,
              before_values::text AS before, after_values::text AS after
       FROM audit_event WHERE entity_id = $1 OR (action = 'test_request.created' AND after_values->>'programNumber' = $2)
       ORDER BY occurred_at, id`,
      [program.id, program.programNumber],
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      'lab_program.created',
      'lab_program.submitted',
      'test_request.created',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_user_id: h.users.lab,
        actor_account_type: 'shared_lab',
        receiver_user_id: h.users.js,
        receiver_initials_snapshot: 'JS',
      });
      expect(`${row.before}${row.after}`).not.toMatch(/session|token|cookie/i);
    }

    // LAB never administers the catalogue, whoever it selects.
    const admin = await h.send(
      'post',
      '/api/test-types',
      {
        groupId: '00000000-0000-4000-8000-00000000c101',
        code: 'X',
        description: 'x',
        requestedByUserId: h.users.lm,
      },
      'lab',
    );
    expect(admin.status).toBe(403);

    // A personal account is its own requester and can't name someone else.
    const personal = await h.send(
      'post',
      '/api/lab-programs',
      { ...body, idempotencyKey: newKey(), requestedByUserId: h.users.js },
      'tech',
    );
    expect(personal.status).toBe(400);
  });

  it('AC8 (T7): two LAB stations keep separate drafts, people and submissions; signing out one leaves the other', async () => {
    const stationA = await h.cookie('lab');
    const stationB = await h.cookie('lab');
    const lines = [line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture])];
    const [a, b] = await Promise.all([
      createDraft(stationA, lines, { requestedByUserId: h.users.js }),
      createDraft(stationB, lines, { requestedByUserId: h.users.jo }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(a.requestedBy.userId).toBe(h.users.js);
    expect(b.requestedBy.userId).toBe(h.users.jo);

    const signOut = await h
      .http()
      .post('/api/auth/sign-out')
      .set('Cookie', stationA)
      .set('x-materialmule-csrf', '1');
    expect(signOut.status).toBeLessThan(300);
    expect((await h.get(`/api/lab-programs/${a.id}`, stationA)).status).toBe(401);

    const response = await submit(b, stationB, { requestedByUserId: h.users.jo });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.submittedFor.userId).toBe(h.users.jo);
    const stillA = labProgramSchema.parse((await h.get(`/api/lab-programs/${a.id}`, 'lab')).body);
    expect(stillA).toMatchObject({ status: 'draft', requestedBy: { userId: h.users.js } });

    // A personal account doesn't see LAB's drafts.
    expect((await h.get(`/api/lab-programs/${a.id}`, 'tech')).status).toBe(404);
  });

  it('AC9 (T8): stale edits conflict with the current draft; racing and retried submissions make one program', async () => {
    const draft = await createDraft('tech', [
      line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture]),
    ]);
    const first = await h.send(
      'patch',
      `/api/lab-programs/${draft.id}`,
      { version: draft.version, notes: 'first' },
      'tech',
    );
    expect(first.status).toBe(200);
    const stale = await h.send(
      'patch',
      `/api/lab-programs/${draft.id}`,
      { version: draft.version, notes: 'stale' },
      'tech',
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', current: { notes: 'first' } });

    const current = labProgramSchema.parse(first.body);
    const r = await review(current.id);
    const bodyFor = (idempotencyKey: string) => ({
      version: current.version,
      idempotencyKey,
      coverage: coverageOf(r),
    });
    const keys = [newKey(), newKey()];
    const raced = await Promise.all(
      keys.map((key) =>
        h.send('post', `/api/lab-programs/${current.id}/submit`, bodyFor(key), 'tech'),
      ),
    );
    expect(raced.map((x) => x.status).sort()).toEqual([200, 409]);
    const winner = raced.find((x) => x.status === 200)!;
    const loser = raced.find((x) => x.status === 409)!;
    expect(loser.body).toMatchObject({ code: 'not_draft', current: { status: 'submitted' } });

    const requests = async () =>
      (
        await h.db.pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM test_request WHERE program_id = $1',
          [current.id],
        )
      ).rows[0]!.count;
    expect(await requests()).toBe(1);
    // The response was "lost": the same key returns the original program, a new key is refused.
    const { rows: committed } = await h.db.pool.query<{ submit_idempotency_key: string }>(
      'SELECT submit_idempotency_key FROM lab_program WHERE id = $1',
      [current.id],
    );
    const winningKey = committed[0]!.submit_idempotency_key;
    expect(keys).toContain(winningKey);
    const retry = await h.send(
      'post',
      `/api/lab-programs/${current.id}/submit`,
      bodyFor(winningKey),
      'tech',
    );
    expect(retry.status).toBe(200);
    expect(retry.body.programNumber).toBe(winner.body.programNumber);
    const otherKey = keys.find((key) => key !== winningKey)!;
    expect(
      (await h.send('post', `/api/lab-programs/${current.id}/submit`, bodyFor(otherKey), 'tech'))
        .status,
    ).toBe(409);
    expect(await requests()).toBe(1);
    const events = await h.db.pool.query(
      `SELECT 1 FROM audit_event WHERE action = 'lab_program.submitted' AND entity_id = $1`,
      [current.id],
    );
    expect(events.rowCount).toBe(1);

    // A retried create returns the original draft instead of a second one.
    const createKey = newKey();
    const createBody = { projectId: h.projects.a, idempotencyKey: createKey, lines: [] };
    const made = await h.send('post', '/api/lab-programs', createBody, 'tech');
    const replay = await h.send('post', '/api/lab-programs', createBody, 'tech');
    expect([made.status, replay.status]).toEqual([201, 200]);
    expect(replay.body.id).toBe(made.body.id);
    const reused = await h.send('post', '/api/lab-programs', createBody, 'pe');
    expect(reused.status).toBe(409);
  });

  it('AC6: a project correction of a unit referenced by a submitted program is blocked with the program listed', async () => {
    const unit = await h.bucket({ hole: h.holes.a1 });
    const program = await submitted([
      line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture]),
    ]);
    const detail = await h.get(`/api/storage-units/${unit.id}`, 'tech');
    const response = await h.send(
      'patch',
      `/api/storage-units/${unit.id}`,
      {
        version: detail.body.version,
        reason: 'received under the wrong project',
        changes: {
          projectId: h.projects.b,
          holeSummaries: [{ testHoleId: h.holes.b1, type: 'all' }],
        },
      },
      'tech',
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('unresolved_lab_links');
    expect(response.body.links).toContainEqual({
      id: program.id,
      label: program.programNumber,
      status: 'submitted',
    });
  });

  it('database: frozen coverage, requests and submitted lines cannot be changed', async () => {
    const program = await submitted([
      line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture]),
    ]);
    const attempts = [
      `UPDATE program_scope_snapshot SET included = false WHERE program_id = '${program.id}'`,
      `DELETE FROM program_scope_snapshot WHERE program_id = '${program.id}'`,
      `UPDATE test_request SET test_code_snapshot = 'X' WHERE program_id = '${program.id}'`,
      `UPDATE test_line SET scope = 'spt' WHERE program_id = '${program.id}'`,
      `UPDATE lab_program SET status = 'draft' WHERE id = '${program.id}'`,
      `DELETE FROM test_type WHERE id = '${moisture}'`,
    ];
    for (const sql of attempts) {
      await expect(h.db.pool.query(sql), sql).rejects.toMatchObject({ code: PG.restrictViolation });
    }
  });
});

describe.runIf(testDatabaseUrl)('lab program list paging (BUG-002)', () => {
  let h: LabHarness;

  beforeAll(async () => {
    h = await createLabHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('a page past the end still reports the real total, so the client can step back', async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await h.send(
        'post',
        '/api/lab-programs',
        { projectId: h.projects.a, idempotencyKey: newKey(), lines: [] },
        'tech',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    const first = labProgramListSchema.parse((await h.get('/api/lab-programs', 'tech')).body);
    expect(first.total).toBe(2);
    expect(first.items).toHaveLength(2);
    const past = labProgramListSchema.parse((await h.get('/api/lab-programs?page=3', 'tech')).body);
    expect(past).toEqual({ total: 2, items: [] });
    // Drafts stay private past the end too.
    const other = labProgramListSchema.parse((await h.get('/api/lab-programs?page=3', 'pe')).body);
    expect(other).toEqual({ total: 0, items: [] });
  });
});
