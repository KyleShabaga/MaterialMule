import {
  NOTIFICATION_LIST_DAYS,
  REQUEST_DOMAINS,
  REQUEST_TASK_LABELS,
  UPDATE_DOMAINS,
  UPDATE_STAGES,
  UPDATE_TASK_LABELS,
  feedbackTitle,
  isConcreteNotificationKind,
  requestStage,
  updateTitle,
  type InboxCounts,
  type InboxFilter,
  type InboxItem,
  type InboxQuery,
  type InboxRecord,
  type InboxRequestItem,
  type InboxSort,
  type InboxTab,
  type InboxUpdateItem,
  type InboxUpdateKind,
  type NotificationKind,
  type PersonSnapshot,
  type RequestWordingFacts,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { FEEDBACK_HREF, loadFeedbackEvents } from '../feedback/feedback-events.js';
import { hrefOf, loadItemRows, titleOf, type ItemRow } from '../notifications/action-items.js';
import {
  loadConcreteReports,
  loadConcreteTransitions,
} from '../notifications/notifications.service.js';

// STRATA-25: the person's whole Inbox candidate set, built in memory. It is bounded: open
// requests routed to or raised by the person, requests resolved in the last 90 days that are in
// their history, and their notifications of the last 90 days. Titles, task labels and stages come
// from the shared helpers (STRATA-57), so sorting and searching by title use the exact text the
// person sees; paging, counts and every sort then cover all rows, never just one loaded page.

type Db = Pool | PoolClient;

/**
 * The request is in this person's Inbox: routed to them now (open), in their resolved history
 * (as `GET /api/action-items?status=resolved` shows it), or raised by them. `$1` is the person;
 * needs `a` (action_item) and `e` (the opening review event).
 */
export const REQUEST_VISIBLE_SQL = `(
  (a.status = 'open' AND action_item_routed_to(a.id, $1))
  OR (a.status = 'resolved'
      AND (CASE WHEN a.assigned_user_id IS NOT NULL THEN a.assigned_user_id = $1
                ELSE action_item_routed_to(a.id, $1) END
           OR a.resolved_by_user_id = $1))
  OR coalesce(e.user_id, a.created_by_user_id) = $1
)`;

/** Internal sort facts kept beside each item. */
export interface FeedEntry {
  item: InboxItem;
  /**
   * receivedAt as shown (millisecond ISO text), for the fixed order: two items in the same
   * millisecond fall back to the key, exactly as a client comparing receivedAt would see them.
   */
  receivedKey: string;
  /** Searchable text, lower case. */
  haystack: string;
}

interface RequestFacts {
  id: string;
  waiting_on_me: boolean;
  has_read_row: boolean;
  read_at: Date | null;
  received_at: Date;
}

interface UpdateRow {
  id: string;
  kind: InboxUpdateKind;
  action_item_id: string | null;
  concrete_field_report_id: string | null;
  concrete_specimen_id: string | null;
  concrete_report_transition_id: string | null;
  feedback_event_id: string | null;
  created_at: Date;
  read_at: Date | null;
  dismissed_at: Date | null;
}

interface SpecimenRow {
  id: string;
  project_id: string;
  project_number: string;
  field_report_id: string;
  label: string;
}

function wordingFacts(row: ItemRow): RequestWordingFacts {
  return {
    kind: row.kind,
    projectNumber: row.project_number,
    programNumber: row.program_number,
    testCode: row.test_code,
    retentionKind: row.retention_kind,
    retentionScope: row.retention_scope,
    retentionUnits: row.retention_units,
  };
}

/** The record a request is about: its program, its units, or its project. */
function requestRecord(row: ItemRow): InboxRecord {
  if (row.program_id && row.program_number) {
    return { kind: 'lab_program', id: row.program_id, label: row.program_number };
  }
  if (row.kind === 'retention_request' && row.retention_scope === 'units') {
    const units = row.retention_units ?? 0;
    return {
      kind: 'storage_units',
      id: row.entity_id,
      label: `${units} ${units === 1 ? 'unit' : 'units'}`,
    };
  }
  return { kind: 'project', id: row.project_id, label: row.project_number };
}

function requester(row: ItemRow): PersonSnapshot {
  return { userId: row.requester_id, initials: row.requester_initials, name: row.requester_name };
}

function resolver(row: ItemRow): PersonSnapshot | null {
  return row.resolved_by_user_id
    ? {
        userId: row.resolved_by_user_id,
        initials: row.resolved_initials,
        name: row.resolved_name ?? '',
      }
    : null;
}

function haystack(item: InboxItem): string {
  return [item.title, item.jobNumber, item.record?.label, item.from?.name, item.from?.initials]
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .toLowerCase();
}

function entry(item: InboxItem): FeedEntry {
  return { item, receivedKey: item.receivedAt, haystack: haystack(item) };
}

/**
 * Unread for this person: their explicit state when they have one; otherwise unread, except a
 * request they raised (they know about it), which starts read.
 */
function requestUnread(facts: RequestFacts, raisedByMe: boolean): boolean {
  if (facts.has_read_row) return facts.read_at === null;
  return !raisedByMe;
}

async function loadRequests(db: Db, userId: string): Promise<FeedEntry[]> {
  const { rows: facts } = await db.query<RequestFacts>(
    `SELECT a.id,
            coalesce(a.status = 'open' AND action_item_routed_to(a.id, $1), false) AS waiting_on_me,
            r.user_id IS NOT NULL AS has_read_row, r.read_at,
            coalesce(o.created_at, a.created_at) AS received_at
     FROM action_item a
     LEFT JOIN test_request_review_event e ON e.id = a.opened_by_event_id
     LEFT JOIN inbox_request_read r ON r.action_item_id = a.id AND r.user_id = $1
     LEFT JOIN notification o ON o.recipient_user_id = $1 AND o.action_item_id = a.id
                             AND o.kind = 'action_request.opened'
     WHERE (a.status = 'open' OR a.resolved_at >= now() - make_interval(days => $2))
       AND ${REQUEST_VISIBLE_SQL}`,
    [userId, NOTIFICATION_LIST_DAYS],
  );
  if (facts.length === 0) return [];
  const rows = new Map(
    (await loadItemRows(db, 'a.id = ANY($1::uuid[])', [facts.map((fact) => fact.id)], '')).map(
      (row) => [row.id, row],
    ),
  );
  const entries: FeedEntry[] = [];
  for (const fact of facts) {
    const row = rows.get(fact.id);
    if (!row) continue;
    const raisedByMe = row.requester_id === userId;
    const item: InboxRequestItem = {
      type: 'request',
      key: `request:${row.id}`,
      sourceId: row.id,
      kind: row.kind,
      task: REQUEST_TASK_LABELS[row.kind],
      title: titleOf(row),
      projectId: row.project_id,
      jobNumber: row.project_number,
      record: requestRecord(row),
      from: requester(row),
      receivedAt: fact.received_at.toISOString(),
      unread: requestUnread(fact, raisedByMe),
      stage: requestStage(row.kind, row.status),
      domain: REQUEST_DOMAINS[row.kind],
      href: hrefOf(row),
      status: row.status,
      resolution: row.resolution,
      resolvedBy: resolver(row),
      waitingOnMe: fact.waiting_on_me,
      raisedByMe,
      reason: row.reason,
    };
    entries.push(entry(item));
  }
  return entries;
}

async function loadSpecimens(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, SpecimenRow>();
  const { rows } = await db.query<SpecimenRow>(
    `SELECT s.id, s.project_id, p.project_number, st.field_report_id,
            coalesce(coalesce(st.permanent_id, st.temporary_id) || s.letter, s.letter) AS label
     FROM concrete_specimen s
     JOIN concrete_specimen_set st ON st.id = s.set_id
     JOIN project p ON p.id = s.project_id
     WHERE s.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

const unique = (values: (string | null)[]) => [
  ...new Set(values.filter((v): v is string => v !== null)),
];

async function loadUpdates(db: Db, userId: string): Promise<FeedEntry[]> {
  const { rows } = await db.query<UpdateRow>(
    `SELECT n.id, n.kind, n.action_item_id, n.concrete_field_report_id, n.concrete_specimen_id,
            n.concrete_report_transition_id, n.feedback_event_id, n.created_at, n.read_at,
            n.dismissed_at
     FROM notification n
     WHERE n.recipient_user_id = $1
       AND n.created_at >= now() - make_interval(days => $2)
       AND n.kind <> 'action_request.opened'`,
    [userId, NOTIFICATION_LIST_DAYS],
  );
  if (rows.length === 0) return [];
  const itemIds = unique(rows.map((row) => row.action_item_id));
  const items = new Map(
    (itemIds.length > 0 ? await loadItemRows(db, 'a.id = ANY($1::uuid[])', [itemIds], '') : []).map(
      (row) => [row.id, row],
    ),
  );
  const reports = await loadConcreteReports(
    db,
    unique(rows.map((row) => row.concrete_field_report_id)),
  );
  const transitions = await loadConcreteTransitions(
    db,
    unique(rows.map((row) => row.concrete_report_transition_id)),
  );
  const specimens = await loadSpecimens(db, unique(rows.map((row) => row.concrete_specimen_id)));
  const feedback = await loadFeedbackEvents(db, unique(rows.map((row) => row.feedback_event_id)));

  const entries: FeedEntry[] = [];
  for (const row of rows) {
    const base = {
      type: 'update' as const,
      key: `update:${row.id}`,
      sourceId: row.id,
      kind: row.kind,
      task: UPDATE_TASK_LABELS[row.kind as NotificationKind],
      receivedAt: row.created_at.toISOString(),
      unread: row.read_at === null,
      dismissed: row.dismissed_at !== null,
      stage: UPDATE_STAGES[row.kind as NotificationKind],
      domain: UPDATE_DOMAINS[row.kind as NotificationKind],
    };
    let item: InboxUpdateItem | null = null;
    if (row.kind === 'feedback.submitted') {
      // STRATA-104: a Feedback item with the page it came from (the Record column), from the
      // sender; the text stays on the Help & Feedback page behind feedback.read.
      const event = row.feedback_event_id ? feedback.get(row.feedback_event_id) : undefined;
      if (event) {
        item = {
          ...base,
          title: feedbackTitle(event.kind),
          projectId: null,
          jobNumber: null,
          record: event.page ? { kind: 'page', id: event.id, label: event.page } : null,
          from: event.from,
          href: FEEDBACK_HREF,
          aboutMyRequest: false,
          linkedRequestStatus: null,
        };
      }
    } else if (isConcreteNotificationKind(row.kind)) {
      const title = updateTitle(row.kind);
      const report = row.concrete_field_report_id
        ? reports.get(row.concrete_field_report_id)
        : undefined;
      const specimen = row.concrete_specimen_id
        ? specimens.get(row.concrete_specimen_id)
        : undefined;
      const event = row.concrete_report_transition_id
        ? transitions.get(row.concrete_report_transition_id)
        : undefined;
      const from: PersonSnapshot | null = event
        ? {
            userId: event.actor_user_id,
            initials: event.actor_initials,
            name: event.actor_name ?? '',
          }
        : null;
      if (report) {
        item = {
          ...base,
          title,
          projectId: report.project_id,
          jobNumber: report.project_number,
          record: {
            kind: 'concrete_report',
            id: report.id,
            label: report.report_date ?? 'Field report',
          },
          from,
          href: `/concrete/review/${report.id}${event ? `?version=${event.version_no}` : ''}`,
          aboutMyRequest: false,
          linkedRequestStatus: null,
        };
      } else if (specimen) {
        item = {
          ...base,
          title,
          projectId: specimen.project_id,
          jobNumber: specimen.project_number,
          record: { kind: 'specimen', id: specimen.id, label: specimen.label },
          from,
          href: `/concrete/review/${specimen.field_report_id}`,
          aboutMyRequest: false,
          linkedRequestStatus: null,
        };
      }
    } else {
      const request = row.action_item_id ? items.get(row.action_item_id) : undefined;
      if (request) {
        item = {
          ...base,
          title: updateTitle(row.kind, wordingFacts(request)),
          projectId: request.project_id,
          jobNumber: request.project_number,
          record: requestRecord(request),
          from: resolver(request),
          href: hrefOf(request),
          aboutMyRequest: request.requester_id === userId,
          linkedRequestStatus: request.status,
          linkedResolution: request.resolution,
        };
      }
    }
    // A notice whose record is gone (the database requires one) is left out rather than failing.
    if (item) entries.push(entry(item));
  }
  return entries;
}

/** Every item that can appear in any tab for this person. */
export async function loadFeed(db: Db, userId: string): Promise<FeedEntry[]> {
  return [...(await loadRequests(db, userId)), ...(await loadUpdates(db, userId))];
}

// ---------------------------------------------------------------------------------------------
// Tabs, filters, search, sort.

export function inTab(item: InboxItem, tab: InboxTab): boolean {
  const open = item.type === 'request' ? item.status === 'open' : !item.dismissed;
  switch (tab) {
    case 'all':
      return open;
    case 'requests':
      return item.type === 'request' && open;
    case 'updates':
      return item.type === 'update' && open;
    case 'done':
      return !open;
  }
}

function passesFilter(item: InboxItem, filter: InboxFilter): boolean {
  switch (filter) {
    case 'unread':
      return item.unread;
    case 'waiting_on_me':
      return item.type === 'request' && item.waitingOnMe;
    case 'about_my_requests':
      return item.type === 'request' ? item.raisedByMe : item.aboutMyRequest;
  }
}

/** Filters (combined with AND) and search, before the tab. */
export function matches(entry: FeedEntry, filters: readonly InboxFilter[], q: string): boolean {
  if (!filters.every((filter) => passesFilter(entry.item, filter))) return false;
  return q === '' || entry.haystack.includes(q);
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Text compare with blanks last in both directions. */
function text(a: string | null, b: string | null, direction: 1 | -1): number {
  if (a === b) return 0;
  if (a === null || a === '') return 1;
  if (b === null || b === '') return -1;
  return collator.compare(a, b) * direction;
}

const fromName = (item: InboxItem) => item.from?.name || 'Material Mule';

const PRIMARY: Record<InboxSort, (a: InboxItem, b: InboxItem) => number> = {
  newest: () => 0,
  oldest: () => 0,
  requests_first: (a, b) => (a.type === b.type ? 0 : a.type === 'request' ? -1 : 1),
  task_asc: (a, b) => text(a.task, b.task, 1),
  task_desc: (a, b) => text(a.task, b.task, -1),
  title_asc: (a, b) => text(a.title, b.title, 1),
  title_desc: (a, b) => text(a.title, b.title, -1),
  job_number_asc: (a, b) => text(a.jobNumber, b.jobNumber, 1),
  job_number_desc: (a, b) => text(a.jobNumber, b.jobNumber, -1),
  record_asc: (a, b) => text(a.record?.label ?? null, b.record?.label ?? null, 1),
  record_desc: (a, b) => text(a.record?.label ?? null, b.record?.label ?? null, -1),
  from_asc: (a, b) => text(fromName(a), fromName(b), 1),
  from_desc: (a, b) => text(fromName(a), fromName(b), -1),
};

const plain = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every sort ends with received time (newest first; oldest first for `oldest`) then key. */
export function comparator(sort: InboxSort) {
  const received = sort === 'oldest' ? 1 : -1;
  return (a: FeedEntry, b: FeedEntry) =>
    PRIMARY[sort](a.item, b.item) ||
    plain(a.receivedKey, b.receivedKey) * received ||
    plain(a.item.key, b.item.key);
}

/** STRATA-55 counts over the whole feed (no filter, no search). */
export function countsOf(entries: FeedEntry[], badgeUpdates: boolean): InboxCounts {
  let unreadRequests = 0;
  let unreadUpdates = 0;
  let openRequests = 0;
  let unreadWaiting = 0;
  for (const { item } of entries) {
    if (!inTab(item, 'all')) continue;
    if (item.type === 'request') {
      if (item.waitingOnMe) openRequests += 1;
      if (item.unread) unreadRequests += 1;
      if (item.unread && item.waitingOnMe) unreadWaiting += 1;
    } else if (item.unread) {
      unreadUpdates += 1;
    }
  }
  return {
    badge: unreadWaiting + (badgeUpdates ? unreadUpdates : 0),
    unread: unreadRequests + unreadUpdates,
    unreadRequests,
    unreadUpdates,
    openRequests,
  };
}

/** Normalised search text (the query schema already trims it). */
export function searchText(query: Pick<InboxQuery, 'q'>): string {
  return (query.q ?? '').toLowerCase();
}
