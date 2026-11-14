import { z } from 'zod';
import { activityItemSchema } from './activity';
import { inboxPageSchema, inboxQuerySchema, inboxSummarySchema } from './inbox';
import { stageKeySchema, workDomainSchema } from './stage';

// Strata wave 2 lane A contracts: Today (STRATA-22, 23, 56), the LAB station's Today (STRATA-20,
// 21, 63) and the station Inbox (STRATA-27). Routes:
//
//   GET /api/today/needs-you              personal accounts: Inbox requests waiting on me plus
//                                         system work this account may act on (STRATA-56)
//   GET /api/activity/recent?scope=       Last 24 hours, narrowed to mine / my projects / the lab
//   GET /api/station/today                LAB account: the "At this station" server counts
//   GET /api/station/config/:stationId    any active session: a station's row order and visibility
//   PUT /api/station/config/:stationId    Lab Manager with their own (verified) account only
//   GET /api/station/inbox?personId=&...  LAB account: the picked person's Inbox, only when that
//                                         person turned on "Show my Inbox on shared LAB computers"
//   GET /api/station/inbox/summary?personId=   the same, counts and preview only
//
// LAB's picked person is attribution only: nothing here gives the station that person's roles,
// and the station Inbox is read-only (no read, dismiss or decide from the station).

// ---------------------------------------------------------------------------------------------
// Needs you (STRATA-56). One list, most urgent first. Requests come from the Inbox feed word for
// word (same task, title and stage); system work never goes to Inbox (reports to review, HOLDs,
// breaks, retention, drafts, labels). A request is never also listed as system work: each item
// has a stable `key` and the server drops system work a listed request already stands for.

export const NEEDS_YOU_SOURCES = ['request', 'system'] as const;
export type NeedsYouSource = (typeof NEEDS_YOU_SOURCES)[number];

/** System work kinds, in the order the server ranks them (most urgent first). */
export const NEEDS_YOU_SYSTEM_KINDS = [
  'concrete_holds', // Lab Manager: sets on HOLD (Review holds)
  'concrete_reviews', // lead / designated reviewer: field reports to review, never one's own
  'breaks_due', // lab staff: concrete breaks due today, with how many aren't started
  'tests_assigned', // technician: tests assigned to me today
  'lab_unassigned', // Lab Manager: lab requests not assigned yet
  'retention_due', // lead: units at end of retention on my projects (Decide)
  'disposal_approved', // Lab Manager: units approved for disposal (Start disposal)
  'labels_failed', // technician: a label that didn't print (Print again)
  'drafts_old', // my draft receipts not confirmed (Finish); Lab Manager: older than 7 days
  'location_conflicts', // Lab Manager: location checks that disagree
  'program_finished', // lead: a lab program finished (progress only)
] as const;
export type NeedsYouSystemKind = (typeof NEEDS_YOU_SYSTEM_KINDS)[number];

export const needsYouItemSchema = z.object({
  /** Stable: `request:<actionItemId>` or `system:<kind>[:<scope id>]`. */
  key: z.string(),
  source: z.enum(NEEDS_YOU_SOURCES),
  /** Requests: the Inbox Task words ("Close a program"); system work: its tag word. */
  task: z.string(),
  /** The sentence ("Decide on 4 units at end of retention"). */
  title: z.string(),
  /** The detail line; IDs in it are listed in `ids` so the page can set them in mono. */
  detail: z.string().nullable(),
  ids: z.array(z.string()),
  stage: stageKeySchema,
  domain: workDomainSchema,
  /** The one action's words ("Decide", "Review holds", "Open"). */
  action: z.string(),
  /** In-app link the action goes to; following it never grants access. */
  href: z.string(),
  /** How many things the row stands for (1 for a request). */
  count: z.number().int().min(1),
  /** When it became due or arrived, for ordering ties and the detail line. */
  since: z.string().nullable(),
});
export type NeedsYouItem = z.infer<typeof needsYouItemSchema>;

/** The first rows Today shows before "Show all n". */
export const NEEDS_YOU_FIRST = 6;

/** `GET /api/today/needs-you`: every row (rarely more than a dozen), most urgent first. */
export const needsYouResponseSchema = z.object({
  items: z.array(needsYouItemSchema),
  /** Rows in all (= items.length). */
  total: z.number().int().min(0),
  /** How many rows are Inbox requests ("3 are requests in your Inbox"). */
  fromInbox: z.number().int().min(0),
  /**
   * System sources that failed to load; the rest still show. Requests failing fails the route.
   * Empty when everything loaded.
   */
  unavailable: z.array(z.enum(NEEDS_YOU_SYSTEM_KINDS)),
});
export type NeedsYouResponse = z.infer<typeof needsYouResponseSchema>;

/** "5 things need you. 3 are requests in your Inbox." / "Nothing needs you right now." */
export function needsYouSummary(total: number, fromInbox: number): string {
  if (total === 0) return 'Nothing needs you right now.';
  const things = total === 1 ? '1 thing needs you.' : `${total} things need you.`;
  if (fromInbox === 0) return things;
  const requests =
    fromInbox === 1 ? '1 is a request in your Inbox.' : `${fromInbox} are requests in your Inbox.`;
  return `${things} ${requests}`;
}

