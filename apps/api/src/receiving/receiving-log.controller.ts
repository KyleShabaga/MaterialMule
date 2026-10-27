import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import {
  receiptIdParamSchema,
  receiptLogQuerySchema,
  receiptReceiverQuerySchema,
  type ReceiptDetail,
  type ReceiptLogPage,
  type ReceiverOption,
} from '@materialmule/shared';
import { RequirePermission } from '../auth/auth.decorators.js';
import { parseBody } from '../validation/parse-body.js';
import { ReceivingLogService } from './receiving-log.service.js';

/**
 * Receiving Log (MM-T51): confirmed receipts, read-only. Every active session, LAB included, may
 * read it (`inventory.read`); labels keep `label.print` and corrections `storage_unit.correct`.
 */
@Controller('receipts')
export class ReceivingLogController {
  constructor(private readonly receivingLog: ReceivingLogService) {}

  /**
   * `GET /api/receipts?search=&projectId=&receiverUserId=&receivedFrom=&receivedTo=&page=&pageSize=`
   * → `{items, total, page, pageSize}`, one row per receipt.
   */
  @Get()
  @RequirePermission('inventory.read')
  list(@Query() query: unknown): Promise<ReceiptLogPage> {
    return this.receivingLog.list(parseBody(receiptLogQuerySchema, query));
  }

  /** Received by filter options. Declared before `:receiptId` so it isn't taken for an ID. */
  @Get('receivers')
  @RequirePermission('inventory.read')
  receivers(@Query() query: unknown): Promise<ReceiverOption[]> {
    return this.receivingLog.receivers(parseBody(receiptReceiverQuerySchema, query));
  }

  @Get(':receiptId')
  @RequirePermission('inventory.read')
  async detail(@Param() params: unknown): Promise<ReceiptDetail> {
    const { receiptId } = parseBody(receiptIdParamSchema, params);
    const receipt = await this.receivingLog.detail(receiptId);
    if (!receipt) throw new NotFoundException({ code: 'receipt_not_found' });
    return receipt;
  }
}
