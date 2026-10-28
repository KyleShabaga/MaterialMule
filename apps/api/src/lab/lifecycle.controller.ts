import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  lifecycleRequestSchema,
  repeatTestRequestSchema,
  type LifecycleRequestResult,
  type ProgramLifecycleResult,
  type TestRequestResult,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { LabLifecycleService } from './lifecycle.service.js';

/**
 * Program lifecycle, cancellation and repeats (MM-T26). Personal accounts only: the shared LAB
 * account gets 403 on every route here, whoever it selects at the station.
 *
 * - close: the project's PM/PE (`program.close`, checked in the handler; never a delegate);
 * - reopen and cancel: the project's PM/PE or a Lab Manager (checked in the handler);
 * - close-request, cancel-request: `program.close_request` / `test.cancel_request`;
 * - repeat: `lab_program.amend`.
 */
@Controller()
export class LabLifecycleController {
  constructor(private readonly lifecycle: LabLifecycleService) {}

  @Post('lab-programs/:id/close')
  @HttpCode(200)
  @ActiveUser()
  close(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProgramLifecycleResult> {
    return this.lifecycle.close(id, body, user);
  }

  @Post('lab-programs/:id/reopen')
  @HttpCode(200)
  @ActiveUser()
  reopen(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ProgramLifecycleResult> {
    return this.lifecycle.reopen(id, body, user);
  }

  @Post('lab-programs/:id/close-request')
  @HttpCode(201)
  @RequirePermission('program.close_request')
  requestClose(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<LifecycleRequestResult> {
    return this.lifecycle.requestClose(id, parseBody(lifecycleRequestSchema, body), user);
  }

  @Post('test-requests/:id/cancel')
  @HttpCode(200)
  @ActiveUser()
  cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<TestRequestResult> {
    return this.lifecycle.cancel(id, body, user);
  }

  @Post('test-requests/:id/cancel-request')
  @HttpCode(201)
  @RequirePermission('test.cancel_request')
  requestCancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<LifecycleRequestResult> {
    return this.lifecycle.requestCancel(id, parseBody(lifecycleRequestSchema, body), user);
  }

  @Post('test-requests/:id/repeat')
  @HttpCode(201)
  @RequirePermission('lab_program.amend')
  repeat(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<TestRequestResult> {
    return this.lifecycle.repeat(id, parseBody(repeatTestRequestSchema, body), user);
  }
}
