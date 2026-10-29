import {
  labProgramReviewSchema,
  labProgramSchema,
  programWorkSchema,
  type LabProgram,
} from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { PG } from '../test-support/fixtures.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { completedTestEvidence } from './work.service.js';

// MM-T26 program lifecycle, cancellation and repeats (card AC1, AC2, AC4–AC6, AC8–AC10, test plan
// T1, T3, T4, T7, T8 and preparation scenarios L01–L16 that belong to this part). Real PostgreSQL;
// races use real connections and row locks, never sleeps. Fictional data only: DEMO-2601 (A),
// whose Lead Project Engineer is Pat Example (`pe`); Lee Manager (`lm`) is the Lab Manager; Jordan Smith (`js`)
// is an acceptance delegate on A; Alex Tester (`tech`) an ordinary Technician; Admin Example
// (`admin`) holds only the admin role.
describe.runIf(testDatabaseUrl)('lab program lifecycle API (MM-T26)', () => {
  let h: LabHarness;
  let moisture: string;
  let sieve: string;
  type As = Parameters<LabHarness['send']>[3];

  /** Submits a program of `lines` on project A as the technician. */
  async function submit(lines: unknown[]): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects.a, idempotencyKey: newKey(), lines },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
    );
    const submitted = await h.send(
      'post',
      `/api/lab-programs/${created.body.id}/submit`,
      {
        version: created.body.version,
        idempotencyKey: newKey(),
        coverage: review.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
      },
      'tech',
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return labProgramSchema.parse(submitted.body);
  }

  /** A submitted program on a fresh hole with one ALL line and `tests` requested. */
  async function program(tests: string[] = [moisture]) {
    const holeId = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects.a, `TH-${newKey().slice(0, 8)}`],
      )
    ).rows[0]!.id;
    const bucket = await h.bucket({ hole: holeId });
    const p = await submit([line({ kind: 'test_hole', id: holeId }, 'all', tests)]);
    return { program: p, holeId, bucket, ids: p.lines[0]!.requests.map((r) => r.id) };
  }

  const status = (id: string, to: string, version: number, as: As = 'tech', extra = {}) =>
    h.send(
      'post',
      `/api/test-requests/${id}/status`,
      { to, version, idempotencyKey: newKey(), ...extra },
      as,
    );
  const review = (id: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send('post', `/api/test-requests/${id}/review`, { idempotencyKey: newKey(), ...body }, as);

  /** Moves a Requested test to `target` and returns its version. */
  async function advance(
    id: string,
    target: 'in_progress' | 'completed' | 'review' | 'returned' | 'review_complete' | 'accepted',
  ): Promise<number> {
    let version = (await row(id)).version;
    const path = ['in_progress', 'completed', 'review'];
    const steps =
      target === 'returned' || target === 'review_complete' || target === 'accepted'
        ? path
        : path.slice(0, path.indexOf(target) + 1);
    for (const to of steps) {
      const moved = await status(id, to, version);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      version = moved.body.version as number;
    }
    if (target === 'returned') {
      version = (await review(id, { action: 'return', comment: 'Recheck', version })).body.version;
    }
    if (target === 'review_complete' || target === 'accepted') {
      version = (await review(id, { action: 'complete', version })).body.version;
    }
    if (target === 'accepted') {
      const accepted = await h.send(
        'post',
        `/api/test-requests/${id}/accept`,
        { version, idempotencyKey: newKey() },
        'pe',
      );
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      version = accepted.body.version as number;
    }
    return version;
  }

  async function row(id: string) {
    const { rows } = await h.db.pool.query<{
      status: string;
      review_state: string | null;
      version: number;
      cancel_reason: string | null;
      repeat_of_id: string | null;
    }>(
      `SELECT status, review_state, version, cancel_reason, repeat_of_id
       FROM test_request WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function programRow(id: string) {
    const { rows } = await h.db.pool.query<{
      status: string;
      version: number;
      closed_by_user_id: string | null;
    }>('SELECT status, version, closed_by_user_id FROM lab_program WHERE id = $1', [id]);
    return rows[0]!;
  }

  const cancel = (id: string, version: number, as: As, reason = 'Client withdrew the test') =>
    h.send(
      'post',
      `/api/test-requests/${id}/cancel`,
      { reason, version, idempotencyKey: newKey() },
      as,
    );
  const close = async (programId: string, as: As, version?: number, key = newKey()) =>
    h.send(
      'post',
      `/api/lab-programs/${programId}/close`,
      { version: version ?? (await programRow(programId)).version, idempotencyKey: key },
      as,
    );
  const reopen = async (programId: string, as: As, reason = 'Repeat needed') =>
    h.send(
      'post',
      `/api/lab-programs/${programId}/reopen`,
      { reason, version: (await programRow(programId)).version, idempotencyKey: newKey() },
      as,
    );
  const repeat = async (id: string, as: As = 'tech', key = newKey()) =>
    h.send(
      'post',
      `/api/test-requests/${id}/repeat`,
      { version: (await row(id)).version, idempotencyKey: key },
      as,
    );

  async function work(programId: string, as: As) {
    return programWorkSchema.parse((await h.get(`/api/lab-programs/${programId}/work`, as)).body);
  }

  async function lifecycleEvents(programId: string) {
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM program_lifecycle_event WHERE program_id = $1',
      [programId],
    );
    return rows[0]!.n;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC26', 'Moisture content (fictional)', 'Moisture')).id;
    sieve = (await h.testType('DEMO-SV26', 'Sieve analysis (fictional)', 'Sieve')).id;
    const granted = await h.send(
      'post',
      `/api/projects/${h.projects.a}/acceptance-delegates`,
      { delegateUserId: h.users.js, idempotencyKey: newKey() },
      'pe',
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('L01/AC1: each unresolved state blocks closure with the exact blockers', async () => {
    const p = await program([moisture, sieve]);
    const [a, b] = p.ids as [string, string];
    for (const target of ['requested', 'in_progress', 'completed', 'review', 'returned'] as const) {
      const fresh = await program([moisture]);
      const id = fresh.ids[0]!;
      if (target !== 'requested') await advance(id, target);
      const refused = await close(fresh.program.id, 'pe');
      expect(refused.status, target).toBe(422);
      expect(refused.body.code).toBe('closure_blocked');
      expect(refused.body.closure.blockers).toEqual([
        expect.objectContaining({
          testRequestId: id,
          reason: target === 'returned' ? 'review' : target,
          ...(target === 'returned' ? { reviewState: 'returned' } : {}),
        }),
      ]);
      expect((await programRow(fresh.program.id)).status).toBe('submitted');
      expect(await lifecycleEvents(fresh.program.id)).toBe(0);
    }
    // Review complete still needs acceptance; one Accepted test doesn't resolve its sibling.
    await advance(a, 'accepted');
    await advance(b, 'review_complete');
    const refused = await close(p.program.id, 'pe');
    expect(refused.status).toBe(422);
    expect(refused.body.closure).toMatchObject({
      eligible: false,
      counts: { review: 1 },
      summary: '1 test still in Review',
    });
    const view = await work(p.program.id, 'pe');
    expect(view.lifecycle).toMatchObject({ canClose: false, closeBlockedReason: 'unresolved' });
  });

  it('L02/L03/AC2/AC8: Lead Project Engineer closes resolved programs; storage units are untouched', async () => {
    const p = await program([moisture, sieve]);
    const [a, b] = p.ids as [string, string];
    await advance(a, 'accepted');
    expect((await cancel(b, (await row(b)).version, 'lm')).status).toBe(200);
    const unitBefore = await h.db.pool.query(
      'SELECT to_jsonb(su) AS u FROM storage_unit su WHERE id = $1',
      [p.bucket.id],
    );

    // Delegate, admin alone, Lab Manager, technician and LAB (with a Lead Project Engineer selected) are refused.
    for (const as of ['js', 'admin', 'lm', 'tech'] as const) {
      expect((await close(p.program.id, as)).status, as).toBe(403);
    }
    const lab = await h.send(
      'post',
      `/api/lab-programs/${p.program.id}/close`,
      {
        version: (await programRow(p.program.id)).version,
        idempotencyKey: newKey(),
        actingStaffUserId: h.users.pe,
      },
      'lab',
    );
    expect(lab.status).toBe(403);

    const view = await work(p.program.id, 'pe');
    expect(view.lifecycle).toMatchObject({
      canClose: true,
      closure: { eligible: true, summary: 'All tests resolved' },
    });
    const key = newKey();
    const closed = await close(p.program.id, 'pe', undefined, key);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed' });
    expect(await programRow(p.program.id)).toMatchObject({
      status: 'closed',
      closed_by_user_id: h.users.pe,
    });
    // Exact retry: same result, one event.
    const replay = await h.send(
      'post',
      `/api/lab-programs/${p.program.id}/close`,
      { version: closed.body.version - 1, idempotencyKey: key },
      'pe',
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(closed.body);
    expect(await lifecycleEvents(p.program.id)).toBe(1);
    // AC8: closure changed no storage unit (status, location, retention, holds — the whole row).
    const unitAfter = await h.db.pool.query(
      'SELECT to_jsonb(su) AS u FROM storage_unit su WHERE id = $1',
      [p.bucket.id],
    );
    expect(unitAfter.rows[0]).toEqual(unitBefore.rows[0]);
    expect((await row(a)).status).toBe('accepted');
    expect((await row(b)).status).toBe('cancelled');
    const { rows: audit } = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE entity_id = $1 AND action LIKE 'lab_program.%'`,
      [p.program.id],
    );
    expect(audit.map((r) => r.action)).toContain('lab_program.closed');

    // L03: every test cancelled with a reason closes too, with no implied acceptance.
    const q = await program([moisture]);
    expect((await cancel(q.ids[0]!, 1, 'pe')).status).toBe(200);
    const closedAll = await close(q.program.id, 'pe');
    expect(closedAll.status).toBe(200);
    const { rows: accepted } = await h.db.pool.query(
      `SELECT 1 FROM test_request WHERE program_id = $1 AND status = 'accepted'`,
      [q.program.id],
    );
    expect(accepted).toHaveLength(0);
  });

  it('empty-program rule: a submitted program with zero requests never closes (API and database)', async () => {
    // Submission itself refuses a program without requests, so build the impossible state
    // directly (with the submission guard paused) to prove closure doesn't rely on vacuous truth.
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO lab_program (project_id, created_by_account_user_id, created_by_account_type,
                                requested_by_user_id, requested_by_name_snapshot,
                                create_idempotency_key)
       VALUES ($1, $2, 'personal', $2, 'Pat Example', $3) RETURNING id`,
      [h.projects.a, h.users.pe, newKey()],
    );
    const id = rows[0]!.id;
    await h.db.pool.query('ALTER TABLE lab_program DISABLE TRIGGER lab_program_guard');
    try {
      await h.db.pool.query(
        `UPDATE lab_program SET status = 'submitted', program_number = 'LP-2026-9901',
                submitted_at = now(), submitted_by_account_user_id = $2,
                submitted_by_account_type = 'personal', submitted_by_name_snapshot = 'Pat Example',
                submitted_for_user_id = $2, submitted_for_name_snapshot = 'Pat Example',
                submit_idempotency_key = $3
         WHERE id = $1`,
        [id, h.users.pe, newKey()],
      );
    } finally {
      await h.db.pool.query('ALTER TABLE lab_program ENABLE TRIGGER lab_program_guard');
    }
    const refused = await close(id, 'pe');
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('empty_program');
    expect(refused.body.closure).toMatchObject({ emptyProgram: true, eligible: false });
    expect(await programRow(id)).toMatchObject({ status: 'submitted' });
    expect(await lifecycleEvents(id)).toBe(0);
    const view = await work(id, 'pe');
    expect(view.lifecycle).toMatchObject({ canClose: false, closeBlockedReason: 'empty_program' });
    await expect(
      h.db.pool.query(
        `UPDATE lab_program SET status = 'closed', closed_at = now(), closed_by_user_id = $2,
                closed_by_name_snapshot = 'Pat Example' WHERE id = $1`,
        [id, h.users.pe],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation, constraint: 'lab_program_closure' });
  });

  it('database: unresolved requests block closing; cancellation needs its reason', async () => {
    const p = await program([moisture]);
    await expect(
      h.db.pool.query(
        `UPDATE lab_program SET status = 'closed', closed_at = now(), closed_by_user_id = $2,
                closed_by_name_snapshot = 'Pat Example' WHERE id = $1`,
        [p.program.id, h.users.pe],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation, constraint: 'lab_program_closure' });
    await expect(
      h.db.pool.query(
        `UPDATE test_request SET status = 'cancelled', cancelled_at = now(),
                cancelled_by_user_id = $2, cancelled_by_name_snapshot = 'Pat Example'
         WHERE id = $1`,
        [p.ids[0], h.users.pe],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      h.db.pool.query(`UPDATE program_lifecycle_event SET reason = 'x'`),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('AC4/L06/AC5/L05: closed programs refuse repeats and cancellation until reopened', async () => {
    const p = await program([moisture]);
    const id = p.ids[0]!;
    await advance(id, 'accepted');
    expect((await close(p.program.id, 'pe')).status).toBe(200);

    const refused = await repeat(id);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('program_not_open');
    expect((await cancel(id, (await row(id)).version, 'pe')).body.code).toBe('program_not_open');

    // Reopen: whitespace reason refused; technician, delegate and admin alone refused.
    const blank = await reopen(p.program.id, 'lm', '   ');
    expect(blank.status).toBe(400);
    for (const as of ['tech', 'js', 'admin'] as const) {
      expect((await reopen(p.program.id, as)).status, as).toBe(403);
    }
    expect(await lifecycleEvents(p.program.id)).toBe(1);
    const reopened = await reopen(p.program.id, 'lm', 'Client asked for a repeat');
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.status).toBe('submitted');
    expect((await row(id)).status).toBe('accepted');

    // AC5: a repeat links to the original; the original keeps its status and history.
    const before = await work(p.program.id, 'tech');
    const repeated = await repeat(id);
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(201);
    const repeatId = repeated.body.testRequestId as string;
    expect(await row(repeatId)).toMatchObject({ status: 'requested', repeat_of_id: id });
    expect(await row(id)).toMatchObject({ status: 'accepted', repeat_of_id: null });
    const after = await work(p.program.id, 'tech');
    expect(after.statusHistory.filter((e) => e.testRequestId === id)).toEqual(
      before.statusHistory.filter((e) => e.testRequestId === id),
    );
    const original = after.requests.find((r) => r.testRequestId === id)!;
    const linked = after.requests.find((r) => r.testRequestId === repeatId)!;
    expect(original.lifecycle.repeatIds).toEqual([repeatId]);
    expect(linked.lifecycle.repeatOfId).toBe(id);
    // The repeat blocks closure until it is resolved.
    const blocked = await close(p.program.id, 'pe');
    expect(blocked.status).toBe(422);
    expect(blocked.body.closure.blockers).toEqual([
      expect.objectContaining({ testRequestId: repeatId, reason: 'requested' }),
    ]);
    // Only accepted tests are repeated (other origins are unresolved product edges).
    const notAccepted = await repeat(repeatId);
    expect(notAccepted.status).toBe(422);
    expect(notAccepted.body.code).toBe('invalid_transition');
    const { rows: audit } = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE entity_id = $1`,
      [p.program.id],
    );
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining(['lab_program.closed', 'lab_program.reopened']),
    );
  });

  it('L11: a repeat retry returns the same request; another intent under the key is refused', async () => {
    const p = await program([moisture]);
    const id = p.ids[0]!;
    await advance(id, 'accepted');
    const key = newKey();
    const once = await repeat(id, 'tech', key);
    const twice = await repeat(id, 'tech', key);
    expect(once.status).toBe(201);
    expect(twice.status).toBe(201);
    expect(twice.body).toEqual(once.body);
    const { rows } = await h.db.pool.query(`SELECT 1 FROM test_request WHERE repeat_of_id = $1`, [
      id,
    ]);
    expect(rows).toHaveLength(1);
    const otherUser = await repeat(id, 'js', key);
    expect(otherUser.status).toBe(409);
    expect(otherUser.body.code).toBe('idempotency_key_reused');
  });

  it('AC6: a technician can’t cancel; their request becomes an action item resolved by the cancellation', async () => {
    const p = await program([moisture]);
    const id = p.ids[0]!;
    const version = await advance(id, 'in_progress');
    expect((await cancel(id, version, 'tech')).status).toBe(403);
    expect((await cancel(id, version, 'js')).status).toBe(403); // delegate alone
    expect((await cancel(id, version, 'admin')).status).toBe(403);

    const key = newKey();
    const body = { reason: 'Sample looks contaminated', idempotencyKey: key };
    const asked = await h.send('post', `/api/test-requests/${id}/cancel-request`, body, 'tech');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const again = await h.send('post', `/api/test-requests/${id}/cancel-request`, body, 'tech');
    expect(again.body).toEqual(asked.body);
    const other = await h.send(
      'post',
      `/api/test-requests/${id}/cancel-request`,
      { reason: 'Me too', idempotencyKey: newKey() },
      'jo',
    );
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('already_requested');
    expect((await row(id)).status).toBe('in_progress');
    let view = await work(p.program.id, 'pe');
    expect(view.actionItems).toEqual([
      expect.objectContaining({
        id: asked.body.actionItemId,
        kind: 'cancellation_request',
        testRequestId: id,
        comment: 'Sample looks contaminated',
        status: 'open',
        createdBy: expect.objectContaining({ name: 'Alex Tester' }),
      }),
    ]);
    expect(view.requests[0]!.lifecycle).toMatchObject({ canCancel: true });

    const blank = await cancel(id, version, 'pe', '  ');
    expect(blank.status).toBe(400);
    const done = await cancel(id, version, 'pe');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await row(id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'Client withdrew the test',
    });
    view = await work(p.program.id, 'pe');
    expect(view.actionItems[0]).toMatchObject({ status: 'resolved', resolution: 'cancelled' });
    expect(view.statusHistory.at(-1)).toMatchObject({
      fromStatus: 'in_progress',
      toStatus: 'cancelled',
    });
    // Cancelled is final here: no second cancellation, no repeat, no progress.
    expect((await cancel(id, done.body.version, 'pe')).body.code).toBe('invalid_transition');
    expect((await status(id, 'completed', done.body.version)).status).toBe(422);
  });

  it('cancelling a test returned for correction resolves the open correction; accepted tests can’t be cancelled', async () => {
    const p = await program([moisture, sieve]);
    const [a, b] = p.ids as [string, string];
    const version = await advance(a, 'returned');
    expect((await cancel(a, version, 'lm')).status).toBe(200);
    const view = await work(p.program.id, 'lm');
    expect(view.actionItems.find((i) => i.testRequestId === a)).toMatchObject({
      kind: 'correction',
      status: 'resolved',
      resolution: 'cancelled',
    });
    const acceptedVersion = await advance(b, 'accepted');
    const refused = await cancel(b, acceptedVersion, 'pe');
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('invalid_transition');
  });

  it('closure requests: any personal account asks; the program stays open; closing resolves it', async () => {
    const p = await program([moisture]);
    const body = { reason: 'All work is reported', idempotencyKey: newKey() };
    const asked = await h.send(
      'post',
      `/api/lab-programs/${p.program.id}/close-request`,
      body,
      'tech',
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect((await programRow(p.program.id)).status).toBe('submitted');
    await advance(p.ids[0]!, 'accepted');
    expect((await close(p.program.id, 'pe')).status).toBe(200);
    const view = await work(p.program.id, 'pe');
    expect(view.actionItems).toEqual([
      expect.objectContaining({
        kind: 'closure_request',
        testRequestId: null,
        status: 'resolved',
        resolution: 'closed',
      }),
    ]);
    // Closed: no more closure requests.
    const late = await h.send(
      'post',
      `/api/lab-programs/${p.program.id}/close-request`,
      { reason: 'Again', idempotencyKey: newKey() },
      'tech',
    );
    expect(late.status).toBe(422);
  });

  it('AC9/L16: LAB is refused every lifecycle and request endpoint, whoever it selects', async () => {
    const p = await program([moisture]);
    const id = p.ids[0]!;
    // LAB may still do its T24 work on the same program.
    const started = await status(id, 'in_progress', 1, 'lab', { actingStaffUserId: h.users.pe });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const station1 = await h.cookie('lab');
    const station2 = await h.cookie('lab');
    for (const station of [station1, station2]) {
      const calls: [string, Record<string, unknown>][] = [
        [`/api/lab-programs/${p.program.id}/close`, { version: 1 }],
        [`/api/lab-programs/${p.program.id}/reopen`, { version: 1, reason: 'x' }],
        [`/api/lab-programs/${p.program.id}/close-request`, { reason: 'x' }],
        [`/api/test-requests/${id}/cancel`, { version: 2, reason: 'x' }],
        [`/api/test-requests/${id}/cancel-request`, { reason: 'x' }],
        [`/api/test-requests/${id}/repeat`, { version: 2 }],
      ];
      for (const [path, body] of calls) {
        for (const person of [h.users.pe, h.users.lm]) {
          const response = await h.send(
            'post',
            path,
            { ...body, idempotencyKey: newKey(), actingStaffUserId: person },
            station,
          );
          expect(response.status, path).toBe(403);
        }
      }
    }
    expect(station1.startsWith(SESSION_COOKIE)).toBe(true);
    const view = await work(p.program.id, 'lab');
    expect(view.lifecycle).toMatchObject({
      canClose: false,
      closeBlockedReason: 'personal_sign_in',
      canRequestClose: false,
      canReopen: false,
    });
    expect(view.requests[0]!.lifecycle).toMatchObject({
      canCancel: false,
      canRequestCancel: false,
      canRepeat: false,
    });
    expect((await row(id)).status).toBe('in_progress');
  });

  it('L12: a delegate alone can’t cancel, close, reopen or change priority', async () => {
    const p = await program([moisture]);
    const id = p.ids[0]!;
    expect((await cancel(id, 1, 'js')).status).toBe(403);
    expect((await close(p.program.id, 'js')).status).toBe(403);
    const priority = await h.send(
      'patch',
      `/api/lab-programs/${p.program.id}/priority`,
      {
        priority: 'urgent',
        version: (await programRow(p.program.id)).version,
        idempotencyKey: newKey(),
      },
      'js',
    );
    expect(priority.status).toBe(403);
  });

  it('L15: a stale closure after a repeat was added is refused', async () => {
    const p = await program([moisture]);
    const id = p.ids[0]!;
    await advance(id, 'accepted');
    const stale = (await programRow(p.program.id)).version;
    expect((await repeat(id)).status).toBe(201);
    const refused = await close(p.program.id, 'pe', stale);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('version_conflict');
    expect((await programRow(p.program.id)).status).toBe('submitted');
  });

  it('L09: close and repeat race; one serial outcome, never a closed program with an open test', async () => {
    for (const closeFirst of [true, false]) {
      const p = await program([moisture]);
      const id = p.ids[0]!;
      await advance(id, 'accepted');
      const programVersion = (await programRow(p.program.id)).version;
      const originalVersion = (await row(id)).version;
      const blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM lab_program WHERE id = $1 FOR UPDATE', [p.program.id]);
        const first = closeFirst
          ? close(p.program.id, 'pe', programVersion)
          : h.send(
              'post',
              `/api/test-requests/${id}/repeat`,
              { version: originalVersion, idempotencyKey: newKey() },
              'tech',
            );
        await waitForLockWait(h, 'lab_program');
        await blocker.query('COMMIT');
        const firstResult = await first;
        const second = closeFirst
          ? await repeat(id)
          : await close(p.program.id, 'pe', programVersion);
        if (closeFirst) {
          expect(firstResult.status).toBe(200);
          expect(second.status).toBe(422);
          expect(second.body.code).toBe('program_not_open');
        } else {
          expect(firstResult.status).toBe(201);
          expect(second.status).toBe(409);
        }
        const { rows } = await h.db.pool.query<{ open: number }>(
          `SELECT count(*)::int AS open FROM test_request r JOIN lab_program lp
             ON lp.id = r.program_id
           WHERE lp.id = $1 AND lp.status = 'closed' AND r.status NOT IN ('accepted', 'cancelled')`,
          [p.program.id],
        );
        expect(rows[0]!.open).toBe(0);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end();
      }
    }
  });

  it('AC10/L10: cancellation and LAB progress from the same version: one wins, the other is stale', async () => {
    const p = await program([moisture]);
    const id = p.ids[0]!;
    const blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM test_request WHERE id = $1 FOR UPDATE', [id]);
      const cancelling = cancel(id, 1, 'pe');
      const starting = status(id, 'in_progress', 1, 'lab', { actingStaffUserId: h.users.tech });
      await waitForLockWait(h, 'test_request');
      await blocker.query('COMMIT');
      const results = await Promise.all([cancelling, starting]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const final = await row(id);
      expect(['cancelled', 'in_progress']).toContain(final.status);
      expect(final.version).toBe(2);
      const { rows } = await h.db.pool.query(
        'SELECT 1 FROM test_request_status_history WHERE test_request_id = $1',
        [id],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  });

  it('Lane B contract: a cancelled test is no longer completed-test evidence; a sibling’s still is', async () => {
    const holeId = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects.a, `TH-${newKey().slice(0, 8)}`],
      )
    ).rows[0]!.id;
    const tube = await h.tube({ holeId });
    const group = await h.bulkGroup({ holeId, sampleReference: 'B1', depthFrom: 1, buckets: 1 });
    const bucket = group.members[0]!;
    const p = await submit([line({ kind: 'test_hole', id: holeId }, 'all', [moisture, sieve])]);
    const [a, b] = p.lines[0]!.requests.map((r) => r.id) as [string, string];
    for (const [id, unit] of [
      [a, tube.id],
      [b, bucket.id],
    ] as const) {
      expect((await status(id, 'in_progress', 1)).status).toBe(200);
      const done = await status(id, 'completed', 2, 'tech', { testedStorageUnitIds: [unit] });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    expect(await completedTestEvidence(h.db.pool, tube.id)).toHaveLength(1);
    expect((await cancel(a, 3, 'pe', 'Wrong tube tested')).status).toBe(200);
    expect(await completedTestEvidence(h.db.pool, tube.id)).toEqual([]);
    expect(await completedTestEvidence(h.db.pool, bucket.id)).toEqual([
      expect.objectContaining({ test_request_id: b, request_status: 'completed' }),
    ]);
    // The link itself is kept as history.
    const { rows } = await h.db.pool.query(
      'SELECT 1 FROM test_request_unit_link WHERE test_request_id = $1',
      [a],
    );
    expect(rows).toHaveLength(1);
  });

  it('L13: a repeat never makes disposed material available again', async () => {
    const holeId = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects.a, `TH-${newKey().slice(0, 8)}`],
      )
    ).rows[0]!.id;
    const tube = await h.tube({ holeId });
    const p = await submit([line({ kind: 'test_hole', id: holeId }, 'all', [moisture])]);
    const id = p.lines[0]!.requests[0]!.id;
    expect((await status(id, 'in_progress', 1)).status).toBe(200);
    expect(
      (await status(id, 'completed', 2, 'tech', { testedStorageUnitIds: [tube.id] })).status,
    ).toBe(200);
    let version = 3;
    for (const to of ['review'] as const) version = (await status(id, to, version)).body.version;
    version = (await review(id, { action: 'complete', version })).body.version;
    expect(
      (
        await h.send(
          'post',
          `/api/test-requests/${id}/accept`,
          { version, idempotencyKey: newKey() },
          'pe',
        )
      ).status,
    ).toBe(200);
    // The tube is physically gone (MM-T36's removal, played here by its end state).
    await h.db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [tube.id]);
    const repeated = await repeat(id);
    expect(repeated.status).toBe(201);
    const repeatId = repeated.body.testRequestId as string;
    expect((await status(repeatId, 'in_progress', 1)).status).toBe(200);
    const reuse = await status(repeatId, 'completed', 2, 'tech', {
      testedStorageUnitIds: [tube.id],
    });
    expect(reuse.status).toBe(422);
    const { rows } = await h.db.pool.query<{ status: string }>(
      'SELECT status FROM storage_unit WHERE id = $1',
      [tube.id],
    );
    expect(rows[0]!.status).toBe('disposed');
  });
});

async function waitForLockWait(h: LabHarness, table: string) {
  for (let i = 0; i < 500; i += 1) {
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
      [`%${table}%`],
    );
    if (rows[0]!.n > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`nothing waited on ${table}`);
}
