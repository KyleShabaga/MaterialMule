import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type {
  ConcreteFieldReportDetail,
  ConcreteReportAction,
  ConcreteReportVersionDetail,
  ConcreteReportVersionList,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteReportLifecycleService } from './concrete-report-lifecycle.service.js';

/**
 * Field-report versions and lifecycle commands (MM-V2-C09). Reads follow the project
 * (`inventory.read`, LAB included, as C04's report reads). Submit and resubmit need
 * `concrete_report.draft` at the guard (LAB with the performing staff member); the other
 * commands are project- and record-scoped, so the guard admits any active user and the service
 * checks `concrete_report.recall`, `concrete.review` or `report.issue` before the body.
 */
@Controller('concrete/field-reports')
export class ConcreteReportLifecycleController {
  constructor(private readonly lifecycle: ConcreteReportLifecycleService) {}

  @Get(':id/versions')
  @RequirePermission('inventory.read')
  versions(@Param('id') id: string): Promise<ConcreteReportVersionList> {
    return this.lifecycle.versions(id);
  }

  @Get(':id/versions/:versionNo')
  @RequirePermission('inventory.read')
  version(
    @Param('id') id: string,
    @Param('versionNo') versionNo: string,
  ): Promise<ConcreteReportVersionDetail> {
    return this.lifecycle.version(id, versionNo);
  }

  @Post(':id/submit')
  @RequirePermission('concrete_report.draft')
  submit(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('submit', id, body, user, req);
  }

  @Post(':id/resubmit')
  @RequirePermission('concrete_report.draft')
  resubmit(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('resubmit', id, body, user, req);
  }

  @Post(':id/recall')
  @ActiveUser()
  recall(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('recall', id, body, user, req);
  }

  @Post(':id/return')
  @ActiveUser()
  returnForCorrection(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('return', id, body, user, req);
  }

  @Post(':id/review')
  @ActiveUser()
  review(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('review', id, body, user, req);
  }

  @Post(':id/issue')
  @ActiveUser()
  issue(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('issue', id, body, user, req);
  }

  @Post(':id/revise')
  @ActiveUser()
  revise(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('revise', id, body, user, req);
  }

  private run(
    action: ConcreteReportAction,
    id: string,
    body: unknown,
    user: AuthUser,
    req: AuthenticatedRequest,
  ): Promise<ConcreteFieldReportDetail> {
    return this.lifecycle.command(action, id, body, user, actorFor(user), requestIdOf(req));
  }
}
