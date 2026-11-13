import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type {
  ConcreteDisposalReady,
  ConcreteHoldActionResult,
  ConcreteHoldHistory,
  ConcreteHoldList,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteHoldsService } from './concrete-holds.service.js';

/**
 * HOLD management, bulk HOLD actions and concrete specimen disposal (MM-V2-C26). Reads use the
 * internal read (`inventory.read`, LAB included). Schedule test and Authorize disposal check
 * `concrete_ordinary_hold.manage` (ordinary HOLD) or `concrete_hold.manage` (failed-specimen
 * hold) per specimen in the handler: a caller who can release no hold anywhere is refused before
 * the body. Record disposal is lab staff (`concrete_specimen.dispose_record`).
 */
@Controller('concrete')
export class ConcreteHoldsController {
  constructor(private readonly holds: ConcreteHoldsService) {}

  @Get('holds')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<ConcreteHoldList> {
    return this.holds.list(query, user);
  }

  @Get('specimens/:specimenId/hold-history')
  @RequirePermission('inventory.read')
  history(@Param('specimenId') specimenId: string): Promise<ConcreteHoldHistory> {
    return this.holds.history(specimenId);
  }

  @Post('holds/schedule-test')
  @HttpCode(200)
  @ActiveUser()
  scheduleTest(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteHoldActionResult> {
    return this.holds.scheduleTest(body, user, actorFor(user), requestIdOf(request));
  }

  /** STRATA-121: scheduled specimens onto an ordinary HOLD until a date (from Breaks). */
  @Post('holds/hold-until')
  @HttpCode(200)
  @ActiveUser()
  holdUntil(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteHoldActionResult> {
    return this.holds.holdUntil(body, user, actorFor(user), requestIdOf(request));
  }

  @Post('holds/authorize-disposal')
  @HttpCode(200)
  @ActiveUser()
  authorizeDisposal(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteHoldActionResult> {
    return this.holds.authorizeDisposal(body, user, actorFor(user), requestIdOf(request));
  }

  /** MISC-13's Ready for disposal list, Concrete specimens filter. */
  @Get('disposal/ready')
  @RequirePermission('inventory.read')
  ready(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<ConcreteDisposalReady> {
    return this.holds.ready(query, user);
  }

  @Post('disposal/record')
  @HttpCode(200)
  @RequirePermission('concrete_specimen.dispose_record')
  record(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteHoldActionResult> {
    return this.holds.recordDisposal(body, user, actorFor(user), requestIdOf(request));
  }
}
