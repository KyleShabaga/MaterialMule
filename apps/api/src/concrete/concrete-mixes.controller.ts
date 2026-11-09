import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type {
  ConcreteMixDetail,
  ConcreteMixList,
  ConcreteMixSuppliers,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteMixesService } from './concrete-mixes.service.js';

/**
 * Project concrete mixes (MM-V2-C03). Reads follow the project (`inventory.read`: every active
 * session, LAB included, as the project GETs and concrete settings). Writes are `@ActiveUser()`;
 * the service checks `concrete_mix.manage` / `concrete_mix.approve` (the project's Lead Project
 * Engineer only) against the project as it stands, under the D09 locks.
 */
@Controller()
export class ConcreteMixesController {
  constructor(private readonly mixes: ConcreteMixesService) {}

  @Get('projects/:projectId/concrete-mixes')
  @RequirePermission('inventory.read')
  list(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteMixList> {
    return this.mixes.list(projectId, query, user);
  }

  @Get('projects/:projectId/concrete-mix-suppliers')
  @RequirePermission('inventory.read')
  suppliers(@Param('projectId') projectId: string): Promise<ConcreteMixSuppliers> {
    return this.mixes.suppliers(projectId);
  }

  @Post('projects/:projectId/concrete-mixes')
  @ActiveUser()
  create(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteMixDetail> {
    return this.mixes.create(projectId, body, user, actorFor(user), requestIdOf(request));
  }

  @Post('projects/:projectId/concrete-mixes/copy')
  @ActiveUser()
  copy(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteMixDetail> {
    return this.mixes.copy(projectId, body, user, actorFor(user), requestIdOf(request));
  }

  @Get('concrete-mixes/:id')
  @RequirePermission('inventory.read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ConcreteMixDetail> {
    return this.mixes.get(id, user);
  }

  @Patch('concrete-mixes/:id')
  @ActiveUser()
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteMixDetail> {
    return this.mixes.update(id, body, user, actorFor(user), requestIdOf(request));
  }

  @Post('concrete-mixes/:id/approve')
  @ActiveUser()
  approve(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteMixDetail> {
    return this.mixes.approve(id, body, user, actorFor(user), requestIdOf(request));
  }

  /** MM-V2-C37: discard the open draft revision of an approved mix (the Lead). */
  @Post('concrete-mixes/:id/discard-draft')
  @ActiveUser()
  @HttpCode(HttpStatus.OK)
  discardDraft(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteMixDetail> {
    return this.mixes.discardDraft(id, body, user, actorFor(user), requestIdOf(request));
  }
}
