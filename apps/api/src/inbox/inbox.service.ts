import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  InboxBulk,
  InboxBulkResult,
  InboxPage,
  InboxQuery,
  InboxSummary,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { badgeUpdatesPreference } from './badge-preference.js';
import {
  REQUEST_VISIBLE_SQL,
  comparator,
  countsOf,
  inTab,
  loadFeed,
  matches,
  searchText,
  type FeedEntry,
} from './inbox-feed.js';

const idSchema = z.uuid();
const PREVIEW_SIZE = 3;
/** A feed key: `request:<uuid>` or `update:<uuid>`. */
const BULK_KEY =
  /^(request|update):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const isRequestKey = (key: string) => key.startsWith('request:');

/**
 * The single Inbox feed (STRATA-25/54/55/57) over action requests (MM-T27) and notifications
 * (MM-T91). Every query is for the signed-in person's own feed (`user.userId`): never anyone a LAB
 * station selects, and LAB itself holds neither `action_item.read` nor `notification.read`.
 * Reading, unreading or reading everything changes read state only: never a request's status,
 * routing or the audit log. Resolving stays with each request's own workflow.
 */
@Injectable()
export class InboxService {
  constructor(private readonly database: DatabaseService) {}

  async page(user: AuthUser, query: InboxQuery): Promise<InboxPage> {
    return this.pageFor(user.userId, query);
  }

  async summary(user: AuthUser): Promise<InboxSummary> {
    return this.summaryFor(user.userId);
  }

  /**
   * The Inbox page of the person `userId`, read-only. Takes a user ID, never a session, so a
   * caller reading someone else's feed (the LAB station Inbox, STRATA-27, with that person's
   * consent) never acts as them: nothing here checks a permission or changes read state.
   */
  async pageFor(userId: string, query: InboxQuery): Promise<InboxPage> {
    const feed = await loadFeed(this.database.pool, userId);
    const q = searchText(query);
    const matching = feed.filter((entry) => matches(entry, query.filter, q));
    const inTabNow = matching.filter((entry) => inTab(entry.item, query.tab));
    inTabNow.sort(comparator(query.sort));
    const start = (query.page - 1) * query.pageSize;
    return {
      items: inTabNow.slice(start, start + query.pageSize).map((entry) => entry.item),
      total: inTabNow.length,
      page: query.page,
      pageSize: query.pageSize,
      tabCounts: {
        all: matching.filter((entry) => inTab(entry.item, 'all')).length,
        requests: matching.filter((entry) => inTab(entry.item, 'requests')).length,
        updates: matching.filter((entry) => inTab(entry.item, 'updates')).length,
        done: matching.filter((entry) => inTab(entry.item, 'done')).length,
      },
      summary: await this.summaryOf(userId, feed),
    };
  }

  /** The Inbox counts and preview of the person `userId`, read-only (see `pageFor`). */
  async summaryFor(userId: string): Promise<InboxSummary> {
    return this.summaryOf(userId, await loadFeed(this.database.pool, userId));
  }

