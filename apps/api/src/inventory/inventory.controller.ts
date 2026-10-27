import { Controller, Get, Query } from '@nestjs/common';
import {
  inventoryQuerySchema,
  type InventoryLocation,
  type InventoryPage,
} from '@materialmule/shared';
import { RequirePermission } from '../auth/auth.decorators.js';
import { parseBody } from '../validation/parse-body.js';
import { InventoryService } from './inventory.service.js';

/** Inventory search (MM-T12). Read-only; every active session, including LAB, may use it. */
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /**
   * `GET /api/inventory?search=&projectId=&testHoleId=&type=&locationId=&status=&receivedFrom=
   * &receivedTo=&sort=&dir=&page=&pageSize=` → `{items, total, page, pageSize}`.
   */
  @Get('inventory')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown): Promise<InventoryPage> {
    return this.inventory.query(parseBody(inventoryQuerySchema, query));
  }

  /** Read-only location list for the filter. Managing locations is MM-T37. */
  @Get('locations')
  @RequirePermission('inventory.read')
  locations(): Promise<InventoryLocation[]> {
    return this.inventory.locations();
  }
}
