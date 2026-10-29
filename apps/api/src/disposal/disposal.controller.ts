import {
  Body,
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
  removeDisposalSchema,
  revokeDisposalSchema,
  type ApproveDisposalResult,
  type DisposalCandidates,
  type DisposalScanResult,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { DisposalService } from './disposal.service.js';

/**
 * Standard disposal (MM-T30). Approve/revoke: the project's Lead Project Engineer or a Lab Manager
 * (`disposal.approve`, project-scoped, checked in the handler). Removal scan: personal accounts
 * (`storage_unit.dispose_scan`); LAB is refused whoever its station selects. The ordinary move
 * routes can never dispose a unit. MM-T36's post-testing removal is a separate route.
 */
@Controller('disposal')
export class DisposalController {
  constructor(private readonly disposal: DisposalService) {}

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

  /** 200 Disposed; 422 Not approved / Blocked (with reasons, audited); 404 unknown ID. */
  @Post('remove')
  @HttpCode(200)
  @RequirePermission('storage_unit.dispose_scan')
  async remove(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<DisposalScanResult> {
    const result = await this.disposal.remove(user, parseBody(removeDisposalSchema, body));
    if (result.result === 'not_found') throw new NotFoundException(result);
    if (result.result !== 'disposed') throw new UnprocessableEntityException(result);
    return result;
  }
}
