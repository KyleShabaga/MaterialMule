import { Controller, Get, Query } from '@nestjs/common';
import type { ConcreteReceivingQueue, ConcreteSearch } from '@materialmule/shared';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteLabService } from './concrete-lab.service.js';

/**
 * The Concrete Lab workspace reads (MM-V2-C31): the receiving queue (Awaiting pickup / Awaiting
 * receiving, My reports first) and Concrete search. Reads follow every concrete read
 * (`inventory.read`, LAB included); navigation and lists never grant anything.
 */
@Controller('concrete')
export class ConcreteLabController {
  constructor(private readonly lab: ConcreteLabService) {}

  @Get('receiving-queue')
  @RequirePermission('inventory.read')
  receivingQueue(
    @Query() query: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ConcreteReceivingQueue> {
    return this.lab.receivingQueue(query, user);
  }

  @Get('search')
  @RequirePermission('inventory.read')
  search(@Query() query: unknown): Promise<ConcreteSearch> {
    return this.lab.search(query);
  }
}
