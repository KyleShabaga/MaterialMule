import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { putDraftSettingsRequestSchema, type DraftSettings } from '@trapezoid/shared';
import { requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { parseBody } from '../validation/parse-body.js';
import { getDraftSettings, putDraftSettings } from './draft-settings.js';

/** App settings (TRP-T40). */
@Controller('settings')
export class SettingsController {
  constructor(private readonly database: DatabaseService) {}

  /** Draft auto-delete. Every active session reads it (receiving stations, LAB included). */
  @Get('drafts')
  @ActiveUser()
  drafts(): Promise<DraftSettings> {
    return getDraftSettings(this.database.pool);
  }

  /** `{draftAutoDelete: {enabled, afterDays}, version}`: Admin and Lab Manager only. */
  @Put('drafts')
  @RequirePermission('settings.drafts.manage')
  updateDrafts(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<DraftSettings> {
    const input = parseBody(putDraftSettingsRequestSchema, body);
    return putDraftSettings(this.database.pool, user, input, requestIdOf(request));
  }
}
