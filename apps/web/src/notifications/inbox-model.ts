import {
  ACTION_REQUEST_RESOLUTION_LABEL,
  INBOX_FILTERS,
  INBOX_SORTS,
  INBOX_TABS,
  INBOX_VIEWS,
  LAB_TIME_ZONE,
  formatRecordDate,
  labCalendarDate,
  type ActionRequestKind,
  type DateFormatPreference,
  type InboxFilter,
  type InboxItem,
  type InboxRecord,
  type InboxRequestItem,
  type InboxSort,
  type InboxTab,
  type InboxUpdateItem,
  type InboxView,
} from '@materialmule/shared';
import type { SortLabels, SortOption, SortState } from '../components/strata/table-query';

// Pure Inbox rules (DESIGN.md › Inbox; STRATA-24, 26, 64): URL state, sort mapping, the day
// headings and groups, and the drawer's wording. Kept apart from the page so they are tested
// without rendering.

export const INBOX_PATH = '/inbox';

/** The full page of one item. Keys hold a colon (`request:<id>`), so they are encoded. */
export function inboxItemPath(key: string): string {
  return `${INBOX_PATH}/${encodeURIComponent(key)}`;
}

export const TAB_LABELS: Record<InboxTab, string> = {
  all: 'All',
  requests: 'Requests',
  updates: 'Updates',
  done: 'Done',
};

export function readInboxTab(params: URLSearchParams): InboxTab {
  const tab = params.get('tab');
  return (INBOX_TABS as readonly string[]).includes(tab ?? '') ? (tab as InboxTab) : 'all';
}

export function readInboxPage(params: URLSearchParams): number {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return Number.isFinite(page) && page > 1 ? page : 1;
}

export function readInboxView(value: string | null): InboxView | null {
  return (INBOX_VIEWS as readonly string[]).includes(value ?? '') ? (value as InboxView) : null;
}

export function inboxFilters(ids: readonly string[]): InboxFilter[] {
  return ids.filter((id): id is InboxFilter => (INBOX_FILTERS as readonly string[]).includes(id));
}

export const FILTER_OPTIONS: readonly { id: InboxFilter; label: string }[] = [
  { id: 'unread', label: 'Unread only' },
  { id: 'waiting_on_me', label: 'Waiting on me' },
  { id: 'about_my_requests', label: 'About my requests' },
];

export const VIEW_OPTIONS: readonly { id: InboxView; label: string }[] = [
  { id: 'stream', label: 'One stream' },
  { id: 'grouped', label: 'Grouped' },
  { id: 'table', label: 'Table' },
];

/** The toolbar's Sort menu. The first is the default (newest first). */
export const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Newest first', sort: null },
  { label: 'Oldest first', sort: { key: 'received', dir: 'asc' } },
  { label: 'Requests first', sort: { key: 'requests_first', dir: 'asc' } },
];

/** Chip and Sort-button words for the Table view's heading sorts. */
export const SORT_LABELS: SortLabels = {
  received: { asc: 'Oldest first', desc: 'Newest first' },
  task: { asc: 'Task A–Z', desc: 'Task Z–A' },
  title: { asc: 'Title A–Z', desc: 'Title Z–A' },
  job_number: { asc: 'Job number A–Z', desc: 'Job number Z–A' },
  record: { asc: 'Record A–Z', desc: 'Record Z–A' },
  from: { asc: 'From A–Z', desc: 'From Z–A' },
  requests_first: { asc: 'Requests first', desc: 'Requests first' },
};

const HEADING_KEYS = new Set(['task', 'title', 'job_number', 'record', 'from']);

/**
 * The URL's sort as the server's: none is newest first; Received ascending is oldest first (and
 * descending is the default again); a heading maps to `<key>_<dir>`. Anything else is the default.
 */
export function inboxSort(sort: SortState | null): InboxSort {
  if (!sort) return 'newest';
  if (sort.key === 'received') return sort.dir === 'asc' ? 'oldest' : 'newest';
  if (sort.key === 'requests_first') return 'requests_first';
  if (HEADING_KEYS.has(sort.key)) {
    const value = `${sort.key}_${sort.dir}`;
    if ((INBOX_SORTS as readonly string[]).includes(value)) return value as InboxSort;
  }
  return 'newest';
}

// ---------------------------------------------------------------------------------------------
// Day headings and groups.

const labDay = new Intl.DateTimeFormat('en-CA', { timeZone: LAB_TIME_ZONE });
const weekdayLong = new Intl.DateTimeFormat('en-CA', { timeZone: LAB_TIME_ZONE, weekday: 'long' });

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Today", then the weekday ("Tuesday") within the last six days, then the record date. */
export function dayHeading(
  receivedAt: string,
  now: Date,
  preference?: DateFormatPreference,
): string {
  const day = labCalendarDate(receivedAt);
  if (!day) return '';
  const today = labDay.format(now);
  if (day === today) return 'Today';
  if (day >= shiftDate(today, -6) && day < today) return weekdayLong.format(new Date(receivedAt));
  return formatRecordDate(day, preference);
}

export interface InboxSection {
  id: string;
  heading: string;
  items: InboxItem[];
}

/**
 * One stream: day headings in the server's order, requests above updates on the same day. Only
 * the received-time sorts have days; any other order is one plain list.
 */
