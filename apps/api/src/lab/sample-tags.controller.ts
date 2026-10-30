import { Controller, Get, Param } from '@nestjs/common';
import type { SampleTagSheet } from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { SampleTagsService } from './sample-tags.service.js';

/**
 * Sample ID tags for a submitted or closed program (MM-T69). `lab_program.read`, with the
 * program's own visibility; 404 `lab_program_not_found`, 409 `program_not_submitted` for a draft.
 */
@Controller()
export class SampleTagsController {
  constructor(private readonly tags: SampleTagsService) {}

  @Get('lab-programs/:id/sample-tags')
  @RequirePermission('lab_program.read')
  sheet(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<SampleTagSheet> {
    return this.tags.sheet(id, user);
  }
}
