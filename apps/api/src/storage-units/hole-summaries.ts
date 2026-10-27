import type { StorageUnitHoleSummary } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

interface SummaryRow {
  storage_unit_id: string;
  test_hole_id: string;
  test_hole_name: string;
  summary_type: StorageUnitHoleSummary['type'];
  sample_from: string | null;
  sample_to: string | null;
  depth_from: string | null;
  depth_to: string | null;
  depth_unit: 'ft' | 'm' | null;
  custom_text: string | null;
  note: string | null;
}

/** Hole summaries for the given units, keyed by unit ID, each list ordered by test-hole name. */
export async function loadHoleSummaries(
  pool: Pool | PoolClient,
  storageUnitIds: string[],
): Promise<Map<string, StorageUnitHoleSummary[]>> {
  const byUnit = new Map<string, StorageUnitHoleSummary[]>();
  if (storageUnitIds.length === 0) return byUnit;
  const { rows } = await pool.query<SummaryRow>(
    `SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type,
            h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text,
            h.note
     FROM storage_unit_hole_summary h
     JOIN test_hole th ON th.id = h.test_hole_id
     WHERE h.storage_unit_id = ANY ($1::uuid[])
     ORDER BY th.name_normalized, th.id`,
    [storageUnitIds],
  );
  for (const row of rows) {
    const list = byUnit.get(row.storage_unit_id) ?? [];
    list.push({
      testHoleId: row.test_hole_id,
      testHoleName: row.test_hole_name,
      type: row.summary_type,
      sampleFrom: row.sample_from,
      sampleTo: row.sample_to,
      // numeric(8, 2) arrives as a string; 1.50 shows as 1.5.
      depthFrom: row.depth_from === null ? null : Number(row.depth_from),
      depthTo: row.depth_to === null ? null : Number(row.depth_to),
      depthUnit: row.depth_unit,
      customText: row.custom_text,
      note: row.note,
    });
    byUnit.set(row.storage_unit_id, list);
  }
  return byUnit;
}
