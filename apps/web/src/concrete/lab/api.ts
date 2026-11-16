import {
  concreteFieldReportDetailSchema,
  concreteReceivingQueueSchema,
  concreteReviewQueueSchema,
  concreteScheduleHistorySchema,
  concreteSearchSchema,
  concreteSetReceivingSchema,
  concreteSpecimenSetDetailSchema,
  concreteTestingTableSchema,
  concreteWorklistSchema,
  inventoryPageSchema,
  projectSearchResponseSchema,
  type ConcreteFieldReportDetail,
  type ConcreteMarkerConfirmationRequest,
  type ConcretePickupRequest,
  type ConcreteReceiptRequest,
  type ConcreteTestingTable,
  type ConcreteReceivingQueue,
  type ConcreteReceivingStage,
  type ConcreteScheduleHistory,
  type ConcreteSearch,
  type ConcreteSetReceiving,
  type ConcreteSpecimenSetDetail,
  type InventoryPage,
  type ProjectSummary,
} from '@materialmule/shared';
import type { z } from 'zod';
import { apiFetch } from '../../api/client';

// The Concrete Lab workspace (MM-V2-C31). Every call resolves; failures carry a readable
// message. The dashboard reuses the lists its counts open: the receiving queue, C22's worklist
// and C28's review queue (AC3).

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';

export type LoadResult<T> =
  { ok: true; data: T } | { ok: false; message: string; notFound?: boolean };

