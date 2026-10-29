import { randomUUID } from 'node:crypto';
import { labProgramReviewSchema, labProgramSchema, type LabProgram } from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-T76: Shelby completion serialises across programs, same-key retries replay after the lock,
// and completion doesn't deadlock with a move of the same unit. Barrier tests: a blocker
// connection holds the contended row lock until every racer is waiting on it, so the race is
// forced rather than hoped for (no fixed sleeps). Real PostgreSQL, fictional data only
// (DEMO-2601, TH26-xx).
describe.runIf(testDatabaseUrl)('completion locking (MM-T76)', () => {
  let h: LabHarness;
  let moisture: string;
  let shelf: string;
  let blocker: Client;

  async function newHole() {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [h.projects.a, `TH26-${newKey().slice(0, 6)}`],
    );
    return rows[0]!.id;
  }

  /** A submitted ALL program on `holeId` covering every unit available now. */
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

  const status = (requestId: string, body: Record<string, unknown>) =>
    h.send(
      'post',
      `/api/test-requests/${requestId}/status`,
      { idempotencyKey: newKey(), ...body },
      'tech',
    );

  /**
   * Resolves once at least `n` backends wait, directly or behind another waiter, on a lock the
   * blocker connection holds. Only this test's racers count (pg_blocking_pids), so other suites
   * and databases on the same server never satisfy it.
   */
  async function waiters(n: number) {
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    for (let i = 0; i < 2000; i += 1) {
      const { rows } = await h.db.pool.query<{ n: number }>(
        `WITH RECURSIVE blocked(pid) AS (
           SELECT a.pid FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))
           UNION
           SELECT a.pid FROM pg_stat_activity a, blocked b
           WHERE b.pid = ANY (pg_blocking_pids(a.pid))
         )
         SELECT count(*)::int AS n FROM blocked`,
        [pid],
      );
      if (rows[0]!.n >= n) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`fewer than ${n} waited on the blocker`);
  }

  async function count(sql: string, params: unknown[]) {
    return (await h.db.pool.query<{ n: number }>(sql, params)).rows[0]!.n;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC76', 'Moisture content (fictional)', 'Moisture')).id;
    shelf = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO location (code, name, kind) VALUES ('T76-SHELF', 'T76 shelf', 'warehouse')
         RETURNING id`,
      )
    ).rows[0]!.id;
    blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    await blocker.connect();
  });

  afterAll(async () => {
    await blocker?.end();
    await h?.close();
  });

  it('AC1/T1: two programs completing on the same tube at once: one commits, the other gets 422', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole });
    const first = (await submitted(hole)).lines[0]!.requests[0]!.id;
    const second = (await submitted(hole)).lines[0]!.requests[0]!.id;
    for (const id of [first, second]) {
      expect((await status(id, { to: 'in_progress', version: 1 })).status).toBe(200);
    }
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT id FROM storage_unit WHERE id = $1 FOR NO KEY UPDATE', [tube.id]);
      const racing = [first, second].map((id) =>
        status(id, { to: 'completed', version: 2, testedStorageUnitIds: [tube.id] }),
      );
      await waiters(2);
      await blocker.query('COMMIT');
      const results = await Promise.all(racing);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(results.find((r) => r.status === 422)!.body.code).toBe('unit_contents_destroyed');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
    }
    // Exactly one program holds evidence for the tube.
    expect(
      await count(
        `SELECT count(DISTINCT r.program_id)::int AS n FROM test_request_unit_link l
         JOIN test_request r ON r.id = l.test_request_id WHERE l.storage_unit_id = $1`,
        [tube.id],
      ),
    ).toBe(1);
  });

  it('AC2/T2: concurrent deliveries with the same key both return the original 200; one history row', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole });
    const id = (await submitted(hole)).lines[0]!.requests[0]!.id;
    expect((await status(id, { to: 'in_progress', version: 1 })).status).toBe(200);
    const key = newKey();
    const body = {
      to: 'completed',
      version: 2,
      testedStorageUnitIds: [tube.id],
      idempotencyKey: key,
    };
    await blocker.query('BEGIN');
    try {
      // Hold the request (the lock both deliveries reach after the unit) so both pass the early
      // replay check before either commits.
      await blocker.query('SELECT id FROM test_request WHERE id = $1 FOR UPDATE', [id]);
      const racing = [1, 2].map(() =>
        h.send('post', `/api/test-requests/${id}/status`, body, 'tech'),
      );
      // One waits on the request; the other waits behind it on the unit.
      await waiters(2);
      await blocker.query('COMMIT');
      const results = await Promise.all(racing);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results[1]!.body).toEqual(results[0]!.body);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
    }
    expect(
      await count(
        `SELECT count(*)::int AS n FROM test_request_status_history WHERE idempotency_key = $1`,
        [key],
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM test_request_unit_link WHERE storage_unit_id = $1',
        [tube.id],
      ),
    ).toBe(1);
  });

  it('AC2: same-key deliveries without units also replay after the request lock', async () => {
    const hole = await newHole();
    await h.bucket({ hole });
    const id = (await submitted(hole)).lines[0]!.requests[0]!.id;
    const key = newKey();
    const body = { to: 'in_progress', version: 1, idempotencyKey: key };
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT id FROM test_request WHERE id = $1 FOR UPDATE', [id]);
      const racing = [1, 2].map(() =>
        h.send('post', `/api/test-requests/${id}/status`, body, 'tech'),
      );
      await waiters(2);
      await blocker.query('COMMIT');
      const results = await Promise.all(racing);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results[1]!.body).toEqual(results[0]!.body);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
    }
    expect(
      await count(
        `SELECT count(*)::int AS n FROM test_request_status_history WHERE idempotency_key = $1`,
        [key],
      ),
    ).toBe(1);
  });

  it('AC3/T3: a completion and a move of the same tube released together both succeed (no deadlock)', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole });
    const id = (await submitted(hole)).lines[0]!.requests[0]!.id;
    expect((await status(id, { to: 'in_progress', version: 1 })).status).toBe(200);
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM storage_unit WHERE id = $1',
      [tube.id],
    );
    const station = await h.cookie('lab');
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT id FROM storage_unit WHERE id = $1 FOR UPDATE', [tube.id]);
      const completing = status(id, {
        to: 'completed',
        version: 2,
        testedStorageUnitIds: [tube.id],
      });
      const moving = h.send(
        'post',
        '/api/moves',
        {
          clientMoveId: randomUUID(),
          storageUnitId: tube.id,
          toLocationId: shelf,
          baseVersion: rows[0]!.version,
          scannedAt: new Date().toISOString(),
          capturedOffline: false,
          captureContext: {
            stationId: randomUUID(),
            accountId: h.users.lab,
            moverUserId: h.users.js,
          },
        },
        station,
      );
      await waiters(2);
      await blocker.query('COMMIT');
      const [completed, moved] = await Promise.all([completing, moving]);
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      expect(moved.status, JSON.stringify(moved.body)).toBeLessThan(300);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('database: the link guard serialises on the unit, so a second program is refused after the first commits', async () => {
    const hole = await newHole();
    const tube = await h.tube({ holeId: hole });
    const first = (await submitted(hole)).lines[0]!.requests[0]!.id;
    const second = (await submitted(hole)).lines[0]!.requests[0]!.id;
    const other = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    await other.connect();
    // Raw completion evidence, as a client past the service would write it.
    const complete = async (client: Client, requestId: string) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO test_request_status_history
           (test_request_id, program_id, from_status, to_status, account_user_id, account_type,
            account_name_snapshot, person_user_id, person_name_snapshot, idempotency_key,
            request_hash)
         SELECT r.id, r.program_id, 'in_progress', 'completed', $2, 'personal', 'Alex Tester',
                $2, 'Alex Tester', gen_random_uuid(), 'x'
         FROM test_request r WHERE r.id = $1 RETURNING id`,
        [requestId, h.users.tech],
      );
      return client.query(
        `INSERT INTO test_request_unit_link (test_request_id, status_history_id, storage_unit_id,
                                             project_id, unit_readable_id_snapshot)
         VALUES ($1, $2, $3, $4, 'x')`,
        [requestId, rows[0]!.id, tube.id, h.projects.a],
      );
    };
    await blocker.query('BEGIN');
    await other.query('BEGIN');
    try {
      await complete(blocker, first);
      const late = complete(other, second);
      late.catch(() => undefined);
      await waiters(1);
      await blocker.query('COMMIT');
      await expect(late).rejects.toMatchObject({
        constraint: 'test_request_unit_link_contents_available',
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await other.query('ROLLBACK').catch(() => undefined);
      await other.end();
    }
  });
});
