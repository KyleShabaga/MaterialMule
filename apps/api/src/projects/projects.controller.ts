import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import {
  PROJECT_SEARCH_DEFAULT_LIMIT,
  createProjectRequestSchema,
  type ProjectSummary,
} from '@trapezoid/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /** Search by project number or name, prefix or contains, ignoring case (TRP-T08). */
  @Get('search')
  @RequirePermission('inventory.read')
  search(@Query('q') q?: string, @Query('limit') limit?: string): Promise<ProjectSummary[]> {
    const requested = Number.parseInt(limit ?? '', 10);
    return this.projects.search(
      typeof q === 'string' ? q : '',
      Number.isFinite(requested) ? requested : PROJECT_SEARCH_DEFAULT_LIMIT,
    );
  }

  @Get(':projectId')
  @RequirePermission('inventory.read')
  get(@Param('projectId', new ParseUUIDPipe()) projectId: string): Promise<ProjectSummary> {
    return this.projects.getById(projectId);
  }

  /** Add a missing project while receiving (D42). 201 with the project, or 409 `{existing}`. */
  @Post()
  @RequirePermission('project.create')
  create(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectSummary> {
    const input = parseBody(createProjectRequestSchema, body);
    return this.projects.create(input, actorFor(user), requestIdOf(request));
  }
}
