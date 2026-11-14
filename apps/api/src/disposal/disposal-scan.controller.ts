import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  disposalScanRequestSchema,
  type DisposalScanCheckResponse,
  type DisposalScanRecordResponse,
} from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { DisposalScanService } from './disposal-scan.service.js';

/**
 * STRATA-92 Disposal scan-out. Both routes: personal accounts with `storage_unit.dispose_scan`
 * (STRATA-111, kept as today); a LAB station is refused whoever it names. `check` changes nothing;
 * `record` disposes the approved intents and is idempotent per intent ID. The Move routes can
 * never dispose a unit.
 */
@Controller('disposal/scan')
export class DisposalScanController {
  constructor(private readonly scan: DisposalScanService) {}

  /** Per intent: what recording would do now (approved, not approved, blocked, not found…). */
  @Post('check')
  @HttpCode(200)
  @RequirePermission('storage_unit.dispose_scan')
  check(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<DisposalScanCheckResponse> {
    return this.scan.check(user, parseBody(disposalScanRequestSchema, body));
  }

  /** Per intent: the outcome recorded (a retry returns the first one). Always 200 per batch. */
  @Post('record')
  @HttpCode(200)
  @RequirePermission('storage_unit.dispose_scan')
  record(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<DisposalScanRecordResponse> {
    return this.scan.record(user, parseBody(disposalScanRequestSchema, body));
  }
}
