import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type {
  ConcreteSpecimenTestResults,
  ConcreteTestResult,
  ConcreteTestResultSaveResult,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteTestResultsService } from './concrete-test-results.service.js';

/**
 * Concrete test-result drafts (MM-V2-C07). Reads use the internal read (`inventory.read`, LAB
 * included), as every concrete read; saving needs `concrete_test.enter` (Lab Technicians, Lab
 * Managers and LAB naming the staff member entering it), re-checked under the account lock.
 */
@Controller('concrete/specimens/:specimenId/test-results')
export class ConcreteTestResultsController {
  constructor(private readonly results: ConcreteTestResultsService) {}

  @Get()
  @RequirePermission('inventory.read')
  list(@Param('specimenId') specimenId: string): Promise<ConcreteSpecimenTestResults> {
    return this.results.list(specimenId);
  }

  @Get(':resultId')
  @RequirePermission('inventory.read')
  get(
    @Param('specimenId') specimenId: string,
    @Param('resultId') resultId: string,
  ): Promise<ConcreteTestResult> {
    return this.results.get(specimenId, resultId);
  }

  @Put(':resultId')
  @RequirePermission('concrete_test.enter')
  save(
    @Param('specimenId') specimenId: string,
    @Param('resultId') resultId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteTestResultSaveResult> {
    return this.results.save(
      specimenId,
      resultId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }
}
