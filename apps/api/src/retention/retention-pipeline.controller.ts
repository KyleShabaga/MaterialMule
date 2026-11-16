import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  retentionDecisionSchema,
  retentionDecisionUnitsQuerySchema,
  retentionPipelineQuerySchema,
  type RetentionDecisionResult,
  type RetentionDecisionUnits,
  type RetentionPipeline,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { RetentionPipelineService } from './retention-pipeline.service.js';
import { RetentionService } from './retention.service.js';

/**
 * STRATA-90/91: the Retention page's pipeline and the decision drawer. Reads: anyone who reads
 * inventory (as the per-unit and per-project retention reads). Decisions: the project's Lead
 * Project Engineer or a Lab Manager, checked per project under lock (holds and extensions
 * `retention.manage`, the disposal list `disposal.approve`); 403 before the body is read for
 * anyone who can't decide anywhere, and LAB never. Others use `POST /api/retention/requests`.
 */
@Controller('retention')
export class RetentionPipelineController {
  constructor(
    private readonly pipeline: RetentionPipelineService,
    private readonly retention: RetentionService,
  ) {}

  @Get('pipeline')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<RetentionPipeline> {
    return this.pipeline.pipeline(user, parseBody(retentionPipelineQuerySchema, query));
  }

  @Get('decision-units')
  @RequirePermission('inventory.read')
  units(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<RetentionDecisionUnits> {
    return this.pipeline.decisionUnits(user, parseBody(retentionDecisionUnitsQuerySchema, query));
  }

  @Post('decisions')
  @HttpCode(200)
  @ActiveUser()
  async decide(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<RetentionDecisionResult> {
    // Lab Managers and Lead Project Engineers hold both retention.manage and disposal.approve;
    // each project is checked again under lock for the action chosen.
    await this.retention.assertMayManage(user);
    return this.pipeline.decide(user, parseBody(retentionDecisionSchema, body));
  }
}
