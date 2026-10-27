import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  inventoryQuerySchema,
  recentlyReceivedQuerySchema,
  type InventoryLocation,
  type InventoryPage,
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
   * &receivedTo=&sort=&dir=&page=&pageSize=` → `{items, total, page, pageSize}`.
   */
  @Get('inventory')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown): Promise<InventoryPage> {
    return this.inventory.query(parseBody(inventoryQuerySchema, query));
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

  /** Read-only location list for the filter. Managing locations is MM-T37. */
  @Get('locations')
  @RequirePermission('inventory.read')
  locations(): Promise<InventoryLocation[]> {
    return this.inventory.locations();
  }
}
