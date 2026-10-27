import { Body, Controller, NotFoundException, Param, Patch } from '@nestjs/common';
import { storageUnitCorrectionRequestSchema, type StorageUnitDetail } from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/policy.js';
import { parseBody } from '../../validation/parse-body.js';
import { StorageUnitCorrectionsService } from './corrections.service.js';

/** Corrections to a confirmed storage unit (MM-T13). Personal accounts only; LAB gets 403. */
@Controller('storage-units')
export class StorageUnitCorrectionsController {
  constructor(private readonly corrections: StorageUnitCorrectionsService) {}

  /**
   * `{version, reason, changes}` → the corrected unit. 409 `version_conflict` for a stale
   * version, 409 `unresolved_lab_links` when a project change is blocked, 400 for validation.
   * Accepts the unit's UUID or readable ID.
   */
  @Patch(':id')
  @RequirePermission('storage_unit.correct')
  async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<StorageUnitDetail> {
    const request = parseBody(storageUnitCorrectionRequestSchema, body);
    const unit = await this.corrections.correct(id, request, user);
    if (!unit) throw new NotFoundException({ code: 'storage_unit_not_found' });
    return unit;
  }
}
