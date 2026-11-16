import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  inventoryListQuerySchema,
  recentlyReceivedQuerySchema,
  type InventoryListPage,
  type RecentlyReceivedResponse,
} from '@materialmule/shared';
import { RequirePermission } from '../auth/auth.decorators.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { parseBody } from '../validation/parse-body.js';
import { InventoryService } from './inventory.service.js';
import { dashboardDates, queryRecentlyReceived } from './recently-received.js';

/** Inventory search (MM-T12). Read-only; every active session, including LAB, may use it. */
@Controller()
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * `GET /api/inventory?search=&projectId=&testHoleId=&type=&locationId=&status=&receivedFrom=
   * &receivedTo=&retention=&conflict=open&stage=&counts=1&sort=&dir=&page=&pageSize=` →
   * `{items, total, page, pageSize, stageCounts?}`. Each item carries `openConflict` (MM-T81) and
   * `locationPath`. STRATA-79: `stage` is a stage tab (it replaces `status`); `counts=1` adds every
   * tab's count under the same search and filters.
   */
  @Get('inventory')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown): Promise<InventoryListPage> {
    return this.inventory.query(parseBody(inventoryListQuerySchema, query));
  }

  /**
   * Dashboard "Recently received": `GET /api/inventory/recently-received?show=all|today|labels
   * &limit=` → the newest units with receiver and latest print status, plus the counts.
   */
  @Get('inventory/recently-received')
  @RequirePermission('inventory.read')
  recentlyReceived(@Query() query: unknown): Promise<RecentlyReceivedResponse> {
    return queryRecentlyReceived(
      this.database.pool,
      parseBody(recentlyReceivedQuerySchema, query),
      dashboardDates(new Date(), this.config.BUSINESS_TIME_ZONE),
    );
  }
}
