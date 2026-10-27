import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/policy.js';
import { listAuditForEntity } from '../audit/audit.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { enqueuePrintJob, getPrintJob } from './print-queue.js';
import { PrintWorker } from './print-worker.js';
import type { PrinterTarget, PrinterTransport, SendOutcome } from './zebra-client.js';

// MM-T42: saving a job's result fails after its labels were sent (the database went away for a
// moment). The worker must save the kept result once the database is back, without restarting
// and without sending the labels again, and later jobs on that printer must still run. Faults are
// injected into a real PostgreSQL pool. Fictional data only.

/** The worker's settlement UPDATE (the one that writes the attempt's result). */
const SETTLEMENT_SQL = /UPDATE print_job\s+SET status = \$2/;

class Faults {
  /** Settlement UPDATEs still to fail before they reach the database. */
  failSettlement = 0;
  /** Settlement COMMITs still to report failure AFTER they committed (reply lost). */
  loseCommitReply = 0;
  /** Database unreachable: every connect and query fails. */
  down = false;
  injected = 0;

  fail(): Promise<never> {
    this.injected += 1;
    return Promise.reject(new Error('Connection terminated unexpectedly (injected)'));
  }
}

function sqlOf(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  return (first as { text?: string } | undefined)?.text ?? '';
}

