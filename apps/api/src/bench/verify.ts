import type { Pool } from 'pg';

/**
 * Correctness checks after a load run (TRP-T19 AC3, test plan T3). Each returns a list of problems;
 * an empty list means consistent. They read the whole database, so they also cover the generated
 * history, not just the rows the load wrote.
 */
export interface IntegrityReport {
  problems: string[];
  storageUnits: number;
  receipts: number;
  /** Receipts confirmed at or after `since` (the load window), when given. */
  receiptsSince?: number;
  unitsSince?: number;
}

const one = async (pool: Pool, sql: string, params: unknown[] = []) =>
  (await pool.query<{ n: number }>(sql, params)).rows[0]!.n;

export async function verifyIntegrity(pool: Pool, since?: Date): Promise<IntegrityReport> {
  const problems: string[] = [];
  const check = async (label: string, sql: string, params: unknown[] = []) => {
    const n = await one(pool, sql, params);
    if (n !== 0) problems.push(`${label}: ${n}`);
  };

  await check(
    'duplicate storage unit IDs',
    `SELECT count(*)::int AS n FROM
       (SELECT readable_id FROM storage_unit GROUP BY readable_id HAVING count(*) > 1) d`,
  );
  // Each prefix/year series is 1..N with no gap or repeat, and its counter equals N.
  await check(
    'ID series with a gap, repeat or counter mismatch',
    `SELECT count(*)::int AS n FROM (
       SELECT su.id_prefix, su.issued_year, count(*) AS issued,
              count(DISTINCT substring(su.readable_id from '[0-9]{6}$')) AS distinct_numbers,
              max(substring(su.readable_id from '[0-9]{6}$')::int) AS highest,
              max(c.last_value) AS counter
       FROM storage_unit su
       LEFT JOIN storage_unit_annual_counter c
         ON c.prefix = su.id_prefix AND c.year = su.issued_year
       GROUP BY su.id_prefix, su.issued_year) s
     WHERE issued <> distinct_numbers OR issued <> highest OR counter IS DISTINCT FROM highest`,
  );
  await check(
    'receipts whose unit count or line numbers disagree with quantity',
    `SELECT count(*)::int AS n FROM (
       SELECT r.id FROM receipt r LEFT JOIN storage_unit su ON su.receipt_id = r.id
       GROUP BY r.id, r.quantity
       HAVING count(su.id) <> r.quantity
           OR count(DISTINCT su.receipt_line) <> r.quantity
           OR max(su.receipt_line) <> r.quantity) bad`,
  );
  await check(
    'units with more than one storage_unit.created event',
    `SELECT count(*)::int AS n FROM (
       SELECT entity_id FROM audit_event
       WHERE action = 'storage_unit.created' AND entity_type = 'storage_unit'
       GROUP BY entity_id HAVING count(*) > 1) d`,
  );
  await check(
    'units without a search document',
    `SELECT count(*)::int AS n FROM storage_unit su
     WHERE NOT EXISTS (SELECT 1 FROM storage_unit_search s WHERE s.storage_unit_id = su.id)`,
  );

  const report: IntegrityReport = {
    problems,
    storageUnits: await one(pool, 'SELECT count(*)::int AS n FROM storage_unit'),
    receipts: await one(pool, 'SELECT count(*)::int AS n FROM receipt'),
  };

  if (since) {
    // Everything confirmed during the load: exactly one audit event per receipt and per unit.
    await check(
      'load receipts without exactly one receipt.confirmed event',
      `SELECT count(*)::int AS n FROM receipt r
       WHERE r.confirmed_at >= $1
         AND (SELECT count(*) FROM audit_event e
              WHERE e.action = 'receipt.confirmed' AND e.entity_type = 'receipt'
                AND e.entity_id = r.id) <> 1`,
      [since],
    );
    await check(
      'load units without exactly one storage_unit.created event',
      `SELECT count(*)::int AS n FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
       WHERE r.confirmed_at >= $1
         AND (SELECT count(*) FROM audit_event e
              WHERE e.action = 'storage_unit.created' AND e.entity_type = 'storage_unit'
                AND e.entity_id = su.id) <> 1`,
      [since],
    );
    report.receiptsSince = await one(
      pool,
      'SELECT count(*)::int AS n FROM receipt WHERE confirmed_at >= $1',
      [since],
    );
    report.unitsSince = await one(
      pool,
      `SELECT count(*)::int AS n FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
       WHERE r.confirmed_at >= $1`,
      [since],
    );
  }
  return report;
}

const COUNTED_TABLES = [
  'app_user',
  'project',
  'test_hole',
  'location',
  'receipt',
  'storage_unit',
  'storage_unit_hole_summary',
  'storage_unit_search',
  'print_job',
  'print_job_item',
  'audit_event',
  'session',
] as const;

/** Exact row counts of the tables the benchmark cares about. */
export async function tableCounts(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = await one(pool, `SELECT count(*)::int AS n FROM ${table}`);
  }
  return counts;
}

/**
 * A short hash of the generated storage units (ID, project, date, status, location, document), so
 * two machines can confirm they loaded identical data from the same seed.
 */
export async function datasetFingerprint(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ fingerprint: string }>(
    `SELECT left(md5(string_agg(
              su.readable_id || '|' || p.project_number || '|' || su.received_date || '|' ||
              su.status || '|' || l.code || '|' || s.document,
              E'\\n' ORDER BY su.readable_id COLLATE "C")), 16) AS fingerprint
     FROM storage_unit su
     JOIN project p ON p.id = su.project_id
     JOIN location l ON l.id = su.current_location_id
     JOIN storage_unit_search s ON s.storage_unit_id = su.id`,
  );
  return rows[0]!.fingerprint;
}
