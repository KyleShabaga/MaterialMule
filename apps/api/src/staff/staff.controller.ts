import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  disableStaffRequestSchema,
  LIST_TOTAL_HEADER,
  preprovisionStaffRequestSchema,
  setStaffRolesRequestSchema,
  staffListQuerySchema,
  setJobTitleOverrideRequestSchema,
  updateStaffRequestSchema,
  type ReceiverOption,
  type StaffMember,
} from '@materialmule/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { StaffService } from './staff.service.js';

/** Validates with a shared zod schema; the 400 lists field messages, never submitted values. */
function parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new BadRequestException({
      code: 'invalid_request',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

const uuid = new ParseUUIDPipe();

/**
 * Settings → Staff & access (MM-T07). Every management route needs `staff.manage` (admin only;
 * LAB never). Receiver search is open to any active session, LAB included: choosing a receiver
 * is attribution, not authentication, and grants nothing.
 */
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get('receivers')
  @ActiveUser()
  receivers(@Query('search') search?: string): Promise<ReceiverOption[]> {
    return this.staff.receivers(typeof search === 'string' ? search.slice(0, 100) : undefined);
  }

  @Get()
  @RequirePermission('staff.manage')
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffMember[]> {
    const { items, total } = await this.staff.list(parse(staffListQuerySchema, query));
    // The body stays a plain array; the header says whether it was cut (BUG-007).
    response.setHeader(LIST_TOTAL_HEADER, String(total));
    return items;
  }

  @Post()
  @RequirePermission('staff.manage')
  preprovision(
    @Body() body: unknown,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffMember> {
    return this.staff.preprovision(parse(preprovisionStaffRequestSchema, body), {
      actor: actorFor(admin),
      requestId: requestIdOf(request),
    });
  }

  @Post(':id/approve')
  @RequirePermission('staff.manage')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', uuid) id: string,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffMember> {
    return this.staff.approve(id, { actor: actorFor(admin), requestId: requestIdOf(request) });
  }

  @Post(':id/disable')
  @RequirePermission('staff.manage')
  @HttpCode(HttpStatus.OK)
  disable(
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffMember> {
    const { reason } = parse(disableStaffRequestSchema, body);
    return this.staff.disable(id, reason, {
      actor: actorFor(admin),
      requestId: requestIdOf(request),
    });
  }

  @Post(':id/enable')
  @RequirePermission('staff.manage')
  @HttpCode(HttpStatus.OK)
  enable(
    @Param('id', uuid) id: string,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffMember> {
    return this.staff.enable(id, { actor: actorFor(admin), requestId: requestIdOf(request) });
  }

  @Put(':id/roles')
  @RequirePermission('staff.manage')
  setRoles(
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffMember> {
    const { roles, reason } = parse(setStaffRolesRequestSchema, body);
    return this.staff.setRoles(id, roles, reason ?? null, {
      actor: actorFor(admin),
      requestId: requestIdOf(request),
    });
  }

  /** D16 (MM-AO06): set or clear the job-title override; always with a reason. */
  @Put(':id/job-title-override')
  @RequirePermission('staff.manage')
  setJobTitleOverride(
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffMember> {
    const { jobTitleOverride, reason } = parse(setJobTitleOverrideRequestSchema, body);
    return this.staff.setJobTitleOverride(id, jobTitleOverride, reason, {
      actor: actorFor(admin),
      requestId: requestIdOf(request),
    });
  }

  @Patch(':id')
  @RequirePermission('staff.manage')
  update(
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffMember> {
    return this.staff.update(id, parse(updateStaffRequestSchema, body), {
      actor: actorFor(admin),
      requestId: requestIdOf(request),
    });
  }
}
