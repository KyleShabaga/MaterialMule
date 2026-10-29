import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  correctionDoneRequestSchema,
  reviewDecisionRequestSchema,
  type AcceptanceDelegates,
  type ReviewResult,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { LabReviewService } from './review.service.js';

/**
 * Review corrections and delegated acceptance (MM-T25). Personal accounts only: the shared LAB
 * account gets 403 on every route here, whoever it selects at the station.
 *
 * - review (complete / return): `test.review`, any internal personal account;
 * - correction-done: `test.correction_done`, the Lab Manager role only;
 * - accept: active user, handler checks `test.accept` for the test's project (Lead Project Engineer or an active
 *   delegate) before reading the body;
 * - delegates: read with `acceptance_delegation.read`; grant and revoke by the project's Lead Project Engineer
 *   (`acceptance_delegation.manage`, checked in the handler), each with a reason (D15, MM-AO03):
 *   the revocation is `DELETE` with a JSON body `{reason}`.
 */
@Controller()
export class LabReviewController {
  constructor(private readonly reviews: LabReviewService) {}

  @Post('test-requests/:id/review')
  @HttpCode(200)
  @RequirePermission('test.review')
  review(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ReviewResult> {
    return this.reviews.review(id, parseBody(reviewDecisionRequestSchema, body), user);
  }

  @Post('test-requests/:id/correction-done')
  @HttpCode(200)
  @RequirePermission('test.correction_done')
  correctionDone(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ReviewResult> {
    return this.reviews.correctionDone(id, parseBody(correctionDoneRequestSchema, body), user);
  }

  @Post('test-requests/:id/accept')
  @HttpCode(200)
  @ActiveUser()
  accept(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ReviewResult> {
    return this.reviews.accept(id, body, user);
  }

  @Get('projects/:projectId/acceptance-delegates')
  @RequirePermission('acceptance_delegation.read')
  delegates(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AcceptanceDelegates> {
    return this.reviews.delegates(projectId, user);
  }

  @Post('projects/:projectId/acceptance-delegates')
  @ActiveUser()
  grant(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<AcceptanceDelegates> {
    return this.reviews.grant(projectId, body, user);
  }

  @Delete('projects/:projectId/acceptance-delegates/:id')
  @ActiveUser()
  revoke(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<AcceptanceDelegates> {
    return this.reviews.revoke(projectId, id, body, user);
  }
}
