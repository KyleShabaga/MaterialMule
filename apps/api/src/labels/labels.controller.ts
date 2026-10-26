import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import type { LabelPreview, ReceiptLabelPreviews } from '@trapezoid/shared';
import { RequirePermission } from '../auth/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { getLabelPreview, getReceiptLabelPreviews } from './label-preview.js';

/**
 * Label preview (TRP-T39): the T14 sticker SVG for the screen and for Print → Save as PDF. Same
 * permission as reading the unit. Never creates a print job, changes a unit or writes an audit
 * event: saving a PDF is not a label print.
 */
@Controller()
export class LabelsController {
  constructor(private readonly database: DatabaseService) {}

  /** Accepts the storage unit's UUID or its readable ID (e.g. BKT-2026-000014). */
  @Get('storage-units/:id/label/preview')
  @RequirePermission('inventory.read')
  async preview(@Param('id') id: string): Promise<LabelPreview> {
    const preview = await getLabelPreview(this.database.pool, id);
    if (!preview) throw new NotFoundException({ code: 'storage_unit_not_found' });
    return preview;
  }

  @Get('receipts/:id/labels/preview')
  @RequirePermission('inventory.read')
  async receiptPreviews(@Param('id') id: string): Promise<ReceiptLabelPreviews> {
    const previews = await getReceiptLabelPreviews(this.database.pool, id);
    if (!previews) throw new NotFoundException({ code: 'receipt_not_found' });
    return previews;
  }
}
