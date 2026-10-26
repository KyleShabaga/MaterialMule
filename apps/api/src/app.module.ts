import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { SessionService } from './auth/session.service.js';
import { APP_CONFIG } from './config/config.constants.js';
import type { AppConfig } from './config/env.js';
import { DatabaseService } from './database/database.service.js';
import { HealthController } from './health/health.controller.js';
import { pinoHttpOptions } from './logging/logger.js';
import { UsersService } from './users/users.service.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      // DiscoveryModule lets the route-coverage test enumerate every controller.
      imports: [LoggerModule.forRoot({ pinoHttp: pinoHttpOptions(config) }), DiscoveryModule],
      controllers: [HealthController, AuthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        DatabaseService,
        SessionService,
        UsersService,
        // Default deny on every route (TRP-T04).
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
