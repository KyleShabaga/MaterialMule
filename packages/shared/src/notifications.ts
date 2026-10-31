import { z } from 'zod';
import { ACTION_REQUEST_KINDS, ACTION_REQUEST_RESOLUTIONS } from './action-requests';
import { personSnapshotSchema } from './lab-programs';

// MM-T91: in-app notifications, kept separate from action requests (MM-T27).
//
// A notification tells a person something happened. An action request is work they must do in the
// underlying workflow. Reading, dismissing or opening a notification never resolves, approves or
// changes an action request. Owner decisions (2026-10-31): no routine-event kinds yet; unread/read,
// "Mark all read", and a dismiss that only hides a row and can be undone; nothing is deleted; the
// list covers the last 90 days; reassignment adds a row for the new recipient and never retargets
// the old one.

export const NOTIFICATION_KINDS = [
  /** An action request now waits on you (created, reassigned to you, or rerouted to you). */
  'action_request.opened',
  /** Someone else resolved a request you raised (or a correction you returned was marked done). */
  'action_request.decided',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** How far back the notification list reaches. */
export const NOTIFICATION_LIST_DAYS = 90;
/** Rows one list page returns when the caller doesn't ask for a size (newest first). */
export const NOTIFICATION_PAGE_SIZE = 50;
/** Largest page a caller may ask for. Older rows are reached with `cursor`, never a bigger page. */
export const NOTIFICATION_PAGE_SIZE_MAX = 100;
/** Longest cursor the API accepts (an encoded timestamp and id is about 70 characters). */
export const NOTIFICATION_CURSOR_MAX_LENGTH = 200;

/**
 * `GET /api/notifications?filter=`: `active` (default; everything not dismissed), `unread`
 * (unread and not dismissed), or `all` (includes dismissed rows, so a dismiss can be undone).
 */
export const NOTIFICATION_FILTERS = ['active', 'unread', 'all'] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];
export const notificationFilterSchema = z.enum(NOTIFICATION_FILTERS);

/** The linked action request's state now, read live (never a stale "needs action"). */
export const notificationLinkedRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(ACTION_REQUEST_KINDS),
  status: z.enum(['open', 'resolved']),
  resolution: z.enum(ACTION_REQUEST_RESOLUTIONS).nullable(),
  resolvedBy: personSnapshotSchema.nullable(),
  resolvedAt: z.string().nullable(),
  /** Open and still routed to the signed-in person (D10 routing, computed now). */
  stillYours: z.boolean(),
});
export type NotificationLinkedRequest = z.infer<typeof notificationLinkedRequestSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTIFICATION_KINDS),
  /** "Closure requested for LP-001", rendered from the linked request. */
  title: z.string(),
  projectId: z.string().nullable(),
  projectNumber: z.string().nullable(),
  /** In-app link to the underlying item. Following it never grants access: that page checks. */
  href: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  linkedRequest: notificationLinkedRequestSchema.nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

/**
 * `GET /api/notifications?filter=&cursor=&limit=`: one page, newest first, ordered by
 * (createdAt, id) descending so equal timestamps still have one fixed order. `nextCursor` is
 * opaque; pass it back unchanged (with the same filter) for the next, older page. It is null on
 * the last page. A notification that arrives while someone pages lands before the first page, so
 * it never shifts or repeats rows on later pages; reload the first page to see it.
 */
export const notificationListQuerySchema = z.strictObject({
  filter: notificationFilterSchema.default('active'),
  cursor: z.string().min(1).max(NOTIFICATION_CURSOR_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_PAGE_SIZE_MAX).optional(),
});
export type NotificationListQuery = z.output<typeof notificationListQuerySchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

/**
 * `GET /api/notifications/count`, and the body of every mutation below: unread, not dismissed
 * notifications for the signed-in person. Independent of the action-request pending count.
 */
export const notificationCountSchema = z.object({ unread: z.number().int().min(0) });
export type NotificationCount = z.infer<typeof notificationCountSchema>;

// Mutations (no body; recipient-only, another person's id is 404):
//   POST /api/notifications/:id/read      mark read
//   POST /api/notifications/:id/dismiss   hide from the default list (also marks it read)
//   POST /api/notifications/:id/restore   undo a dismiss
//   POST /api/notifications/read-all      mark every unread one read
