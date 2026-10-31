import { Body, Controller, Get, NotFoundException, Param, Patch } from '@nestjs/common';
import {
  changeBulkGroupRequestSchema,
  correctBulkGroupRequestSchema,
  type BulkGroupSummary,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/policy.js';
import { parseBody } from '../../validation/parse-body.js';
import { BulkGroupsService } from './bulk-groups.service.js';

/**
 * Bulk-sample groups (MM-T36). Listing follows receiving (LAB may read); both corrections need
 * `storage_unit.correct`, which only personal accounts hold, so LAB gets 403.
 */
@Controller()
export class BulkGroupsController {
  constructor(private readonly bulkGroups: BulkGroupsService) {}

  /** The project's bulk samples, for the receiving picker and the correction form. */
  @Get('projects/:projectId/bulk-groups')
  @RequirePermission('inventory.read')
  list(@Param('projectId') projectId: string): Promise<BulkGroupSummary[]> {
    return this.bulkGroups.list(projectId);
  }

  /**
   * `{version, reason, groupId | newGroup}` → the corrected unit. 409 `version_conflict`;
   * 422 `not_bulk_bucket`, `bulk_identity_required` (groupId null), `bulk_group_not_in_project`,
   * `storage_unit_disposed`, `storage_unit_tested` (MM-T82),
   * `test_hole_not_in_project`; 400 for validation.
   */
  @Patch('storage-units/:id/bulk-group')
  @RequirePermission('storage_unit.correct')
  async changeMembership(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<StorageUnitDetail> {
    const request = parseBody(changeBulkGroupRequestSchema, body);
    const unit = await this.bulkGroups.changeMembership(id, request, user);
    if (!unit) throw new NotFoundException({ code: 'storage_unit_not_found' });
    return unit;
  }

  /** `{version, reason, identity}` → the corrected group. 409 `version_conflict`, 422, 400. */
  @Patch('bulk-groups/:id')
  @RequirePermission('storage_unit.correct')
  async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<BulkGroupSummary> {
    const request = parseBody(correctBulkGroupRequestSchema, body);
    const group = await this.bulkGroups.correctIdentity(id, request, user);
    if (!group) throw new NotFoundException({ code: 'bulk_group_not_found' });
    return group;
  }
}
