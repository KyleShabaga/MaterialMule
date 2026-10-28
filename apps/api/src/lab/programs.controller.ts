import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  createLabProgramRequestSchema,
  discardLabProgramRequestSchema,
  labSourceRefSchema,
  submitLabProgramRequestSchema,
  updateLabProgramRequestSchema,
  type LabProgram,
  type LabProgramList,
  type LabProgramReview,
  type LabSource,
  type LabSourceUnit,
} from '@materialmule/shared';
import type { Response } from 'express';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { LabProgramsService } from './programs.service.js';

/**
 * Testing programs (MM-T23). Reads: `lab_program.read`; drafts and submission:
 * `lab_program.manage` (personal accounts, and LAB with a valid `requestedByUserId` on every
 * action). 404 `lab_program_not_found` (also for someone else's draft); 409 `version_conflict`
 * and `not_draft` (with `current`), `coverage_changed` (with a fresh `review`),
 * `idempotency_key_reused`; 422 `not_ready` (with `review`), `requested_by_invalid`,
 * `requested_by_mismatch`, `source_not_in_project`, `unit_not_in_source`, `retired_tests`.
 */
@Controller()
export class LabProgramsController {
  constructor(private readonly programs: LabProgramsService) {}

  @Get('lab-programs')
  @RequirePermission('lab_program.read')
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('projectId') projectId?: string,
    @Query('page') page?: string,
  ): Promise<LabProgramList> {
    const pageNumber = Number(page);
    return this.programs.list(user, {
      status,
      projectId,
      page: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1,
    });
  }

  @Get('lab-programs/:id')
  @RequirePermission('lab_program.read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<LabProgram> {
    return this.programs.get(id, user);
  }

  /** What submitting now would record: coverage per line, warnings and blocking problems. */
  @Get('lab-programs/:id/review')
  @RequirePermission('lab_program.read')
  review(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<LabProgramReview> {
    return this.programs.review(id, user);
  }

  /** 201 with a new draft; 200 with the original draft when the idempotency key is replayed. */
  @Post('lab-programs')
  @RequirePermission('lab_program.manage')
  async create(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LabProgram> {
    const result = await this.programs.create(parseBody(createLabProgramRequestSchema, body), user);
    response.status(result.created ? 201 : 200);
    return result.program;
  }

  @Patch('lab-programs/:id')
  @RequirePermission('lab_program.manage')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<LabProgram> {
    return this.programs.update(id, parseBody(updateLabProgramRequestSchema, body), user);
  }

  @Post('lab-programs/:id/discard')
  @HttpCode(204)
  @RequirePermission('lab_program.manage')
  async discard(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const request = parseBody(discardLabProgramRequestSchema, body);
    await this.programs.discard(id, request.version, request.requestedByUserId, user);
  }

  /** 200 with the submitted program, also for an exact retry of a committed submission. */
  @Post('lab-programs/:id/submit')
  @HttpCode(200)
  @RequirePermission('lab_program.manage')
  async submit(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<LabProgram> {
    const result = await this.programs.submit(
      id,
      parseBody(submitLabProgramRequestSchema, body),
      user,
    );
    return result.program;
  }

  /** Sampling sources a line can name in this project (holes, standalone tubes and groups). */
  @Get('projects/:projectId/lab-sources')
  @RequirePermission('lab_program.read')
  sources(@Param('projectId') projectId: string): Promise<LabSource[]> {
    return this.programs.sources(projectId);
  }

  /** Units a source currently offers, for the Grabs/SPT review and Specific unit links. */
  @Get('projects/:projectId/lab-sources/:kind/:sourceId/units')
  @RequirePermission('lab_program.read')
  sourceUnits(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Param('sourceId') sourceId: string,
  ): Promise<LabSourceUnit[]> {
    const source = parseBody(labSourceRefSchema, { kind, id: sourceId });
    return this.programs.sourceUnits(projectId, source);
  }
}
