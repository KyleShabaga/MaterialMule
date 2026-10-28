import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  locationConflictDetailSchema,
  moveConflictResponseSchema,
  moveSavedResponseSchema,
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  type MoveRequest,
} from '@materialmule/shared';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
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

// MM-T28 card section 12 D at the API, against real PostgreSQL: idempotent delivery, lost
// responses, two LAB stations racing (same LAB account), committed conflict replay, predecessor
// chains, account changes, retirement/removal races and rollback. Races use a separate
// connection holding the contested row lock as a barrier: the requests are released only once
// the database shows them all waiting on it, so no test depends on timing. Fictional data only.

describe.runIf(testDatabaseUrl)('storage moves and location conflicts (MM-T28)', () => {
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
  // Two browser profiles (LAB computers) signed in as the same LAB account.
  const stationA = randomUUID();
  const stationB = randomUUID();

  const http = () => request(app.getHttpServer());
  const get = (path: string, who: string) => http().get(path).set('Cookie', cookies[who]!);
  const post = (path: string, who: string, body?: object) =>
    http().post(path).set('Cookie', cookies[who]!).set(CSRF_HEADER, '1').send(body);

  async function addUser(
    key: string,
    accountType: 'personal' | 'shared_lab',
    roles: string[] = [],
  ) {
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
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
  }

  async function signIn(key: string, cookieKey = key) {
    const accountType = key.startsWith('lab') ? 'shared_lab' : 'personal';
    const session = await app.get(SessionService).create(users[key]!, accountType);
    cookies[cookieKey] = `${SESSION_COOKIE}=${session.token}`;
    return session.sessionId;
  }

  async function addLocation(code: string, name: string) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [code, name],
    );
    locations[code] = rows[0]!.id;
    return rows[0]!.id;
  }

  async function addUnit(status = 'in_stock') {
    unitSeq++;
    const id = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId: locations.RECEIVING! },
      { readableId: `BKT-2026-${String(unitSeq).padStart(6, '0')}` },
    );
    if (status !== 'in_stock') {
      await db.pool.query('UPDATE storage_unit SET status = $2 WHERE id = $1', [id, status]);
    }
    return id;
  }

  async function unitRow(id: string) {
    const { rows } = await db.pool.query<{
      readable_id: string;
      current_location_id: string;
      version: number;
      status: string;
    }>('SELECT readable_id, current_location_id, version, status FROM storage_unit WHERE id = $1', [
      id,
    ]);
    return rows[0]!;
  }

  async function count(sql: string, params: unknown[] = []) {
    const { rows } = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params);
    return rows[0]!.n;
  }

  /** A frozen move intent, as a station's queue stores it. */
  function intent(
    unitId: string,
    to: string,
    options: {
      who?: string;
      station?: string;
      baseVersion?: number;
      previous?: string;
      offline?: boolean;
      mover?: string | null;
      scannedAt?: string;
    } = {},
  ): MoveRequest {
    const who = options.who ?? 'lab';
    const mover =
      options.mover === undefined ? (who.startsWith('lab') ? users.jo : undefined) : options.mover;
    return {
      clientMoveId: randomUUID(),
      storageUnitId: unitId,
      toLocationId: locations[to] ?? to,
      baseVersion: options.baseVersion ?? 1,
      scannedAt: options.scannedAt ?? '2026-10-27T09:15:00.000-06:00',
      capturedOffline: options.offline ?? false,
      ...(options.previous ? { previousClientMoveId: options.previous } : {}),
      captureContext: {
        stationId: options.station ?? stationA,
        accountId: users[who.replace(/[AB2]$/, '')]!,
        ...(mover ? { moverUserId: mover } : {}),
      },
    };
  }

  const send = (body: MoveRequest, who = 'labA') => post('/api/moves', who, body);
  /** Sends now (supertest only sends once then() is called) so a barrier can hold it. */
  const start = <T>(test: PromiseLike<T>): Promise<T> => Promise.resolve(test);

  /**
   * Holds a row lock on another connection until `release`; `waitFor(n)` resolves once n of the
   * app's connections are blocked behind it (pg_stat_activity), never after a fixed delay.
   */
  async function barrier(lockSql: string, params: unknown[]) {
    const client = new pg.Client({ connectionString: barrierUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query(lockSql, params);
    return {
      client,
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
      async release(commit = false) {
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        await client.end();
      },
    };
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await addUser('lab', 'shared_lab');
    await addUser('tech', 'personal');
    await addUser('lm', 'personal', ['lab_manager']);
    await addUser('jo', 'personal');
    await addUser('kim', 'personal');
    locations.RECEIVING = await receivingLabId(db.pool);
    await addLocation('WH-C1', 'Warehouse C1');
    await addLocation('WH-C2', 'Warehouse C2');
    await addLocation('LAB-B1', 'Lab Bench 1');
    projectId = await insertProject(db.pool, 'DEMO-2601', users.tech!);
    receiptId = await insertReceipt(db.pool, projectId, users.tech!, 50);

    appName = `mm_t28_${db.schema}`;
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
    await signIn('lab', 'labA');
    await signIn('lab', 'labB');
    await signIn('tech');
    await signIn('lm');
    await signIn('kim');
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('P01/AC1: online moves save with actor, time and one version step each; IDs unchanged', async () => {
    const u1 = await addUnit();
    const u2 = await addUnit();
    const before = await unitRow(u1);
    for (const unit of [u1, u2]) {
      const response = await send(intent(unit, 'WH-C1'));
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const saved = moveSavedResponseSchema.parse(response.body);
      expect(saved).toMatchObject({
        outcome: 'saved',
        appliedToLocationId: locations['WH-C1'],
        resultingVersion: 2,
        replayed: false,
      });
      expect((await unitRow(unit)).current_location_id).toBe(locations['WH-C1']);
    }
    expect((await unitRow(u1)).readable_id).toBe(before.readable_id);
    const { rows } = await db.pool.query(
      `SELECT kind, actor_user_id, mover_name_snapshot, station_id, source, saved_at, scanned_at
       FROM movement_event WHERE storage_unit_id = $1`,
      [u1],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'move',
        actor_user_id: users.lab,
        mover_name_snapshot: 'User jo',
        station_id: stationA,
        source: 'online',
      }),
    ]);
    expect(rows[0].saved_at).not.toEqual(rows[0].scanned_at);
    const history = storageUnitHistoryPageSchema.parse(
      (await get(`/api/storage-units/${u1}/history`, 'tech')).body,
    );
    expect(history.items[0]).toMatchObject({
      action: 'storage_unit.moved',
      receiver: { name: 'User jo' },
      before: { location: { code: 'RECEIVING' } },
      after: { location: { code: 'WH-C1', name: 'Warehouse C1' }, source: 'online' },
    });
  });

  it('P08/AC6: a retry after a lost response replays once, even after another station moved it', async () => {
    const unit = await addUnit();
    const move = intent(unit, 'WH-C2', { offline: true });
    const first = await send(move);
    expect(first.status).toBe(201);
    // The response was lost; station B then moves the unit from the new version.
    expect(
      (await send(intent(unit, 'LAB-B1', { station: stationB, baseVersion: 2 }), 'labB')).status,
    ).toBe(201);
    const retry = await send(move);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ...first.body, replayed: true });
    expect(await count('FROM movement_event WHERE client_move_id = $1', [move.clientMoveId])).toBe(
      1,
    );
    // The replay never re-applied: the unit stays at B's newer location.
    expect(await unitRow(unit)).toMatchObject({
      current_location_id: locations['LAB-B1'],
      version: 3,
    });
  });

  it('P10: a committed ID reused with a different intent or by another account is refused', async () => {
    const unit = await addUnit();
    const move = intent(unit, 'WH-C1');
    expect((await send(move)).status).toBe(201);
    const altered = await send({ ...move, toLocationId: locations['WH-C2']! });
    expect(altered.status).toBe(409);
    expect(altered.body.code).toBe('idempotency_key_reused');
    // Another account can neither adopt nor read it: its own capture context changes the intent.
    const adopted = await post('/api/moves', 'tech', {
      ...move,
      captureContext: { stationId: stationA, accountId: users.tech },
    });
    expect(adopted.status).toBe(409);
    expect(adopted.body).toEqual({
      code: 'idempotency_key_reused',
      message: expect.any(String),
    });
    // ...and can't send the LAB queue as it was captured (P15).
    const replayed = await post('/api/moves', 'tech', move);
    expect(replayed.status).toBe(403);
    expect(replayed.body.code).toBe('capture_account_mismatch');
    expect(await unitRow(unit)).toMatchObject({
      current_location_id: locations['WH-C1'],
      version: 2,
    });
  });

  it('P06/AC3/AC8: a stale queued move from a second LAB station becomes a durable conflict', async () => {
    const unit = await addUnit();
    const queued = intent(unit, 'WH-C2', { station: stationA, offline: true });
    // Station B (same LAB account) saves C1 first.
    expect((await send(intent(unit, 'WH-C1', { station: stationB }), 'labB')).status).toBe(201);
    const response = await send(queued);
    expect(response.status).toBe(409);
    const conflict = moveConflictResponseSchema.parse(response.body);
    expect(conflict).toMatchObject({ outcome: 'conflict', currentVersion: 2, replayed: false });
    // Nothing was decided: the saved location is B's, and both events are kept.
    expect(await unitRow(unit)).toMatchObject({
      current_location_id: locations['WH-C1'],
      version: 2,
    });
    const detail = locationConflictDetailSchema.parse(
      (await get(`/api/location-conflicts/${conflict.conflictId}`, 'labA')).body,
    );
    expect(detail).toMatchObject({
      status: 'open',
      version: 1,
      storageUnit: { savedLocation: { code: 'WH-C1' }, version: 2 },
      savedEvent: {
        kind: 'move',
        to: { code: 'WH-C1' },
        station: stationB.slice(0, 8).toUpperCase(),
      },
      events: [
        {
          id: conflict.attemptEventId,
          kind: 'contested',
          to: { code: 'WH-C2' },
          source: 'queued',
          actor: { accountType: 'shared_lab' },
          station: stationA.slice(0, 8).toUpperCase(),
        },
      ],
      resolution: null,
    });
    const unitDetail = storageUnitDetailSchema.parse(
      (await get(`/api/storage-units/${unit}`, 'tech')).body,
    );
    expect(unitDetail.location.code).toBe('WH-C1');
    expect(unitDetail.locationConflict).toMatchObject({ id: conflict.conflictId, version: 1 });
  });

  it('P07/AC8: two LAB stations deliver distinct moves from one base at once → one saved, one conflict', async () => {
    const unit = await addUnit();
    const a = intent(unit, 'WH-C1', { station: stationA });
    const b = intent(unit, 'WH-C2', { station: stationB });
    const gate = await barrier('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit]);
    const pending = [start(send(a, 'labA')), start(send(b, 'labB'))];
    await gate.waitFor(2);
    await gate.release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = responses.find((r) => r.status === 201)!;
    const after = await unitRow(unit);
    expect(after.version).toBe(2);
    expect(after.current_location_id).toBe(winner.body.appliedToLocationId);
    expect(await count('FROM movement_event WHERE storage_unit_id = $1', [unit])).toBe(2);
    expect(
      await count(`FROM location_conflict WHERE storage_unit_id = $1 AND status = 'open'`, [unit]),
    ).toBe(1);
    // Device time decided nothing: both scans reported the same instant.
    expect(a.scannedAt).toBe(b.scannedAt);
  });

  it('two simultaneous first deliveries of one action converge on one outcome', async () => {
    const unit = await addUnit();
    const move = intent(unit, 'WH-C1');
    const gate = await barrier('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit]);
    const pending = [start(send(move, 'labA')), start(send(move, 'labA'))];
    await gate.waitFor(2);
    await gate.release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(responses[0]!.body.movementEventId).toBe(responses[1]!.body.movementEventId);
    expect(await count('FROM movement_event WHERE storage_unit_id = $1', [unit])).toBe(1);
    expect((await unitRow(unit)).version).toBe(2);
  });

  describe('conflict resolution', () => {
    async function conflictFor(unit: string) {
      expect((await send(intent(unit, 'WH-C1', { station: stationB }), 'labB')).status).toBe(201);
      const attempt = intent(unit, 'WH-C2', { station: stationA, offline: true });
      const response = await send(attempt);
      expect(response.status).toBe(409);
      return { attempt, conflict: moveConflictResponseSchema.parse(response.body) };
    }

    const resolveBody = (over: Record<string, unknown> = {}) => ({
      clientResolutionId: randomUUID(),
      locationId: locations['WH-C1'],
      note: 'Checked the shelf: it is on C1.',
      expectedUnitVersion: 2,
      expectedConflictVersion: 1,
      ...over,
    });

    it('P09/P17/AC4: replay keeps the conflict; LAB is refused; a personal account resolves with history kept', async () => {
      const unit = await addUnit();
      const { attempt, conflict } = await conflictFor(unit);
      const again = await send(attempt);
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ ...conflict, replayed: true });
      expect(await count('FROM movement_event WHERE conflict_id = $1', [conflict.conflictId])).toBe(
        1,
      );

      // LAB never settles a conflict, even with a Lab Manager named as the mover.
      const lab = await post(
        `/api/location-conflicts/${conflict.conflictId}/resolve`,
        'labA',
        resolveBody(),
      );
      expect(lab.status).toBe(403);

      const body = resolveBody();
      const resolved = await post(
        `/api/location-conflicts/${conflict.conflictId}/resolve`,
        'tech',
        body,
      );
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
      expect(resolved.body.conflict).toMatchObject({
        status: 'resolved',
        version: 2,
        storageUnit: { savedLocation: { code: 'WH-C1' }, version: 3 },
        resolution: { resolvedBy: { name: 'User tech' }, location: { code: 'WH-C1' } },
      });
      expect(resolved.body.conflict.events.map((e: { kind: string }) => e.kind)).toEqual([
        'contested',
        'resolution',
      ]);
      // Same resolution again: replayed, nothing new.
      const replay = await post(
        `/api/location-conflicts/${conflict.conflictId}/resolve`,
        'tech',
        body,
      );
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      // The conflicted attempt still replays as the conflict it was; nothing reopens or moves.
      const late = await send(attempt);
      expect(late.status).toBe(409);
      expect(late.body.conflictId).toBe(conflict.conflictId);
      expect(
        await count(`FROM location_conflict WHERE storage_unit_id = $1 AND status = 'open'`, [
          unit,
        ]),
      ).toBe(0);
      expect(await unitRow(unit)).toMatchObject({
        current_location_id: locations['WH-C1'],
        version: 3,
      });

      const history = storageUnitHistoryPageSchema.parse(
        (await get(`/api/storage-units/${unit}/history`, 'labA')).body,
      );
      expect(history.items.map((item) => item.action).slice(0, 3)).toEqual([
        'storage_unit.location_conflict_resolved',
        'storage_unit.location_conflict',
        'storage_unit.moved',
      ]);
    });

    it('P18: racing resolutions, stale versions and an attempt racing a resolution lose nothing', async () => {
      const unit = await addUnit();
      const { conflict } = await conflictFor(unit);
      // A new contested attempt joins the open conflict and bumps its version...
      const joined = await send(
        intent(unit, 'LAB-B1', { station: stationB, baseVersion: 2 }),
        'labB',
      );
      expect(joined.status).toBe(409);
      expect(joined.body.conflictId).toBe(conflict.conflictId);
      // ...so a resolution based on what the person saw before is stale, not silently applied.
      const stale = await post(
        `/api/location-conflicts/${conflict.conflictId}/resolve`,
        'tech',
        resolveBody(),
      );
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('conflict_version_changed');
      expect(stale.body.current.events).toHaveLength(2);

      const gate = await barrier('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit]);
      const pending = [
        start(
          post(
            `/api/location-conflicts/${conflict.conflictId}/resolve`,
            'tech',
            resolveBody({ expectedConflictVersion: 2 }),
          ),
        ),
        start(
          post(
            `/api/location-conflicts/${conflict.conflictId}/resolve`,
            'kim',
            resolveBody({ expectedConflictVersion: 2, locationId: locations['LAB-B1'] }),
          ),
        ),
      ];
      await gate.waitFor(2);
      await gate.release();
      const responses = await Promise.all(pending);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(responses.find((r) => r.status === 409)!.body.code).toBe('conflict_already_resolved');
      expect(
        await count(`FROM movement_event WHERE conflict_id = $1 AND kind = 'resolution'`, [
          conflict.conflictId,
        ]),
      ).toBe(1);
      expect(
        await count(`FROM movement_event WHERE conflict_id = $1 AND kind = 'contested'`, [
          conflict.conflictId,
        ]),
      ).toBe(2);
    });

    it('a resolution ID reused on another conflict is refused', async () => {
      const first = await conflictFor(await addUnit());
      const second = await conflictFor(await addUnit());
      const id = randomUUID();
      expect(
        (
          await post(
            `/api/location-conflicts/${first.conflict.conflictId}/resolve`,
            'tech',
            resolveBody({ clientResolutionId: id }),
          )
        ).status,
      ).toBe(201);
      const reused = await post(
        `/api/location-conflicts/${second.conflict.conflictId}/resolve`,
        'tech',
        resolveBody({ clientResolutionId: id }),
      );
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('idempotency_key_reused');
    });

    it('a retired location can’t be confirmed as the actual location', async () => {
      const unit = await addUnit();
      const { conflict } = await conflictFor(unit);
      const shelf = await addLocation('OLD-1', 'Old shelf');
      await db.pool.query(
        `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Gone' WHERE id = $1`,
        [shelf],
      );
      const response = await post(
        `/api/location-conflicts/${conflict.conflictId}/resolve`,
        'tech',
        resolveBody({ locationId: shelf }),
      );
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('location_retired');
    });
  });

  it('a move while a conflict is open joins it instead of deciding the location', async () => {
    const unit = await addUnit();
    expect((await send(intent(unit, 'WH-C1', { station: stationB }), 'labB')).status).toBe(201);
    const first = await send(intent(unit, 'WH-C2'));
    expect(first.status).toBe(409);
    // A fresh scan with the current version still waits for a person to confirm.
    const fresh = await post(
      '/api/moves',
      'tech',
      intent(unit, 'LAB-B1', { who: 'tech', baseVersion: 2 }),
    );
    expect(fresh.status).toBe(409);
    expect(fresh.body.conflictId).toBe(first.body.conflictId);
    const { rows } = await db.pool.query('SELECT version FROM location_conflict WHERE id = $1', [
      first.body.conflictId,
    ]);
    expect(rows[0].version).toBe(2);
    expect((await unitRow(unit)).current_location_id).toBe(locations['WH-C1']);
  });

  describe('P11/P12: successive offline moves linked to their predecessor', () => {
    it('apply in order using the predecessor’s result; a successor sent first waits', async () => {
      const unit = await addUnit();
      const m1 = intent(unit, 'WH-C1', { offline: true });
      const m2 = intent(unit, 'WH-C2', { offline: true, previous: m1.clientMoveId });
      const early = await send(m2);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('predecessor_not_applied');
      expect((await send(m1)).status).toBe(201);
      const second = await send(m2);
      expect(second.status).toBe(201);
      expect(second.body.resultingVersion).toBe(3);
      expect(await unitRow(unit)).toMatchObject({
        current_location_id: locations['WH-C2'],
        version: 3,
      });
    });

    it('another station’s intervening move makes the successor a conflict, not a rebase', async () => {
      const unit = await addUnit();
      const m1 = intent(unit, 'WH-C1', { offline: true });
      const m2 = intent(unit, 'WH-C2', { offline: true, previous: m1.clientMoveId });
      expect((await send(m1)).status).toBe(201);
      expect(
        (await send(intent(unit, 'LAB-B1', { station: stationB, baseVersion: 2 }), 'labB')).status,
      ).toBe(201);
      const response = await send(m2);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('location_conflict');
      expect((await unitRow(unit)).current_location_id).toBe(locations['LAB-B1']);
    });

    it('a conflicted predecessor holds its successor; invalid links are refused', async () => {
      const unit = await addUnit();
      const other = await addUnit();
      expect((await send(intent(unit, 'WH-C1', { station: stationB }), 'labB')).status).toBe(201);
      const m1 = intent(unit, 'WH-C2', { offline: true });
      expect((await send(m1)).status).toBe(409);
      const m2 = intent(unit, 'LAB-B1', { offline: true, previous: m1.clientMoveId });
      const held = await send(m2);
      expect(held.status).toBe(409);
      expect(held.body.code).toBe('predecessor_not_applied');
      expect(await count('FROM movement_event WHERE client_move_id = $1', [m2.clientMoveId])).toBe(
        0,
      );

      const saved = intent(other, 'WH-C1');
      expect((await send(saved)).status).toBe(201);
      for (const bad of [
        intent(unit, 'WH-C1', { previous: saved.clientMoveId }), // another unit
        intent(other, 'WH-C2', { previous: saved.clientMoveId, station: stationB }), // another station
      ]) {
        const response = await send(
          bad,
          bad.captureContext.stationId === stationB ? 'labB' : 'labA',
        );
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('predecessor_invalid');
      }
      const selfLinked = intent(other, 'WH-C2');
      const self = await send({ ...selfLinked, previousClientMoveId: selfLinked.clientMoveId });
      expect(self.status).toBe(400);
      expect(self.body.code).toBe('validation_failed');
    });
  });

  describe('P16: destination and unit status, including races with retirement and removal', () => {
    it('refuses retired destinations and disposed units; approved-for-disposal units still move', async () => {
      const shelf = await addLocation('RET-1', 'Retiring shelf');
      await db.pool.query(
        `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Gone' WHERE id = $1`,
        [shelf],
      );
      const unit = await addUnit();
      const retired = await send(intent(unit, shelf));
      expect(retired.status).toBe(422);
      expect(retired.body.code).toBe('location_retired');

      const disposed = await addUnit('disposed');
      const refused = await send(intent(disposed, 'WH-C1'));
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('storage_unit_disposed');

      const approved = await addUnit('approved_for_disposal');
      expect((await send(intent(approved, 'WH-C1'))).status).toBe(201);
      expect((await unitRow(approved)).status).toBe('approved_for_disposal');
      expect(
        await count('FROM movement_event WHERE storage_unit_id = ANY($1)', [[unit, disposed]]),
      ).toBe(0);
      // The database refuses it too, whatever the code path.
      await expect(
        db.pool.query('UPDATE storage_unit SET current_location_id = $2 WHERE id = $1', [
          disposed,
          locations['WH-C1'],
        ]),
      ).rejects.toMatchObject({ constraint: 'storage_unit_disposed_stays_put' });
    });

    it('a retirement committed while the move waits on the location is seen by the move', async () => {
      const shelf = await addLocation('RACE-R', 'Race shelf');
      const unit = await addUnit();
      const gate = await barrier('SELECT 1 FROM location WHERE id = $1 FOR UPDATE', [shelf]);
      await gate.client.query(
        `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Race'
         WHERE id = $1`,
        [shelf],
      );
      const pending = start(send(intent(unit, shelf)));
      await gate.waitFor(1);
      await gate.release(true);
      const response = await pending;
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('location_retired');
      expect((await unitRow(unit)).current_location_id).toBe(locations.RECEIVING);
    });

    it('a retirement waits for an in-flight move and then counts the unit (T37 contract)', async () => {
      const shelf = await addLocation('RACE-M', 'Race shelf 2');
      const unit = await addUnit();
      const gate = await barrier('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit]);
      const move = start(send(intent(unit, shelf)));
      await gate.waitFor(1);
      await gate.release();
      expect((await move).status).toBe(201);
      const retire = await post(`/api/locations/${shelf}/retire`, 'lm', {
        reason: 'Done',
        version: 1,
      });
      expect(retire.status).toBe(409);
      expect(retire.body).toMatchObject({ code: 'location_occupied', inStockCount: 1 });
    });

    it('AC9: a unit disposed (e.g. a tested Shelby tube removed) while the move waits is refused', async () => {
      const unit = await addUnit();
      const gate = await barrier('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit]);
      await gate.client.query(
        `UPDATE storage_unit SET status = 'disposed', version = version + 1 WHERE id = $1`,
        [unit],
      );
      const pending = start(send(intent(unit, 'WH-C1', { offline: true })));
      await gate.waitFor(1);
      await gate.release(true);
      const response = await pending;
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('storage_unit_disposed');
      expect(await count('FROM move_action WHERE storage_unit_id = $1', [unit])).toBe(0);
    });
  });

  it('P22: a correction after the scan makes the queued move a conflict, never a silent rebase', async () => {
    const unit = await addUnit();
    const queued = intent(unit, 'WH-C1', { offline: true });
    const correction = await http()
      .patch(`/api/storage-units/${unit}`)
      .set('Cookie', cookies.tech!)
      .set(CSRF_HEADER, '1')
      .send({ version: 1, changes: { note: 'Lid cracked' }, reason: 'Noticed at the shelf' });
    expect(correction.status, JSON.stringify(correction.body)).toBe(200);
    const response = await send(queued);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('location_conflict');
    const detail = locationConflictDetailSchema.parse(
      (await get(`/api/location-conflicts/${response.body.conflictId}`, 'tech')).body,
    );
    // The competing change was a correction, not a move.
    expect(detail.savedEvent).toBeNull();
    expect((await unitRow(unit)).current_location_id).toBe(locations.RECEIVING);
  });

  it('a scan at the unit’s own saved location confirms it there without a new version', async () => {
    const unit = await addUnit();
    const response = await send(intent(unit, 'RECEIVING'));
    expect(response.status).toBe(201);
    expect(response.body.resultingVersion).toBe(1);
    expect((await unitRow(unit)).version).toBe(1);
  });

  describe('P13/P14/P24: sessions, accounts and the person moving', () => {
    it('an expired LAB station pauses; after signing back in the same action saves once', async () => {
      const unit = await addUnit();
      const move = intent(unit, 'WH-C1', { offline: true });
      const sessionId = await signIn('lab', 'labX');
      await app.get(SessionService).revoke(sessionId);
      const unauthenticated = await send(move, 'labX');
      expect(unauthenticated.status).toBe(401);
      expect(await count('FROM move_action WHERE client_move_id = $1', [move.clientMoveId])).toBe(
        0,
      );
      // Station B is unaffected by A's sign-out.
      expect(
        (await send(intent(await addUnit(), 'WH-C2', { station: stationB }), 'labB')).status,
      ).toBe(201);
      await signIn('lab', 'labX');
      expect((await send(move, 'labX')).status).toBe(201);
      expect((await send(move, 'labX')).status).toBe(200);
      const { rows } = await db.pool.query(
        'SELECT actor_user_id, mover_user_id, station_id FROM movement_event WHERE client_move_id = $1',
        [move.clientMoveId],
      );
      expect(rows).toEqual([
        { actor_user_id: users.lab, mover_user_id: users.jo, station_id: stationA },
      ]);
    });

    it('LAB must name an active staff member; a personal account can’t credit someone else', async () => {
      const unit = await addUnit();
      const none = await send(intent(unit, 'WH-C1', { mover: null }));
      expect(none.status).toBe(422);
      expect(none.body.code).toBe('mover_required');
      const lab = await send(intent(unit, 'WH-C1', { mover: users.lab }));
      expect(lab.status).toBe(422);
      expect(lab.body.code).toBe('unknown_mover');
      const other = await post(
        '/api/moves',
        'tech',
        intent(unit, 'WH-C1', { who: 'tech', mover: users.jo }),
      );
      expect(other.status).toBe(422);
      expect(other.body.code).toBe('mover_not_allowed');
      expect(
        (await post('/api/moves', 'tech', intent(unit, 'WH-C1', { who: 'tech' }))).status,
      ).toBe(201);
    });

    it('a renamed mover keeps the name recorded at the move', async () => {
      const unit = await addUnit();
      expect((await send(intent(unit, 'WH-C1'))).status).toBe(201);
      await db.pool.query(`UPDATE app_user SET display_name = 'Jo Renamed' WHERE id = $1`, [
        users.jo,
      ]);
      const history = storageUnitHistoryPageSchema.parse(
        (await get(`/api/storage-units/${unit}/history`, 'tech')).body,
      );
      expect(history.items[0]!.receiver).toMatchObject({ name: 'User jo' });
      await db.pool.query(`UPDATE app_user SET display_name = 'User jo' WHERE id = $1`, [users.jo]);
    });
  });

  describe('P23: one transaction, all or nothing', () => {
    async function failOn(action: string, run: () => Promise<void>) {
      await db.pool.query(`
        CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = '${action}' THEN RAISE EXCEPTION 'injected failure'; END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER fail_audit BEFORE INSERT ON audit_event
          FOR EACH ROW EXECUTE FUNCTION fail_audit();`);
      try {
        await run();
      } finally {
        await db.pool.query('DROP TRIGGER fail_audit ON audit_event; DROP FUNCTION fail_audit();');
      }
    }

    it('a failure after the event insert leaves no move, version, action or audit; the retry saves once', async () => {
      const unit = await addUnit();
      const move = intent(unit, 'WH-C1');
      await failOn('storage_unit.moved', async () => {
        expect((await send(move)).status).toBe(500);
      });
      expect(await unitRow(unit)).toMatchObject({
        current_location_id: locations.RECEIVING,
        version: 1,
      });
      expect(await count('FROM movement_event WHERE storage_unit_id = $1', [unit])).toBe(0);
      expect(await count('FROM move_action WHERE storage_unit_id = $1', [unit])).toBe(0);
      expect((await send(move)).status).toBe(201);
      expect((await send(move)).status).toBe(200);
      expect(await count('FROM movement_event WHERE storage_unit_id = $1', [unit])).toBe(1);
    });

    it('a failed conflict write leaves no conflict or attempt behind', async () => {
      const unit = await addUnit();
      expect((await send(intent(unit, 'WH-C1', { station: stationB }), 'labB')).status).toBe(201);
      const stale = intent(unit, 'WH-C2');
      await failOn('storage_unit.location_conflict', async () => {
        expect((await send(stale)).status).toBe(500);
      });
      expect(await count('FROM location_conflict WHERE storage_unit_id = $1', [unit])).toBe(0);
      expect((await send(stale)).status).toBe(409);
      expect(await count('FROM location_conflict WHERE storage_unit_id = $1', [unit])).toBe(1);
    });
  });

  it('movement history and recorded outcomes are append-only', async () => {
    const unit = await addUnit();
    const move = intent(unit, 'WH-C1');
    expect((await send(move)).status).toBe(201);
    await expect(
      db.pool.query(`UPDATE movement_event SET to_location_id = $2 WHERE client_move_id = $1`, [
        move.clientMoveId,
        locations['WH-C2'],
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.pool.query('DELETE FROM move_action WHERE client_move_id = $1', [move.clientMoveId]),
    ).rejects.toThrow(/append-only/);
  });

  it('validates the frozen intent: a scan time needs its offset', async () => {
    const unit = await addUnit();
    const response = await send({ ...intent(unit, 'WH-C1'), scannedAt: '2026-10-27T09:15:00' });
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'scannedAt' })]);
  });
});
