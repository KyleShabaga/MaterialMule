import type { Pool } from 'pg';
import { endGrant, lockGrant, type GrantTable } from '../project-access/grant-tables.js';

// Review fix #134: a grant ending and a command racing on the same authority. The ending runs in
// its own transaction (the real `lockGrant` + `endGrant` path) and stays open while the command
// starts; PostgreSQL's lock wait (pg_blocking_pids), never a sleep, says the command queued behind
// it. Then the ending commits and the command's answer is returned. A command that reads the grant
// without locking it doesn't wait and answers before the ending commits.

/**
 * Ends grant `grantId` of `t` in an open transaction, runs `command`, waits until the command
 * waits on that transaction (or answers without waiting), commits the ending, and returns the
 * command's answer.
 */
export async function endGrantDuring<T>(
  pool: Pool,
  t: GrantTable,
  grantId: string,
  by: { userId: string; initials: string | null; displayName: string },
  command: () => PromiseLike<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    const row = await lockGrant(blocker, t, grantId);
    if (!row || row.endedAt) throw new Error('grant to end is not active');
    await endGrant(blocker, t, row, {
      by,
      reason: 'Ended during a race test',
      extra,
      actor: {
        userId: by.userId,
        accountType: 'personal',
        initials: by.initials,
        name: by.displayName,
      },
    });
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    let settled = false;
    // Promise.resolve: a supertest request is a thenable that sends when awaited.
    const pending = Promise.resolve(command()).finally(() => {
      settled = true;
    });
    for (let i = 0; !settled; i += 1) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))`,
        [pid],
      );
      if (rows[0]!.n > 0) break;
      if (i > 20_000) throw new Error('the command neither waited nor answered');
      await new Promise((resolve) => setImmediate(resolve));
    }
    await blocker.query('COMMIT');
    return await pending;
  } catch (error) {
    await blocker.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    blocker.release();
  }
}
