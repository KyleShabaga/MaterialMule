import { randomUUID } from 'node:crypto';
import {
  disposalScanCheckResponseSchema,
  disposalScanRecordResponseSchema,
  labProgramReviewSchema,
  labProgramSchema,
  type LabProgram,
} from '@materialmule/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BusinessClock } from '../retention/business-clock.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// STRATA-92 Disposal scan-out: check (changes nothing) and record (idempotent per intent ID) on
// the MM-T30 rules. Holds, dates, open programs, revocation, the tested-unit exemption, LAB
// refused, other accounts, duplicate and reused intent IDs, and refused direct calls. Real
// PostgreSQL, no sleeps. Fictional data only: DEMO-2601 (A), Lee Manager (`lm`), Alex Tester
// (`tech`), Pat Example (`pe`, DEMO-2601's Lead Project Engineer).
describe.runIf(testDatabaseUrl)('disposal scan-out (STRATA-92)', () => {
  let h: LabHarness;
  let clock: BusinessClock;
  let moisture: string;
  type As = Parameters<LabHarness['send']>[3];

  const at = (date: string) => clock.set(new Date(`${date}T18:00:00Z`));

  async function newHole() {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects.a, `TH-${newKey().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  async function oldBucket() {
    return h.bucket({ hole: await newHole(), receivedDate: '2026-10-23' });
  }

  const approve = (unitIds: string[]) =>
    h.send('post', '/api/disposal/approvals', { unitIds, idempotencyKey: newKey() }, 'lm');

  const intent = (code: string, as: As = 'tech', intentId = randomUUID()) => ({
    intentId,
    code,
    scannedByUserId: h.users[as as keyof LabHarness['users']],
    scannedAt: '2027-10-24T16:00:00.000Z',
  });

  const check = (intents: object[], as: As = 'tech') =>
    h.send('post', '/api/disposal/scan/check', { intents }, as);
  const record = (intents: object[], as: As = 'tech') =>
    h.send('post', '/api/disposal/scan/record', { intents }, as);

  async function checked(intents: object[], as: As = 'tech') {
    const response = await check(intents, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return disposalScanCheckResponseSchema.parse(response.body).results;
  }

  async function recorded(intents: object[], as: As = 'tech') {
    const response = await record(intents, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return disposalScanRecordResponseSchema.parse(response.body).results;
  }

  const count = async (sql: string, params: unknown[] = []) =>
    (await h.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;

  const history = (unitId: string) =>
    count(
      `FROM audit_event WHERE entity_id = $1 AND action IN ('disposal.blocked', 'disposal.removed')`,
      [unitId],
    );

  const status = async (id: string) =>
    (
      await h.db.pool.query<{ status: string }>('SELECT status FROM storage_unit WHERE id = $1', [
        id,
      ])
    ).rows[0]!.status;

  async function submitted(holeId: string): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture])],
      },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
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
      },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return labProgramSchema.parse(response.body);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    clock = h.app.get(BusinessClock);
    moisture = (await h.testType('MC', 'Moisture content', 'Moisture')).id;
  }, 60_000);

  afterEach(() => clock.set(null));

  afterAll(async () => {
    await h?.close();
  });

  it('check reports approved, not approved and not found, and changes nothing', async () => {
    const approved = await oldBucket();
    const waiting = await oldBucket();
    at('2027-10-24');
    expect((await approve([approved.id])).status).toBe(201);
    const audits = await count('FROM audit_event');
    const results = await checked([
      intent(approved.readableId.toLowerCase()),
      intent(waiting.readableId),
      intent('BKT-2026-999999'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['approved', 'not_approved', 'not_found']);
    expect(results[0]).toMatchObject({
      message: 'Approved · will be disposed',
      unit: { readableId: approved.readableId, projectNumber: 'DEMO-2601' },
    });
    expect(results[0]!.unit!.holes).toHaveLength(1);
    expect(results[1]!.message).toMatch(/Not approved for disposal/);
    expect(results[2]!.message).toMatch(/No storage unit has the ID BKT-2026-999999/);
    expect(await status(approved.id)).toBe('approved_for_disposal');
    expect(await count('FROM audit_event')).toBe(audits);
    expect(await count('FROM disposal_scan_intent')).toBe(0);
  });

  it('record disposes an approved unit once; a retried intent returns the same outcome with no second history entry', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    const scan = intent(unit.readableId);
    const [first] = await recorded([scan]);
    expect(first!.outcome).toMatchObject({
      result: 'disposed',
      replayed: false,
      removedBy: { name: 'Alex Tester' },
    });
    expect(await status(unit.id)).toBe('disposed');
    const [again] = await recorded([scan]);
    expect(again!.outcome).toMatchObject({
      result: 'disposed',
      replayed: true,
      removedAt: first!.outcome.removedAt,
    });
    expect(await history(unit.id)).toBe(1);
    expect(await count('FROM disposal_removal WHERE storage_unit_id = $1', [unit.id])).toBe(1);
    // Checking the recorded intent reports it as recorded; a new scan of it is already disposed.
    const [seen] = await checked([scan]);
    const [fresh] = await checked([intent(`  ${unit.readableId} `)]);
    expect(seen).toMatchObject({ status: 'recorded', recorded: { result: 'disposed' } });
    expect(fresh).toMatchObject({ status: 'not_approved' });
    expect(fresh!.message).toMatch(/already disposed/);
  });

  it('concurrent retries of one intent dispose it once', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    const scan = intent(unit.readableId);
    const both = await Promise.all([record([scan]), record([scan])]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.map((r) => r.body.results[0].outcome.result)).toEqual(['disposed', 'disposed']);
    expect(both.map((r) => r.body.results[0].outcome.replayed).sort()).toEqual([false, true]);
    expect(await history(unit.id)).toBe(1);
  });

  it('a hold placed after approval blocks it; a refused intent is audited once however often it is retried', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    const held = await h.send(
      'post',
      '/api/retention/holds',
      {
        projectId: h.projects.a,
        scope: 'units',
        unitIds: [unit.id],
        reason: 'Claim review',
        idempotencyKey: newKey(),
      },
      'lm',
    );
    expect(held.status).toBe(201);
    const [seen] = await checked([intent(unit.readableId)]);
    expect(seen).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'on_hold', label: 'On hold: Claim review' }],
    });
    const scan = intent(unit.readableId);
    const [first] = await recorded([scan]);
    expect(first!.outcome.result).toBe('blocked');
    expect(first!.outcome.message).toMatch(/On hold: Claim review/);
    // Released since: the same intent still answers what it did; nothing new is recorded.
    const released = await h.send(
      'post',
      `/api/retention/holds/${held.body.id}/release`,
      { reason: 'Settled', version: 1, idempotencyKey: newKey() },
      'pe',
    );
    expect(released.status).toBe(200);
    const [again] = await recorded([scan]);
    expect(again!.outcome).toMatchObject({ result: 'blocked', replayed: true });
    expect(await history(unit.id)).toBe(1);
    expect(await status(unit.id)).toBe('approved_for_disposal');
    // A new scan after the release disposes it.
    const [fresh] = await recorded([intent(unit.readableId)]);
    expect(fresh!.outcome.result).toBe('disposed');
  });

  it('a later retain-until (extension after approval) and an open program block it', async () => {
    const hole = await newHole();
    const dated = await h.bucket({ hole, receivedDate: '2026-10-23' });
    const programmed = await oldBucket();
    at('2027-10-24');
    expect((await approve([dated.id, programmed.id])).status).toBe(201);
    const extended = await h.send(
      'post',
      '/api/retention/extensions',
      {
        projectId: h.projects.a,
        scope: 'units',
        unitIds: [dated.id],
        retainUntil: '2028-06-30',
        reason: 'Client asked',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    expect(extended.status, JSON.stringify(extended.body)).toBe(201);
    const programHole = (
      await h.db.pool.query<{ test_hole_id: string }>(
        'SELECT test_hole_id FROM storage_unit_hole_summary WHERE storage_unit_id = $1',
        [programmed.id],
      )
    ).rows[0]!.test_hole_id;
    const program = await submitted(programHole);
    const results = await recorded([intent(dated.readableId), intent(programmed.readableId)]);
    expect(results.map((r) => r.outcome.result)).toEqual(['blocked', 'blocked']);
    expect(results[0]!.outcome.blockers.map((b) => b.label)).toContain('Retain until 2028-06-30');
    expect(results[1]!.outcome.blockers.map((b) => b.label)).toContain(
      `Program ${program.programNumber} open`,
    );
    expect([await status(dated.id), await status(programmed.id)]).toEqual([
      'approved_for_disposal',
      'approved_for_disposal',
    ]);
  });

  it('a revoked approval is refused; one refused unit never undoes another unit in the batch', async () => {
    const revokedUnit = await oldBucket();
    const good = await oldBucket();
    at('2027-10-24');
    const approval = await approve([revokedUnit.id, good.id]);
    const approvalId = approval.body.approvals.find(
      (a: { storageUnitId: string }) => a.storageUnitId === revokedUnit.id,
    ).id as string;
    const [before] = await checked([intent(revokedUnit.readableId)]);
    expect(before!.status).toBe('approved');
    expect(
      (
        await h.send(
          'post',
          `/api/disposal/approvals/${approvalId}/revoke`,
          { reason: 'Keep it', idempotencyKey: newKey() },
          'pe',
        )
      ).status,
    ).toBe(200);
    const results = await recorded([intent(revokedUnit.readableId), intent(good.readableId)]);
    expect(results.map((r) => r.outcome.result)).toEqual(['not_approved', 'disposed']);
    expect(await status(revokedUnit.id)).toBe('in_stock');
  });

  it('a tested tube is never disposed here: it is pointed to Confirm removal after testing', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole, sampleReference: 'T1' });
    const program = await submitted(hole);
    const requestId = program.lines[0]!.requests[0]!.id;
    const move = (body: object, as: As) =>
      h.send(
        'post',
        `/api/test-requests/${requestId}/status`,
        { idempotencyKey: newKey(), ...body },
        as,
      );
    expect((await move({ to: 'in_progress', version: 1 }, 'tech')).status).toBe(200);
    const done = await move(
      {
        to: 'completed',
        version: 2,
        testedStorageUnitIds: [tube.id],
        actingStaffUserId: h.users.js,
      },
      'lab',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [seen] = await checked([intent(tube.readableId)]);
    expect(seen!.status).toBe('not_approved');
    expect(seen!.message).toMatch(/Confirm removal after testing/);
    const [result] = await recorded([intent(tube.readableId)]);
    expect(result!.outcome.result).toBe('not_approved');
    expect(await status(tube.id)).toBe('in_stock');
  });

  it('LAB is refused both routes whoever it names; nothing changes', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    const audits = await count('FROM audit_event');
    const scan = { ...intent(unit.readableId), scannedByUserId: h.users.lab };
    expect((await check([scan], 'lab')).status).toBe(403);
    expect((await record([scan], 'lab')).status).toBe(403);
    expect((await record([{ ...scan, scannedByUserId: h.users.lm }], 'lab')).status).toBe(403);
    expect(await status(unit.id)).toBe('approved_for_disposal');
    expect(await count('FROM audit_event')).toBe(audits);
    expect(await count('FROM disposal_scan_intent WHERE storage_unit_id = $1', [unit.id])).toBe(0);
  });

  it('a scan taken under another account is refused without history; a disabled account is refused', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    const theirs = intent(unit.readableId, 'lm');
    const [seen] = await checked([theirs], 'tech');
    expect(seen!.status).toBe('other_account');
    const [result] = await recorded([theirs], 'tech');
    expect(result!.outcome.result).toBe('other_account');
    expect(await status(unit.id)).toBe('approved_for_disposal');
    expect(await history(unit.id)).toBe(0);
    expect((await record([intent(unit.readableId, 'disabled')], 'disabled')).status).toBe(401);
  });

  it('refuses repeated intent IDs or units in one request, and an intent ID reused for another unit', async () => {
    const first = await oldBucket();
    const second = await oldBucket();
    at('2027-10-24');
    expect((await approve([first.id, second.id])).status).toBe(201);
    const id = randomUUID();
    expect(
      (await record([intent(first.readableId, 'tech', id), intent(second.readableId, 'tech', id)]))
        .status,
    ).toBe(400);
    expect(
      (await record([intent(first.readableId), intent(first.readableId.toLowerCase())])).status,
    ).toBe(400);
    expect((await record([])).status).toBe(400);
    const [done] = await recorded([intent(first.readableId, 'tech', id)]);
    expect(done!.outcome.result).toBe('disposed');
    const [reused] = await recorded([intent(second.readableId, 'tech', id)]);
    expect(reused!.outcome.result).toBe('intent_reused');
    expect((await checked([intent(second.readableId, 'tech', id)]))[0]!.status).toBe(
      'intent_reused',
    );
    // The same ID from another account is refused too, and the other unit stays approved.
    const [byOther] = await recorded([intent(first.readableId, 'lm', id)], 'lm');
    expect(byOther!.outcome.result).toBe('intent_reused');
    expect(await status(second.id)).toBe('approved_for_disposal');
  });

  it('a key first used by the single-scan route replays here instead of refusing', async () => {
    const unit = await oldBucket();
    at('2027-10-24');
    expect((await approve([unit.id])).status).toBe(201);
    const key = randomUUID();
    const single = await h.send(
      'post',
      '/api/disposal/remove',
      { suNumber: unit.readableId, idempotencyKey: key },
      'tech',
    );
    expect(single.status).toBe(200);
    const [replayed] = await recorded([intent(unit.readableId, 'tech', key)]);
    expect(replayed!.outcome).toMatchObject({ result: 'disposed', replayed: true });
    expect(await history(unit.id)).toBe(1);
  });
});
