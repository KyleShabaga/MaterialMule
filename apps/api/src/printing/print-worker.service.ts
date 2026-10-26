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
import { ensureConfiguredPrinter } from './printers.js';
import { PrintWorker } from './print-worker.js';
import { ZebraTcpTransport } from './zebra-client.js';

/** Hosts the print worker in the API process: started on boot, stopped (gracefully) on close. */
@Injectable()
export class PrintWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PrintWorker');
  readonly worker: PrintWorker;

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.worker = new PrintWorker(database.pool, new ZebraTcpTransport(), undefined, this.logger);
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      if (await ensureConfiguredPrinter(this.database.pool, this.config)) {
        this.logger.log('Added the receiving label printer from LABEL_PRINTER_HOST');
      }
    } catch (error) {
      // The database may be down at boot; printing simply waits until it is back.
      this.logger.error(`Could not check printer configuration: ${(error as Error).message}`);
    }
    this.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.stop();
  }
}
