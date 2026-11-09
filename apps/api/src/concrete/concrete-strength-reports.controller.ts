import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type {
  ConcreteExceptionNoteList,
  ConcreteReportAction,
  ConcreteReportVersionDetail,
  ConcreteReportVersionList,
  ConcreteStrengthReportDetail,
  ConcreteStrengthReportList,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteStrengthReportsService } from './concrete-strength-reports.service.js';

/**
 * Concrete strength reports (MM-V2-C39): one per specimen set, addressed by the set. Reads follow
 * the concrete reads (`inventory.read`, LAB included). Submit, resubmit and recall are lab work
 * (`concrete_test.enter` at the guard; LAB names the performing person). Review, return, issue,
 * revise and exception notes are project- and record-scoped, so the guard admits any active user
 * and the service checks `concrete.review` / `report.issue` (scope `concrete_strength`) before
 * the body.
 */
@Controller('concrete')
export class ConcreteStrengthReportsController {
  constructor(private readonly reports: ConcreteStrengthReportsService) {}

  @Get('strength-reports')
  @RequirePermission('inventory.read')
  list(@Query() query: Record<string, unknown>): Promise<ConcreteStrengthReportList> {
    return this.reports.list(query);
  }

  @Get('specimen-sets/:setId/strength-report')
  @RequirePermission('inventory.read')
  detail(
    @Param('setId') setId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteStrengthReportDetail> {
    return this.reports.detail(setId, user);
  }

  @Get('specimen-sets/:setId/strength-report/versions')
  @RequirePermission('inventory.read')
  versions(@Param('setId') setId: string): Promise<ConcreteReportVersionList> {
    return this.reports.versions(setId);
  }

  @Get('specimen-sets/:setId/strength-report/versions/:versionNo')
  @RequirePermission('inventory.read')
  version(
    @Param('setId') setId: string,
    @Param('versionNo') versionNo: string,
  ): Promise<ConcreteReportVersionDetail> {
    return this.reports.version(setId, versionNo);
  }

  @Get('specimen-sets/:setId/strength-report/versions/:versionNo/exception-notes')
  @RequirePermission('inventory.read')
  notes(
    @Param('setId') setId: string,
    @Param('versionNo') versionNo: string,
  ): Promise<ConcreteExceptionNoteList> {
    return this.reports.notes(setId, versionNo);
  }

  @Post('specimen-sets/:setId/strength-report/versions/:versionNo/exception-notes')
  @ActiveUser()
  document(
    @Param('setId') setId: string,
    @Param('versionNo') versionNo: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConcreteExceptionNoteList> {
    return this.reports.document(setId, versionNo, body, user, actorFor(user), requestIdOf(req));
  }

  @Post('specimen-sets/:setId/strength-report/submit')
  @RequirePermission('concrete_test.enter')
  submit(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('submit', setId, body, user, req);
  }

  @Post('specimen-sets/:setId/strength-report/resubmit')
  @RequirePermission('concrete_test.enter')
  resubmit(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('resubmit', setId, body, user, req);
  }

  @Post('specimen-sets/:setId/strength-report/recall')
  @RequirePermission('concrete_test.enter')
  recall(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('recall', setId, body, user, req);
  }

  @Post('specimen-sets/:setId/strength-report/return')
  @ActiveUser()
  returnForCorrection(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('return', setId, body, user, req);
  }

  @Post('specimen-sets/:setId/strength-report/review')
  @ActiveUser()
  review(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('review', setId, body, user, req);
  }

  @Post('specimen-sets/:setId/strength-report/issue')
  @ActiveUser()
  issue(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('issue', setId, body, user, req);
  }

  @Post('specimen-sets/:setId/strength-report/revise')
  @ActiveUser()
  revise(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.run('revise', setId, body, user, req);
  }

  private run(
    action: ConcreteReportAction,
    setId: string,
    body: unknown,
    user: AuthUser,
    req: AuthenticatedRequest,
  ): Promise<ConcreteStrengthReportDetail> {
    return this.reports.command(action, setId, body, user, actorFor(user), requestIdOf(req));
  }
}