export function streamSections(
  items: readonly InboxItem[],
  sort: InboxSort,
  now: Date,
  preference?: DateFormatPreference,
): InboxSection[] {
  if (sort !== 'newest' && sort !== 'oldest') {
    return items.length ? [{ id: 'all', heading: '', items: [...items] }] : [];
  }
  const sections: InboxSection[] = [];
  for (const item of items) {
    const day = labCalendarDate(item.receivedAt) ?? '';
    let section = sections.find((s) => s.id === day);
    if (!section) {
      section = { id: day, heading: dayHeading(item.receivedAt, now, preference), items: [] };
      sections.push(section);
    }
    section.items.push(item);
  }
  for (const section of sections) {
    section.items = [
      ...section.items.filter((item) => item.type === 'request'),
      ...section.items.filter((item) => item.type === 'update'),
    ];
  }
  return sections;
}

/** Grouped: "Needs action · n" (requests) first, then "Updates · n". Empty groups are left out. */
export function groupedSections(items: readonly InboxItem[], tab: InboxTab): InboxSection[] {
  const requests = items.filter((item) => item.type === 'request');
  const updates = items.filter((item) => item.type === 'update');
  const requestHeading = tab === 'done' ? 'Requests' : 'Needs action';
  return [
    { id: 'requests', heading: `${requestHeading} · ${requests.length}`, items: requests },
    { id: 'updates', heading: `Updates · ${updates.length}`, items: updates },
  ].filter((section) => section.items.length > 0);
}

/** The keys in the order they are shown, for Previous/Next (K/J) and "n of m". */
export function shownOrder(sections: readonly InboxSection[]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.key));
}

// ---------------------------------------------------------------------------------------------
// Wording.

/** "Request · Correction" or "Update · Your request was decided" (the folded kind icon). */
export function kindText(item: InboxItem): string {
  return `${item.type === 'request' ? 'Request' : 'Update'} · ${item.task}`;
}

/** The request drawer's main action: a link to where the work is done, named for the work. */
export const REQUEST_ACTION_LABELS: Record<ActionRequestKind, string> = {
  correction: 'Make the correction',
  cancellation_request: 'Decide on the cancellation',
  closure_request: 'Review the closure',
  retention_request: 'Decide on retention',
  lead_appointment: 'Appoint a lead',
  grant_review: 'Review the grants',
  team_join_request: 'Review the join request',
  review_approval_lost: 'Choose a reviewer',
};

/** "This request closes on its own when …" by kind. */
export const REQUEST_CLOSES_WHEN: Record<ActionRequestKind, string> = {
  correction: 'the correction is saved',
  cancellation_request: 'the test is cancelled or kept',
  closure_request: 'the program is closed',
  retention_request: 'the hold or extension is decided',
  lead_appointment: 'a Lead Project Engineer is appointed',
  grant_review: 'the inherited grants are reviewed',
  team_join_request: 'the join request is accepted or declined',
  review_approval_lost: 'the review has an eligible reviewer again',
};

/** "Open the program" etc.: the record's own page, by what the record is. */
export function openRecordLabel(record: InboxRecord | null): string {
  switch (record?.kind) {
    case 'lab_program':
      return 'Open the program';
    case 'project':
      return 'Open the project';
    case 'storage_units':
      return 'Open retention';
    case 'concrete_report':
    case 'specimen':
      return 'Open the report';
    case 'page':
      return 'Open feedback';
    default:
      return 'Open the record';
  }
}

/** The record's own page when it differs from the item's link; null when it is the same page. */
export function recordHref(item: InboxItem): string | null {
  const record = item.record;
  if (!record) return null;
  let href: string | null = null;
  if (record.kind === 'lab_program') href = `/lab-testing/programs/${record.id}`;
  else if (record.kind === 'project') href = `/projects/${record.id}`;
  return href && href !== item.href ? href : null;
}

export const RECORD_KIND_LABELS: Record<InboxRecord['kind'], string> = {
  lab_program: 'Lab program',
  project: 'Project',
  storage_units: 'Storage units',
  concrete_report: 'Field report',
  specimen: 'Specimen',
  page: 'Page',
};

/** Whether the request waits on me, on others, or is done; for the "From …" line. */
export function requestState(item: InboxRequestItem): string | null {
  if (item.status === 'resolved') return null;
  if (item.waitingOnMe) return 'waiting on you';
  if (item.raisedByMe) return 'you asked';
  return 'waiting on someone else';
}

/** "Resolved by Pat Example · Program closed" (or without the name when it isn't known). */
export function resolvedLine(
  by: { name: string } | null | undefined,
  resolution: InboxRequestItem['resolution'] | undefined,
): string {
  const who = by?.name ? `Resolved by ${by.name}` : 'Resolved';
  return resolution ? `${who} · ${ACTION_REQUEST_RESOLUTION_LABEL[resolution]}` : who;
}

/** The update drawer's sentence. */
export function updateSentence(item: InboxUpdateItem): string {
  switch (item.kind) {
    case 'action_request.decided':
      return item.linkedRequestStatus === 'resolved'
        ? resolvedLine(item.from, item.linkedResolution)
        : 'Your request was decided.';
    case 'concrete_report.returned':
      return 'A reviewer returned this field report for correction.';
    case 'concrete_curing.out_of_range':
      return 'A curing temperature reading is outside the allowed range.';
    case 'concrete_equipment.flagged':
      return 'Equipment used on this report was flagged and needs review.';
    case 'concrete_test.failed':
      return 'A concrete test result did not meet its requirement.';
    case 'concrete_report.auto_submitted':
      return 'This field report was submitted automatically.';
    case 'feedback.submitted':
      return 'Someone sent feedback from this page. Read it on Help & Feedback.';
  }
}

/** Who it's from: a person's name, or Material Mule itself. */
export function fromName(item: InboxItem): string {
  return item.from?.name || 'Material Mule';
}
