import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG } from './config/config.constants.js';
import type { AppConfig } from './config/env.js';
import { DatabaseService } from './database/database.service.js';
import { HealthController } from './health/health.controller.js';
import { pinoHttpOptions } from './logging/logger.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot({ pinoHttp: pinoHttpOptions(config) })],
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }, DatabaseService],
    };
  }
}
