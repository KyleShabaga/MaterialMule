import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';

// Waiting for a connection and for a query: generous enough for a busy host (and a slow CI
// runner) not to turn a momentary stall into a 500. The health check keeps its own short limit.
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 15000;
const PING_TIMEOUT_MS = 2000;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  /** Shared connection pool. Use withTransaction(pool, …) for multi-statement changes. */
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      max: 10,
    });
    // An idle client losing its connection must not crash the process.
    this.pool.on('error', (error) => {
      this.logger.error(`Idle database client error: ${error.message}`);
    });
    // Nor may a client that loses its connection while checked out (mid-query): pg-pool removes
    // its own error listener during checkout, so without this the 'error' event is unhandled and
    // the whole API process exits. The query in flight still fails, and the pool discards the
    // broken client on release (found by MM-T18 failure injection).
    this.pool.on('connect', (client) => {
      client.on('error', (error) => {
        this.logger.error(`Database connection lost: ${error.message}`);
      });
    });
  }

  /** True when the database answers a trivial query within the timeout. */
  async ping(): Promise<boolean> {
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Query read timeout')), PING_TIMEOUT_MS);
      });
      try {
        await Promise.race([this.pool.query('SELECT 1'), timeout]);
      } finally {
        clearTimeout(timer);
      }
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
