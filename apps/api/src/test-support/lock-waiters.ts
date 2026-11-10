import type { Pool, PoolClient } from 'pg';

/**
 * Waits until at least `n` backends are blocked behind `blocker`'s transaction: directly, or
 * behind a backend that is itself blocked by it (a request queued on another's lock). Lets a
 * race test release the blocker only once every competing request is really waiting.
 */
export async function lockWaiters(pool: Pool, blocker: PoolClient, n: number): Promise<void> {
  const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]!.pid;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows: counted } = await pool.query<{ n: number }>(
      `WITH direct AS (
         SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
       )
       SELECT count(*)::int AS n FROM pg_stat_activity a
       WHERE a.pid IN (SELECT pid FROM direct)
          OR EXISTS (SELECT 1 FROM direct d WHERE d.pid = ANY (pg_blocking_pids(a.pid)))`,
      [pid],
    );
    if (counted[0]!.n >= n) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`fewer than ${n} requests waited on the blocker`);
}
