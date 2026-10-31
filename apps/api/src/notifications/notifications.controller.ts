import { BadRequestException, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  notificationFilterSchema,
  type NotificationCount,
  type NotificationList,
} from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { NotificationsService } from './notifications.service.js';

/**
 * In-app notifications (MM-T91). Personal accounts only (`notification.read`): a LAB station
 * gets 403 on every route, whoever it selects. Each route reads or changes the signed-in person's
 * own notifications; nothing here resolves, approves or changes an action request.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission('notification.read')
  list(@CurrentUser() user: AuthUser, @Query('filter') filter?: string): Promise<NotificationList> {
    const parsed = notificationFilterSchema.safeParse(filter ?? 'active');
    if (!parsed.success) throw new BadRequestException({ code: 'invalid_filter' });
    return this.notifications.list(user, parsed.data);
  }

  @Get('count')
  @RequirePermission('notification.read')
  count(@CurrentUser() user: AuthUser): Promise<NotificationCount> {
    return this.notifications.count(user);
  }

  @Post('read-all')
  @HttpCode(200)
  @RequirePermission('notification.read')
  readAll(@CurrentUser() user: AuthUser): Promise<NotificationCount> {
    return this.notifications.markAllRead(user);
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission('notification.read')
  read(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<NotificationCount> {
    return this.notifications.markRead(user, id);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @RequirePermission('notification.read')
  dismiss(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<NotificationCount> {
    return this.notifications.dismiss(user, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission('notification.read')
  restore(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<NotificationCount> {
    return this.notifications.restore(user, id);
  }
}
