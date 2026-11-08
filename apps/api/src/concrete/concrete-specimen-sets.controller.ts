import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type {
  ConcreteCastingCorrectionResult,
  ConcreteSpecimenSetDefaults,
  ConcreteSpecimenSetDetail,
  ConcreteSpecimenSetList,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteSpecimenSetsService } from './concrete-specimen-sets.service.js';

/**
 * Specimen sets and age assignments (MM-V2-C05), beneath their field report. Reads follow the
 * project (`inventory.read`, LAB included). Draft writes need `concrete_report.draft` (C10) with
 * C04's own-draft rule, checked before the body and again under the D09 locks. The casting
 * correction (AC5) checks `concrete_specimen.reschedule` on the report's project in the handler
 * (owner to confirm). No allocation, Void, reschedule or device-code route here.
 */
@Controller('concrete')
export class ConcreteSpecimenSetsController {
  constructor(private readonly sets: ConcreteSpecimenSetsService) {}

  @Get('field-reports/:reportId/specimen-set-defaults')
  @RequirePermission('inventory.read')
  defaults(@Param('reportId') reportId: string): Promise<ConcreteSpecimenSetDefaults> {
    return this.sets.defaults(reportId);
  }

  @Get('field-reports/:reportId/specimen-sets')
  @RequirePermission('inventory.read')
  list(
    @Param('reportId') reportId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteSpecimenSetList> {
    return this.sets.list(reportId, user);
  }

  @Post('field-reports/:reportId/specimen-sets')
  @RequirePermission('concrete_report.draft')
  create(
    @Param('reportId') reportId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSpecimenSetDetail> {
    return this.sets.create(reportId, body, user, actorFor(user), requestIdOf(request));
  }

  @Get('specimen-sets/:id')
  @RequirePermission('inventory.read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ConcreteSpecimenSetDetail> {
    return this.sets.get(id, user);
  }

  @Patch('specimen-sets/:id')
  @RequirePermission('concrete_report.draft')
  save(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSpecimenSetDetail> {
    return this.sets.save(id, body, user, actorFor(user), requestIdOf(request));
  }

  @Delete('specimen-sets/:id')
  @RequirePermission('concrete_report.draft')
  discard(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string; discarded: true }> {
    return this.sets.discard(id, body, user, actorFor(user), requestIdOf(request));
  }

  @Post('field-reports/:reportId/casting-correction')
  @ActiveUser()
  correctCasting(
    @Param('reportId') reportId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteCastingCorrectionResult> {
    return this.sets.correctCasting(reportId, body, user, actorFor(user), requestIdOf(request));
  }
}
