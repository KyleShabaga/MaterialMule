import {
  acceptanceDelegatesSchema,
  labProgramReviewSchema,
  labProgramSchema,
  programWorkSchema,
  reviewResultSchema,
  type LabProgram,
} from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, type AuthUser } from '../auth/policy.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { PG } from '../test-support/fixtures.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { completedTestEvidence } from './work.service.js';

// MM-T25 review corrections and delegated acceptance (card AC1–AC8, test plan T1–T3, T5, T6 and
// preparation scenarios R01–R12 that belong to this card). Real PostgreSQL; races use two real
// connections and row locks, never sleeps. Fictional data only: DEMO-2601 (A) and DEMO-2602 (B),
// whose PM/PE is Pat Example (`pe`); Lee Manager (`lm`) is the Lab Manager; Jordan Smith (`js`)
// plays the acceptance delegate DE; Alex Tester (`tech`) is an ordinary Technician.
describe.runIf(testDatabaseUrl)('lab review and acceptance API (MM-T25)', () => {
  let h: LabHarness;
  let moisture: string;
  type As = Parameters<LabHarness['send']>[3];

  /** A submitted program on a fresh hole of `project`, its one test sent to Review. */
  async function inReview(
    project: 'a' | 'b' = 'a',
    moves: string[] = ['in_progress', 'completed', 'review'],
  ): Promise<{ program: LabProgram; id: string; version: number }> {
    const holeId = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects[project], `TH-${newKey().slice(0, 8)}`],
      )
    ).rows[0]!.id;
    await h.bucket({ project, hole: holeId });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects[project],
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture])],
      },
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
    const program = labProgramSchema.parse(submitted.body);
    const id = program.lines[0]!.requests[0]!.id;
    let version = 1;
    for (const to of moves) {
      const moved = await h.send(
        'post',
        `/api/test-requests/${id}/status`,
        { to, version, idempotencyKey: newKey() },
        'tech',
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      version = moved.body.version as number;
    }
    return { program, id, version };
  }

  const review = (id: string, body: Record<string, unknown>, as: As) =>
    h.send('post', `/api/test-requests/${id}/review`, { idempotencyKey: newKey(), ...body }, as);
  const correctionDone = (id: string, body: Record<string, unknown>, as: As) =>
    h.send(
      'post',
      `/api/test-requests/${id}/correction-done`,
      { idempotencyKey: newKey(), ...body },
      as,
    );
  const accept = (id: string, version: number, as: As, key = newKey()) =>
    h.send('post', `/api/test-requests/${id}/accept`, { version, idempotencyKey: key }, as);

  async function state(id: string) {
    const { rows } = await h.db.pool.query<{
      status: string;
      review_state: string | null;
      version: number;
      accepted_by_user_id: string | null;
      accepted_via_delegation_id: string | null;
    }>(
      `SELECT status, review_state, version, accepted_by_user_id, accepted_via_delegation_id
       FROM test_request WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function counts(id: string) {
    const { rows } = await h.db.pool.query<{ events: number; items: number; audits: number }>(
      `SELECT (SELECT count(*)::int FROM test_request_review_event WHERE test_request_id = $1)
                AS events,
              (SELECT count(*)::int FROM action_item WHERE entity_id = $1) AS items,
              (SELECT count(*)::int FROM audit_event WHERE entity_id = $1
                 AND action IN ('test_request.review_completed',
                              'test_request.returned_for_correction',
                              'test_request.correction_done', 'test_request.accepted'))
                AS audits`,
      [id],
    );
    return rows[0]!;
  }

  async function work(programId: string, as: As) {
    return programWorkSchema.parse((await h.get(`/api/lab-programs/${programId}/work`, as)).body);
  }

  async function grant(project: 'a' | 'b', delegate: string, as: As = 'pe') {
    return h.send(
      'post',
      `/api/projects/${h.projects[project]}/acceptance-delegates`,
      { delegateUserId: delegate, idempotencyKey: newKey() },
      as,
    );
  }

  async function revoke(project: 'a' | 'b', delegationId: string, as: As = 'pe') {
    const cookie = as.startsWith(SESSION_COOKIE) ? as : await h.cookie(as as 'pe');
    return h
      .http()
      .delete(`/api/projects/${h.projects[project]}/acceptance-delegates/${delegationId}`)
      .set('Cookie', cookie)
      .set('x-materialmule-csrf', '1');
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)', 'Moisture Content')).id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('R01/T2: Review → review complete → accept, in order, with actor and time', async () => {
    const t = await inReview();
    expect(await state(t.id)).toMatchObject({ status: 'review', review_state: 'awaiting_review' });

    const premature = await accept(t.id, t.version, 'pe');
    expect(premature.status).toBe(422);
    expect(premature.body.code).toBe('review_not_complete');

    const done = await review(t.id, { action: 'complete', version: t.version }, 'tech');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const result = reviewResultSchema.parse(done.body);
    expect(result).toMatchObject({ status: 'review', reviewState: 'review_complete' });

    const accepted = await accept(t.id, result.version, 'pe');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', reviewState: null });
    expect(await state(t.id)).toMatchObject({
      status: 'accepted',
      review_state: null,
      accepted_by_user_id: h.users.pe,
      accepted_via_delegation_id: null,
    });

    const view = await work(t.program.id, 'pe');
    const request = view.requests.find((r) => r.testRequestId === t.id)!;
    expect(request.acceptedBy?.name).toBe('Pat Example');
    expect(view.reviewEvents.map((e) => [e.kind, e.person.name])).toEqual([
      ['review_completed', 'Alex Tester'],
      ['accepted', 'Pat Example'],
    ]);
    expect(view.statusHistory.at(-1)).toMatchObject({ fromStatus: 'review', toStatus: 'accepted' });
    const { rows: audit } = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE entity_id = $1 ORDER BY occurred_at, id`,
      [t.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'test_request.created',
      'test_request.status_changed',
      'test_request.status_changed',
      'test_request.status_changed',
      'test_request.review_completed',
      'test_request.accepted',
    ]);

    // Accepted is terminal for T25: no further review decisions.
    const again = await review(
      t.id,
      {
        action: 'return',
        comment: 'late',
        version: accepted.body.version as number,
      },
      'tech',
    );
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('invalid_transition');
  });

  it('AC1/AC2/R02: a return needs a comment, stays in Review and opens one Lab Manager item', async () => {
    const t = await inReview();
    for (const comment of [undefined, '', '   ']) {
      const blank = await review(t.id, { action: 'return', comment, version: t.version }, 'tech');
      expect(blank.status).toBe(400);
      expect(blank.body.code).toBe('validation_failed');
    }
    expect(await counts(t.id)).toEqual({ events: 0, items: 0, audits: 0 });

    const returned = await review(
      t.id,
      { action: 'return', comment: 'Wrong sieve stack recorded', version: t.version },
      'tech',
    );
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(await state(t.id)).toMatchObject({ status: 'review', review_state: 'returned' });
    const { rows: items } = await h.db.pool.query(
      `SELECT kind, target_role, status FROM action_item WHERE entity_id = $1`,
      [t.id],
    );
    expect(items).toEqual([{ kind: 'correction', target_role: 'lab_manager', status: 'open' }]);
    const view = await work(t.program.id, 'lm');
    expect(view.actionItems).toEqual([
      expect.objectContaining({ comment: 'Wrong sieve stack recorded', status: 'open' }),
    ]);
    const request = view.requests.find((r) => r.testRequestId === t.id)!;
    expect(request.reviewActions).toMatchObject({
      canCorrectionDone: true,
      canReview: false,
      canAccept: false,
      acceptBlockedReason: 'no_authority',
    });
  });

  it('AC3/R03/R04: return → correction done → (accept refused) → second return keeps history → complete → accept', async () => {
    const t = await inReview();
    let version = (
      await review(t.id, { action: 'return', comment: 'First problem', version: t.version }, 'tech')
    ).body.version as number;

    expect((await accept(t.id, version, 'pe')).body.code).toBe('review_not_complete');

    // Only the Lab Manager marks the correction done, with a note.
    expect((await correctionDone(t.id, { note: 'Fixed', version }, 'tech')).status).toBe(403);
    expect((await correctionDone(t.id, { note: 'Fixed', version }, 'pe')).status).toBe(403);
    expect((await correctionDone(t.id, { note: 'Fixed', version }, 'admin')).status).toBe(403);
    expect((await correctionDone(t.id, { note: '  ', version }, 'lm')).status).toBe(400);
    const fixed = await correctionDone(t.id, { note: 'Re-entered the stack', version }, 'lm');
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body.reviewState).toBe('correction_done');
    version = fixed.body.version as number;

    // Correction done still needs a fresh review before acceptance.
    expect((await accept(t.id, version, 'pe')).body.code).toBe('review_not_complete');

    const second = await review(
      t.id,
      { action: 'return', comment: 'Second problem', version },
      'js',
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    version = second.body.version as number;
    version = (await correctionDone(t.id, { note: 'Fixed again', version }, 'lm')).body
      .version as number;
    // Re-review by the same person who returned it is allowed (no separation rule).
    const complete = await review(t.id, { action: 'complete', version }, 'js');
    expect(complete.status).toBe(200);
    const accepted = await accept(t.id, complete.body.version as number, 'pe');
    expect(accepted.status).toBe(200);

    const view = await work(t.program.id, 'pe');
    expect(view.reviewEvents.map((e) => [e.kind, e.comment, e.correctionCycle])).toEqual([
      ['returned', 'First problem', 1],
      ['correction_done', 'Re-entered the stack', 1],
      ['returned', 'Second problem', 2],
      ['correction_done', 'Fixed again', 2],
      ['review_completed', null, 2],
      ['accepted', null, 2],
    ]);
    expect(view.actionItems.map((i) => [i.comment, i.status])).toEqual([
      ['First problem', 'resolved'],
      ['Second problem', 'resolved'],
    ]);
  });

  it('T1/§12: invalid review moves are refused without changing anything', async () => {
    const t = await inReview();
    // A returned test can't be completed or returned again before the correction.
    let version = (
      await review(t.id, { action: 'return', comment: 'Check', version: t.version }, 'tech')
    ).body.version as number;
    const before = await counts(t.id);
    for (const body of [
      { action: 'complete', version },
      { action: 'return', comment: 'Again', version },
    ]) {
      const refused = await review(t.id, body, 'tech');
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('invalid_transition');
    }
    expect(await counts(t.id)).toEqual(before);
    version = (await correctionDone(t.id, { note: 'Done', version }, 'lm')).body.version as number;
    expect((await correctionDone(t.id, { note: 'Done twice', version }, 'lm')).status).toBe(422);
    version = (await review(t.id, { action: 'complete', version }, 'tech')).body.version as number;

    // Unresolved edge: Review complete → Returned stays refused until the owner decides.
    const reverse = await review(t.id, { action: 'return', comment: 'Late find', version }, 'tech');
    expect(reverse.status).toBe(422);
    expect(reverse.body.code).toBe('invalid_transition');

    // Tests not yet in Review (Requested, In progress, Completed) can't be reviewed or accepted.
    for (const moves of [[], ['in_progress'], ['in_progress', 'completed']]) {
      const early = await inReview('a', moves);
      const refused = await review(
        early.id,
        { action: 'complete', version: early.version },
        'tech',
      );
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('invalid_transition');
      expect((await accept(early.id, early.version, 'pe')).body.code).toBe('invalid_transition');
      expect((await counts(early.id)).events).toBe(0);
    }
  });

  it('AC4/R05: a Lab Manager or admin without delegation can’t accept', async () => {
    const t = await inReview();
    const version = (await review(t.id, { action: 'complete', version: t.version }, 'lm')).body
      .version as number;
    for (const as of ['lm', 'admin', 'tech'] as const) {
      const refused = await accept(t.id, version, as);
      expect(refused.status).toBe(403);
    }
    expect(await state(t.id)).toMatchObject({ status: 'review', review_state: 'review_complete' });
    const request = (await work(t.program.id, 'lm')).requests.find(
      (r) => r.testRequestId === t.id,
    )!;
    expect(request.reviewActions).toMatchObject({
      canAccept: false,
      acceptBlockedReason: 'no_authority',
    });
  });

  it('AC5/AC6/R06/R12: a delegate accepts on its project only; revocation blocks the next accept, earlier attribution stays', async () => {
    const granted = await grant('a', h.users.js);
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const delegates = acceptanceDelegatesSchema.parse(granted.body);
    const grantId = delegates.active.find((d) => d.delegate.userId === h.users.js)!.id;
    expect((await grant('a', h.users.js)).body.code).toBe('already_delegated');

    const onA = await inReview('a');
    const v1 = (await review(onA.id, { action: 'complete', version: onA.version }, 'tech')).body
      .version as number;
    const onB = await inReview('b');
    const vB = (await review(onB.id, { action: 'complete', version: onB.version }, 'tech')).body
      .version as number;
    expect((await work(onA.program.id, 'js')).requests[0]!.reviewActions.canAccept).toBe(true);

    expect((await accept(onB.id, vB, 'js')).status).toBe(403);
    const byDelegate = await accept(onA.id, v1, 'js');
    expect(byDelegate.status, JSON.stringify(byDelegate.body)).toBe(200);
    expect(await state(onA.id)).toMatchObject({
      accepted_by_user_id: h.users.js,
      accepted_via_delegation_id: grantId,
    });

    // AC6: delegation grants neither priority nor closure nor delegation management.
    const priority = await h.send(
      'patch',
      `/api/lab-programs/${onA.program.id}/priority`,
      { priority: 'urgent', version: onA.program.version, idempotencyKey: newKey() },
      'js',
    );
    expect(priority.status).toBe(403);
    const delegateUser: AuthUser = {
      userId: h.users.js,
      sessionId: 'x',
      accountType: 'personal',
      status: 'active',
      roles: [],
      displayName: 'Jordan Smith',
      initials: 'JS',
    };
    const context = { pmPeUserId: h.users.pe, acceptanceDelegateUserIds: [h.users.js] };
    expect(can(delegateUser, 'test.accept', context)).toBe(true);
    expect(can(delegateUser, 'program.close', context)).toBe(false);
    expect(can(delegateUser, 'program.priority.set', context)).toBe(false);
    expect((await grant('a', h.users.jo, 'js')).status).toBe(403);
    expect((await revoke('a', grantId, 'js')).status).toBe(403);

    // Only the PM/PE revokes; the next accept by DE is refused, the earlier one keeps DE.
    expect((await revoke('a', grantId, 'lm')).status).toBe(403);
    const revoked = await revoke('a', grantId);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(acceptanceDelegatesSchema.parse(revoked.body).history[0]).toMatchObject({
      id: grantId,
      revokedBy: { name: 'Pat Example' },
    });
    const next = await inReview('a');
    const v2 = (await review(next.id, { action: 'complete', version: next.version }, 'tech')).body
      .version as number;
    expect((await accept(next.id, v2, 'js')).status).toBe(403);
    expect(await state(onA.id)).toMatchObject({
      status: 'accepted',
      accepted_by_user_id: h.users.js,
      accepted_via_delegation_id: grantId,
    });
    // Renaming the person later doesn't rewrite the recorded acceptance.
    await h.db.pool.query(`UPDATE app_user SET display_name = 'Jordan Renamed' WHERE id = $1`, [
      h.users.js,
    ]);
    const view = await work(onA.program.id, 'pe');
    expect(view.reviewEvents.find((e) => e.kind === 'accepted')).toMatchObject({
      person: { name: 'Jordan Smith' },
      viaDelegation: true,
    });
    await h.db.pool.query(`UPDATE app_user SET display_name = 'Jordan Smith' WHERE id = $1`, [
      h.users.js,
    ]);

    // Revoking again changes nothing; history is kept and a new grant is a new row.
    expect((await revoke('a', grantId)).status).toBe(200);
    const regrant = await grant('a', h.users.js);
    expect(regrant.status).toBe(201);
    const after = acceptanceDelegatesSchema.parse(regrant.body);
    expect(after.active).toHaveLength(1);
    expect(after.history.map((d) => d.id)).toContain(grantId);
    await revoke('a', after.active[0]!.id);
    const { rows: audit } = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE entity_type = 'acceptance_delegation'
       ORDER BY occurred_at, id`,
    );
    expect(audit.map((a) => a.action)).toEqual([
      'acceptance_delegation.granted',
      'acceptance_delegation.revoked',
      'acceptance_delegation.granted',
      'acceptance_delegation.revoked',
    ]);
  });

  it('delegation targets must be active staff other than the PM/PE; reads are personal-only', async () => {
    expect((await grant('a', h.users.pe)).body.code).toBe('invalid_delegate');
    expect((await grant('a', h.users.disabled)).body.code).toBe('invalid_delegate');
    expect((await grant('a', h.users.lab)).body.code).toBe('invalid_delegate');
    expect((await grant('a', h.users.js, 'admin')).status).toBe(403);
    const read = await h.get(`/api/projects/${h.projects.a}/acceptance-delegates`, 'tech');
    expect(read.status).toBe(200);
    expect(acceptanceDelegatesSchema.parse(read.body).canManage).toBe(false);
    expect(
      acceptanceDelegatesSchema.parse(
        (await h.get(`/api/projects/${h.projects.a}/acceptance-delegates`, 'pe')).body,
      ).canManage,
    ).toBe(true);
  });

  it('AC7/R09/T5: LAB stations get 403 on every T25 action, whoever they select; a personal reviewer keeps only their own rights', async () => {
    const t = await inReview();
    const stationA = await h.cookie('lab');
    const stationB = await h.cookie('lab');
    // Both stations may still do T24 work (send to review) — proven by inReview-style moves.
    const other = await inReview();
    for (const station of [stationA, stationB]) {
      for (const selected of [h.users.pe, h.users.lm]) {
        const asStation = { actingStaffUserId: selected };
        expect(
          (await review(t.id, { action: 'complete', version: t.version, ...asStation }, station))
            .status,
        ).toBe(403);
        expect(
          (await review(t.id, { action: 'return', comment: 'x', version: t.version }, station))
            .status,
        ).toBe(403);
        expect(
          (await correctionDone(t.id, { note: 'x', version: t.version, ...asStation }, station))
            .status,
        ).toBe(403);
        expect((await accept(t.id, t.version, station)).status).toBe(403);
        expect((await grant('a', h.users.js, station)).status).toBe(403);
        expect((await revoke('a', newKey(), station)).status).toBe(403);
        expect(
          (await h.get(`/api/projects/${h.projects.a}/acceptance-delegates`, station)).status,
        ).toBe(403);
      }
    }
    expect(await counts(t.id)).toEqual({ events: 0, items: 0, audits: 0 });
    const labView = await work(other.program.id, stationA);
    expect(labView.requests[0]!.reviewActions).toEqual({
      canReview: false,
      canCorrectionDone: false,
      canAccept: false,
      acceptBlockedReason: 'personal_sign_in',
    });
    // A personal Technician signed in elsewhere reviews, but can't accept or correct.
    const reviewed = await review(t.id, { action: 'complete', version: t.version }, 'tech');
    expect(reviewed.status).toBe(200);
    expect((await accept(t.id, reviewed.body.version as number, 'tech')).status).toBe(403);
  });

  it('AC8/R08: two reviewers deciding from the same version: one wins, the stale one gets 409, nothing lost or doubled', async () => {
    const t = await inReview();
    const [first, second] = await Promise.all([
      review(t.id, { action: 'return', comment: 'Reviewer one', version: t.version }, 'tech'),
      review(t.id, { action: 'complete', version: t.version }, 'js'),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body).toMatchObject({
      code: 'version_conflict',
      current: { testRequestId: t.id },
    });
    const after = await counts(t.id);
    expect(after.events).toBe(1);
    expect(after.items).toBe(first.status === 200 ? 1 : 0);
  });

  it('R10: an exact retry returns the original result; the same key with another intent is refused', async () => {
    const t = await inReview();
    const key = newKey();
    const body = { action: 'return', comment: 'Retry me', version: t.version, idempotencyKey: key };
    const once = await h.send('post', `/api/test-requests/${t.id}/review`, body, 'tech');
    const twice = await h.send('post', `/api/test-requests/${t.id}/review`, body, 'tech');
    expect(once.status).toBe(200);
    expect(twice.status).toBe(200);
    expect(twice.body).toEqual(once.body);
    expect(await counts(t.id)).toEqual({ events: 1, items: 1, audits: 1 });
    const changed = await h.send(
      'post',
      `/api/test-requests/${t.id}/review`,
      { ...body, comment: 'Different' },
      'tech',
    );
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('idempotency_key_reused');
    const otherUser = await h.send('post', `/api/test-requests/${t.id}/review`, body, 'js');
    expect(otherUser.body.code).toBe('idempotency_key_reused');

    let version = once.body.version as number;
    version = (await correctionDone(t.id, { note: 'ok', version }, 'lm')).body.version as number;
    version = (await review(t.id, { action: 'complete', version }, 'tech')).body.version as number;
    const acceptKey = newKey();
    const accepted = await accept(t.id, version, 'pe', acceptKey);
    const replay = await accept(t.id, version, 'pe', acceptKey);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(accepted.body);
    expect((await counts(t.id)).events).toBe(4);
  });

  it('R07/T6: acceptance and revocation serialise in both commit orders', async () => {
    const granted = acceptanceDelegatesSchema.parse((await grant('a', h.users.jo)).body);
    const grantId = granted.active.find((d) => d.delegate.userId === h.users.jo)!.id;
    const t1 = await inReview('a');
    const t2 = await inReview('a');
    const v1 = (await review(t1.id, { action: 'complete', version: t1.version }, 'tech')).body
      .version as number;
    const v2 = (await review(t2.id, { action: 'complete', version: t2.version }, 'tech')).body
      .version as number;
    const blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    await blocker.connect();
    try {
      // Acceptance first: while an acceptance holds the grant (share lock, played by the
      // blocker after a real acceptance has committed), a revocation waits for it; the committed
      // acceptance keeps its delegate attribution after the revocation lands.
      const accepted = await accept(t1.id, v1, 'jo');
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM acceptance_delegation WHERE id = $1 FOR SHARE', [
        grantId,
      ]);
      const revoking = revoke('a', grantId);
      await waitForLockWait(h, 'acceptance_delegation');
      await blocker.query('COMMIT');
      expect((await revoking).status).toBe(200);
      expect(await state(t1.id)).toMatchObject({
        status: 'accepted',
        accepted_by_user_id: h.users.jo,
        accepted_via_delegation_id: grantId,
      });

      // Revocation first: a real acceptance is held at the test's row lock (its authority was
      // checked before the transaction), the revocation commits, then the acceptance rechecks
      // the grant under lock and is refused.
      const regrant = acceptanceDelegatesSchema.parse((await grant('a', h.users.jo)).body);
      const second = regrant.active.find((d) => d.delegate.userId === h.users.jo)!.id;
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM test_request WHERE id = $1 FOR UPDATE', [t2.id]);
      const late = accept(t2.id, v2, 'jo');
      await waitForLockWait(h, 'test_request');
      expect((await revoke('a', second)).status).toBe(200);
      await blocker.query('COMMIT');
      expect((await late).status).toBe(403);
      expect(await state(t2.id)).toMatchObject({ status: 'review', accepted_by_user_id: null });
      expect((await counts(t2.id)).events).toBe(1);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  });

  it('a closed program refuses review decisions', async () => {
    // Since MM-T26 a program closes only with every test resolved, so close it for real.
    const t = await inReview();
    const done = await review(t.id, { action: 'complete', version: t.version }, 'tech');
    const accepted = await accept(t.id, done.body.version as number, 'pe');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM lab_program WHERE id = $1',
      [t.program.id],
    );
    const closed = await h.send(
      'post',
      `/api/lab-programs/${t.program.id}/close`,
      { version: rows[0]!.version, idempotencyKey: newKey() },
      'pe',
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const refused = await review(
      t.id,
      { action: 'complete', version: accepted.body.version },
      'tech',
    );
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('program_not_open');
  });

  it('Lane B contract: completedTestEvidence reports the test’s current status', async () => {
    const tube = await h.tube({ location: 'Embankment Location 07' });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'standalone_unit', id: tube.id }, 'all', [moisture])],
      },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const reviewBody = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
    );
    const submitted = await h.send(
      'post',
      `/api/lab-programs/${created.body.id}/submit`,
      {
        version: created.body.version,
        idempotencyKey: newKey(),
        coverage: reviewBody.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
      },
      'tech',
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const id = labProgramSchema.parse(submitted.body).lines[0]!.requests[0]!.id;
    await h.send(
      'post',
      `/api/test-requests/${id}/status`,
      { to: 'in_progress', version: 1, idempotencyKey: newKey() },
      'tech',
    );
    await h.send(
      'post',
      `/api/test-requests/${id}/status`,
      { to: 'completed', version: 2, idempotencyKey: newKey(), testedStorageUnitIds: [tube.id] },
      'tech',
    );
    const evidence = await completedTestEvidence(h.db.pool, tube.id);
    expect(evidence).toEqual([expect.objectContaining({ request_status: 'completed' })]);
  });

  it('database: acceptance needs a complete review; review moves follow the table; history is append-only', async () => {
    const t = await inReview();
    await expect(
      h.db.pool.query(
        `UPDATE test_request SET status = 'accepted', review_state = NULL, accepted_at = now(),
                accepted_by_user_id = $2 WHERE id = $1`,
        [t.id, h.users.pe],
      ),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      h.db.pool.query(`UPDATE test_request SET review_state = 'correction_done' WHERE id = $1`, [
        t.id,
      ]),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      h.db.pool.query(`UPDATE test_request SET review_state = NULL WHERE id = $1`, [t.id]),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await review(t.id, { action: 'return', comment: 'x', version: t.version }, 'tech');
    await expect(
      h.db.pool.query(`UPDATE test_request_review_event SET comment = 'edited'`),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(
      h.db.pool.query(`DELETE FROM action_item WHERE entity_id = $1`, [t.id]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    // A second open correction for the same test is impossible.
    const { rows } = await h.db.pool.query<{ opened_by_event_id: string; program_id: string }>(
      `SELECT opened_by_event_id, program_id FROM action_item WHERE entity_id = $1`,
      [t.id],
    );
    await expect(
      h.db.pool.query(
        `INSERT INTO action_item (kind, target_role, entity_type, entity_id, program_id,
                                  opened_by_event_id, created_by_user_id)
         VALUES ('correction', 'lab_manager', 'test_request', $1, $2, $3, $4)`,
        [t.id, rows[0]!.program_id, rows[0]!.opened_by_event_id, h.users.tech],
      ),
    ).rejects.toMatchObject({ code: PG.uniqueViolation });
    // Two active grants for one person on one project are impossible; grants are never deleted.
    await grant('b', h.users.jo);
    await expect(
      h.db.pool.query(
        `INSERT INTO acceptance_delegation (project_id, delegate_user_id, delegate_name_snapshot,
           granted_by_user_id, granted_by_name_snapshot, grant_idempotency_key, grant_request_hash)
         VALUES ($1, $2, 'Jamie Song', $3, 'Pat Example', gen_random_uuid(), 'x')`,
        [h.projects.b, h.users.jo, h.users.pe],
      ),
    ).rejects.toMatchObject({ code: PG.uniqueViolation });
    await expect(
      h.db.pool.query(`DELETE FROM acceptance_delegation WHERE project_id = $1`, [h.projects.b]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });
});

/** Resolves once some backend is waiting on a row lock of `table` (no fixed sleeps). */
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
