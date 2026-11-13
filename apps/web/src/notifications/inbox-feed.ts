import {
  inboxBadgeText,
  inboxSummarySchema,
  type InboxItem,
  type InboxSummary,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';
import { announceNotificationsChanged } from './api';

/**
 * The Inbox feed as the bell and the sidebar badge see it (STRATA-13), read from lane 1C's single
 * Inbox (STRATA-25/55): `GET /api/inbox/summary` gives the one badge-eligible unread count and the
 * newest three unread items, word for word as in Inbox; `POST /api/inbox/read-all` marks them
 * read. Personal accounts only: the shared LAB account gets 403 and the count stays hidden.
 */

/** Where the bell and "Open Inbox" go: the Inbox page (STRATA-24). */
export const INBOX_HREF = '/inbox';

/** How many of the newest Inbox items the preview shows. */
export const BELL_PREVIEW_SIZE = 3;

/** The badge's text: the count up to nine, then "9+" (lane 1C's one badge rule). */
export function bellBadgeText(count: number): string {
  return inboxBadgeText(count) ?? '';
}

/** The preview's heading, from the same count as the badge and the sidebar. */
export function inboxHeading(count: number | null): string {
  return count ? `Inbox · ${count} unread` : 'Inbox';
}

/** One preview row, in the Inbox's own words. */
export interface InboxPreviewItem {
  id: string;
  /** A request is work waiting on you; an update tells you something happened. */
  type: 'request' | 'update';
  /** The Task column's words (REQUEST_TASK_LABELS / UPDATE_TASK_LABELS), e.g. "Close a program". */
  kind: string;
  title: string;
  projectNumber: string | null;
  href: string;
  createdAt: string;
  unread: boolean;
}

export interface InboxFeedSource {
  /** Badge-eligible unread items; null when they can't be read (LAB, offline, refused). */
  fetchUnreadCount(): Promise<number | null>;
  /** The newest items, newest first. Throws when the list can't be loaded. */
  fetchNewest(limit: number): Promise<InboxPreviewItem[]>;
  /** Marks every unread item read; the new unread count, or null when it failed. */
  markAllRead(): Promise<number | null>;
}

/** An Inbox item as a preview row: request vs update from the item's type. */
export function toPreviewItem(item: InboxItem): InboxPreviewItem {
  return {
    id: item.key,
    type: item.type,
    kind: item.task,
    title: item.title,
    projectNumber: item.jobNumber,
    href: item.href,
    createdAt: item.receivedAt,
    unread: item.unread,
  };
}

export const INBOX_SUMMARY_PATH = '/api/inbox/summary';

async function fetchSummary(): Promise<InboxSummary | null> {
  const response = await apiFetch(INBOX_SUMMARY_PATH);
  if (!response.ok) return null;
  return inboxSummarySchema.parse(await response.json());
}

/** The single Inbox (lane 1C, STRATA-25/55). */
export const inboxSummarySource: InboxFeedSource = {
  async fetchUnreadCount() {
    return (await fetchSummary())?.counts.badge ?? null;
  },
  async fetchNewest(limit) {
    const summary = await fetchSummary();
    if (!summary) throw new Error('Inbox summary unavailable');
    return summary.preview.slice(0, limit).map(toPreviewItem);
  },
  async markAllRead() {
    try {
      const response = await apiFetch('/api/inbox/read-all', { method: 'POST' });
      if (!response.ok) return null;
      const summary = inboxSummarySchema.parse(await response.json());
      // The notification center (and any other reader) follows.
      announceNotificationsChanged();
      return summary.counts.badge;
    } catch {
      return null;
    }
  },
};
