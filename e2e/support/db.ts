import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';

// Direct test-database access for E2E setup the UI can't do yet (e.g. confirmed storage units
// before the receiving screens exist). Uses the same database as the E2E API (apps/api/.env.test).
// Every row is fictional, attached to the seeded project DEMO-2601 and test hole TH26-01.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const TH26_01_ID = '00000000-0000-4000-8000-000000000301';
const ALEX_TESTER_ID = '00000000-0000-4000-8000-000000000102';

/** Playwright runs from the repository root. */
function databaseUrl(): string {
  const env = parseEnv(readFileSync(resolve('apps/api/.env.test'), 'utf8'));
  if (!env.DATABASE_URL) throw new Error('apps/api/.env.test has no DATABASE_URL');
  return env.DATABASE_URL;
}

export async function withDatabase<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface TestLocation {
  id: string;
  code: string;
  name: string;
}

/**
 * A fictional warehouse location whose code no other test or viewport in the run has: `prefix`,
 * 40 random bits and `suffix` (at most 20 characters, as `location.code` allows). Both
 * Playwright viewports share one database, so a short random number used to collide now and then
 * (location_code_key); on the rare clash this draws a new code, so the database's own uniqueness
 * rule is what guarantees it.
 */
export async function insertLocation(
  prefix: string,
  suffix: string,
  name: string,
): Promise<TestLocation> {
  return withDatabase(async (client) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `${prefix}${randomBytes(5).toString('hex').toUpperCase()}-${suffix}`;
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
          [code, `${name} ${code}`],
        );
        return { id: rows[0]!.id, code, name: `${name} ${code}` };
      } catch (error) {
        if ((error as { constraint?: string }).constraint !== 'location_code_key') throw error;
      }
    }
    throw new Error('Could not draw an unused location code in 5 tries');
  });
}

export interface TestUnit {
  id: string;
  readableId: string;
}

/**
 * A confirmed one-bucket receipt at the Receiving lab, summarised under `holeId` (TH26-01 by
 * default). IDs use issue year 2025 and a random number so they never collide with IDs the app
 * issues during the same run.
 */
export async function insertConfirmedBucket(holeId: string = TH26_01_ID): Promise<TestUnit> {
  return withDatabase(async (client) => {
    await client.query('BEGIN');
    try {
      const receipt = await client.query<{ id: string }>(
        `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                              receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                              request_hash)
         VALUES ($1, '2025-11-03', $2, 'AT', 'Alex Tester', $2, 1, gen_random_uuid(), 'e2e')
         RETURNING id`,
        [DEMO_PROJECT_ID, ALEX_TESTER_ID],
      );
      const readableId = `BKT-2025-${String(randomInt(1, 999_999)).padStart(6, '0')}`;
      const unit = await client.query<{ id: string }>(
        `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                   receipt_id, project_id, unit_type, holder_kind,
                                   current_location_id, received_date)
         SELECT $1, 'BKT', 2025, 'bucket', $2, $3, 'bucket', 'bucket', l.id, '2025-11-03'
         FROM location l WHERE l.code_normalized = 'RECEIVING'
         RETURNING id`,
        [readableId, receipt.rows[0]!.id, DEMO_PROJECT_ID],
      );
      await client.query(
        `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                summary_type)
         VALUES ($1, $2, $3, 'all')`,
        [unit.rows[0]!.id, DEMO_PROJECT_ID, holeId],
      );
      await client.query('COMMIT');
      return { id: unit.rows[0]!.id, readableId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * A confirmed receipt of several buckets (MM-T39), with receipt lines in the given order. IDs use
 * issue year 2025 and consecutive random numbers, as insertConfirmedBucket does.
 */
export async function insertConfirmedReceipt(
  count: number,
): Promise<{ receiptId: string; units: TestUnit[] }> {
  return withDatabase(async (client) => {
    await client.query('BEGIN');
    try {
      const receipt = await client.query<{ id: string }>(
        `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                              receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                              request_hash)
         VALUES ($1, '2025-11-03', $2, 'AT', 'Alex Tester', $2, $3, gen_random_uuid(), 'e2e')
         RETURNING id`,
        [DEMO_PROJECT_ID, ALEX_TESTER_ID, count],
      );
      const receiptId = receipt.rows[0]!.id;
      const first = randomInt(1, 999_999 - count);
      const units: TestUnit[] = [];
      for (let line = 1; line <= count; line++) {
        // Receipt order runs opposite to ID order, so "in order" can only mean receipt order.
        const readableId = `BKT-2025-${String(first + count - line).padStart(6, '0')}`;
        const unit = await client.query<{ id: string }>(
          `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                     receipt_id, project_id, unit_type, holder_kind,
                                     current_location_id, received_date, receipt_line)
           SELECT $1, 'BKT', 2025, 'bucket', $2, $3, 'bucket', 'bucket', l.id, '2025-11-03', $4
           FROM location l WHERE l.code_normalized = 'RECEIVING'
           RETURNING id`,
          [readableId, receiptId, DEMO_PROJECT_ID, line],
        );
        await client.query(
          `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                  summary_type)
           VALUES ($1, $2, $3, 'all')`,
          [unit.rows[0]!.id, DEMO_PROJECT_ID, TH26_01_ID],
        );
        units.push({ id: unit.rows[0]!.id, readableId });
      }
      await client.query('COMMIT');
      return { receiptId, units };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
