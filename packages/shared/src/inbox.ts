import { z } from 'zod';
import {
  ACTION_REQUEST_KINDS,
  ACTION_REQUEST_RESOLUTIONS,
  type ActionRequestKind,
} from './action-requests';
import { personSnapshotSchema } from './lab-programs';
import { NOTIFICATION_KINDS, type NotificationKind } from './notifications';
import { stageKeySchema, workDomainSchema, type StageKey, type WorkDomain } from './stage';

// STRATA-25: one Inbox feed over the existing action requests (MM-T27) and notifications (MM-T91).
// STRATA-55: one badge-eligible unread count for the sidebar, the bell and the Inbox heading.
// STRATA-54: the job number travels as its own field (never parsed from a title).
// STRATA-57: request and update wording comes from this module only.
//
// Rules carried over: reading, dismissing or opening an item never resolves a request; requests
// close on their own when the underlying workflow action is done. Updates can be read and
// dismissed (and a dismiss undone); the list covers 90 days. An `action_request.opened`
// notification is the same work as its request, so the feed shows the request row only (reading
// the request also marks that notice read). Personal and test accounts only: the shared LAB
// account gets 403 here, as on the existing endpoints (the station consent route is STRATA-27).
//
// Routes:
//   GET  /api/inbox                       one page of the feed (query below)
//   GET  /api/inbox/summary               the canonical counts and the bell's 3-item preview
//   POST /api/inbox/requests/:id/read     mark a request read for me (never resolves it)
//   POST /api/inbox/requests/:id/unread   mark it unread again
//   POST /api/inbox/read-all              mark every unread item in the feed read
// Updates keep their existing routes: POST /api/notifications/:id/read|dismiss|restore.
// Every mutation answers with the new summary.

export const INBOX_ITEM_TYPES = ['request', 'update'] as const;
export type InboxItemType = (typeof INBOX_ITEM_TYPES)[number];

