import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { ConcreteExceptionNoteList, ConcreteReviewQueue } from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteReviewService } from './concrete-review.service.js';

/**
 * The review queue and exception notes (MM-V2-C28). Reads follow C04's report reads
 * (`inventory.read`, LAB included). Documenting an exception is review work: the guard admits any
 * active user and the service checks `concrete.review` (project-scoped, with C09's routing and
 * never on one's own report) before the body.
 */
@Controller('concrete')
export class ConcreteReviewController {
  constructor(private readonly review: ConcreteReviewService) {}

  @Get('review-queue')
  @RequirePermission('inventory.read')
  queue(
    @Query() query: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteReviewQueue> {
    return this.review.queue(query, user);
  }

  @Get('field-reports/:id/versions/:versionNo/exception-notes')
  @RequirePermission('inventory.read')
  notes(
    @Param('id') id: string,
    @Param('versionNo') versionNo: string,
  ): Promise<ConcreteExceptionNoteList> {
    return this.review.notes(id, versionNo);
  }

  @Post('field-reports/:id/versions/:versionNo/exception-notes')
  @ActiveUser()
  document(
    @Param('id') id: string,
    @Param('versionNo') versionNo: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConcreteExceptionNoteList> {
    return this.review.document(id, versionNo, body, user, actorFor(user), requestIdOf(req));
  }
}
