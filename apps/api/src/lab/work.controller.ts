import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  addCommentRequestSchema,
  changeTestStatusRequestSchema,
  editCommentRequestSchema,
  type LabComment,
  type ProgramWork,
  type SameSourceUnits,
  type Worklist,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { LabWorkService } from './work.service.js';

/**
 * Lab worklist and progress (MM-T24). Progress and comments: personal accounts, or LAB with a
 * valid `actingStaffUserId` on every request. Priority: the project's PM/PE or a Lab Manager
 * (checked in the handler, project-scoped). 403 before 422 (`invalid_transition`,
 * `program_not_open`, `tested_units_required`, `unit_not_covered`, `confirmation_not_needed`,
 * `unit_disposed`, `unit_contents_destroyed`) before 409
 * (`version_conflict` with current state, `idempotency_key_reused`, `edit_window_closed`).
 */
@Controller()
export class LabWorkController {
  constructor(private readonly work: LabWorkService) {}

  /** D52 order: Urgent first, then oldest submission; ordering never changes a status. */
  @Get('worklist')
  @RequirePermission('lab_program.read')
  worklist(
    @Query('priority') priority?: string,
    @Query('projectId') projectId?: string,
    @Query('open') open?: string,
    @Query('testTypeId') testTypeId?: string,
  ): Promise<Worklist> {
    return this.work.worklist({ priority, projectId, openOnly: open === 'true', testTypeId });
  }

  @Get('lab-programs/:id/work')
  @RequirePermission('lab_program.read')
  programWork(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ProgramWork> {
    return this.work.work(id, user);
  }

  /**
   * MM-T73: units of the line's own source outside its frozen coverage that a completion may
   * still record as tested, with an explicit same-source confirmation.
   */
  @Get('test-requests/:id/same-source-units')
  @RequirePermission('test.progress')
  sameSourceUnits(@Param('id') id: string): Promise<SameSourceUnits> {
    return this.work.sameSourceUnits(id);
  }

  @Post('test-requests/:id/status')
  @HttpCode(200)
  @RequirePermission('test.progress')
  changeStatus(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.work.changeStatus(id, parseBody(changeTestStatusRequestSchema, body), user);
  }

  @Patch('lab-programs/:id/priority')
  @ActiveUser()
  changePriority(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    // Authority is project-scoped and checked before the body is validated.
    return this.work.changePriority(id, body, user);
  }

  @Post('lab-programs/:id/comments')
  @RequirePermission('lab_comment.write')
  addComment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<LabComment> {
    return this.work.addComment(id, parseBody(addCommentRequestSchema, body), user);
  }

  @Patch('comments/:id')
  @RequirePermission('lab_comment.write')
  editComment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<LabComment> {
    return this.work.editComment(id, parseBody(editCommentRequestSchema, body), user);
  }
}
