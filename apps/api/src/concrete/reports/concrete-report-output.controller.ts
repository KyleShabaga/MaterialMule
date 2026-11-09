import { Body, Controller, Get, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type {
  ConcreteReportHeader,
  ConcreteSummaryReport,
  ConcreteSummaryReportList,
} from '@materialmule/shared';
import type { Response } from 'express';
import { actorFor, requestIdOf } from '../../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/policy.js';
import { ConcreteReportOutputService } from './concrete-report-output.service.js';

function sendPdf(response: Response, bytes: Uint8Array, fileName: string, sha256?: string) {
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (sha256) response.setHeader('X-Content-SHA256', sha256);
  response.end(Buffer.from(bytes));
}

/**
 * Issued concrete report files and the project summary report (MM-V2-C32). Reads follow the
 * project (`inventory.read`, LAB included, as the other concrete reads): the stored file is
 * served exactly as issued. Issuing a summary is `@ActiveUser()`; the service checks
 * `report.issue` on the project (the lead or an Authorized report issuer) before the body and
 * again under the project lock. The report header is admin-managed (proposal).
 */
@Controller()
export class ConcreteReportOutputController {
  constructor(private readonly output: ConcreteReportOutputService) {}

  @Get('concrete/report-files/:fileId')
  @RequirePermission('inventory.read')
  async download(@Param('fileId') fileId: string, @Res() response: Response): Promise<void> {
    const stored = await this.output.file(fileId);
    sendPdf(response, stored.content, stored.record.fileName, stored.record.sha256);
  }

  @Get('concrete/projects/:projectId/summary-reports')
  @RequirePermission('inventory.read')
  listSummaries(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteSummaryReportList> {
    return this.output.listSummaries(projectId, user);
  }

  /** The unnumbered preview (never stored): the same snapshot and template as issuing. */
  @Get('concrete/projects/:projectId/summary-reports/preview')
  @RequirePermission('inventory.read')
  async previewSummary(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const bytes = await this.output.previewSummary(projectId, query);
    sendPdf(response, bytes, 'summary-preview.pdf');
  }

  @Post('concrete/projects/:projectId/summary-reports')
  @ActiveUser()
  issueSummary(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSummaryReport> {
    return this.output.issueSummary(projectId, body, user, actorFor(user), requestIdOf(request));
  }

  @Get('concrete/report-header')
  @RequirePermission('inventory.read')
  header(): Promise<ConcreteReportHeader> {
    return this.output.header();
  }

  @Put('concrete/report-header')
  @RequirePermission('concrete_settings.report_header.manage')
  updateHeader(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteReportHeader> {
    return this.output.updateHeader(body, actorFor(user), user, requestIdOf(request));
  }
}
