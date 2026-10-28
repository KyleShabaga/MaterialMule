import { Body, Controller, Param, Post, Req, Res } from '@nestjs/common';
import {
  confirmTestedRemovalRequestSchema,
  type ConfirmTestedRemovalResponse,
} from '@materialmule/shared';
import type { Response } from 'express';
import { requestIdOf } from '../../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/policy.js';
import { parseBody } from '../../validation/parse-body.js';
import { TestedRemovalService } from './tested-removal.service.js';

/**
 * Post-testing removal of a tested Shelby tube or bulk soil bucket (MM-T36). Personal accounts
 * only (`storage_unit.tested_removal`): LAB is refused before the body is read, whoever its
 * station selects. No retention, hold, disposal approval or program closure is checked.
 */
@Controller('storage-units')
export class TestedRemovalController {
  constructor(private readonly removals: TestedRemovalService) {}

  /** 201 recorded; 200 an exact retry. Accepts the readable ID or the UUID. */
  @Post(':id/tested-removal')
  @RequirePermission('storage_unit.tested_removal')
  async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConfirmTestedRemovalResponse> {
    const input = parseBody(confirmTestedRemovalRequestSchema, body);
    const result = await this.removals.confirm(id, input, user, requestIdOf(request));
    response.status(result.replayed ? 200 : 201);
    return result;
  }
}
