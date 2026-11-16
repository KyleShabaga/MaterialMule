import { Controller, Get } from '@nestjs/common';
import type { NeedsYouResponse } from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { TodayService } from './today.service.js';

/**
 * Today (STRATA-56). Personal accounts only: the shared LAB account doesn't hold `today.read`
 * (a station has no requests or authority of its own and never borrows the picked person's), and
 * a pending account gets 403 too. Read only.
 */
@Controller('today')
export class TodayController {
  constructor(private readonly today: TodayService) {}

  /** `GET /api/today/needs-you`: Inbox requests waiting on me plus system work, most urgent first. */
  @Get('needs-you')
  @RequirePermission('today.read')
  needsYou(@CurrentUser() user: AuthUser): Promise<NeedsYouResponse> {
    return this.today.needsYou(user);
  }
}
