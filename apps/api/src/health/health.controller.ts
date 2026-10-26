import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HealthResponse } from '@materialmule/shared';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { APP_VERSION } from '../version.js';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Public()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const databaseUp = await this.database.ping();
    if (!databaseUp) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      status: databaseUp ? 'ok' : 'degraded',
      version: APP_VERSION,
      database: databaseUp ? 'up' : 'down',
    };
  }
}
