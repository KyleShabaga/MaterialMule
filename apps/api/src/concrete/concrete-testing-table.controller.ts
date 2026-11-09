import { Controller, Get, Query } from '@nestjs/common';
import type { ConcreteTestingTable } from '@materialmule/shared';
import { RequirePermission } from '../auth/auth.decorators.js';
import { ConcreteTestingTableService } from './concrete-testing-table.service.js';

/**
 * The daily concrete testing table (MM-V2-C23). Read with the internal read (`inventory.read`,
 * LAB included), as every concrete read; entry is C07's PUT (`concrete_test.enter`).
 */
@Controller('concrete')
export class ConcreteTestingTableController {
  constructor(private readonly testing: ConcreteTestingTableService) {}

  @Get('testing-table')
  @RequirePermission('inventory.read')
  table(@Query() query: unknown): Promise<ConcreteTestingTable> {
    return this.testing.table(query);
  }
}
