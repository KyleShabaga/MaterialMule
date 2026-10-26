import { BadRequestException, Body, Controller, Post, Res } from '@nestjs/common';
import {
  confirmReceiptRequestSchema,
  toFieldErrors,
  type ConfirmReceiptResponse,
} from '@materialmule/shared';
import type { Response } from 'express';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ReceiptsService } from './receipts.service.js';

@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  /**
   * Confirms a receiving draft (MM-T09). 201 when the receipt is created; 200 with the original
   * result when the same idempotency key and payload are sent again. Printing is separate (T15).
   */
  @Post()
  @RequirePermission('receipt.confirm')
  async confirm(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConfirmReceiptResponse> {
    const parsed = confirmReceiptRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        errors: toFieldErrors(parsed.error),
      });
    }
    const result = await this.receipts.confirm(parsed.data, user);
    response.status(result.created ? 201 : 200);
    return result.response;
  }
}
