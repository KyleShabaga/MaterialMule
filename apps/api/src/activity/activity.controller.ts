import { Controller, Get, Query } from '@nestjs/common';
import type { ActivityItem } from '@materialmule/shared';
import { listRecentAudit } from '../audit/audit.js';
import { RequirePermission } from '../auth/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { DASHBOARD_ACTIONS, toActivityItem } from './activity.js';

const MAX_LIMIT = 50;

@Controller('activity')
export class ActivityController {
  constructor(private readonly database: DatabaseService) {}

  /** Latest receipt, print and correction events for the dashboard (MM-T34). */
  @Get('recent')
  @RequirePermission('inventory.read')
  async recent(@Query('limit') limit?: string): Promise<ActivityItem[]> {
    const requested = Number.parseInt(limit ?? '20', 10);
    const bounded = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : 20;
    const events = await listRecentAudit(this.database.pool, [...DASHBOARD_ACTIONS], bounded);
    return events.map(toActivityItem);
  }
}