/** Notification kinds the feed shows as updates (opened notices fold into their request). */
export const INBOX_UPDATE_KINDS = NOTIFICATION_KINDS.filter(
  (kind) => kind !== 'action_request.opened',
) as Exclude<NotificationKind, 'action_request.opened'>[];
export type InboxUpdateKind = (typeof INBOX_UPDATE_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// STRATA-57 wording. One place for the Task column, the title, the domain and the stage.

/** The Task column (and the bell preview's kind) for a request. */
export const REQUEST_TASK_LABELS: Record<ActionRequestKind, string> = {
  correction: 'Correction',
  cancellation_request: 'Cancel a test',
  closure_request: 'Close a program',
  retention_request: 'Retention',
  lead_appointment: 'Appoint a lead',
  grant_review: 'Review grants',
  team_join_request: 'Team request',
  review_approval_lost: 'Reviewer lost',
};

/** The Task column for an update. */
export const UPDATE_TASK_LABELS: Record<NotificationKind, string> = {
  'action_request.opened': 'New request',
  'action_request.decided': 'Your request was decided',
  'concrete_report.returned': 'Returned for correction',
  'concrete_curing.out_of_range': 'Curing out of range',
  'concrete_equipment.flagged': 'Equipment flagged',
  'concrete_test.failed': 'Failed test',
  'concrete_report.auto_submitted': 'Submitted automatically',
};

export const REQUEST_DOMAINS: Record<ActionRequestKind, WorkDomain> = {
  correction: 'correction',
  cancellation_request: 'lab',
  closure_request: 'lab',
  retention_request: 'retention',
  lead_appointment: 'project',
  grant_review: 'access',
  team_join_request: 'access',
  review_approval_lost: 'review',
};

export const UPDATE_DOMAINS: Record<NotificationKind, WorkDomain> = {
  'action_request.opened': 'project',
  'action_request.decided': 'project',
  'concrete_report.returned': 'concrete',
  'concrete_curing.out_of_range': 'concrete',
  'concrete_equipment.flagged': 'concrete',
  'concrete_test.failed': 'concrete',
  'concrete_report.auto_submitted': 'concrete',
};

/** Structured facts a request title is built from (never parsed from text). */
export interface RequestWordingFacts {
  kind: ActionRequestKind;
  projectNumber: string;
  /** Program number (LP-001); null when the request isn't about a program. */
  programNumber?: string | null;
  /** Test code (MC) for test-level requests. */
  testCode?: string | null;
  /** Retention requests: hold or extension, and the scope. */
  retentionKind?: 'hold' | 'extension' | null;
  retentionScope?: 'project' | 'units' | null;
  retentionUnits?: number | null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Closure requested for LP-001", "Hold requested for DEMO-2601 · 4 units". */
export function requestTitle(facts: RequestWordingFacts): string {
  const program = facts.programNumber ?? 'a program';
  const test = facts.testCode ? ` · ${facts.testCode}` : '';
  switch (facts.kind) {
    case 'correction':
      return `Correction returned for ${program}${test}`;
    case 'cancellation_request':
      return `Cancellation requested for ${program}${test}`;
    case 'closure_request':
      return `Closure requested for ${program}`;
    case 'retention_request': {
      const what = facts.retentionKind === 'extension' ? 'Retention extension' : 'Hold';
      const scope =
        facts.retentionScope === 'units'
          ? ` · ${plural(facts.retentionUnits ?? 0, 'unit')}`
          : ' · whole project';
      return `${what} requested for ${facts.projectNumber}${scope}`;
    }
    case 'lead_appointment':
      return `Lead Project Engineer needed for ${facts.projectNumber}`;
    case 'grant_review':
      return `Review inherited grants on ${facts.projectNumber}`;
    case 'team_join_request':
      return `Team join request on ${facts.projectNumber}`;
    case 'review_approval_lost':
      return `Reviewer lost eligibility on ${facts.projectNumber}`;
  }
}

/** Fixed titles of concrete updates; action-request updates take their request's title. */
export const CONCRETE_UPDATE_TITLES = {
  'concrete_report.returned': 'Field report returned for correction',
  'concrete_curing.out_of_range': 'Curing temperature out of range',
  'concrete_equipment.flagged': 'Equipment flag needs review',
  'concrete_test.failed': 'Failed concrete test',
  'concrete_report.auto_submitted': 'Field report submitted automatically',
} as const satisfies Partial<Record<NotificationKind, string>>;

/**
 * An update's title: its request's title for action-request kinds (`requestFacts` required),
 * otherwise the fixed concrete title. A missing linked request reads "A request" rather than
 * failing.
 */
export function updateTitle(kind: NotificationKind, requestFacts?: RequestWordingFacts | null) {
  if (kind === 'action_request.opened' || kind === 'action_request.decided') {
    return requestFacts ? requestTitle(requestFacts) : 'A request';
  }
  return CONCRETE_UPDATE_TITLES[kind];
}

/**
 * A request's stage: open requests wait on someone (`due`), resolved ones are `closed`. A
 * correction is returned work (`danger`: red means act now).
 */
export function requestStage(kind: ActionRequestKind, status: 'open' | 'resolved'): StageKey {
  if (status === 'resolved') return 'closed';
  return kind === 'correction' ? 'danger' : 'due';
}

/** An update's stage, from its kind alone. */
export const UPDATE_STAGES: Record<NotificationKind, StageKey> = {
  'action_request.opened': 'due',
  'action_request.decided': 'closed',
  'concrete_report.returned': 'danger',
  'concrete_curing.out_of_range': 'danger',
  'concrete_equipment.flagged': 'due',
  'concrete_test.failed': 'danger',
  'concrete_report.auto_submitted': 'due',
};

// ---------------------------------------------------------------------------------------------
// The feed.

/** The record an item is about, for the Record column (IDs in mono). */
export const inboxRecordSchema = z.object({
  kind: z.enum(['lab_program', 'project', 'storage_units', 'concrete_report', 'specimen']),
  id: z.string(),
  /** LP-001, DEMO-2601, "4 units", a report date. */
  label: z.string(),
});
export type InboxRecord = z.infer<typeof inboxRecordSchema>;

const inboxItemBase = {
  /** Stable feed key: `request:<id>` or `update:<id>`. */
  key: z.string(),
  /** The source row's own ID (action item or notification). */
  sourceId: z.string(),
  /** Task column wording, from REQUEST_TASK_LABELS or UPDATE_TASK_LABELS. */
  task: z.string(),
  title: z.string(),
  /** STRATA-54: the project ID and job (project) number as fields; null for non-project items. */
  projectId: z.string().nullable(),
  jobNumber: z.string().nullable(),
  record: inboxRecordSchema.nullable(),
  /** Who it's from; null means Material Mule itself (an MM avatar). */
  from: personSnapshotSchema.nullable(),
  receivedAt: z.string(),
  /** Unread for the signed-in person (bold, with a dot and "Unread" for screen readers). */
  unread: z.boolean(),
  stage: stageKeySchema,
  domain: workDomainSchema,
  /** In-app link to the underlying record; following it never grants access. */
  href: z.string(),
};

export const inboxRequestItemSchema = z.object({
  ...inboxItemBase,
  type: z.literal('request'),
  kind: z.enum(ACTION_REQUEST_KINDS),
  /** Live workflow state; reading never changes it. */
  status: z.enum(['open', 'resolved']),
  resolution: z.enum(ACTION_REQUEST_RESOLUTIONS).nullable(),
  /** Open and routed to the signed-in person now (D10 routing). */
  waitingOnMe: z.boolean(),
  /** The signed-in person raised it. */
  raisedByMe: z.boolean(),
  reason: z.string(),
});
export type InboxRequestItem = z.infer<typeof inboxRequestItemSchema>;

export const inboxUpdateItemSchema = z.object({
  ...inboxItemBase,
  type: z.literal('update'),
  kind: z.enum(INBOX_UPDATE_KINDS as [InboxUpdateKind, ...InboxUpdateKind[]]),
  dismissed: z.boolean(),
  /** The update is about a request the signed-in person raised. */
  aboutMyRequest: z.boolean(),
  /** For action-request updates: the request's live state. */
  linkedRequestStatus: z.enum(['open', 'resolved']).nullable(),
});
export type InboxUpdateItem = z.infer<typeof inboxUpdateItemSchema>;

export const inboxItemSchema = z.discriminatedUnion('type', [
  inboxRequestItemSchema,
  inboxUpdateItemSchema,
]);
export type InboxItem = z.infer<typeof inboxItemSchema>;

/**
 * Tabs: `all` (open requests and undismissed updates), `requests` (open requests routed to me or
 * raised by me), `updates` (undismissed updates), `done` (resolved requests and dismissed updates).
 */
export const INBOX_TABS = ['all', 'requests', 'updates', 'done'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/** Filter menu: Unread only, Waiting on me, About my requests. Combined with AND. */
export const INBOX_FILTERS = ['unread', 'waiting_on_me', 'about_my_requests'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/**
 * Sort: the toolbar's Newest first, Oldest first, Requests first, and the Table view's column
 * headings. Every sort ends with received time then key, so equal values keep one fixed order.
 */
export const INBOX_SORTS = [
  'newest',
  'oldest',
  'requests_first',
  'task_asc',
  'task_desc',
  'title_asc',
  'title_desc',
  'job_number_asc',
  'job_number_desc',
  'record_asc',
  'record_desc',
  'from_asc',
  'from_desc',
] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export const INBOX_PAGE_SIZE = 50;
export const INBOX_PAGE_SIZE_MAX = 100;
export const INBOX_SEARCH_MAX_LENGTH = 200;

const commaList = <T extends string>(values: readonly [T, ...T[]]) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.enum(values)).max(values.length),
  );

/**
 * `GET /api/inbox?tab=&filter=unread,waiting_on_me&q=&sort=&page=&pageSize=`. `q` matches title,
 * job number, record label and sender, case-insensitively. Paging is by page number with a fixed
 * order; changing the query starts again at page 1.
 */
export const inboxQuerySchema = z.strictObject({
  tab: z.enum(INBOX_TABS).default('all'),
  filter: commaList(INBOX_FILTERS).default([]),
  q: z.string().trim().max(INBOX_SEARCH_MAX_LENGTH).optional(),
  sort: z.enum(INBOX_SORTS).default('newest'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(INBOX_PAGE_SIZE_MAX).default(INBOX_PAGE_SIZE),
});
export type InboxQuery = z.output<typeof inboxQuerySchema>;

/**
 * STRATA-55: the canonical counts.
 * - `badge`: unread open requests + (unread undismissed updates, if `badgeUpdates` is on). The
 *   sidebar badge, the bell badge and the "Inbox · n unread" heading all show this one number
 *   (display caps at 9+, the value never does).
 * - `unread`: every unread item in the All tab, muted updates included (the bold rows).
 * - `unreadRequests`, `unreadUpdates`: its two parts.
 * - `openRequests`: open requests waiting on me, read or not (separate from unread).
 */
export const inboxCountsSchema = z.object({
  badge: z.number().int().min(0),
  unread: z.number().int().min(0),
  unreadRequests: z.number().int().min(0),
  unreadUpdates: z.number().int().min(0),
  openRequests: z.number().int().min(0),
});
export type InboxCounts = z.infer<typeof inboxCountsSchema>;

/** `GET /api/inbox/summary` and every Inbox mutation's response. */
export const inboxSummarySchema = z.object({
  counts: inboxCountsSchema,
  /** The newest three unread items, word for word as in Inbox; empty means "Nothing unread". */
  preview: z.array(inboxItemSchema).max(3),
});
export type InboxSummary = z.infer<typeof inboxSummarySchema>;

/** `GET /api/inbox` response: one page, the tab counts and the summary. */
export const inboxPageSchema = z.object({
  items: z.array(inboxItemSchema),
  /** Rows matching the query in all (every page). */
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  /** Items per tab for the same filter and search (the tab badges). */
  tabCounts: z.object({
    all: z.number().int().min(0),
    requests: z.number().int().min(0),
    updates: z.number().int().min(0),
    done: z.number().int().min(0),
  }),
  summary: inboxSummarySchema,
});
export type InboxPage = z.infer<typeof inboxPageSchema>;

/** The badge as displayed: nothing at zero, "9+" above nine. */
export function inboxBadgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}
