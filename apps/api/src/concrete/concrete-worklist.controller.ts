import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type {
  ConcreteRescheduleResult,
  ConcreteScheduleHistory,
  ConcreteWorklist,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteWorklistService } from './concrete-worklist.service.js';

/**
 * Daily concrete lab worklist and specimen rescheduling (MM-V2-C22). Reads use the existing
 * internal read (`inventory.read`, LAB included) until the owner defines "lab staff". The
 * reschedule checks `concrete_specimen.reschedule` on the specimen's project in the handler,
 * before the body and again under the D09 locks.
 */
@Controller('concrete')
export class ConcreteWorklistController {
  constructor(private readonly worklist: ConcreteWorklistService) {}

  @Get('lab-worklist')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<ConcreteWorklist> {
    return this.worklist.worklist(query, user);
  }

  @Get('specimens/:specimenId/schedule-history')
  @RequirePermission('inventory.read')
  history(@Param('specimenId') specimenId: string): Promise<ConcreteScheduleHistory> {
    return this.worklist.history(specimenId);
  }

  @Post('specimens/:specimenId/reschedule')
  @ActiveUser()
  reschedule(
    @Param('specimenId') specimenId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteRescheduleResult> {
    return this.worklist.reschedule(specimenId, body, user, actorFor(user), requestIdOf(request));
  }
}
