import { Controller, Get, Query } from '@nestjs/common';
import { activityQuerySchema, type ActivityItem } from '@materialmule/shared';
import { listRecentAudit } from '../audit/audit.js';
import { RequirePermission } from '../auth/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { parseBody } from '../validation/parse-body.js';
import { DASHBOARD_ACTIONS, toActivityItem } from './activity.js';

@Controller('activity')
export class ActivityController {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Latest receipt, print, correction, move and disposal events for Today's ledger (MM-T34,
   * Field Ledger). `hours` keeps only the last so many hours.
   */
  @Get('recent')
  @RequirePermission('inventory.read')
  async recent(@Query() query: unknown): Promise<ActivityItem[]> {
    const { limit, hours } = parseBody(activityQuerySchema, query);
    const since = hours ? new Date(Date.now() - hours * 3_600_000) : null;
    const events = await listRecentAudit(this.database.pool, [...DASHBOARD_ACTIONS], limit, since);
    // Moves and disposals record only the unit's row ID: name it by its storage unit ID.
    const unitIds = [
      ...new Set(
        events
          .filter((event) => event.entityType === 'storage_unit' && event.entityId)
          .map((event) => event.entityId!),
      ),
    ];
    const readable = new Map<string, string>();
    if (unitIds.length > 0) {
      const { rows } = await this.database.pool.query<{ id: string; readable_id: string }>(
        'SELECT id, readable_id FROM storage_unit WHERE id = ANY($1::uuid[])',
        [unitIds],
      );
      for (const row of rows) readable.set(row.id, row.readable_id);
    }
    return events.map((event) =>
      toActivityItem(
        event,
        event.entityType === 'storage_unit' && event.entityId
          ? readable.get(event.entityId)
          : undefined,
      ),
    );
  }
}
