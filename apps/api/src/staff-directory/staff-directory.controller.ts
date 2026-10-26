import { Controller, Get } from '@nestjs/common';
import type { StaffOption } from '@trapezoid/shared';
import { RequirePermission } from '../auth/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { listActiveStaff } from './staff-directory.js';

@Controller('staff')
export class StaffDirectoryController {
  constructor(private readonly database: DatabaseService) {}

  /** Active staff for PM/PE and receiver pickers (TRP-T08). LAB may read it while receiving. */
  @Get('active')
  @RequirePermission('inventory.read')
  active(): Promise<StaffOption[]> {
    return listActiveStaff(this.database.pool);
  }
}
