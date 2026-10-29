import type { Pool } from 'pg';

// Small insert helpers for schema tests. Every value is fictional.

export async function insertUser(pool: Pool, initials = 'AT'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_user (display_name, official_initials, account_type, status)
     VALUES ($1, $2, 'test', 'active') RETURNING id`,
    [`Test ${initials}`, initials],
  );
  return rows[0]!.id;
}

export async function insertProject(
  pool: Pool,
  projectNumber: string,
  leadProjectEngineerUserId: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
     VALUES ($1, 'Fictional project', 'Example Client', $2) RETURNING id`,
    [projectNumber, leadProjectEngineerUserId],
  );
  return rows[0]!.id;
}

export async function insertTestHole(pool: Pool, projectId: string, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id',
    [projectId, name],
  );
  return rows[0]!.id;
}

export async function receivingLabId(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO location (code, name, kind, is_system)
     VALUES ('RECEIVING', 'Receiving lab', 'receiving_lab', true)
     ON CONFLICT (code_normalized) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
  );
  return rows[0]!.id;
}

export async function insertReceipt(
  pool: Pool,
  projectId: string,
  userId: string,
  quantity = 1,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                          receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                          request_hash)
     VALUES ($1, '2026-10-23', $2, 'AT', 'Test AT', $2, $3, gen_random_uuid(), 'hash')
     RETURNING id`,
    [projectId, userId, quantity],
  );
  return rows[0]!.id;
}

export interface UnitInput {
  readableId: string;
  prefix?: string;
  year?: number;
  issuedHolderKind?: string;
  unitType?: string;
  holderKind?: string;
}

export async function insertStorageUnit(
  pool: Pool,
  ids: { projectId: string; receiptId: string; locationId: string },
  unit: UnitInput,
): Promise<string> {
  const prefix = unit.prefix ?? unit.readableId.split('-')[0]!;
  const year = unit.year ?? Number(unit.readableId.split('-')[1]);
  const issuedHolderKind = unit.issuedHolderKind ?? 'bucket';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind, receipt_id,
                               project_id, unit_type, holder_kind, current_location_id,
                               received_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-10-23') RETURNING id`,
    [
      unit.readableId,
      prefix,
      year,
      issuedHolderKind,
      ids.receiptId,
      ids.projectId,
      unit.unitType ?? 'bucket',
      unit.holderKind ?? issuedHolderKind,
      ids.locationId,
    ],
  );
  return rows[0]!.id;
}

export interface SummaryInput {
  type: 'all' | 'sample_range' | 'depth_range' | 'custom';
  sampleFrom?: string | null;
  sampleTo?: string | null;
  depthFrom?: number | null;
  depthTo?: number | null;
  depthUnit?: string | null;
  customText?: string | null;
}

export async function insertSummary(
  pool: Pool,
  ids: { storageUnitId: string; projectId: string; testHoleId: string },
  summary: SummaryInput,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id, summary_type,
                                            sample_from, sample_to, depth_from, depth_to,
                                            depth_unit, custom_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      ids.storageUnitId,
      ids.projectId,
      ids.testHoleId,
      summary.type,
      summary.sampleFrom ?? null,
      summary.sampleTo ?? null,
      summary.depthFrom ?? null,
      summary.depthTo ?? null,
      summary.depthUnit ?? null,
      summary.customText ?? null,
    ],
  );
  return rows[0]!.id;
}

/** PostgreSQL SQLSTATE codes used in assertions. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  restrictViolation: '23001',
  notNullViolation: '23502',
} as const;
