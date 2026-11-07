import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { ConcreteProjectSettings } from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteSettingsService } from './concrete-settings.service.js';

/**
 * Per-project concrete settings (MM-V2-C02). Every active session reads them, as it reads the
 * project (`inventory.read`, LAB included: field and receiving work use the defaults). Saving is
 * `@ActiveUser()`; the service checks `project.edit` (the project's Lead Project Engineer or an
 * admin) against the project as it stands.
 */
@Controller('projects/:projectId/concrete-settings')
export class ConcreteSettingsController {
  constructor(private readonly settings: ConcreteSettingsService) {}

  @Get()
  @RequirePermission('inventory.read')
  get(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteProjectSettings> {
    return this.settings.get(projectId, user);
  }

  @Patch()
  @ActiveUser()
  update(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteProjectSettings> {
    return this.settings.update(projectId, body, user, actorFor(user), requestIdOf(request));
  }
}
