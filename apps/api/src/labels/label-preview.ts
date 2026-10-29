import {
  normalizeStorageUnitCode,
  type LabelPreview,
  type ReceiptLabelPreviews,
} from '@materialmule/shared';
import type { Pool } from 'pg';
import { renderPreviewSvg } from './preview.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StickerRow {
  id: string;
  readable_id: string;
  received_date: string;
  project_number: string;
  project_name: string;
  test_holes: string[];
}

/**
 * The unit's current sticker values, selected exactly as the print worker (T15) selects them, so
 * the preview shows what the ZD621 would print. Read-only: no print job, no audit event.
 */
// The origin line (test-hole / field-location names) comes from storage_unit_origin_names
// (storage_unit_origin_names): hole names, a Shelby tube's source or a bulk group's source. Never sample
// references, depths, group IDs or bucket counts (MM-T36 sticker contract).
const STICKER_SELECT = `
  SELECT su.id, su.readable_id, su.received_date::text AS received_date,
         p.project_number, p.name AS project_name,
         storage_unit_origin_names(su.id) AS test_holes
  FROM storage_unit su
  JOIN project p ON p.id = su.project_id`;

function toPreview(row: StickerRow): LabelPreview {
  const preview = renderPreviewSvg({
    storageUnitId: row.readable_id,
    projectNumber: row.project_number,
    projectName: row.project_name,
    receivedDate: row.received_date,
    testHoles: row.test_holes,
  });
  return {
    storageUnitId: row.id,
    readableId: row.readable_id,
    svg: preview.svg,
    templateVersion: preview.templateVersion,
    warnings: preview.warnings,
  };
}

/** Preview for one unit by UUID or readable ID (any case); null when there is no such unit. */
export async function getLabelPreview(pool: Pool, idOrCode: string): Promise<LabelPreview | null> {
  const byUuid = UUID_PATTERN.test(idOrCode);
  const { rows } = await pool.query<StickerRow>(
    `${STICKER_SELECT}
     WHERE ${byUuid ? 'su.id' : 'su.readable_id'} = $1`,
    [byUuid ? idOrCode : normalizeStorageUnitCode(idOrCode)],
  );
  const row = rows[0];
  return row ? toPreview(row) : null;
}

/** Every label of a receipt in receipt order; null when there is no such receipt. */
export async function getReceiptLabelPreviews(
  pool: Pool,
  receiptId: string,
): Promise<ReceiptLabelPreviews | null> {
  if (!UUID_PATTERN.test(receiptId)) return null;
  const { rows: receipts } = await pool.query('SELECT 1 FROM receipt WHERE id = $1', [receiptId]);
  if (receipts.length === 0) return null;
  const { rows } = await pool.query<StickerRow>(
    `${STICKER_SELECT}
     WHERE su.receipt_id = $1
     ORDER BY su.receipt_line NULLS LAST, su.readable_id`,
    [receiptId],
  );
  return { receiptId, labels: rows.map(toPreview) };
}
