import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import type { ConcreteStrengthExclusionState, ConcreteStrengthTests } from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteStrengthService } from './concrete-strength.service.js';

/**
 * MM-V2-C24: strength tests (computed, advisory) and reviewer exclusions. Reads follow the
 * concrete reads (`inventory.read`). Exclusion is project-scoped, so the guard admits any active
 * user and the service checks `concrete.review` (scope `concrete_strength`) before the body.
 */
@Controller('concrete')
export class ConcreteStrengthController {
  constructor(private readonly strength: ConcreteStrengthService) {}

  @Get('strength-tests')
  @RequirePermission('inventory.read')
  tests(@Query() query: Record<string, unknown>): Promise<ConcreteStrengthTests> {
    return this.strength.tests(query);
  }

  @Get('specimens/:specimenId/strength-exclusion')
  @RequirePermission('inventory.read')
  exclusion(@Param('specimenId') specimenId: string): Promise<ConcreteStrengthExclusionState> {
    return this.strength.exclusion(specimenId);
  }

  @Put('specimens/:specimenId/strength-exclusion')
  @ActiveUser()
  exclude(
    @Param('specimenId') specimenId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConcreteStrengthExclusionState> {
    return this.strength.exclude(specimenId, body, user, actorFor(user), requestIdOf(req));
  }
}
