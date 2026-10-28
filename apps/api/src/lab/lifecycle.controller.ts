import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  amendProgramRequestSchema,
  changeTestRequestSchema,
  lifecycleRequestSchema,
  repeatTestRequestSchema,
  type AmendmentResult,
  type LaterReceipts,
  type LifecycleRequestResult,
  type ProgramLifecycleResult,
  type TestRequestResult,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { LabAmendmentsService } from './amendments.service.js';
import { LabLifecycleService } from './lifecycle.service.js';

/**
 * Program lifecycle, cancellation and repeats (MM-T26). Personal accounts only: the shared LAB
 * account gets 403 on every route here, whoever it selects at the station.
 *
 * - close: the project's PM/PE (`program.close`, checked in the handler; never a delegate);
 * - reopen and cancel: the project's PM/PE or a Lab Manager (checked in the handler);
 * - close-request, cancel-request: `program.close_request` / `test.cancel_request`;
 * - repeat, amend, later-receipts and the accepted-request change (PATCH): `lab_program.amend`.
 */
@Controller()
export class LabLifecycleController {
  constructor(
    private readonly lifecycle: LabLifecycleService,
    private readonly amendments: LabAmendmentsService,
  ) {}

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

  /** Change the sample/depth/test of an Accepted test (D09): only it returns to Requested. */
  @Patch('test-requests/:id')
  @RequirePermission('lab_program.amend')
  change(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<TestRequestResult> {
    return this.amendments.changeRequest(id, parseBody(changeTestRequestSchema, body), user);
  }

  /** Units each ALL/Grabs/SPT line could take in by amendment (received since it froze). */
  @Get('lab-programs/:id/later-receipts')
  @RequirePermission('lab_program.amend')
  laterReceipts(@Param('id') id: string): Promise<LaterReceipts> {
    return this.amendments.laterReceipts(id);
  }

  @Post('lab-programs/:id/amend')
  @HttpCode(201)
  @RequirePermission('lab_program.amend')
  amend(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<AmendmentResult> {
    return this.amendments.amend(id, parseBody(amendProgramRequestSchema, body), user);
  }
}
