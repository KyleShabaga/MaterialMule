import { Controller, Get, Param } from '@nestjs/common';
import type { AccessSummary } from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { AccessSummaryService } from './access-summary.service.js';

/**
 * Access summaries (MM-AO06): `GET /api/me/access` is the signed-in person's own (personal
 * accounts: `project_access.read`, so LAB gets 403), never anyone else's. `GET /api/staff/:id/access`
 * is the admin's read-only view of a person (`staff.manage`), e.g. before disabling them.
 */
@Controller()
export class AccessSummaryController {
  constructor(private readonly access: AccessSummaryService) {}

  @Get('me/access')
  @RequirePermission('project_access.read')
  mine(@CurrentUser() user: AuthUser): Promise<AccessSummary> {
    return this.access.summary(user.userId, user);
  }

  @Get('staff/:id/access')
  @RequirePermission('staff.manage')
  person(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<AccessSummary> {
    return this.access.summary(id, user);
  }
}
