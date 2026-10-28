import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  actionRequestStatusFilterSchema,
  reassignActionRequestSchema,
  updateNotificationPreferencesSchema,
  type ActionRequest,
  type ActionRequestAssignees,
  type ActionRequestCount,
  type ActionRequestList,
  type NotificationPreferences,
} from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { ActionItemsService } from './action-items.service.js';

/**
 * Action requests inbox and personal notification preferences (MM-T27). Personal accounts only:
 * the shared LAB account gets 403 everywhere here, whoever it selects at the station. Nothing
 * here resolves an item; resolution is the underlying workflow action (close, cancel, correction
 * done), which checks its own permission.
 */
@Controller()
export class ActionItemsController {
  constructor(private readonly items: ActionItemsService) {}

  @Get('action-items')
  @RequirePermission('action_item.read')
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
  ): Promise<ActionRequestList> {
    const parsed = actionRequestStatusFilterSchema.safeParse(status ?? 'open');
    if (!parsed.success || (scope !== undefined && scope !== 'mine' && scope !== 'all')) {
      throw new BadRequestException({ code: 'invalid_filter' });
    }
    return this.items.list(user, parsed.data, scope ?? 'mine');
  }

  @Get('action-items/count')
  @RequirePermission('action_item.read')
  count(@CurrentUser() user: AuthUser): Promise<ActionRequestCount> {
    return this.items.count(user);
  }

  @Get('action-items/:id/assignees')
  @RequirePermission('action_item.reassign')
  assignees(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ActionRequestAssignees> {
    return this.items.assignees(user, id);
  }

  @Post('action-items/:id/reassign')
  @HttpCode(200)
  @RequirePermission('action_item.reassign')
  reassign(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ActionRequest> {
    return this.items.reassign(user, id, parseBody(reassignActionRequestSchema, body));
  }

  @Get('me/notification-preferences')
  @RequirePermission('action_item.read')
  preferences(@CurrentUser() user: AuthUser): Promise<NotificationPreferences> {
    return this.items.preferences(user);
  }

  @Put('me/notification-preferences')
  @RequirePermission('action_item.read')
  updatePreferences(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationPreferences> {
    return this.items.updatePreferences(user, parseBody(updateNotificationPreferencesSchema, body));
  }
}
