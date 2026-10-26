import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { createTestHoleRequestSchema, type TestHole } from '@trapezoid/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { TestHolesService } from './test-holes.service.js';

@Controller('projects/:projectId/test-holes')
export class TestHolesController {
  constructor(private readonly testHoles: TestHolesService) {}

  /** Holes in the project matching `q` (contains, ignoring case), TRP-T08. */
  @Get()
  @RequirePermission('inventory.read')
  list(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('q') q?: string,
  ): Promise<TestHole[]> {
    return this.testHoles.list(projectId, typeof q === 'string' ? q : '');
  }

  /** Add a missing hole while receiving. 201 with the hole, or 409 `{existing}`. */
  @Post()
  @RequirePermission('test_hole.create')
  create(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<TestHole> {
    const input = parseBody(createTestHoleRequestSchema, body);
    return this.testHoles.create(projectId, input, actorFor(user), requestIdOf(request));
  }
}
