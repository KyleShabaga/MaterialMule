import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { activityQuerySchema, type ScopedActivityItem } from '@materialmule/shared';
import { listRecentAudit, type RecentAuditScope } from '../audit/audit.js';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { parseBody } from '../validation/parse-body.js';
import { DASHBOARD_ACTIONS, toActivityItem } from './activity.js';

@Controller('activity')
export class ActivityController {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Latest receipt, print, correction, move and disposal events for Today's ledger (MM-T34,
   * Field Ledger). `hours` keeps only the last so many hours. `scope` (STRATA-23) narrows it:
   * `lab` everything (the default, as always), `projects` events on projects the signed-in person
   * is involved in, `mine` events they performed themselves. The shared LAB account has no
   * projects and no "mine": a picked person is attribution only, so `projects` and `mine` from
   * LAB are refused (400 `scope_not_available`) rather than answered with someone's work.
   */
  @Get('recent')
  @RequirePermission('inventory.read')
  async recent(
    @Query() query: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ScopedActivityItem[]> {
    const { limit, hours, scope } = parseBody(activityQuerySchema, query);
    if (scope !== 'lab' && user.accountType === 'shared_lab') {
      throw new BadRequestException({ code: 'scope_not_available' });
    }
    const narrowed: RecentAuditScope =
      scope === 'mine'
        ? { actorUserId: user.userId }
        : scope === 'projects'
          ? { projectsOfUserId: user.userId }
          : {};
    const since = hours ? new Date(Date.now() - hours * 3_600_000) : null;
    const events = await listRecentAudit(
      this.database.pool,
      [...DASHBOARD_ACTIONS],
      limit,
      since,
      narrowed,
    );
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
    return events.map((event) => ({
      ...toActivityItem(
        event,
        event.entityType === 'storage_unit' && event.entityId
          ? readable.get(event.entityId)
          : undefined,
      ),
      // The account itself did it; on LAB the account is never the person (attribution only).
      byMe: user.accountType !== 'shared_lab' && event.actorUserId === user.userId,
    }));
  }
}