/** A pool that behaves like `pool` except where `faults` says the database fails. */
function faultyPool(pool: Pool, faults: Faults): Pool {
  const wrapClient = (client: PoolClient): PoolClient => {
    let settling = false;
    return new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            if (faults.down) return faults.fail();
            const sql = sqlOf(args);
            if (SETTLEMENT_SQL.test(sql)) {
              if (faults.failSettlement > 0) {
                faults.failSettlement -= 1;
                return faults.fail();
              }
              settling = true;
            }
            const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (sql === 'COMMIT' && settling) {
              settling = false;
              if (faults.loseCommitReply > 0) {
                faults.loseCommitReply -= 1;
                return faults.fail();
              }
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  };
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => {
          if (faults.down) return faults.fail();
          return wrapClient(await target.connect());
        };
      }
      if (prop === 'query') {
        return (...args: unknown[]) =>
          faults.down
            ? faults.fail()
            : (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Counts sends; outcomes come from a list (last one repeats); can hold a send open. */
class CountingTransport implements PrinterTransport {
  readonly payloads: string[] = [];
  outcomes: SendOutcome[] = [{ result: 'sent' }];
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((resolve) => (this.openGate = resolve));
  }

  release(): void {
    this.openGate?.();
    this.gate = null;
  }

  async send(_target: PrinterTarget, payload: string): Promise<SendOutcome> {
    this.payloads.push(payload);
    if (this.gate) await this.gate;
    const index = Math.min(this.payloads.length - 1, this.outcomes.length - 1);
    return this.outcomes[index]!;
  }
}

describe.runIf(testDatabaseUrl)('print settlement recovery (MM-T42)', () => {
  let db: TestSchema;
  let user: AuthUser;
  let units: string[];
  let faults: Faults;
  let transport: CountingTransport;
  const workers: PrintWorker[] = [];
  const errors: string[] = [];
  const log = { error: (m: string) => errors.push(m), warn: () => undefined };

  const READABLE = ['BKT-2026-000021', 'BKT-2026-000022'];

  function worker(pool: Pool = faultyPool(db.pool, faults)) {
    const w = new PrintWorker(
      pool,
      transport,
      { pollIntervalMs: 20, retryBaseMs: 0, maxAttempts: 3 },
      log,
    );
    workers.push(w);
    return w;
  }

  const enqueue = (storageUnitIds: string[]) =>
    enqueuePrintJob(db.pool, user, { storageUnitIds, kind: 'reprint' }, null);
  const status = async (id: string) => (await getPrintJob(db.pool, id))!.status;
  const sendsOf = (readableId: string) =>
    transport.payloads.filter((p) => p.includes(readableId)).length;

  async function inventorySnapshot() {
    const { rows } = await db.pool.query(
      `SELECT su.*, r.confirmed_at, r.quantity, l.code
       FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
       JOIN location l ON l.id = su.current_location_id
       ORDER BY su.readable_id`,
    );
    return rows;
  }

  async function auditActions(jobId: string) {
    return (await listAuditForEntity(db.pool, 'print_job', jobId)).map((e) => e.action);
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    const userId = await insertUser(db.pool);
    user = {
      userId,
      sessionId: 's',
      accountType: 'test',
      status: 'active',
      roles: [],
      displayName: 'Test AT',
      initials: 'AT',
    };
    const locationId = await receivingLabId(db.pool);
    const projectId = await insertProject(db.pool, 'DEMO-2601', userId);
    const th1 = await insertTestHole(db.pool, projectId, 'TH26-01');
    const receiptId = await insertReceipt(db.pool, projectId, userId, 2);
    units = [];
    for (const readableId of READABLE) {
      const id = await insertStorageUnit(
        db.pool,
        { projectId, receiptId, locationId },
        { readableId },
      );
      await insertSummary(
        db.pool,
        { storageUnitId: id, projectId, testHoleId: th1 },
        { type: 'all' },
      );
      units.push(id);
    }
    // A fictional printer; the counting transport never opens a socket.
    await db.pool.query(
      `INSERT INTO printer (key, name, host, port, is_default, check_status)
       VALUES ('receiving', 'Receiving ZD621', '127.0.0.1', 9100, true, false)`,
    );
  });

  afterEach(async () => {
    faults.down = false;
    transport.release();
    await Promise.all(workers.splice(0).map((w) => w.stop()));
    await db.pool.query(
      `UPDATE print_job SET status = 'failed' WHERE status IN ('queued', 'sending')`,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  // Fresh fault and transport state for every test.
  beforeEach(() => {
    faults = new Faults();
    transport = new CountingTransport();
    errors.length = 0;
  });

  it('review reproduction: one failed settlement no longer blocks the printer (AC1, AC2, AC3)', async () => {
    const before = await inventorySnapshot();
    const first = await enqueue([units[0]!]);
    const second = await enqueue([units[1]!]);
    faults.failSettlement = 1;

    const w = worker();
    await w.drain();
    await w.drain();

    expect(faults.injected).toBe(1);
    expect(await status(first.id)).toBe('sent');
    expect(await status(second.id)).toBe('sent');
    // Each job's labels went out exactly once, in order: the first was never resent.
    expect(transport.payloads).toHaveLength(2);
    expect(transport.payloads[0]).toContain(READABLE[0]);
    expect(transport.payloads[1]).toContain(READABLE[1]);
    expect(await getPrintJob(db.pool, first.id)).toMatchObject({ attempts: 1, lastError: null });
    expect(await inventorySnapshot()).toEqual(before);
  });

  it('a running worker recovers from repeated outages; uncertain stays uncertain (AC1, AC3, AC5)', async () => {
    const before = await inventorySnapshot();
    transport.outcomes = [
      { result: 'uncertain', error: 'Printer dropped the connection' },
      { result: 'sent' },
    ];
    const first = await enqueue([units[0]!]);
    const second = await enqueue([units[1]!]);
    faults.failSettlement = Number.POSITIVE_INFINITY;

    const w = worker();
    w.start();
    // The settlement keeps failing; then the whole database goes away for a while.
    await expect.poll(() => faults.injected, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
    faults.down = true;
    faults.failSettlement = 0;
    const injected = faults.injected;
    await expect.poll(() => faults.injected, { timeout: 5_000 }).toBeGreaterThan(injected + 3);
    expect(await status(first.id)).toBe('sending');
    expect(await status(second.id)).toBe('queued');
    expect(transport.payloads).toHaveLength(1);
    faults.down = false;

    await expect.poll(() => status(second.id), { timeout: 5_000 }).toBe('sent');
    expect(await getPrintJob(db.pool, first.id)).toMatchObject({
      status: 'uncertain',
      attempts: 1,
      lastError: 'Printer dropped the connection',
    });
    // The uncertain labels were not resent; a person decides about a reprint.
    expect(sendsOf(READABLE[0]!)).toBe(1);
    expect(sendsOf(READABLE[1]!)).toBe(1);
    expect(await auditActions(first.id)).toEqual([
      'label.print_uncertain',
      'label.reprint_requested',
    ]);
    expect(errors.some((m) => m.includes('will retry'))).toBe(true);
    expect(await inventorySnapshot()).toEqual(before);
  });

  it('a save that committed but lost its reply is not audited twice (AC5)', async () => {
    transport.outcomes = [{ result: 'uncertain', error: 'Printer dropped the connection' }];
    const job = await enqueue([units[0]!]);
    faults.loseCommitReply = 1;

    const w = worker();
    await w.drain();
    await w.drain();

    expect(faults.injected).toBe(1);
    expect(await status(job.id)).toBe('uncertain');
    expect(await auditActions(job.id)).toEqual([
      'label.print_uncertain',
      'label.reprint_requested',
    ]);
    expect(transport.payloads).toHaveLength(1);
  });

  it('a job whose send is still in progress is not claimed twice; order is kept (AC4)', async () => {
    const first = await enqueue([units[0]!]);
    const second = await enqueue([units[1]!]);
    transport.hold();

    const w = worker();
    w.start();
    await expect.poll(() => transport.payloads.length, { timeout: 5_000 }).toBe(1);
    // Let several polls pass (and a settlement fault wait) while the send is held open.
    faults.failSettlement = 1;
    const polled = w.health.lastPollAt?.getTime() ?? 0;
    await expect
      .poll(() => (w.health.lastPollAt?.getTime() ?? 0) > polled + 60, { timeout: 5_000 })
      .toBe(true);
    w.wake();
    expect(transport.payloads).toHaveLength(1);
    expect(await status(first.id)).toBe('sending');
    expect(await status(second.id)).toBe('queued');

    transport.release();
    await expect.poll(() => status(second.id), { timeout: 5_000 }).toBe('sent');
    expect(await status(first.id)).toBe('sent');
    expect(transport.payloads).toHaveLength(2);
    expect(transport.payloads[0]).toContain(READABLE[0]);
    expect(transport.payloads[1]).toContain(READABLE[1]);
  });

  it('a result still unsaved at shutdown becomes uncertain on restart and is not resent', async () => {
    const first = await enqueue([units[0]!]);
    faults.failSettlement = Number.POSITIVE_INFINITY;

    const w = worker();
    await w.drain();
    await w.stop();
    expect(await status(first.id)).toBe('sending');

    // The database is fine again when the service starts.
    const second = await enqueue([units[1]!]);
    faults.failSettlement = 0;
    await worker(db.pool).drain();

    expect(await getPrintJob(db.pool, first.id)).toMatchObject({
      status: 'uncertain',
      lastError: 'Material Mule restarted while sending these labels',
    });
    expect(await status(second.id)).toBe('sent');
    expect(sendsOf(READABLE[0]!)).toBe(1);
    expect(await auditActions(first.id)).toEqual([
      'label.print_uncertain',
      'label.reprint_requested',
    ]);
  });
});
