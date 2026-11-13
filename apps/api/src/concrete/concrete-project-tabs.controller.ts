import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type {
  ConcreteMixPropagationPreview,
  ConcreteMixPropagationResult,
  ConcreteProjectSetList,
  ConcreteProjectSpecimenList,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteMixPropagationService } from './concrete-mix-propagation.service.js';
import { ConcreteProjectSpecimensService } from './concrete-project-specimens.service.js';

/**
 * The project Concrete section (MM-V2-C30): the Specimens and Sets (STRATA-98) tabs and the mix
 * propagation review.
 * Reads follow the project (`inventory.read`, LAB included, like the project's mixes and field
 * reports). Applying a propagation is `@ActiveUser()`; the service checks `concrete_mix.approve`
 * (the project's Lead only) against the project as it stands, under the D09 locks.
 */
@Controller()
export class ConcreteProjectTabsController {
  constructor(
    private readonly specimens: ConcreteProjectSpecimensService,
    private readonly propagation: ConcreteMixPropagationService,
  ) {}

  @Get('concrete/projects/:projectId/specimens')
  @RequirePermission('inventory.read')
  listSpecimens(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ConcreteProjectSpecimenList> {
    return this.specimens.list(projectId, query);
  }

  // STRATA-98: the Sets tab (one row per set, "n of m tested").
  @Get('concrete/projects/:projectId/specimen-sets')
  @RequirePermission('inventory.read')
  listSets(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ConcreteProjectSetList> {
    return this.specimens.listSets(projectId, query);
  }

  @Get('concrete-mixes/:id/propagation')
  @RequirePermission('inventory.read')
  preview(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteMixPropagationPreview> {
    return this.propagation.preview(id, user);
  }

  @Post('concrete-mixes/:id/propagation')
  @ActiveUser()
  apply(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteMixPropagationResult> {
    return this.propagation.apply(id, body, user, actorFor(user), requestIdOf(request));
  }
}
