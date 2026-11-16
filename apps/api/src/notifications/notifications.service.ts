import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CONCRETE_UPDATE_TITLES,
  concreteReportLifecycleState,
  feedbackTitle,
  isConcreteNotificationKind,
  NOTIFICATION_LIST_DAYS,
  type ConcreteNotificationKind,
  type ConcreteReportVersionState,
  type ConcreteWorkflowState,
  NOTIFICATION_PAGE_SIZE,
  type Notification,
  type NotificationCount,
  type NotificationKind,
  type NotificationList,
  type NotificationListQuery,
} from '@materialmule/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/policy.js';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { FEEDBACK_HREF, loadFeedbackEvents } from '../feedback/feedback-events.js';
import { hrefOf, loadItemRows, titleOf } from './action-items.js';

const notificationIdSchema = z.uuid();

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  action_item_id: string | null;
  concrete_field_report_id: string | null;
  concrete_report_transition_id: string | null;
  feedback_event_id: string | null;
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

/**
 * True for a real UTC instant: every calendar and clock field in range (Date.parse would roll
 * 2026-02-30 over to March 2, while PostgreSQL rejects it). Years 1–9999 only.
 */
function isRealTimestamp(text: string): boolean {
  const [y, mo, d, h, mi, sec] = [0, 5, 8, 11, 14, 17].map((at, i) =>
    Number(text.slice(at, at + (i === 0 ? 4 : 2))),
  ) as [number, number, number, number, number, number];
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return d >= 1 && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

/** The cursor a previous page returned, or 400 `invalid_cursor` for anything else. */
export function decodeCursor(text: string): Cursor {
  const match = CURSOR_TEXT.exec(Buffer.from(text, 'base64url').toString('utf8'));
  if (!match || !notificationIdSchema.safeParse(match[2]).success || !isRealTimestamp(match[1]!)) {
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
      `SELECT n.id, n.kind, n.action_item_id, n.concrete_field_report_id,
              n.concrete_report_transition_id, n.feedback_event_id, n.created_at, n.read_at,
              n.dismissed_at,
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
    const reportIds = [...new Set(rows.flatMap((row) => row.concrete_field_report_id ?? []))];
    const transitionIds = [
      ...new Set(rows.flatMap((row) => row.concrete_report_transition_id ?? [])),
    ];
    const reports = await loadConcreteReports(this.database.pool, reportIds);
    const transitions = await loadConcreteTransitions(this.database.pool, transitionIds);
    const feedback = await loadFeedbackEvents(this.database.pool, [
      ...new Set(rows.flatMap((row) => row.feedback_event_id ?? [])),
    ]);
    const list: Notification[] = [];
    for (const row of rows) {
      if (row.kind === 'feedback.submitted') {
        // STRATA-104: the kind and page, read live from the feedback event; never the text.
        const event = row.feedback_event_id ? feedback.get(row.feedback_event_id) : undefined;
        if (!event) continue;
        list.push({
          id: row.id,
          kind: row.kind,
          title: feedbackTitle(event.kind),
          projectId: null,
          projectNumber: null,
          href: FEEDBACK_HREF,
          createdAt: row.created_at.toISOString(),
          readAt: row.read_at?.toISOString() ?? null,
          dismissedAt: row.dismissed_at?.toISOString() ?? null,
          linkedRequest: null,
          linkedReport: null,
          linkedFeedback: event.kind
            ? { kind: event.kind, page: event.page, from: event.from }
            : null,
        });
        continue;
      }
      if (isConcreteNotificationKind(row.kind)) {
        const report = row.concrete_field_report_id
          ? reports.get(row.concrete_field_report_id)
          : undefined;
        // Specimen-only kinds get their rendering with their producer card (C23/C25).
        if (!report) continue;
        const event = row.concrete_report_transition_id
          ? transitions.get(row.concrete_report_transition_id)
          : undefined;
        list.push(concreteNotificationOf(row, report, event));
        continue;
      }
      const item = row.action_item_id ? items.get(row.action_item_id) : undefined;
      // Action-request kinds link an action item (the database requires it).
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
        linkedReport: null,
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

interface ConcreteReportRow {
  id: string;
  project_id: string;
  project_number: string;
  report_date: string | null;
  workflow_state: ConcreteWorkflowState;
  latest_version_state: ConcreteReportVersionState | null;
}

interface ConcreteTransitionRow {
  id: string;
  version_no: number;
  comment: string | null;
  actor_user_id: string;
  actor_initials: string | null;
  actor_name: string | null;
}

/** The linked reports as they stand now (state is read live, never stored on the notice). */
export async function loadConcreteReports(pool: Pool | PoolClient, ids: string[]) {
  if (ids.length === 0) return new Map<string, ConcreteReportRow>();
  const { rows } = await pool.query<ConcreteReportRow>(
    `SELECT r.id, r.project_id, p.project_number, to_char(r.report_date, 'YYYY-MM-DD') AS report_date,
            r.workflow_state,
            (SELECT v.state FROM concrete_report_version v WHERE v.field_report_id = r.id
             ORDER BY v.version_no DESC LIMIT 1) AS latest_version_state
     FROM concrete_field_report r JOIN project p ON p.id = r.project_id
     WHERE r.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/** The C09 events the notices name: who acted, on which version, and the comment. */
export async function loadConcreteTransitions(pool: Pool | PoolClient, ids: string[]) {
  if (ids.length === 0) return new Map<string, ConcreteTransitionRow>();
  const { rows } = await pool.query<ConcreteTransitionRow>(
    `SELECT t.id, v.version_no, t.comment, t.actor_user_id,
            u.official_initials AS actor_initials, u.display_name AS actor_name
     FROM concrete_report_transition t
     JOIN concrete_report_version v ON v.id = t.version_id
     JOIN app_user u ON u.id = t.actor_user_id
     WHERE t.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

function concreteNotificationOf(
  row: NotificationRow,
  report: ConcreteReportRow,
  event: ConcreteTransitionRow | undefined,
): Notification {
  return {
    id: row.id,
    kind: row.kind,
    title: CONCRETE_UPDATE_TITLES[row.kind as ConcreteNotificationKind],
    projectId: report.project_id,
    projectNumber: report.project_number,
    // C28 review view (preview, checklist, history); ?version= opens the version the event was about.
    href: `/concrete/review/${report.id}${event ? `?version=${event.version_no}` : ''}`,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
    dismissedAt: row.dismissed_at?.toISOString() ?? null,
    linkedRequest: null,
    linkedReport: {
      id: report.id,
      kind: 'field',
      state: concreteReportLifecycleState(report.workflow_state, report.latest_version_state),
      reportDate: report.report_date,
      versionNo: event?.version_no ?? null,
      by: event
        ? {
            userId: event.actor_user_id,
            initials: event.actor_initials,
            name: event.actor_name ?? '',
          }
        : null,
      comment: event?.comment ?? null,
    },
  };
}