  /**
   * Marks a request read (or unread) for the signed-in person. Reading also marks their
   * `action_request.opened` notice for it read. Only someone the request is (or was) routed to,
   * its resolver or the person who raised it may; anyone else gets 404, as for a missing id.
   */
  async markRequest(user: AuthUser, id: string, read: boolean): Promise<InboxSummary> {
    if (!idSchema.safeParse(id).success) {
      throw new NotFoundException({ code: 'action_item_not_found' });
    }
    await withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM action_item a
         LEFT JOIN test_request_review_event e ON e.id = a.opened_by_event_id
         WHERE a.id = $2 AND ${REQUEST_VISIBLE_SQL}`,
        [user.userId, id],
      );
      if (rows.length === 0) throw new NotFoundException({ code: 'action_item_not_found' });
      await client.query(
        `INSERT INTO inbox_request_read (user_id, action_item_id, read_at)
         VALUES ($1, $2, CASE WHEN $3::boolean THEN now() END)
         ON CONFLICT (user_id, action_item_id) DO UPDATE
           SET read_at = CASE WHEN $3::boolean
                              THEN coalesce(inbox_request_read.read_at, now()) END,
               updated_at = now()`,
        [user.userId, id, read],
      );
      if (read) await markOpenedNoticesRead(client, user.userId, [id]);
    });
    return this.summary(user);
  }

  /** Marks every unread request and undismissed update in the person's feed read. */
  async readAll(user: AuthUser): Promise<InboxSummary> {
    const feed = await loadFeed(this.database.pool, user.userId);
    const requestIds = feed
      .filter(({ item }) => item.type === 'request')
      .map(({ item }) => item.sourceId);
    const unreadRequestIds = feed
      .filter(({ item }) => item.type === 'request' && item.unread)
      .map(({ item }) => item.sourceId);
    const unreadUpdateIds = feed
      .filter(({ item }) => item.type === 'update' && item.unread && !item.dismissed)
      .map(({ item }) => item.sourceId);
    await withTransaction(this.database.pool, async (client) => {
      if (unreadRequestIds.length > 0) {
        await client.query(
          `INSERT INTO inbox_request_read (user_id, action_item_id, read_at)
           SELECT $1, id, now() FROM unnest($2::uuid[]) AS id
           ON CONFLICT (user_id, action_item_id) DO UPDATE
             SET read_at = now(), updated_at = now()
             WHERE inbox_request_read.read_at IS NULL`,
          [user.userId, unreadRequestIds],
        );
      }
      if (unreadUpdateIds.length > 0) {
        await client.query(
          `UPDATE notification SET read_at = now()
           WHERE recipient_user_id = $1 AND id = ANY($2::uuid[])
             AND read_at IS NULL AND dismissed_at IS NULL`,
          [user.userId, unreadUpdateIds],
        );
      }
      await markOpenedNoticesRead(client, user.userId, requestIds);
    });
    return this.summary(user);
  }

  /**
   * STRATA-48: read, unread or dismiss checked rows. Each key is checked as the signed-in
   * person's (a request in their Inbox, an update addressed to them); anything else goes to
   * `failed` and the rest still apply. Requests change read state only, never their workflow.
   * Dismiss is for updates: any request key refuses the whole call before anything changes.
   * An update can't be marked unread again (the notification table keeps read once, migration
   * 0014's guard), so `unread` on a read update fails that key; an unread one counts as done.
   */
  async bulk(user: AuthUser, body: InboxBulk): Promise<InboxBulkResult> {
    const requestIds = new Map<string, string>();
    const updateIds = new Map<string, string>();
    const failed: string[] = [];
    for (const key of new Set(body.keys)) {
      const match = BULK_KEY.exec(key);
      if (!match) {
        failed.push(key);
        continue;
      }
      (match[1] === 'request' ? requestIds : updateIds).set(match[2]!.toLowerCase(), key);
    }
    // Any request key, well formed or not, refuses the whole dismiss before anything changes.
    if (body.action === 'dismiss' && body.keys.some(isRequestKey)) {
      throw new BadRequestException({ code: 'dismiss_requests' });
    }
    let updated = 0;
    await withTransaction(this.database.pool, async (client) => {
      if (requestIds.size > 0) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT a.id FROM action_item a
           LEFT JOIN test_request_review_event e ON e.id = a.opened_by_event_id
           WHERE a.id = ANY($2::uuid[]) AND ${REQUEST_VISIBLE_SQL}`,
          [user.userId, [...requestIds.keys()]],
        );
        const mine = rows.map((row) => row.id);
        for (const [id, key] of requestIds) if (!mine.includes(id)) failed.push(key);
        if (mine.length > 0) {
          const read = body.action === 'read';
          await client.query(
            `INSERT INTO inbox_request_read (user_id, action_item_id, read_at)
             SELECT $1, id, CASE WHEN $3::boolean THEN now() END FROM unnest($2::uuid[]) AS id
             ON CONFLICT (user_id, action_item_id) DO UPDATE
               SET read_at = CASE WHEN $3::boolean
                                  THEN coalesce(inbox_request_read.read_at, now()) END,
                   updated_at = now()`,
            [user.userId, mine, read],
          );
          if (read) await markOpenedNoticesRead(client, user.userId, mine);
          updated += mine.length;
        }
      }
      if (updateIds.size > 0) {
        const { rows } = await client.query<{ id: string; read: boolean }>(
          `SELECT id, read_at IS NOT NULL AS read FROM notification
           WHERE id = ANY($2::uuid[]) AND recipient_user_id = $1
           FOR UPDATE`,
          [user.userId, [...updateIds.keys()]],
        );
        const mine = new Map(rows.map((row) => [row.id, row.read]));
        for (const [id, key] of updateIds) {
          if (!mine.has(id) || (body.action === 'unread' && mine.get(id))) failed.push(key);
        }
        const ids = [...mine.keys()];
        if (body.action === 'read' && ids.length > 0) {
          await client.query(
            `UPDATE notification SET read_at = now()
             WHERE recipient_user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
            [user.userId, ids],
          );
        } else if (body.action === 'dismiss' && ids.length > 0) {
          await client.query(
            `UPDATE notification SET read_at = coalesce(read_at, now()), dismissed_at = now()
             WHERE recipient_user_id = $1 AND id = ANY($2::uuid[]) AND dismissed_at IS NULL`,
            [user.userId, ids],
          );
        }
        updated += body.action === 'unread' ? ids.filter((id) => !mine.get(id)).length : ids.length;
      }
    });
    return { updated, failed, summary: await this.summary(user) };
  }

  private async summaryOf(userId: string, feed: FeedEntry[]): Promise<InboxSummary> {
    const badgeUpdates = await badgeUpdatesPreference(this.database.pool, userId);
    const preview = feed
      .filter((entry) => entry.item.unread && inTab(entry.item, 'all'))
      .sort(comparator('newest'))
      .slice(0, PREVIEW_SIZE)
      .map((entry) => entry.item);
    return { counts: countsOf(feed, badgeUpdates), preview };
  }
}

/** The opened notices fold into their request: reading the request reads them. */
async function markOpenedNoticesRead(
  client: PoolClient,
  userId: string,
  actionItemIds: string[],
): Promise<void> {
  if (actionItemIds.length === 0) return;
  await client.query(
    `UPDATE notification SET read_at = now()
     WHERE recipient_user_id = $1 AND kind = 'action_request.opened'
       AND action_item_id = ANY($2::uuid[]) AND read_at IS NULL`,
    [userId, actionItemIds],
  );
}
