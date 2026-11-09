import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type {
  ConcreteReceivingException,
  ConcreteReceivingExceptionList,
  ConcreteReportReceiving,
  ConcreteSetReceiving,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteReceivingService } from './concrete-receiving.service.js';

/**
 * Concrete specimen pickup, initial curing and lab receipt (MM-V2-C06). Reads use the internal
 * read (`inventory.read`, LAB included). Pickup, the Pick up window, receipt and mass entry,
 * marker confirmation and recording exceptions need `concrete_specimen.receive` (lab staff,
 * MM-V2-C36); a mass correction `concrete_specimen.mass_correct` on a personal account.
 * Resolving an exception (`concrete_receiving_exception.resolve`) and a curing flag
 * (`concrete.review`) are project authority, checked in the handler.
 */
@Controller('concrete')
export class ConcreteReceivingController {
  constructor(private readonly receiving: ConcreteReceivingService) {}

  @Get('specimen-sets/:setId/receiving')
  @RequirePermission('inventory.read')
  setReceiving(@Param('setId') setId: string): Promise<ConcreteSetReceiving> {
    return this.receiving.setReceiving(setId);
  }

  @Get('field-reports/:reportId/receiving')
  @RequirePermission('inventory.read')
  reportReceiving(@Param('reportId') reportId: string): Promise<ConcreteReportReceiving> {
    return this.receiving.reportReceiving(reportId);
  }

  @Get('projects/:projectId/receiving-exceptions')
  @RequirePermission('inventory.read')
  exceptions(
    @Param('projectId') projectId: string,
    @Query() query: unknown,
  ): Promise<ConcreteReceivingExceptionList> {
    return this.receiving.listExceptions(projectId, query);
  }

  @Post('specimen-sets/:setId/pickup')
  @RequirePermission('concrete_specimen.receive')
  pickup(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSetReceiving> {
    return this.receiving.pickup(setId, body, user, actorFor(user), requestIdOf(request));
  }

  @Put('specimen-sets/:setId/pickup-window')
  @RequirePermission('concrete_specimen.receive')
  pickupWindow(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSetReceiving> {
    return this.receiving.pickupWindow(setId, body, user, actorFor(user), requestIdOf(request));
  }

  @Post('specimens/:specimenId/receipt')
  @RequirePermission('concrete_specimen.receive')
  receipt(
    @Param('specimenId') specimenId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSetReceiving> {
    return this.receiving.receipt(specimenId, body, user, actorFor(user), requestIdOf(request));
  }

  @Post('specimens/:specimenId/mass-correction')
  @RequirePermission('concrete_specimen.mass_correct')
  massCorrection(
    @Param('specimenId') specimenId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSetReceiving> {
    return this.receiving.massCorrection(
      specimenId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Post('specimen-sets/:setId/marker-confirmation')
  @RequirePermission('concrete_specimen.receive')
  markerConfirmation(
    @Param('setId') setId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSetReceiving> {
    return this.receiving.markerConfirmation(
      setId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Post('projects/:projectId/receiving-exceptions')
  @RequirePermission('concrete_specimen.receive')
  recordException(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteReceivingException> {
    return this.receiving.recordException(
      projectId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Post('receiving-exceptions/:exceptionId/resolve')
  @ActiveUser()
  resolveException(
    @Param('exceptionId') exceptionId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteReceivingException> {
    return this.receiving.resolveException(
      exceptionId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Post('specimens/:specimenId/curing-resolution')
  @ActiveUser()
  curingResolution(
    @Param('specimenId') specimenId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSetReceiving> {
    return this.receiving.curingResolution(
      specimenId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }
}
