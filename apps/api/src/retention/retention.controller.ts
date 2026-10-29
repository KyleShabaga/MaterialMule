import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  decideRetentionRequestSchema,
  placeHoldSchema,
  releaseRetentionSchema,
  retentionRequestSchema,
  setExtensionSchema,
  type ProjectRetention,
  type RetentionMutationResult,
  type RetentionRequestResult,
  type StorageUnitRetention,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { RetentionService } from './retention.service.js';

/**
 * Retention (MM-T29). Reads: anyone who reads inventory. Holds, extensions, releases and request
 * decisions: the project's Lead Project Engineer or a Lab Manager (`retention.manage`, project-scoped, checked in
 * the handler). Requests: `retention.request` (personal accounts). LAB: 403 on every change,
 * whoever its station selects.
 */
@Controller()
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('storage-units/:id/retention')
  @RequirePermission('inventory.read')
  unit(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<StorageUnitRetention> {
    return this.retention.unit(user, id);
  }

  @Get('projects/:id/retention')
  @RequirePermission('inventory.read')
  project(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ProjectRetention> {
    return this.retention.project(user, id);
  }

  @Post('retention/holds')
  @HttpCode(201)
  @ActiveUser()
  async placeHold(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<RetentionMutationResult> {
    await this.retention.assertMayManage(user);
    return this.retention.placeHold(user, parseBody(placeHoldSchema, body));
  }

  @Post('retention/holds/:id/release')
  @HttpCode(200)
  @ActiveUser()
  async releaseHold(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<RetentionMutationResult> {
    await this.retention.assertMayManage(user);
    return this.retention.release(user, 'hold', id, parseBody(releaseRetentionSchema, body));
  }

  @Post('retention/extensions')
  @HttpCode(201)
  @ActiveUser()
  async setExtension(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<RetentionMutationResult> {
    await this.retention.assertMayManage(user);
    return this.retention.setExtension(user, parseBody(setExtensionSchema, body));
  }

  @Post('retention/extensions/:id/release')
  @HttpCode(200)
  @ActiveUser()
  async releaseExtension(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<RetentionMutationResult> {
    await this.retention.assertMayManage(user);
    return this.retention.release(user, 'extension', id, parseBody(releaseRetentionSchema, body));
  }

  @Post('retention/requests')
  @HttpCode(201)
  @RequirePermission('retention.request')
  request(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<RetentionRequestResult> {
    return this.retention.request(user, parseBody(retentionRequestSchema, body));
  }

  @Post('retention/requests/:id/approve')
  @HttpCode(200)
  @ActiveUser()
  async approve(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.retention.assertMayManage(user);
    return this.retention.decide(
      user,
      id,
      'approved',
      parseBody(decideRetentionRequestSchema, body),
    );
  }

  @Post('retention/requests/:id/decline')
  @HttpCode(200)
  @ActiveUser()
  async decline(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.retention.assertMayManage(user);
    return this.retention.decide(
      user,
      id,
      'declined',
      parseBody(decideRetentionRequestSchema, body),
    );
  }
}
