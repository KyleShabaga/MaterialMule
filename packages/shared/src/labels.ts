import { z } from 'zod';

// Label preview (TRP-T39): the T14 sticker as a real-size SVG, for the screen and for
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
});

export type LabelPreview = z.infer<typeof labelPreviewSchema>;

/** `GET /api/receipts/:id/labels/preview`: every label of a receipt, in receipt order. */
export const receiptLabelPreviewsSchema = z.object({
  receiptId: z.string(),
  labels: z.array(labelPreviewSchema),
});

export type ReceiptLabelPreviews = z.infer<typeof receiptLabelPreviewsSchema>;
