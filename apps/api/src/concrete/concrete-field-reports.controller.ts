import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { ConcreteFieldReportDetail, ConcreteFieldReportList } from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteFieldReportsService } from './concrete-field-reports.service.js';

/**
 * Concrete field-report drafts (MM-V2-C04). Reads follow the project (`inventory.read`: every
 * active session, LAB included, like the project's mixes and equipment). Writes need
 * `concrete_report.draft` (C10): the guard checks it before the body, and the service again under
 * the D09 locks together with the own-draft rule (CD-58). No submission or issuance route here.
 */
@Controller('concrete')
export class ConcreteFieldReportsController {
  constructor(private readonly reports: ConcreteFieldReportsService) {}

  @Get('projects/:projectId/field-reports')
  @RequirePermission('inventory.read')
  list(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ConcreteFieldReportList> {
    return this.reports.list(projectId, query);
  }

  @Post('projects/:projectId/field-reports')
  @RequirePermission('concrete_report.draft')
  create(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteFieldReportDetail> {
    return this.reports.create(projectId, body, user, actorFor(user), requestIdOf(request));
  }

  @Get('field-reports/:id')
  @RequirePermission('inventory.read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ConcreteFieldReportDetail> {
    return this.reports.get(id, user);
  }

  @Patch('field-reports/:id')
  @RequirePermission('concrete_report.draft')
  save(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteFieldReportDetail> {
    return this.reports.save(id, body, user, actorFor(user), requestIdOf(request));
  }
}
