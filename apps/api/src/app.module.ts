import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ActivityController } from './activity/activity.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import {
  LabAdminController,
  LabAuthController,
} from './auth/providers/local-lab/lab-auth.controller.js';
import { LabAuthService } from './auth/providers/local-lab/lab-auth.service.js';
import {
  EntraIdentityProvider,
  microsoftSettings,
} from './auth/providers/microsoft/entra-provider.js';
import { MicrosoftAuthController } from './auth/providers/microsoft/microsoft-auth.controller.js';
import { MicrosoftSignInService } from './auth/providers/microsoft/microsoft-sign-in.service.js';
import {
  MICROSOFT_PROVIDER,
  MICROSOFT_SETTINGS,
} from './auth/providers/microsoft/microsoft.constants.js';
import { MicrosoftTokenCache } from './auth/providers/microsoft/token-cache.js';
import { SessionService } from './auth/session.service.js';
import { TestAuthController, testAuthEnabled } from './auth/test-provider/test-auth.controller.js';
import { APP_CONFIG } from './config/config.constants.js';
import type { AppConfig } from './config/env.js';
import { DatabaseService } from './database/database.service.js';
import { HealthController } from './health/health.controller.js';
import { InventoryController } from './inventory/inventory.controller.js';
import { InventoryService } from './inventory/inventory.service.js';
import { LabelsController } from './labels/labels.controller.js';
import { pinoHttpOptions } from './logging/logger.js';
import { PrintingController } from './printing/printing.controller.js';
import { PrintWorkerService } from './printing/print-worker.service.js';
import { ProfileController } from './profile/profile.controller.js';
import { ProfileService } from './profile/profile.service.js';
import { ProjectsController } from './projects/projects.controller.js';
import { ProjectsService } from './projects/projects.service.js';
import { StaffDirectoryController } from './staff-directory/staff-directory.controller.js';
import { StaffController } from './staff/staff.controller.js';
import { StaffService } from './staff/staff.service.js';
import { StorageUnitCorrectionsController } from './storage-units/corrections/corrections.controller.js';
import { StorageUnitCorrectionsService } from './storage-units/corrections/corrections.service.js';
import {
  LAB_REQUEST_LINK_CHECKER,
  NoLabRequestLinks,
} from './storage-units/corrections/lab-request-links.js';
import { StorageUnitsController } from './storage-units/storage-units.controller.js';
import { StorageUnitsService } from './storage-units/storage-units.service.js';
import { SystemStatusController } from './system-status/system-status.controller.js';
import { TestHolesController } from './test-holes/test-holes.controller.js';
import { TestHolesService } from './test-holes/test-holes.service.js';
import { ReceiptsController } from './receiving/receipts.controller.js';
import { ReceiptsService } from './receiving/receipts.service.js';
import { SettingsController } from './settings/settings.controller.js';
import { UsersService } from './users/users.service.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    // Microsoft sign-in stays off (and its routes 404) unless its configuration is present.
    const microsoft = microsoftSettings(config);
    return {
      module: AppModule,
      // DiscoveryModule lets the route-coverage test enumerate every controller.
      imports: [LoggerModule.forRoot({ pinoHttp: pinoHttpOptions(config) }), DiscoveryModule],
      controllers: [
        HealthController,
        AuthController,
        LabAuthController,
        LabAdminController,
        MicrosoftAuthController,
        ProfileController,
        ActivityController,
        PrintingController,
        ProjectsController,
        TestHolesController,
        StaffDirectoryController,
        StaffController,
        ReceiptsController,
        InventoryController,
        StorageUnitsController,
        StorageUnitCorrectionsController,
        SystemStatusController,
        LabelsController,
        SettingsController,
        // Fixture sign-in exists only in development/test with ENABLE_TEST_AUTH=true (MM-T33).
        ...(testAuthEnabled(config) ? [TestAuthController] : []),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        DatabaseService,
        SessionService,
        LabAuthService,
        { provide: MICROSOFT_SETTINGS, useValue: microsoft },
        {
          provide: MICROSOFT_PROVIDER,
          useValue: microsoft ? new EntraIdentityProvider(microsoft) : null,
        },
        MicrosoftTokenCache,
        MicrosoftSignInService,
        ProfileService,
        UsersService,
        StaffService,
        PrintWorkerService,
        ProjectsService,
        TestHolesService,
        ReceiptsService,
        InventoryService,
        StorageUnitsService,
        StorageUnitCorrectionsService,
        // Lab requests arrive with MM-T23; until then no unit has unresolved links.
        { provide: LAB_REQUEST_LINK_CHECKER, useClass: NoLabRequestLinks },
        // Default deny on every route (MM-T04).
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
