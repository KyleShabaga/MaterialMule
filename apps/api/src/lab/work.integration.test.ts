import {
  labCommentSchema,
  labProgramSchema,
  labProgramReviewSchema,
  programWorkSchema,
  worklistSchema,
  type LabProgram,
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
import { completedTestEvidence } from './work.service.js';

// MM-T24 worklist, progress, priority, comments and exact tested-unit evidence. Real PostgreSQL,
// fictional data only.
describe.runIf(testDatabaseUrl)('lab work API (MM-T24)', () => {
  let h: LabHarness;
  let moisture: string;
  let atterberg: string;
  type As = PersonKey | 'lab' | string;

  /** A submitted program (by `as`) on a fresh hole with `buckets` ordinary buckets. */
  async function submitted(
    options: { as?: As; tests?: string[]; holeId?: string; person?: string } = {},
  ): Promise<LabProgram> {
    const as = options.as ?? 'tech';
    const holeId =
      options.holeId ??
      (
        await h.db.pool.query<{ id: string }>(
          `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
          [h.projects.a, `TH-${newKey().slice(0, 8)}`],
        )
      ).rows[0]!.id;
    if (!options.holeId) await h.bucket({ hole: holeId });
    const person = options.person ? { requestedByUserId: options.person } : {};
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', options.tests ?? [moisture])],
        ...person,
      },
      as,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.body.id}/review`, as)).body,
    );
    const response = await h.send(
      'post',
      `/api/lab-programs/${created.body.id}/submit`,
      {
        version: created.body.version,
        idempotencyKey: newKey(),
        coverage: review.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
        ...person,
      },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return labProgramSchema.parse(response.body);
  }

  const status = (requestId: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send(
      'post',
      `/api/test-requests/${requestId}/status`,
      { idempotencyKey: newKey(), ...body },
      as,
    );

  async function historyCount(requestId: string) {
    const { rows } = await h.db.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM test_request_status_history WHERE test_request_id = $1',
      [requestId],
    );
    return rows[0]!.count;
  }

  async function work(programId: string, as: As = 'tech') {
    return programWorkSchema.parse((await h.get(`/api/lab-programs/${programId}/work`, as)).body);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)', 'Moisture Content')).id;
    atterberg = (await h.testType('DEMO-ATT', 'Atterberg limits (fictional)')).id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('AC1/AC3/AC6: Urgent first, then oldest; programs start Normal; priority changes no status', async () => {
    const first = await submitted();
    const second = await submitted();
    const third = await submitted();
    expect([first, second, third].map((p) => p.priority)).toEqual(['normal', 'normal', 'normal']);
    const before = await work(third.id);

    const urgent = await h.send(
      'patch',
      `/api/lab-programs/${third.id}/priority`,
      { priority: 'urgent', version: third.version, idempotencyKey: newKey() },
      'pe',
    );
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(200);

    const list = worklistSchema.parse((await h.get('/api/worklist', 'lab')).body);
    const ours = list.items.filter((item) =>
      [first.id, second.id, third.id].includes(item.programId),
    );
    expect(ours.map((item) => item.programId)).toEqual([third.id, first.id, second.id]);
    expect(ours[0]).toMatchObject({ priority: 'urgent', counts: { requested: 1 }, openCount: 1 });
    expect((await work(third.id)).requests).toEqual(before.requests);
  });

  it('AC2 (T3): Technician and LAB get 403 on priority; PM/PE and Lab Manager succeed with history', async () => {
    const program = await submitted();
    for (const as of ['tech', 'lab'] as const) {
      const refused = await h.send(
        'patch',
        `/api/lab-programs/${program.id}/priority`,
        { priority: 'urgent', version: program.version, idempotencyKey: newKey() },
        as,
      );
      expect(refused.status, as).toBe(403);
    }
    const byPe = await h.send(
      'patch',
      `/api/lab-programs/${program.id}/priority`,
      { priority: 'urgent', version: program.version, idempotencyKey: newKey() },
      'pe',
    );
    expect(byPe.status).toBe(200);
    const byLm = await h.send(
      'patch',
      `/api/lab-programs/${program.id}/priority`,
      { priority: 'normal', version: byPe.body.version, idempotencyKey: newKey() },
      'lm',
    );
    expect(byLm.status).toBe(200);
    const history = (await work(program.id)).priorityHistory;
    expect(history.map((e) => [e.fromPriority, e.toPriority, e.person.name])).toEqual([
      ['normal', 'urgent', 'Pat Example'],
      ['urgent', 'normal', 'Lee Manager'],
    ]);
    // Stale version and same-key retry.
    const stale = await h.send(
      'patch',
      `/api/lab-programs/${program.id}/priority`,
      { priority: 'urgent', version: program.version, idempotencyKey: newKey() },
      'lm',
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('AC4/AC5/AC13 (T4, T10): independent statuses, ordered path, illegal jumps 422 with no history', async () => {
    const program = await submitted({ tests: [moisture, atterberg] });
    const [mc, att] = program.lines[0]!.requests;
    for (const to of ['completed', 'review', 'accepted']) {
      const jump = await status(mc!.id, { to, version: mc!.version });
      expect(jump.status, to).toBe(422);
      expect(jump.body.code).toBe('invalid_transition');
    }
    expect(await historyCount(mc!.id)).toBe(0);
    // LAB is refused acceptance outright, whoever it selects.
    const labAccept = await status(
      mc!.id,
      { to: 'accepted', version: mc!.version, actingStaffUserId: h.users.pe },
      'lab',
    );
    expect(labAccept.status).toBe(403);

    const started = await status(mc!.id, { to: 'in_progress', version: 1 });
    expect(started.body).toMatchObject({ status: 'in_progress', version: 2 });
    const completed = await status(mc!.id, { to: 'completed', version: 2 });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const sent = await status(mc!.id, { to: 'review', version: 3 });
    expect(sent.body).toMatchObject({ status: 'review' });
    const after = await work(program.id);
    expect(after.requests.find((r) => r.testRequestId === att!.id)!.status).toBe('requested');
    expect(after.statusHistory.map((e) => [e.fromStatus, e.toStatus, e.person.name])).toEqual([
      ['requested', 'in_progress', 'Alex Tester'],
      ['in_progress', 'completed', 'Alex Tester'],
      ['completed', 'review', 'Alex Tester'],
    ]);
    const beyond = await status(mc!.id, { to: 'review', version: 4 });
    expect(beyond.status).toBe(422);
  });

  it('AC7/AC9 (T6, T8): LAB stations act for different people on different tests; no person, no action', async () => {
    const program = await submitted({ tests: [moisture, atterberg] });
    const [x, y] = program.lines[0]!.requests;
    const missing = await status(x!.id, { to: 'in_progress', version: 1 }, 'lab');
    expect(missing.status).toBe(400);
    const comment = await h.send(
      'post',
      `/api/lab-programs/${program.id}/comments`,
      { body: 'No person', idempotencyKey: newKey() },
      'lab',
    );
    expect(comment.status).toBe(400);

    const [stationA, stationB] = [await h.cookie('lab'), await h.cookie('lab')];
    await status(y!.id, { to: 'in_progress', version: 1, actingStaffUserId: h.users.jo }, stationB);
    const results = await Promise.all([
      status(x!.id, { to: 'in_progress', version: 1, actingStaffUserId: h.users.js }, stationA),
      status(y!.id, { to: 'completed', version: 2, actingStaffUserId: h.users.jo }, stationB),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const events = (await work(program.id)).statusHistory;
    const byRequest = (id: string) =>
      events
        .filter((e) => e.testRequestId === id)
        .map((e) => [e.toStatus, e.account.accountType, e.person.initials]);
    expect(byRequest(x!.id)).toEqual([['in_progress', 'shared_lab', 'JS']]);
    expect(byRequest(y!.id)).toEqual([
      ['in_progress', 'shared_lab', 'JSO'],
      ['completed', 'shared_lab', 'JSO'],
    ]);
    const audit = await h.db.pool.query(
      `SELECT actor_account_type, receiver_initials_snapshot FROM audit_event
       WHERE action = 'test_request.status_changed' AND entity_id = $1`,
      [x!.id],
    );
    expect(audit.rows).toEqual([
      { actor_account_type: 'shared_lab', receiver_initials_snapshot: 'JS' },
    ]);
  });

  it('AC8/AC16 (T7, T14): racing same-version updates commit once; exact retries replay; reused keys refused', async () => {
    const program = await submitted();
    const request = program.lines[0]!.requests[0]!;
    const raced = await Promise.all([
      status(
        request.id,
        { to: 'in_progress', version: 1, actingStaffUserId: h.users.js },
        await h.cookie('lab'),
      ),
      status(
        request.id,
        { to: 'in_progress', version: 1, actingStaffUserId: h.users.jo },
        await h.cookie('lab'),
      ),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await historyCount(request.id)).toBe(1);

    const key = newKey();
    const body = { to: 'completed', version: 2, idempotencyKey: key };
    const first = await h.send('post', `/api/test-requests/${request.id}/status`, body, 'tech');
    const retry = await h.send('post', `/api/test-requests/${request.id}/status`, body, 'tech');
    expect([first.status, retry.status]).toEqual([200, 200]);
    expect(retry.body).toEqual(first.body);
    expect(await historyCount(request.id)).toBe(2);
    const reused = await h.send(
      'post',
      `/api/test-requests/${request.id}/status`,
      { ...body, to: 'review', version: 3 },
      'tech',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');
    const stale = await status(request.id, { to: 'review', version: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'version_conflict',
      current: { status: 'completed', version: 3 },
    });

    // Priority and comment retries don't duplicate either.
    const priorityKey = newKey();
    const priorityBody = {
      priority: 'urgent',
      version: program.version,
      idempotencyKey: priorityKey,
    };
    const p1 = await h.send(
      'patch',
      `/api/lab-programs/${program.id}/priority`,
      priorityBody,
      'lm',
    );
    const p2 = await h.send(
      'patch',
      `/api/lab-programs/${program.id}/priority`,
      priorityBody,
      'lm',
    );
    expect([p1.status, p2.status]).toEqual([200, 200]);
    expect((await work(program.id)).priorityHistory).toHaveLength(1);
    const commentKey = newKey();
    const c1 = await h.send(
      'post',
      `/api/lab-programs/${program.id}/comments`,
      { body: 'Bag torn', idempotencyKey: commentKey },
      'tech',
    );
    const c2 = await h.send(
      'post',
      `/api/lab-programs/${program.id}/comments`,
      { body: 'Bag torn', idempotencyKey: commentKey },
      'tech',
    );
    expect(c2.body.id).toBe(c1.body.id);
    const c3 = await h.send(
      'post',
      `/api/lab-programs/${program.id}/comments`,
      { body: 'Different', idempotencyKey: commentKey },
      'tech',
    );
    expect(c3.status).toBe(409);
    expect((await work(program.id)).comments).toHaveLength(1);
  });

  it('AC12/AC14 (T11): completion links exactly the tube used; its sibling is not tested and nothing is disposed', async () => {
    const hole = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-41') RETURNING id`,
        [h.projects.a],
      )
    ).rows[0]!.id;
    const tubeA = await h.tube({ holeId: hole, sampleReference: 'T5' });
    const tubeB = await h.tube({ holeId: hole, sampleReference: 'T6' });
    const elsewhere = await h.tube({ holeId: h.holes.a2 });
    const otherProject = await h.tube({ project: 'b', holeId: h.holes.b1 });
    const program = await submitted({ holeId: hole });
    const request = program.lines[0]!.requests[0]!;
    await status(request.id, { to: 'in_progress', version: 1 });

    const unnamed = await status(request.id, { to: 'completed', version: 2 });
    expect(unnamed.status).toBe(422);
    expect(unnamed.body.code).toBe('tested_units_required');
    for (const bad of [elsewhere.id, otherProject.id]) {
      const response = await status(request.id, {
        to: 'completed',
        version: 2,
        testedStorageUnitIds: [bad],
      });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('unit_not_covered');
    }
    await h.db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [tubeB.id]);
    const disposed = await status(request.id, {
      to: 'completed',
      version: 2,
      testedStorageUnitIds: [tubeB.id],
    });
    expect(disposed.body.code).toBe('unit_disposed');
    await h.db.pool.query(`UPDATE storage_unit SET status = 'in_stock' WHERE id = $1`, [tubeB.id]);
    expect(await historyCount(request.id)).toBe(1);

    const locationBefore = await h.db.pool.query(
      'SELECT id, status, current_location_id, version FROM storage_unit WHERE id = ANY ($1::uuid[]) ORDER BY id',
      [[tubeA.id, tubeB.id]],
    );
    const done = await status(
      request.id,
      {
        to: 'completed',
        version: 2,
        testedStorageUnitIds: [tubeA.id],
        actingStaffUserId: h.users.js,
      },
      'lab',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const tested = (await work(program.id)).testedUnits;
    expect(tested.map((t) => t.readableId)).toEqual([tubeA.readableId]);
    expect((await completedTestEvidence(h.db.pool, tubeA.id)).map((e) => e.test_code)).toEqual([
      'DEMO-MC',
    ]);
    expect(await completedTestEvidence(h.db.pool, tubeB.id)).toEqual([]);
    // Completion alone changes no unit (removal is MM-T36's separate personal action).
    const locationAfter = await h.db.pool.query(
      'SELECT id, status, current_location_id, version FROM storage_unit WHERE id = ANY ($1::uuid[]) ORDER BY id',
      [[tubeA.id, tubeB.id]],
    );
    expect(locationAfter.rows).toEqual(locationBefore.rows);
    await expect(
      h.db.pool.query('DELETE FROM test_request_unit_link WHERE storage_unit_id = $1', [tubeA.id]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('bulk amendment: two buckets of one bulk sample — only the linked bucket has evidence', async () => {
    const hole = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-42') RETURNING id`,
        [h.projects.a],
      )
    ).rows[0]!.id;
    const group = await h.bulkGroup({
      holeId: hole,
      sampleReference: 'B1',
      depthFrom: 1.5,
      buckets: 2,
    });
    const program = await submitted({ holeId: hole });
    const request = program.lines[0]!.requests[0]!;
    expect((await work(program.id)).requests[0]!.needsTestedUnits).toBe(true);
    await status(request.id, { to: 'in_progress', version: 1 });
    const [a, b] = group.members;
    const done = await status(request.id, {
      to: 'completed',
      version: 2,
      testedStorageUnitIds: [a!.id],
    });
    expect(done.status).toBe(200);
    expect(await completedTestEvidence(h.db.pool, a!.id)).toHaveLength(1);
    expect(await completedTestEvidence(h.db.pool, b!.id)).toEqual([]);
  });

  it('AC15 (T13): only the attributed author edits, within 15 minutes; every revision is kept', async () => {
    const program = await submitted();
    const lineId = program.lines[0]!.id;
    const created = await h.send(
      'post',
      `/api/lab-programs/${program.id}/comments`,
      {
        lineId,
        body: 'Sample wet on arrival',
        idempotencyKey: newKey(),
        actingStaffUserId: h.users.js,
      },
      'lab',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const comment = labCommentSchema.parse(created.body);
    expect(comment).toMatchObject({
      lineId,
      author: { initials: 'JS' },
      account: { accountType: 'shared_lab' },
    });

    const otherOperator = await h.send(
      'patch',
      `/api/comments/${comment.id}`,
      { body: 'Hijack', version: 1, idempotencyKey: newKey(), actingStaffUserId: h.users.jo },
      'lab',
    );
    expect(otherOperator.status).toBe(403);
    const otherPerson = await h.send(
      'patch',
      `/api/comments/${comment.id}`,
      { body: 'Hijack', version: 1, idempotencyKey: newKey() },
      'tech',
    );
    expect(otherPerson.status).toBe(403);
    const edited = await h.send(
      'patch',
      `/api/comments/${comment.id}`,
      {
        body: 'Sample very wet on arrival',
        version: 1,
        idempotencyKey: newKey(),
        actingStaffUserId: h.users.js,
      },
      'lab',
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const stale = await h.send(
      'patch',
      `/api/comments/${comment.id}`,
      { body: 'Stale', version: 1, idempotencyKey: newKey(), actingStaffUserId: h.users.js },
      'lab',
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(labCommentSchema.parse(edited.body).revisions.map((r) => r.body)).toEqual([
      'Sample wet on arrival',
      'Sample very wet on arrival',
    ]);

    // A comment posted more than 15 minutes ago (server clock) can't be edited.
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO lab_comment (program_id, author_account_user_id, author_account_type,
         author_account_name_snapshot, author_person_user_id, author_person_name_snapshot, body,
         created_at, idempotency_key, request_hash)
       VALUES ($1, $2, 'personal', 'Alex Tester', $2, 'Alex Tester', 'Old note',
               now() - interval '15 minutes 1 second', gen_random_uuid(), 'x') RETURNING id`,
      [program.id, h.users.tech],
    );
    const late = await h.send(
      'patch',
      `/api/comments/${rows[0]!.id}`,
      { body: 'Too late', version: 1, idempotencyKey: newKey() },
      'tech',
    );
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('edit_window_closed');
    await expect(
      h.db.pool.query('DELETE FROM lab_comment WHERE id = $1', [comment.id]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('T16: a person disabled after acting keeps their history but can’t be chosen again', async () => {
    const program = await submitted();
    const request = program.lines[0]!.requests[0]!;
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Temp Person', 'TP', 'personal', 'active') RETURNING id`,
    );
    const temp = rows[0]!.id;
    expect(
      (await status(request.id, { to: 'in_progress', version: 1, actingStaffUserId: temp }, 'lab'))
        .status,
    ).toBe(200);
    await h.db.pool.query(
      `UPDATE app_user SET status = 'disabled', display_name = 'Renamed' WHERE id = $1`,
      [temp],
    );
    const refused = await status(
      request.id,
      { to: 'completed', version: 2, actingStaffUserId: temp },
      'lab',
    );
    expect(refused.status).toBe(422);
    expect((await work(program.id)).statusHistory[0]!.person).toMatchObject({
      name: 'Temp Person',
      initials: 'TP',
    });
  });
});
