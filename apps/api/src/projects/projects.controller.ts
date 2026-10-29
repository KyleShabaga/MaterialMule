import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  PROJECT_SEARCH_DEFAULT_LIMIT,
  createProjectRequestSchema,
  projectListQuerySchema,
  updateProjectRequestSchema,
  type ProjectDetail,
  type ProjectListPage,
  type ProjectSummary,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
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

  /**
   * Projects table (MM-T35): `GET /api/projects?search=&mine=&sort=&dir=&page=&pageSize=` →
   * `{items, total, page, pageSize}`. Every active session may read, LAB included.
   */
  @Get()
  @RequirePermission('inventory.read')
  list(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<ProjectListPage> {
    return this.projects.list(parseBody(projectListQuerySchema, query), user.userId);
  }

  /** Search by project number or name, prefix or contains, ignoring case (MM-T08). */
  @Get('search')
  @RequirePermission('inventory.read')
  search(@Query('q') q?: string, @Query('limit') limit?: string): Promise<ProjectSummary[]> {
    const requested = Number.parseInt(limit ?? '', 10);
    return this.projects.search(
      typeof q === 'string' ? q : '',
      Number.isFinite(requested) ? requested : PROJECT_SEARCH_DEFAULT_LIMIT,
    );
  }

  /** Project detail (MM-T35); a superset of the T08 summary. */
  @Get(':projectId')
  @RequirePermission('inventory.read')
  get(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectDetail> {
    return this.projects.getDetail(projectId, user);
  }

  /**
   * Add a missing project while receiving (D42). 201 with the project, or 409 `{existing}`. The
   * creator may nominate a lead or (with "Can create and lead projects") lead it (MM-AO04).
   */
  @Post()
  @RequirePermission('project.create')
  create(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectSummary> {
    const input = parseBody(createProjectRequestSchema, body);
    return this.projects.create(input, user, actorFor(user), requestIdOf(request));
  }

  /**
   * Edit a project (MM-T35). Project-scoped: the service allows admins and the project's Lead Project Engineer
   * (`project.edit`), and only admins to change the Lead Project Engineer (`project.lead_project_engineer.change`).
   */
  @Patch(':projectId')
  @ActiveUser()
  update(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectDetail> {
    const input = parseBody(updateProjectRequestSchema, body);
    return this.projects.update(projectId, input, user, actorFor(user), requestIdOf(request));
  }
}
