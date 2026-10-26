import type { Pool, PoolClient } from 'pg';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/**
 * Runs `work` inside one transaction on one connection: COMMIT on success, ROLLBACK and rethrow
 * on any error. Pass the client to every query that must be part of the same transaction.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: { isolationLevel?: IsolationLevel } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${options.isolationLevel ?? 'read committed'}`);
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
