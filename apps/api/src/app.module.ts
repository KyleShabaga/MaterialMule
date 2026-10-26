import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ActivityController } from './activity/activity.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { SessionService } from './auth/session.service.js';
import { TestAuthController, testAuthEnabled } from './auth/test-provider/test-auth.controller.js';
import { APP_CONFIG } from './config/config.constants.js';
import type { AppConfig } from './config/env.js';
import { DatabaseService } from './database/database.service.js';
import { HealthController } from './health/health.controller.js';
import { pinoHttpOptions } from './logging/logger.js';
import { ProjectsController } from './projects/projects.controller.js';
import { ProjectsService } from './projects/projects.service.js';
import { StaffDirectoryController } from './staff-directory/staff-directory.controller.js';
import { TestHolesController } from './test-holes/test-holes.controller.js';
import { TestHolesService } from './test-holes/test-holes.service.js';
import { ReceiptsController } from './receiving/receipts.controller.js';
import { ReceiptsService } from './receiving/receipts.service.js';
import { UsersService } from './users/users.service.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      // DiscoveryModule lets the route-coverage test enumerate every controller.
      imports: [LoggerModule.forRoot({ pinoHttp: pinoHttpOptions(config) }), DiscoveryModule],
      controllers: [
        HealthController,
        AuthController,
        ActivityController,
        ProjectsController,
        TestHolesController,
        StaffDirectoryController,
        ReceiptsController,
        // Fixture sign-in exists only in development/test with ENABLE_TEST_AUTH=true (TRP-T33).
        ...(testAuthEnabled(config) ? [TestAuthController] : []),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        DatabaseService,
        SessionService,
        UsersService,
        ProjectsService,
        TestHolesService,
        ReceiptsService,
        // Default deny on every route (TRP-T04).
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
