import {
  concreteFieldReportDetailSchema,
  concreteReceivingQueueSchema,
  concreteReviewQueueSchema,
  concreteScheduleHistorySchema,
  concreteSearchSchema,
  concreteSetReceivingSchema,
  concreteSpecimenSetDetailSchema,
  concreteWorklistSchema,
  inventoryPageSchema,
  projectSearchResponseSchema,
  type ConcreteFieldReportDetail,
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
}): Promise<LoadResult<ConcreteReceivingQueue>> {
  const params = new URLSearchParams({ stage: query.stage });
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
