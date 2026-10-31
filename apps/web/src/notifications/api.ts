import {
  notificationCountSchema,
  notificationListSchema,
  type NotificationFilter,
  type NotificationList,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

/**
 * Fired after anything that may change the unread count (mark read, dismiss, restore, mark all
 * read), so the header Notifications control refreshes at once. Separate from
 * ACTION_REQUESTS_CHANGED_EVENT: reading a notification never changes the pending-actions count.
 */
export const NOTIFICATIONS_CHANGED_EVENT = 'materialmule:notifications-changed';

export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

/** The control's accessible name; never mentions pending actions, whose count is separate. */
export function notificationsLabel(count: number | null): string {
  if (count === null) return 'Notifications';
  return count === 0 ? 'Notifications, none unread' : `Notifications, ${count} unread`;
}

/** Unread, not dismissed notifications; null when they can't be read (LAB, offline). */
export async function fetchUnreadCount(): Promise<number | null> {
  const response = await apiFetch('/api/notifications/count');
  if (!response.ok) return null;
  return notificationCountSchema.parse(await response.json()).unread;
}

/** Thrown when the list is refused, so the page can say so instead of offering a Retry. */
export class NotificationsForbiddenError extends Error {
  constructor() {
    super('HTTP 403');
  }
}

/**
 * One page of notifications, newest first. Pass the previous page's `nextCursor` (with the same
 * filter) for the next, older page; null `nextCursor` in the answer means there are no more.
 */
export async function fetchNotifications(
  filter: NotificationFilter,
  cursor: string | null = null,
): Promise<NotificationList> {
  const query = new URLSearchParams({ filter });
  if (cursor) query.set('cursor', cursor);
  const response = await apiFetch(`/api/notifications?${query.toString()}`);
  if (response.status === 403) throw new NotificationsForbiddenError();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return notificationListSchema.parse(await response.json());
}

export type NotificationAction = 'read' | 'dismiss' | 'restore';

/**
 * One notification mutation. Only ever touches the notification: it never approves, resolves or
 * changes the linked action request. Returns the new unread count, or null when it failed.
 */
export async function updateNotification(
  id: string,
  action: NotificationAction,
): Promise<number | null> {
  return post(`/api/notifications/${encodeURIComponent(id)}/${action}`);
}

export async function markAllRead(): Promise<number | null> {
  return post('/api/notifications/read-all');
}

async function post(path: string): Promise<number | null> {
  try {
    const response = await apiFetch(path, { method: 'POST' });
    if (!response.ok) return null;
    const { unread } = notificationCountSchema.parse(await response.json());
    announceNotificationsChanged();
    return unread;
  } catch {
    return null;
  }
}