async function getJson<T>(url: string, schema: z.ZodType<T>, what: string): Promise<LoadResult<T>> {
  try {
    const response = await apiFetch(url);
    if (!response.ok) {
      return response.status === 404
        ? { ok: false, notFound: true, message: `That ${what} wasn't found.` }
        : { ok: false, message: `The ${what} couldn't load.` };
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

export function fetchReceivingQueue(query: {
  stage: ConcreteReceivingStage;
  page?: number;
  pageSize?: number;
  /** One project only (the server filters). */
  projectId?: string;
}): Promise<LoadResult<ConcreteReceivingQueue>> {
  const params = new URLSearchParams({ stage: query.stage });
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  return getJson(
    `/api/concrete/receiving-queue?${params.toString()}`,
    concreteReceivingQueueSchema,
    'receiving list',
  );
}

export function fetchConcreteSearch(
  q: string,
  page = 1,
  pageSize?: number,
): Promise<LoadResult<ConcreteSearch>> {
  const params = new URLSearchParams({ q });
  if (page > 1) params.set('page', String(page));
  if (pageSize) params.set('pageSize', String(pageSize));
  return getJson(`/api/concrete/search?${params.toString()}`, concreteSearchSchema, 'search');
}

/** The dashboard counts, each read from the list it opens. */
export interface ConcreteDashboardCounts {
  awaitingPickup: number;
  awaitingReceiving: number;
  testsToday: number;
  testsOverdue: number;
  holdsDue: number;
  awaitingReview: number;
  awaitingIssue: number;
}

export async function fetchDashboardCounts(): Promise<LoadResult<ConcreteDashboardCounts>> {
  const [receiving, worklist, review] = await Promise.all([
    fetchReceivingQueue({ stage: 'awaiting_pickup', pageSize: 1 }),
    // The Exceptions view carries every view's counts without reading a page of rows.
    getJson('/api/concrete/lab-worklist?view=exceptions', concreteWorklistSchema, 'worklist'),
    getJson('/api/concrete/review-queue?pageSize=1', concreteReviewQueueSchema, 'review queue'),
  ]);
  if (!receiving.ok) return receiving;
  if (!worklist.ok) return worklist;
  if (!review.ok) return review;
  return {
    ok: true,
    data: {
      awaitingPickup: receiving.data.counts.awaiting_pickup,
      awaitingReceiving: receiving.data.counts.awaiting_receiving,
      testsToday: worklist.data.counts.today,
      testsOverdue: worklist.data.counts.overdue,
      holdsDue: worklist.data.holdReviewDue,
      awaitingReview: review.data.counts.awaiting_review,
      awaitingIssue: review.data.counts.reviewed_awaiting_issue,
    },
  };
}

/** Specimen lookup: C05's set, C06's receiving record and C04's report, read side by side. */
export interface SetLookup {
  set: ConcreteSpecimenSetDetail;
  receiving: ConcreteSetReceiving;
  report: ConcreteFieldReportDetail;
}

export async function fetchSetLookup(setId: string): Promise<LoadResult<SetLookup>> {
  const id = encodeURIComponent(setId);
  const [set, receiving] = await Promise.all([
    getJson(`/api/concrete/specimen-sets/${id}`, concreteSpecimenSetDetailSchema, 'specimen set'),
    getJson(
      `/api/concrete/specimen-sets/${id}/receiving`,
      concreteSetReceivingSchema,
      'specimen set',
    ),
  ]);
  if (!set.ok) return set;
  if (!receiving.ok) return receiving;
  const report = await getJson(
    `/api/concrete/field-reports/${encodeURIComponent(set.data.fieldReportId)}`,
    concreteFieldReportDetailSchema,
    'field report',
  );
  if (!report.ok) return report;
  return { ok: true, data: { set: set.data, receiving: receiving.data, report: report.data } };
}

export function fetchScheduleHistory(
  specimenId: string,
): Promise<LoadResult<ConcreteScheduleHistory>> {
  return getJson(
    `/api/concrete/specimens/${encodeURIComponent(specimenId)}/schedule-history`,
    concreteScheduleHistorySchema,
    'schedule history',
  );
}

// ---- Set page (STRATA-95 part B): test results of a set's scheduled specimens ----------------

/**
 * The testing table's rows for these specimens (C23's read with the STRATA-95 selection): each
 * scheduled specimen's latest result and whether its entry is complete. HOLD and uncast
 * specimens aren't listed there; the set page shows them from the set record.
 */
export function fetchSetTesting(
  specimenIds: readonly string[],
): Promise<LoadResult<ConcreteTestingTable>> {
  const params = new URLSearchParams({
    includeOverdue: 'true',
    specimenIds: specimenIds.join(','),
  });
  return getJson(
    `/api/concrete/testing-table?${params.toString()}`,
    concreteTestingTableSchema,
    'test results',
  );
}

export function fetchSetReceiving(setId: string): Promise<LoadResult<ConcreteSetReceiving>> {
  return getJson(
    `/api/concrete/specimen-sets/${encodeURIComponent(setId)}/receiving`,
    concreteSetReceivingSchema,
    'specimen set',
  );
}

// ---- Pickup and receipt (C06 commands; the rules stay on the server) ------------------------

const COMMAND_REFUSAL: Record<string, string> = {
  forbidden: 'Pickup and receiving need a Lab Technician, a Lab Manager or the LAB station.',
  pickup_incomplete:
    'Mark picked up needs who collected them, when, and both curing readings (minimum and maximum).',
  before_casting: 'The pickup can’t be before the casting time.',
  already_received: 'Already received. A mass is corrected from the set page, with a reason.',
  set_not_numbered: 'Number this set first: permanent IDs are confirmed on a numbered set.',
  nothing_to_confirm: 'Every received specimen’s marking is already confirmed.',
  version_conflict: 'Someone else changed this set first. It has been reloaded; check and retry.',
  report_void: 'Its field report is Void.',
  set_void: 'This set is Void.',
  idempotency_key_reused: 'This was already sent differently. Reload and try again.',
  concrete_specimen_not_found: 'This specimen no longer exists.',
  concrete_specimen_set_not_found: 'This set no longer exists.',
};

export type CommandResult<T> =
  { ok: true; data: T } | { ok: false; message: string; code?: string; field?: string };

async function postJson<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<CommandResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  const json = (await response.json().catch(() => null)) as {
    code?: string;
    errors?: { field?: string; message?: string }[];
  } | null;
  if (response.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  }
  const code = json?.code;
  const known = code ? COMMAND_REFUSAL[code] : undefined;
  const error = json?.errors?.[0];
  if (known) return { ok: false, message: known, code, field: error?.field };
  if (error?.message) {
    const text = error.message[0]!.toUpperCase() + error.message.slice(1);
    return { ok: false, message: `${text}.`.replace(/\.\.$/, '.'), code, field: error.field };
  }
  return { ok: false, message: 'Nothing was saved. Try again.', code };
}

export const recordPickup = (setId: string, body: ConcretePickupRequest) =>
  postJson(
    `/api/concrete/specimen-sets/${encodeURIComponent(setId)}/pickup`,
    body,
    concreteSetReceivingSchema,
  );

export const recordReceipt = (specimenId: string, body: ConcreteReceiptRequest) =>
  postJson(
    `/api/concrete/specimens/${encodeURIComponent(specimenId)}/receipt`,
    body,
    concreteSetReceivingSchema,
  );

export const confirmMarkers = (setId: string, body: ConcreteMarkerConfirmationRequest) =>
  postJson(
    `/api/concrete/specimen-sets/${encodeURIComponent(setId)}/marker-confirmation`,
    body,
    concreteSetReceivingSchema,
  );

// ---- Lab search (top bar): the existing searches of each lab area, side by side ---------------

export const LAB_SEARCH_PREVIEW = 5;

export function searchStorageUnits(q: string): Promise<LoadResult<InventoryPage>> {
  const params = new URLSearchParams({ search: q, pageSize: String(LAB_SEARCH_PREVIEW) });
  return getJson(`/api/inventory?${params.toString()}`, inventoryPageSchema, 'storage unit search');
}

export function searchProjectList(q: string): Promise<LoadResult<ProjectSummary[]>> {
  return getJson(
    `/api/projects/search?q=${encodeURIComponent(q)}&limit=${LAB_SEARCH_PREVIEW}`,
    projectSearchResponseSchema,
    'project search',
  );
}
