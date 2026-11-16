import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  inboxBulkSchema,
  inboxQuerySchema,
  type InboxBulkResult,
  type InboxPage,
  type InboxSummary,
} from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { InboxService } from './inbox.service.js';

const QUERY_FIELDS = new Set(['tab', 'filter', 'q', 'sort', 'page', 'pageSize']);

/**
 * The single Inbox (STRATA-25/55). Personal accounts only: the shared LAB account holds neither
 * `notification.read` nor `action_item.read`, so it gets 403 on every route whoever it selects,
 * and a pending account gets 403 too. Nothing here resolves a request; reading only changes the
 * signed-in person's read state. Updates keep their own routes (`/api/notifications/:id/...`).
 */
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @RequirePermission('notification.read')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<InboxPage> {
    const parsed = inboxQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      const code =
        typeof field === 'string' && QUERY_FIELDS.has(field) ? `invalid_${field}` : 'invalid_query';
      throw new BadRequestException({ code });
    }
    return this.inbox.page(user, parsed.data);
  }

  @Get('summary')
  @RequirePermission('notification.read')
  summary(@CurrentUser() user: AuthUser): Promise<InboxSummary> {
    return this.inbox.summary(user);
  }

  @Post('read-all')
  @HttpCode(200)
  @RequirePermission('notification.read')
  readAll(@CurrentUser() user: AuthUser): Promise<InboxSummary> {
    return this.inbox.readAll(user);
  }

  /**
   * STRATA-48: read, unread or dismiss checked rows by feed key. Keys that aren't the signed-in
   * person's go to `failed`; dismiss with a request key is 400 `dismiss_requests`, nothing changed.
   */
  @Post('bulk')
  @HttpCode(200)
  @RequirePermission('notification.read')
  bulk(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<InboxBulkResult> {
    return this.inbox.bulk(user, parseBody(inboxBulkSchema, body));
  }

  @Post('requests/:id/read')
  @HttpCode(200)
  @RequirePermission('action_item.read')
  read(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<InboxSummary> {
    return this.inbox.markRequest(user, id, true);
  }

  @Post('requests/:id/unread')
  @HttpCode(200)
  @RequirePermission('action_item.read')
  unread(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<InboxSummary> {
    return this.inbox.markRequest(user, id, false);
  }
}
