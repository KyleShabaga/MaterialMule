import { Inject, Injectable, Logger } from '@nestjs/common';
import { concreteLabToday, type StationToday } from '@materialmule/shared';
import { DatabaseService } from '../database/database.service.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { countBreaksDueToday } from '../concrete/concrete-worklist.service.js';
import { countLabelsToPrint, dashboardDates } from '../inventory/recently-received.js';

/**
 * The LAB station's "At this station" counts (STRATA-20, 21, 63). Lab-wide numbers only, never a
 * person's own data. Each count is read on its own: one that fails answers null (logged without
 * values) and the others still come back.
 *
 * - draftReceipts: receiving drafts started on the shared LAB account (registry, migration 0044)
 *   that are open: not deleted, not closed (0049: confirmed, or deleted by the browser's automatic
 *   clean-up while online), and, while automatic clean-up (MM-T45, `draft_auto_delete_setting`)
 *   is on, started no more than its `afterDays` ago, so drafts the clean-up deleted offline drop
 *   out too. The registry knows when a draft was started, not last saved, so a draft still being
 *   edited past that age drops out early (rare: the age is at least 30 days).
 * - breaksDueToday: concrete specimens due today (America/Edmonton) with no complete test entry,
 *   on the concrete worklist's scheduled set.
 * - labelsToPrint: storage units not disposed, received in the last LABELS_TO_CHECK_DAYS days
 *   (business time zone), never printed or whose newest print job failed.
 */
@Injectable()
export class StationTodayService {
  private readonly logger = new Logger(StationTodayService.name);

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async today(now = new Date()): Promise<StationToday> {
    const pool = this.database.pool;
    const [draftReceipts, breaksDueToday, labelsToPrint] = await Promise.all([
      this.safely('draftReceipts', async () => {
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM receipt_draft_registry r
           JOIN app_user a ON a.id = r.account_user_id
           LEFT JOIN draft_auto_delete_setting s ON s.enabled
           WHERE a.account_type = 'shared_lab' AND NOT r.legacy AND r.deleted_at IS NULL
             AND r.closed_at IS NULL
             AND (s.after_days IS NULL
                  OR r.created_at >= $1::timestamptz - make_interval(days => s.after_days))`,
          [now],
        );
        return rows[0]?.count ?? 0;
      }),
      this.safely('breaksDueToday', () => countBreaksDueToday(pool, concreteLabToday(now))),
      this.safely('labelsToPrint', () =>
        countLabelsToPrint(pool, dashboardDates(now, this.config.BUSINESS_TIME_ZONE).labelsSince),
      ),
    ]);
    return { draftReceipts, breaksDueToday, labelsToPrint };
  }

  private async safely(source: string, read: () => Promise<number>): Promise<number | null> {
    try {
      return await read();
    } catch (error) {
      // The source and the error kind only: never values.
      const kind = error instanceof Error ? error.name : 'unknown';
      this.logger.warn(`Station count ${source} unavailable (${kind})`);
      return null;
    }
  }
}
