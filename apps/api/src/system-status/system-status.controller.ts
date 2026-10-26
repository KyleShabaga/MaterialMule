import { Controller, Get, Inject } from '@nestjs/common';
import type { SystemStatusResponse } from '@trapezoid/shared';
import { RequirePermission } from '../auth/auth.decorators.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { PrintWorkerService } from '../printing/print-worker.service.js';
import { APP_VERSION } from '../version.js';
import {
  backupTargetDisk,
  diskSpace,
  printQueueSummary,
  readBackupStatusFile,
  summarizeBackup,
} from './system-status.js';

/** Settings → System status (TRP-T21). Admin only; reads, never changes anything. */
@Controller('admin/system-status')
export class SystemStatusController {
  constructor(
    private readonly database: DatabaseService,
    private readonly printWorker: PrintWorkerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermission('system.status.read')
  async status(): Promise<SystemStatusResponse> {
    const now = new Date();
    const [databaseUp, backupFile, hostDisk] = await Promise.all([
      this.database.ping(),
      this.config.BACKUP_STATUS_FILE
        ? readBackupStatusFile(this.config.BACKUP_STATUS_FILE)
        : Promise.resolve(null),
      // The drive the API runs from (the install root on the host).
      diskSpace(process.cwd(), 'Trapezoid host', now),
    ]);
    const printQueue = databaseUp
      ? await printQueueSummary(this.database.pool, now).catch(() => null)
      : null;
    const worker = this.printWorker.worker.health;
    return {
      checkedAt: now.toISOString(),
      version: APP_VERSION,
      database: databaseUp ? 'up' : 'down',
      backup: summarizeBackup(backupFile, now),
      printQueue,
      printWorker: {
        running: worker.running,
        lastPollAt: worker.lastPollAt ? worker.lastPollAt.toISOString() : null,
      },
      disks: [hostDisk, backupTargetDisk(backupFile)].filter((disk) => disk !== null),
    };
  }
}
