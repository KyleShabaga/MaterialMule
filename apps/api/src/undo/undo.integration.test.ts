import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  UNDO_MOVE_WINDOW_MINUTES,
  moveSavedResponseSchema,
  storageUnitHistoryActionLabel,
  storageUnitHistoryPageSchema,
  undoBlockedResponseSchema,
  undoEligibilitySchema,
  undoResultSchema,
  type MoveRequest,
  type UndoBlockedReason,
} from '@materialmule/shared';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { BusinessClock } from '../retention/business-clock.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  receivingLabId,
} from '../test-support/fixtures.js';

// STRATA-123 at the API, against real PostgreSQL: Undo of a move is a guarded compensating move,
// rechecked at execution; Undo of a dismissal is the existing restore. Replays, a concurrent
// double POST, stale units, the window (business clock, no sleeps), removed access, other
// people's actions, locked units, retired places, LAB attribution, never-undoable actions, and
// proof that every refused call changes nothing. Fictional data only (DEMO-2601, invented people).

describe.runIf(testDatabaseUrl)('undo (STRATA-123)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let appName: string;
  let barrierUrl: string;
  const users: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const locations: Record<string, string> = {};
  let projectId: string;
  let receiptId: string;
  let unitSeq = 0;
  const station = randomUUID();

  const http = () => request(app.getHttpServer());
  const get = (path: string, who: string) => http().get(path).set('Cookie', cookies[who]!);
  const post = (path: string, who: string, body?: object) =>
    http().post(path).set('Cookie', cookies[who]!).set(CSRF_HEADER, '1').send(body);

  async function addUser(key: string, accountType: 'personal' | 'shared_lab') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [
        `User ${key}`,
        accountType === 'shared_lab' ? null : key.toUpperCase().slice(0, 4),
        accountType,
      ],
    );
    users[key] = rows[0]!.id;
  }

  async function signIn(key: string) {
    const accountType = key === 'lab' ? 'shared_lab' : 'personal';
    const session = await app.get(SessionService).create(users[key]!, accountType);
    cookies[key] = `${SESSION_COOKIE}=${session.token}`;
  }

  async function addLocation(code: string) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [code, `Shelf ${code}`],
    );
    locations[code] = rows[0]!.id;
  }

  async function addUnit() {
    unitSeq++;
    return insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId: locations.RECEIVING! },
      { readableId: `BKT-2026-${String(unitSeq).padStart(6, '0')}` },
    );
  }

  async function unitRow(id: string) {
    const { rows } = await db.pool.query<{ current_location_id: string; version: number }>(
      'SELECT current_location_id, version FROM storage_unit WHERE id = $1',
      [id],
    );
    return rows[0]!;
  }

  /** Moves the unit as `who` (LAB credits `mover`) and returns the saved movement event ID. */
  async function move(unitId: string, to: string, who = 'pat', mover?: string): Promise<string> {
    const body: MoveRequest = {
      clientMoveId: randomUUID(),
      storageUnitId: unitId,
      toLocationId: locations[to]!,
      baseVersion: (await unitRow(unitId)).version,
      scannedAt: '2026-11-12T09:15:00.000-07:00',
      capturedOffline: false,
      captureContext: {
        stationId: station,
        accountId: users[who]!,
        ...(mover ? { moverUserId: users[mover]! } : {}),
      },
    };
    const response = await post('/api/moves', who, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return moveSavedResponseSchema.parse(response.body).movementEventId;
  }

  const undo = (who: string, sourceId: string, extra: object = {}) =>
    post('/api/undo', who, {
      action: 'move',
      sourceId,
      idempotencyKey: randomUUID(),
      ...extra,
    });

  async function eligibility(who: string, sourceId: string, query = '', action = 'move') {
    const response = await get(`/api/undo/${action}/${sourceId}${query}`, who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return undoEligibilitySchema.parse(response.body);
  }

  /** Movement, reversal, unit, conflict, notification and audit rows: what a refusal must keep. */
  async function fingerprint() {
    const { rows } = await db.pool.query<{ snapshot: string }>(
      `SELECT concat_ws('|',
         (SELECT count(*) FROM movement_event), (SELECT count(*) FROM move_action),
         (SELECT count(*) FROM movement_reversal), (SELECT count(*) FROM audit_event),
         (SELECT count(*) FROM location_conflict),
         (SELECT string_agg(concat_ws(':', id, current_location_id, version, status), ',' ORDER BY id)
          FROM storage_unit),
         (SELECT string_agg(concat_ws(':', id, dismissed_at, read_at),
                            ',' ORDER BY id) FROM notification)) AS snapshot`,
    );
    return rows[0]!.snapshot;
  }

  async function expectBlocked(
    response: request.Response,
    reason: UndoBlockedReason,
  ): Promise<void> {
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(undoBlockedResponseSchema.parse(response.body).blockedReason).toBe(reason);
  }

  /** Holds a row lock on another connection; `waitFor(n)` resolves once n requests wait on it. */
  async function barrier(lockSql: string, params: unknown[]) {
    const client = new pg.Client({ connectionString: barrierUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query(lockSql, params);
    return {
      async waitFor(n: number) {
        await vi.waitFor(
          async () => {
            const { rows } = await client.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE application_name = $1 AND wait_event_type = 'Lock'`,
              [appName],
            );
            if (rows[0]!.n < n) throw new Error(`${rows[0]!.n} of ${n} waiting`);
          },
          { timeout: 10_000, interval: 10 },
        );
      },
      async release() {
        await client.query('ROLLBACK');
        await client.end();
      },
    };
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await addUser('lab', 'shared_lab');
    await addUser('pat', 'personal');
    await addUser('kim', 'personal');
    await addUser('jo', 'personal');
    await addUser('sam', 'personal');
    locations.RECEIVING = await receivingLabId(db.pool);
    await addLocation('SH-A-01');
    await addLocation('SH-A-02');
    projectId = await insertProject(db.pool, 'DEMO-2601', users.pat!);
    receiptId = await insertReceipt(db.pool, projectId, users.pat!, 50);

    appName = `mm_undo_${db.schema}`;
    const url = new URL(databaseUrlForSchema(db.schema));
    barrierUrl = url.toString();
    url.searchParams.set('application_name', appName);
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    for (const key of ['lab', 'pat', 'kim', 'jo', 'sam']) await signIn(key);
  });

  afterEach(() => {
    app?.get(BusinessClock).set(null);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('undoes a move with a new linked move back; the original and its audit stay untouched', async () => {
    const unit = await addUnit();
    const original = await move(unit, 'SH-A-01');
    const { rows: before } = await db.pool.query('SELECT * FROM movement_event WHERE id = $1', [
      original,
    ]);
    const offered = await eligibility('pat', original);
    expect(offered).toMatchObject({ eligible: true, blockedReason: null });
    const until = Date.parse(offered.availableUntil!);
    expect(until - before[0].saved_at.getTime()).toBe(UNDO_MOVE_WINDOW_MINUTES * 60_000);

    const response = await undo('pat', original);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = undoResultSchema.parse(response.body);
    expect(result).toMatchObject({
      action: 'move',
      sourceId: original,
      replayed: false,
      storageUnit: { id: unit, locationId: locations.RECEIVING, version: 3 },
      physicalReminder: 'Put the holder back on RECEIVING too.',
    });
    expect(await unitRow(unit)).toEqual({ current_location_id: locations.RECEIVING, version: 3 });

    const { rows: reversal } = await db.pool.query(
      `SELECT kind, from_location_id, to_location_id, base_version, resulting_version,
              actor_user_id, client_move_id
       FROM movement_event WHERE id = $1`,
      [result.reversalEventId],
    );
    expect(reversal[0]).toEqual({
      kind: 'move',
      from_location_id: locations['SH-A-01'],
      to_location_id: locations.RECEIVING,
      base_version: 2,
      resulting_version: 3,
      actor_user_id: users.pat,
      client_move_id: expect.any(String),
    });
    const { rows: after } = await db.pool.query('SELECT * FROM movement_event WHERE id = $1', [
      original,
    ]);
    expect(after).toEqual(before);
    const { rows: link } = await db.pool.query(
      'SELECT reversal_event_id FROM movement_reversal WHERE original_event_id = $1',
      [original],
    );
    expect(link).toEqual([{ reversal_event_id: result.reversalEventId }]);

    // History reads like a move, newest first: the undo, then the move it reversed.
    const history = storageUnitHistoryPageSchema.parse(
      (await get(`/api/storage-units/${unit}/history`, 'kim')).body,
    );
    const moves = history.items.filter((e) => e.action === 'storage_unit.moved');
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({
      after: { location: { code: 'RECEIVING' }, undoOfMovementEventId: original },
    });
    expect(storageUnitHistoryActionLabel(moves[0]!.action, moves[0]!.after)).toBe('Move undone');
    expect(storageUnitHistoryActionLabel(moves[1]!.action, moves[1]!.after)).toBe('Moved');

    // Undo of the undo is not offered: the reversal is not an undoable original.
    expect((await eligibility('pat', result.reversalEventId)).blockedReason).toBe('not_found');
    expect((await eligibility('pat', original)).blockedReason).toBe('already_undone');
  });

  it('replays a retry with the same key; another key for the same move is already_undone', async () => {
    const unit = await addUnit();
    const original = await move(unit, 'SH-A-01');
    const body = { action: 'move', sourceId: original, idempotencyKey: randomUUID() };
    const first = undoResultSchema.parse((await post('/api/undo', 'pat', body)).body);
    const snapshot = await fingerprint();
    const again = await post('/api/undo', 'pat', body);
    expect(again.status).toBe(200);
    expect(undoResultSchema.parse(again.body)).toEqual({ ...first, replayed: true });
    await expectBlocked(await undo('pat', original), 'already_undone');
    // The key is the caller's: another account can't adopt it or learn the outcome.
    const stolen = await post('/api/undo', 'kim', body);
    expect(stolen.status).toBe(409);
    expect(stolen.body.code).toBe('idempotency_key_reused');
    expect(await fingerprint()).toBe(snapshot);
  });

  it('a concurrent double POST saves one reversal (different keys and the same key)', async () => {
    for (const sameKey of [false, true]) {
      const unit = await addUnit();
      const original = await move(unit, 'SH-A-01');
      const key = randomUUID();
      const hold = await barrier('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit]);
      const send = () =>
        Promise.resolve(
          post('/api/undo', 'pat', {
            action: 'move',
            sourceId: original,
            idempotencyKey: sameKey ? key : randomUUID(),
          }),
        );
      const racing = [send(), send()];
      await hold.waitFor(2);
      await hold.release();
      const responses = await Promise.all(racing);
      const statuses = responses.map((r) => r.status).sort();
      if (sameKey) {
        expect(statuses).toEqual([200, 200]);
        expect(responses.map((r) => r.body.replayed).sort()).toEqual([false, true]);
      } else {
        expect(statuses).toEqual([200, 409]);
        const refused = responses.find((r) => r.status === 409)!;
        expect(refused.body.blockedReason).toBe('already_undone');
      }
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n FROM movement_event
         WHERE storage_unit_id = $1 AND to_location_id = $2`,
        [unit, locations.RECEIVING],
      );
      expect(rows[0]).toEqual({ n: 1 });
      expect(await unitRow(unit)).toEqual({ current_location_id: locations.RECEIVING, version: 3 });
    }
  });

  it('refuses once the unit changed since (a later move by someone else): changed_since', async () => {
    const unit = await addUnit();
    const original = await move(unit, 'SH-A-01');
    await move(unit, 'SH-A-02', 'kim');
    expect((await eligibility('pat', original)).blockedReason).toBe('changed_since');
    const snapshot = await fingerprint();
    await expectBlocked(await undo('pat', original), 'changed_since');
    expect(await fingerprint()).toBe(snapshot);
  });

  it('refuses after the window (business clock): expired', async () => {
    const unit = await addUnit();
    const original = await move(unit, 'SH-A-01');
    const { rows } = await db.pool.query<{ saved_at: Date }>(
      'SELECT saved_at FROM movement_event WHERE id = $1',
      [original],
    );
    const clock = app.get(BusinessClock);
    const windowEnd = rows[0]!.saved_at.getTime() + UNDO_MOVE_WINDOW_MINUTES * 60_000;
    clock.set(new Date(windowEnd));
    expect((await eligibility('pat', original)).eligible).toBe(true);
    clock.set(new Date(windowEnd + 1));
    expect((await eligibility('pat', original)).blockedReason).toBe('expired');
    const snapshot = await fingerprint();
    await expectBlocked(await undo('pat', original), 'expired');
    expect(await fingerprint()).toBe(snapshot);
  });

  it('refuses when the person can no longer act: pending or disabled accounts, a LAB mover who left', async () => {
    const unit = await addUnit();
    const bySam = await move(unit, 'SH-A-01', 'sam');
    const snapshot = await fingerprint();
    await db.pool.query(`UPDATE app_user SET status = 'pending' WHERE id = $1`, [users.sam]);
    const pending = await undo('sam', bySam);
    expect(pending.status).toBe(403);
    expect(pending.body.code).toBe('access_pending');
    await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [users.sam]);
    expect((await undo('sam', bySam)).status).toBe(401);
    expect((await get(`/api/undo/move/${bySam}`, 'sam')).status).toBe(401);
    expect(await fingerprint()).toBe(snapshot);

    // LAB credited Jo, who has since left: the station can't undo in Jo's name.
    const other = await addUnit();
    const byLab = await move(other, 'SH-A-01', 'lab', 'jo');
    await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [users.jo]);
    try {
      expect((await eligibility('lab', byLab, `?moverUserId=${users.jo}`)).blockedReason).toBe(
        'not_permitted',
      );
      const before = await fingerprint();
      await expectBlocked(await undo('lab', byLab, { moverUserId: users.jo }), 'not_permitted');
      expect(await fingerprint()).toBe(before);
    } finally {
      await db.pool.query(`UPDATE app_user SET status = 'active' WHERE id = $1`, [users.jo]);
    }
  });

  it("another person's move or an unknown ID is not_found, never revealed", async () => {
    const unit = await addUnit();
    const original = await move(unit, 'SH-A-01');
    const unknown = randomUUID();
    for (const [who, id] of [
      ['kim', original],
      ['pat', unknown],
      ['lab', original],
    ] as const) {
      const offered = await eligibility(who, id);
      expect(offered).toMatchObject({ eligible: false, blockedReason: 'not_found' });
      expect(offered.availableUntil).toBeNull();
    }
    const snapshot = await fingerprint();
    await expectBlocked(await undo('kim', original), 'not_found');
    await expectBlocked(await undo('pat', unknown), 'not_found');
    // A personal account can't name someone else as the mover.
    await expectBlocked(await undo('pat', original, { moverUserId: users.kim }), 'not_found');
    expect(await fingerprint()).toBe(snapshot);
  });

  it('refuses a disposed, approved-for-disposal or conflicted unit: record_locked', async () => {
    for (const status of ['disposed', 'approved_for_disposal']) {
      const unit = await addUnit();
      const original = await move(unit, 'SH-A-01');
      await db.pool.query('UPDATE storage_unit SET status = $2 WHERE id = $1', [unit, status]);
      expect((await eligibility('pat', original)).blockedReason).toBe('record_locked');
      const snapshot = await fingerprint();
      await expectBlocked(await undo('pat', original), 'record_locked');
      expect(await fingerprint()).toBe(snapshot);
    }
    // A stale scan from another station opens a location conflict without changing the unit.
    const unit = await addUnit();
    const original = await move(unit, 'SH-A-01');
    const stale = await post('/api/moves', 'kim', {
      clientMoveId: randomUUID(),
      storageUnitId: unit,
      toLocationId: locations['SH-A-02'],
      baseVersion: 1,
      scannedAt: '2026-11-12T09:10:00.000-07:00',
      capturedOffline: true,
      captureContext: { stationId: randomUUID(), accountId: users.kim },
    });
    expect(stale.status).toBe(409);
    expect((await eligibility('pat', original)).blockedReason).toBe('record_locked');
    const snapshot = await fingerprint();
    await expectBlocked(await undo('pat', original), 'record_locked');
    expect(await fingerprint()).toBe(snapshot);
  });

  it('refuses when the place it came from is retired: location_unavailable', async () => {
    await addLocation('SH-OLD');
    const unit = await addUnit();
    await move(unit, 'SH-OLD');
    const original = await move(unit, 'SH-A-01');
    await db.pool.query(
      `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Shelf removed'
       WHERE id = $1`,
      [locations['SH-OLD']],
    );
    expect((await eligibility('pat', original)).blockedReason).toBe('location_unavailable');
    const snapshot = await fingerprint();
    await expectBlocked(await undo('pat', original), 'location_unavailable');
    expect(await fingerprint()).toBe(snapshot);
  });

  it('LAB undoes its own station move only for the same picked person (attribution only)', async () => {
    const unit = await addUnit();
    const original = await move(unit, 'SH-A-01', 'lab', 'jo');
    for (const query of ['', `?moverUserId=${users.kim}`]) {
      expect((await eligibility('lab', original, query)).blockedReason).toBe('not_found');
    }
    const snapshot = await fingerprint();
    await expectBlocked(await undo('lab', original), 'not_found');
    await expectBlocked(await undo('lab', original, { moverUserId: users.kim }), 'not_found');
    // Jo's own personal account didn't save it (LAB did), so Jo can't undo it either.
    await expectBlocked(await undo('jo', original), 'not_found');
    expect(await fingerprint()).toBe(snapshot);

    expect((await eligibility('lab', original, `?moverUserId=${users.jo}`)).eligible).toBe(true);
    const response = await undo('lab', original, { moverUserId: users.jo });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { rows } = await db.pool.query(
      'SELECT actor_user_id, mover_user_id FROM movement_event WHERE id = $1',
      [response.body.reversalEventId],
    );
    expect(rows[0]).toEqual({ actor_user_id: users.lab, mover_user_id: users.jo });
  });

  it('never accepts a never-undoable action (disposal, receipt, report, test, approval)', async () => {
    const snapshot = await fingerprint();
    for (const action of [
      'disposal',
      'disposal_record',
      'receipt_confirm',
      'id_issue',
      'report_issue',
      'destructive_test',
      'approval_revoke',
      'disposal_list_add',
      'test_completion',
    ]) {
      const response = await post('/api/undo', 'pat', {
        action,
        sourceId: randomUUID(),
        idempotencyKey: randomUUID(),
      });
      expect(response.status, action).toBe(400);
      expect((await get(`/api/undo/${action}/${randomUUID()}`, 'pat')).status, action).toBe(400);
    }
    expect(await fingerprint()).toBe(snapshot);
  });

  describe('notification_dismiss', () => {
    async function notice(recipient: string, dismissed: boolean): Promise<string> {
      const { rows: item } = await db.pool.query<{ id: string }>(
        `INSERT INTO action_item (kind, target_role, entity_type, entity_id, target_user_id,
                                  project_id, created_by_user_id, created_by_name_snapshot, reason,
                                  idempotency_key, request_hash)
         VALUES ('retention_request', 'lab_manager', 'retention_request', gen_random_uuid(), $3,
                 $1, $2, 'User kim', 'Fictional reason', gen_random_uuid(), 'hash')
         RETURNING id`,
        [projectId, users.kim, recipient],
      );
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key, read_at,
                                   dismissed_at)
         VALUES ($1, 'action_request.opened', $2::uuid, 'action_item:' || $2::text || ':opened',
                 now(), CASE WHEN $3 THEN now() END)
         RETURNING id`,
        [recipient, item[0]!.id, dismissed],
      );
      return rows[0]!.id;
    }

    const restore = (who: string, sourceId: string, idempotencyKey = randomUUID()) =>
      post('/api/undo', who, { action: 'notification_dismiss', sourceId, idempotencyKey });

    it('restores a dismissed notice for its recipient; it stays read and the request is unchanged', async () => {
      const id = await notice(users.pat!, true);
      const { rows: requestBefore } = await db.pool.query(
        'SELECT a.* FROM action_item a JOIN notification n ON n.action_item_id = a.id WHERE n.id = $1',
        [id],
      );
      expect(await eligibility('pat', id, '', 'notification_dismiss')).toMatchObject({
        eligible: true,
        availableUntil: null,
      });
      const response = await restore('pat', id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(undoResultSchema.parse(response.body)).toMatchObject({
        action: 'notification_dismiss',
        sourceId: id,
        storageUnit: null,
        physicalReminder: null,
      });
      const { rows } = await db.pool.query(
        'SELECT dismissed_at, read_at FROM notification WHERE id = $1',
        [id],
      );
      expect(rows[0]).toEqual({ dismissed_at: null, read_at: expect.any(Date) });
      const { rows: requestAfter } = await db.pool.query(
        'SELECT a.* FROM action_item a JOIN notification n ON n.action_item_id = a.id WHERE n.id = $1',
        [id],
      );
      expect(requestAfter).toEqual(requestBefore);
      // Now there is nothing left to undo.
      expect((await eligibility('pat', id, '', 'notification_dismiss')).blockedReason).toBe(
        'already_undone',
      );
    });

    it('a not-dismissed notice is already_undone; another person, LAB or unknown is not_found', async () => {
      const open = await notice(users.pat!, false);
      const dismissed = await notice(users.pat!, true);
      expect((await eligibility('pat', open, '', 'notification_dismiss')).blockedReason).toBe(
        'already_undone',
      );
      for (const [who, id] of [
        ['kim', dismissed],
        ['lab', dismissed],
        ['pat', randomUUID()],
      ] as const) {
        expect((await eligibility(who, id, '', 'notification_dismiss')).blockedReason).toBe(
          'not_found',
        );
      }
      const snapshot = await fingerprint();
      await expectBlocked(await restore('pat', open), 'already_undone');
      await expectBlocked(await restore('kim', dismissed), 'not_found');
      await expectBlocked(await restore('lab', dismissed), 'not_found');
      expect(await fingerprint()).toBe(snapshot);
    });
  });
});
