import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';

const CONNECT_TIMEOUT_MS = 2000;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  /** Shared connection pool. Use withTransaction(pool, …) for multi-statement changes. */
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: CONNECT_TIMEOUT_MS,
      max: 10,
    });
    // An idle client losing its connection must not crash the process.
    this.pool.on('error', (error) => {
      this.logger.error(`Idle database client error: ${error.message}`);
    });
  }

  /** True when the database answers a trivial query within the timeout. */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.warn(`Database ping failed: ${(error as Error).message}`);
      return false;
    }
  }

  // After every onModuleDestroy hook, so the print worker can finish a send and record it first.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
