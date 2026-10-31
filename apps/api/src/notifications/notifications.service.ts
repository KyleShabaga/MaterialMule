import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  NOTIFICATION_LIST_DAYS,
  NOTIFICATION_PAGE_SIZE,
  type Notification,
  type NotificationCount,
  type NotificationKind,
  type NotificationList,
  type NotificationListQuery,
} from '@materialmule/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { hrefOf, loadItemRows, titleOf } from './action-items.js';

const notificationIdSchema = z.uuid();

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  action_item_id: string | null;
  created_at: Date;
  read_at: Date | null;
  dismissed_at: Date | null;
  still_yours: boolean | null;
  /** created_at as UTC text with microseconds: a JS Date would drop them and break the cursor. */
  cursor_at: string;
}

/** A position in the (created_at DESC, id DESC) order: the last row of the previous page. */
interface Cursor {
  at: string;
  id: string;
}

const CURSOR_TEXT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

/** The cursor a previous page returned, or 400 `invalid_cursor` for anything else. */
export function decodeCursor(text: string): Cursor {
  const match = CURSOR_TEXT.exec(Buffer.from(text, 'base64url').toString('utf8'));
  if (
    !match ||
    !notificationIdSchema.safeParse(match[2]).success ||
    Number.isNaN(Date.parse(match[1]!))
  ) {
    throw new BadRequestException({ code: 'invalid_cursor' });
  }
  return { at: match[1]!, id: match[2]! };
}

const FILTER_SQL: Record<NotificationListQuery['filter'], string> = {
  active: 'n.dismissed_at IS NULL',
  unread: 'n.read_at IS NULL AND n.dismissed_at IS NULL',
  all: 'true',
};

/**
 * In-app notifications (MM-T91), separate from the Action requests inbox. Every query is for the
 * signed-in person's own rows (`user.userId`): never anyone a LAB station selects, and LAB itself
 * has no `notification.read`. Reading, dismissing and restoring change only the notification's
 * read state: never the action item, its routing or the audit log. Another person's id is 404.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * One page of the person's notifications, newest first in a fixed (created_at, id) order.
   * Keyset paging: the next page starts strictly after the cursor row, so equal timestamps are
   * neither skipped nor repeated, and rows that arrive meanwhile (always newer) or change filter
   * meanwhile never shift the pages that follow.
   */
  async list(user: AuthUser, query: NotificationListQuery): Promise<NotificationList> {
    const size = query.limit ?? NOTIFICATION_PAGE_SIZE;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const { rows: fetched } = await this.database.pool.query<NotificationRow>(
      `SELECT n.id, n.kind, n.action_item_id, n.created_at, n.read_at, n.dismissed_at,
              (a.status = 'open' AND action_item_routed_to(a.id, $1)) AS still_yours,
              to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                AS cursor_at
       FROM notification n
       LEFT JOIN action_item a ON a.id = n.action_item_id
       WHERE n.recipient_user_id = $1
         AND n.created_at >= now() - make_interval(days => $2)
         AND ${FILTER_SQL[query.filter]}
         AND ($4::timestamptz IS NULL OR (n.created_at, n.id) < ($4::timestamptz, $5::uuid))
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $3`,
      [user.userId, NOTIFICATION_LIST_DAYS, size + 1, after?.at ?? null, after?.id ?? null],
    );
    const rows = fetched.slice(0, size);
    const last = rows.at(-1);
    const nextCursor =
      fetched.length > size && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null;
    const itemIds = [...new Set(rows.flatMap((row) => row.action_item_id ?? []))];
    const items = new Map(
      (itemIds.length > 0
        ? await loadItemRows(this.database.pool, 'a.id = ANY($1::uuid[])', [itemIds], '')
        : []
      ).map((item) => [item.id, item]),
    );
    const list: Notification[] = [];
    for (const row of rows) {
      const item = row.action_item_id ? items.get(row.action_item_id) : undefined;
      // Both current kinds link an action item (the database requires it).
      if (!item) continue;
      list.push({
        id: row.id,
        kind: row.kind,
        title: titleOf(item),
        projectId: item.project_id,
        projectNumber: item.project_number,
        href: hrefOf(item),
        createdAt: row.created_at.toISOString(),
        readAt: row.read_at?.toISOString() ?? null,
        dismissedAt: row.dismissed_at?.toISOString() ?? null,
        linkedRequest: {
          id: item.id,
          kind: item.kind,
          status: item.status,
          resolution: item.resolution,
          resolvedBy: item.resolved_by_user_id
            ? {
                userId: item.resolved_by_user_id,
                initials: item.resolved_initials,
                name: item.resolved_name ?? '',
              }
            : null,
          resolvedAt: item.resolved_at?.toISOString() ?? null,
          stillYours: row.still_yours === true,
        },
      });
    }
    return { items: list, nextCursor };
  }

  /** Unread, not dismissed, within the list's window: the badge never counts what the list hides. */
  async count(user: AuthUser): Promise<NotificationCount> {
    const { rows } = await this.database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification
       WHERE recipient_user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL
         AND created_at >= now() - make_interval(days => $2)`,
      [user.userId, NOTIFICATION_LIST_DAYS],
    );
    return { unread: rows[0]!.n };
  }

  async markRead(user: AuthUser, id: string): Promise<NotificationCount> {
    await this.change(user, id, 'read_at = now()', 'read_at IS NULL');
    return this.count(user);
  }

  /** Hides it from the default list and marks it read. Undone by restore. */
  async dismiss(user: AuthUser, id: string): Promise<NotificationCount> {
    await this.change(
      user,
      id,
      'read_at = coalesce(read_at, now()), dismissed_at = now()',
      'dismissed_at IS NULL',
    );
    return this.count(user);
  }

  /** Undoes a dismiss; the notification stays read. */
  async restore(user: AuthUser, id: string): Promise<NotificationCount> {
    await this.change(user, id, 'dismissed_at = NULL', 'dismissed_at IS NOT NULL');
    return this.count(user);
  }

  async markAllRead(user: AuthUser): Promise<NotificationCount> {
    await this.database.pool.query(
      `UPDATE notification SET read_at = now()
       WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [user.userId],
    );
    return this.count(user);
  }

  /**
   * Applies `set` to the person's own notification when `pending` still holds; already in that
   * state is fine (idempotent). Missing, malformed or someone else's: 404.
   */
  private async change(user: AuthUser, id: string, set: string, pending: string): Promise<void> {
    if (!notificationIdSchema.safeParse(id).success) {
      throw new NotFoundException({ code: 'notification_not_found' });
    }
    const { rowCount } = await this.database.pool.query(
      `UPDATE notification SET ${set} WHERE id = $1 AND recipient_user_id = $2 AND ${pending}`,
      [id, user.userId],
    );
    if (rowCount) return;
    const { rows } = await this.database.pool.query(
      'SELECT 1 FROM notification WHERE id = $1 AND recipient_user_id = $2',
      [id, user.userId],
    );
    if (rows.length === 0) throw new NotFoundException({ code: 'notification_not_found' });
  }
}
