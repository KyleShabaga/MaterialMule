import { z } from 'zod';
import { ACTION_REQUEST_KINDS, ACTION_REQUEST_RESOLUTIONS } from './action-requests';
import { CONCRETE_REPORT_LIFECYCLE_STATES } from './concrete-report-lifecycle';
import { feedbackKindSchema } from './feedback';
import { personSnapshotSchema } from './lab-programs';

// MM-T91: in-app notifications, kept separate from action requests (MM-T27).
//
// A notification tells a person something happened. An action request is work they must do in the
// underlying workflow. Reading, dismissing or opening a notification never resolves, approves or
// changes an action request. Owner decisions (2026-10-31): no routine-event kinds for V1; unread/read,
// "Mark all read", and a dismiss that only hides a row and can be undone; nothing is deleted; the
// list covers the last 90 days; reassignment adds a row for the new recipient and never retargets
// the old one.

export const NOTIFICATION_KINDS = [
  /** An action request now waits on you (created, reassigned to you, or rerouted to you). */
  'action_request.opened',
  /** Someone else resolved a request you raised (or a correction you returned was marked done). */
  'action_request.decided',
  // MM-V2-C29: concrete events. Each one links a concrete report or specimen, never an action
  // item. In-app only (owner decision 2026-10-30).
  /** A reviewer returned a field report for correction (producer: C09 return command). */
  'concrete_report.returned',
  /** Recorded curing temperatures fell outside the applicable range (producer: C06/C20). */
  'concrete_curing.out_of_range',
  /** A reading or test used flagged equipment (producer: C23 results / C14 field tests). */
  'concrete_equipment.flagged',
  /** A specimen failed its test (producer: C23/C25). */
  'concrete_test.failed',
  /** A report ready to submit was submitted automatically (producer: C19). */
  'concrete_report.auto_submitted',
  /**
   * STRATA-104: someone sent Help & Feedback. Administrators only (`feedback.read`); names the
   * feedback audit event and the page it came from, never the text.
   */
  'feedback.submitted',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const CONCRETE_NOTIFICATION_KINDS = [
  'concrete_report.returned',
  'concrete_curing.out_of_range',
  'concrete_equipment.flagged',
  'concrete_test.failed',
  'concrete_report.auto_submitted',
] as const satisfies readonly NotificationKind[];
export type ConcreteNotificationKind = (typeof CONCRETE_NOTIFICATION_KINDS)[number];

export function isConcreteNotificationKind(
  kind: NotificationKind,
): kind is ConcreteNotificationKind {
  return (CONCRETE_NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/**
 * Who a concrete event notifies, before account eligibility (the API and the database also drop
 * LAB, disabled and non-personal accounts). Combined Plan:
 *   returned        the report's technician and the Lab Manager(s); the reviewer who returned it
 *                   is never notified, so a Lab Manager returning a report they reviewed gets no
 *                   separate Lab Manager notice (C29 AC1).
 *   curing / failed the designated reviewer(s) and the project's Lead Project Engineer (PM/PE).
 *   equipment       the designated reviewer(s).
 *   auto-submitted  the report's technician.
 * The person who caused the event is never notified of it. Every person appears once, however
 * many ways they qualify (AC2); the (recipient, event_key) key guards the same in the database.
 */
export interface ConcreteNotificationFacts {
  /** The person whose action caused the event (the returning reviewer, the tester…), if any. */
  actorUserId: string | null;
  technicianUserId?: string | null;
  labManagerUserIds?: readonly string[];
  designatedReviewerUserIds?: readonly string[];
  leadProjectEngineerUserId?: string | null;
}

export function concreteNotificationRecipients(
  kind: ConcreteNotificationKind,
  facts: ConcreteNotificationFacts,
): string[] {
  const reviewers = facts.designatedReviewerUserIds ?? [];
  const candidates: (string | null | undefined)[] =
    kind === 'concrete_report.returned'
      ? [facts.technicianUserId, ...(facts.labManagerUserIds ?? [])]
      : kind === 'concrete_report.auto_submitted'
        ? [facts.technicianUserId]
        : kind === 'concrete_equipment.flagged'
          ? [...reviewers]
          : [...reviewers, facts.leadProjectEngineerUserId];
  const out: string[] = [];
  for (const id of candidates) {
    if (id && id !== facts.actorUserId && !out.includes(id)) out.push(id);
  }
  return out;
}

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

/**
 * The linked concrete report's state now, read live (C29). For a returned notice, the return
 * event's comment and reviewer, read from the C09 transition (never copied).
 */
export const notificationLinkedReportSchema = z.object({
  id: z.string(),
  kind: z.enum(['field']),
  state: z.enum(CONCRETE_REPORT_LIFECYCLE_STATES),
  reportDate: z.string().nullable(),
  /** The submitted version the event was about, when there is one. */
  versionNo: z.number().int().nullable(),
  by: personSnapshotSchema.nullable(),
  comment: z.string().nullable(),
});
export type NotificationLinkedReport = z.infer<typeof notificationLinkedReportSchema>;

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
  /** Concrete kinds: the report the notice is about (null for action-request kinds). */
  linkedReport: notificationLinkedReportSchema.nullable(),
  /**
   * `feedback.submitted` only (STRATA-104): what kind of feedback and the in-app page it was sent
   * from (null when none was given). Optional so older clients' fixtures still parse.
   */
  linkedFeedback: z
    .object({
      kind: feedbackKindSchema,
      page: z.string().nullable(),
      from: personSnapshotSchema.nullable(),
    })
    .nullable()
    .optional(),
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
