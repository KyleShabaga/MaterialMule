import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  submitFeedbackRequestSchema,
  type FeedbackItem,
  type SubmitFeedbackResponse,
} from '@materialmule/shared';
import { requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { FeedbackService } from './feedback.service.js';

/**
 * Help & Feedback. Anyone signed in and approved (LAB included) may send feedback; only
 * administrators (`staff.manage`) read it. It stays on the host: nothing is emailed.
 */
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  @ActiveUser()
  submit(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<SubmitFeedbackResponse> {
    const input = parseBody(submitFeedbackRequestSchema, body);
    return this.feedback.submit(user, input, requestIdOf(request));
  }

  @Get()
  @RequirePermission('staff.manage')
  list(): Promise<FeedbackItem[]> {
    return this.feedback.list();
  }
}
