import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { EmailWorker, type EmailTransport } from './email-worker.js';

/** Until IT approves a sending configuration there is no transport: nothing can be sent. */
class NoEmailTransport implements EmailTransport {
  send(): Promise<void> {
    return Promise.reject(new Error('Email sending is not configured'));
  }
}

/**
 * Hosts the email outbox worker (MM-T27). It runs only with EMAIL_ENABLED, which configuration
 * refuses until IT approval, so in development, tests and today's production it never starts
 * and outbox rows simply wait.
 */
@Injectable()
export class EmailWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('EmailWorker');
  readonly worker: EmailWorker;

  constructor(
    database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.worker = new EmailWorker(database.pool, new NoEmailTransport());
  }

  onApplicationBootstrap(): void {
    if (!this.config.EMAIL_ENABLED) return;
    this.logger.log('Email outbox worker started');
    this.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.stop();
  }
}
