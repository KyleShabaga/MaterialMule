import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  approveDisposalSchema,
  disposalCandidatesQuerySchema,
  disposalReadyQuerySchema,
  removeDisposalSchema,
  removeFromDisposalListSchema,
  revokeDisposalSchema,
  type ApproveDisposalResult,
  type DisposalCandidates,
  type DisposalReady,
  type DisposalScanOutcome,
  type RemoveFromDisposalListResult,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { DisposalScanService } from './disposal-scan.service.js';
import { DisposalService } from './disposal.service.js';

/**
 * Standard disposal (MM-T30). Approve/revoke: the project's Lead Project Engineer or a Lab Manager
 * (`disposal.approve`, project-scoped, checked in the handler). Removal scan: personal accounts
 * (`storage_unit.dispose_scan`); LAB is refused whoever its station selects. The ordinary move
 * routes can never dispose a unit. MM-T36's post-testing removal is a separate route.
 * STRATA-90: units are put on the disposal list through `POST /api/retention/decisions`; the same
 * people take them off here.
 */
@Controller('disposal')
export class DisposalController {
  constructor(
    private readonly disposal: DisposalService,
    private readonly scan: DisposalScanService,
  ) {}

  @Get('eligible')
  @RequirePermission('inventory.read')
  eligible(
    @Query('projectId') projectId: string | undefined,
    @Query('page') page: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<DisposalCandidates> {
    const query = parseBody(disposalCandidatesQuerySchema, { page });
    return this.disposal.candidates(user, projectId ?? '', query.page);
  }

  /** MISC-13: ready for disposal now, every project; same permission as `eligible`. */
  @Get('ready')
  @RequirePermission('inventory.read')
  ready(
    @Query('page') page: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<DisposalReady> {
    return this.disposal.ready(user, parseBody(disposalReadyQuerySchema, { page }).page);
  }

  @Post('approvals')
  @HttpCode(201)
  @ActiveUser()
  async approve(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ApproveDisposalResult> {
    await this.disposal.assertMayApprove(user);
    return this.disposal.approve(user, parseBody(approveDisposalSchema, body));
  }

  @Post('approvals/:id/revoke')
  @HttpCode(200)
  @ActiveUser()
  async revoke(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.disposal.assertMayApprove(user);
    return this.disposal.revoke(user, id, parseBody(revokeDisposalSchema, body));
  }

  /** STRATA-90: take units off the disposal list (reason required). */
  @Post('list/remove')
  @HttpCode(200)
  @ActiveUser()
  async removeFromList(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<RemoveFromDisposalListResult> {
    await this.disposal.assertMayApprove(user);
    return this.disposal.removeFromList(user, parseBody(removeFromDisposalListSchema, body));
  }

  /**
   * One scan (online). 200 Disposed; 422 Not approved / Blocked (with reasons, audited); 404
   * unknown ID. Recorded by DisposalScanService (STRATA-92), the same rules as the scan page.
   */
  @Post('remove')
  @HttpCode(200)
  @RequirePermission('storage_unit.dispose_scan')
  async remove(@Body() raw: unknown, @CurrentUser() user: AuthUser): Promise<DisposalScanOutcome> {
    const body = parseBody(removeDisposalSchema, raw);
    const result = await this.scan.recordOne(user, {
      intentId: body.idempotencyKey,
      code: body.suNumber,
      scannedByUserId: user.userId,
      scannedAt: new Date().toISOString(),
    });
    if (result.result === 'intent_reused') {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    if (result.result === 'not_found') throw new NotFoundException(result);
    if (result.result !== 'disposed') throw new UnprocessableEntityException(result);
    return result;
  }
}