// ---------------------------------------------------------------------------------------------
// Last 24 hours (STRATA-23): `scope` narrows the existing ledger. `mine` = events I did (the
// technician's "You received 2 buckets"), `projects` = events on projects I'm a member of (lead),
// `lab` = everything (Lab Manager; also the default, as the route always was).

export const ACTIVITY_SCOPES = ['lab', 'projects', 'mine'] as const;
export type ActivityScope = (typeof ACTIVITY_SCOPES)[number];

/** Activity rows with whether the signed-in person did it (for second-person wording). */
export const scopedActivityItemSchema = activityItemSchema.extend({
  byMe: z.boolean().default(false),
});
export type ScopedActivityItem = z.infer<typeof scopedActivityItemSchema>;

// ---------------------------------------------------------------------------------------------
// The LAB station's Today (STRATA-20, 21, 63).

/** The "At this station" rows, in their default order. */
export const STATION_ROWS = ['drafts', 'breaks_due', 'labels_to_print'] as const;
export type StationRow = (typeof STATION_ROWS)[number];

/**
 * `GET /api/station/today`. Each count is null when that source couldn't be read, so one failure
 * leaves the other rows (and the receiving tiles) working. `drafts` is the server's draft
 * registry for LAB (migration 0044); the page adds this browser's own unsynced drafts.
 */
export const stationTodaySchema = z.object({
  draftReceipts: z.number().int().min(0).nullable(),
  breaksDueToday: z.number().int().min(0).nullable(),
  labelsToPrint: z.number().int().min(0).nullable(),
});
export type StationToday = z.infer<typeof stationTodaySchema>;

/** A station's identity: a random ID made once on that computer (`materialmule.station.id`). */
export const stationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, { error: 'must be 8 to 64 letters, digits, - or _' });

/** Which rows show, in what order. Every row appears once; hidden rows keep their place. */
export const stationRowSettingSchema = z.object({
  row: z.enum(STATION_ROWS),
  visible: z.boolean(),
});

export const stationConfigSchema = z.object({
  stationId: z.string(),
  rows: z.array(stationRowSettingSchema),
  /** 0 = never saved (the defaults); each save adds one. */
  version: z.number().int().min(0),
  /** Who last saved it; null for the defaults. */
  updatedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  updatedAt: z.string().nullable(),
});
export type StationConfig = z.infer<typeof stationConfigSchema>;

export const DEFAULT_STATION_ROWS: StationConfig['rows'] = STATION_ROWS.map((row) => ({
  row,
  visible: true,
}));

/**
 * Put stored or submitted rows into canonical form: unknown rows dropped, duplicates dropped
 * (first wins), missing rows appended visible in default order.
 */
export function normalizeStationRows(rows: readonly { row: string; visible: boolean }[]) {
  const seen = new Set<StationRow>();
  const out: StationConfig['rows'] = [];
  for (const entry of rows) {
    const row = entry.row as StationRow;
    if (!STATION_ROWS.includes(row) || seen.has(row)) continue;
    seen.add(row);
    out.push({ row, visible: entry.visible === true });
  }
  for (const row of STATION_ROWS) if (!seen.has(row)) out.push({ row, visible: true });
  return out;
}

/** `PUT /api/station/config/:stationId`: the full row list plus the version it was based on. */
export const updateStationConfigSchema = z.strictObject({
  rows: z
    .array(stationRowSettingSchema)
    .length(STATION_ROWS.length)
    .refine((rows) => new Set(rows.map((r) => r.row)).size === rows.length, {
      error: 'each row once',
    }),
  version: z.number().int().min(0),
});
export type UpdateStationConfig = z.output<typeof updateStationConfigSchema>;

/** Counts over 99 show "99+"; zero shows a muted 0. */
export function stationCountText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

// ---------------------------------------------------------------------------------------------
// Station Inbox (STRATA-27). Consent-based and read-only. The server checks, on every call, that
// the caller is the LAB account, that `personId` is an active staff member, and that the person
// turned on `shareInboxOnStations`. Off (the default) answers `private` with no items or counts.

export const stationInboxQuerySchema = inboxQuerySchema.extend({
  personId: z.string().uuid(),
});
export type StationInboxQuery = z.output<typeof stationInboxQuerySchema>;

const stationPersonSchema = z.object({ userId: z.string(), name: z.string() });

export const stationInboxPageSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('private'), person: stationPersonSchema }),
  z.object({ state: z.literal('shared'), person: stationPersonSchema, page: inboxPageSchema }),
]);
export type StationInboxPage = z.infer<typeof stationInboxPageSchema>;

export const stationInboxSummaryQuerySchema = z.strictObject({ personId: z.string().uuid() });

export const stationInboxSummarySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('private'), person: stationPersonSchema }),
  z.object({
    state: z.literal('shared'),
    person: stationPersonSchema,
    summary: inboxSummarySchema,
  }),
]);
export type StationInboxSummary = z.infer<typeof stationInboxSummarySchema>;
