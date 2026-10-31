import { z } from 'zod';

// Label preview (MM-T39): the T14 sticker as a real-size SVG, for the screen and for
// Print → Save as PDF. Previewing never creates a print job or an audit event.

/** `GET /api/storage-units/:id/label/preview`. */
export const labelPreviewSchema = z.object({
  /** Internal UUID of the storage unit. */
  storageUnitId: z.string(),
  /** Readable ID both barcodes encode, e.g. BKT-2026-000014. */
  readableId: z.string(),
  /** Real-size SVG (3.5in × 1.5in). Generated server-side from escaped values; show as an image. */
  svg: z.string(),
  templateVersion: z.string(),
  /** Plain-language fit warnings, e.g. "Project name shortened to fit". */
  warnings: z.array(z.string()),
  /**
   * MTR-48: the unit is disposed. Its `svg` is then watermarked DISPOSED with struck-through
   * barcodes, and the print views must not offer it.
   */
  disposed: z.boolean(),
});

export type LabelPreview = z.infer<typeof labelPreviewSchema>;

/** `GET /api/receipts/:id/labels/preview`: every label of a receipt, in receipt order. */
export const receiptLabelPreviewsSchema = z.object({
  receiptId: z.string(),
  labels: z.array(labelPreviewSchema),
});

export type ReceiptLabelPreviews = z.infer<typeof receiptLabelPreviewsSchema>;
