import {
  concreteRescheduleResultSchema,
  concreteScheduleHistorySchema,
  concreteWorklistSchema,
  type ConcreteRescheduleRequest,
  type ConcreteRescheduleResult,
  type ConcreteScheduleHistory,
  type ConcreteWorklist,
  type ConcreteWorklistView,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// Lab Testing → Concrete breaks (MM-V2-C22). Every call resolves; failures carry a readable message.

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';

export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

export async function fetchConcreteWorklist(query: {
  view: ConcreteWorklistView;
  projectId: string;
  page: number;
  /** HOLD view only: just the HOLDs due for review (MM-V2-C31). */
  holdDue?: boolean;
}): Promise<LoadResult<ConcreteWorklist>> {
  const params = new URLSearchParams({ view: query.view, page: String(query.page) });
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.holdDue) params.set('holdDue', 'true');
  try {
    const response = await apiFetch(`/api/concrete/lab-worklist?${params.toString()}`);
    if (!response.ok) return { ok: false, message: "The concrete worklist couldn't load." };
    const parsed = concreteWorklistSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

export async function fetchScheduleHistory(
  specimenId: string,
): Promise<LoadResult<ConcreteScheduleHistory>> {
  try {
    const response = await apiFetch(
      `/api/concrete/specimens/${encodeURIComponent(specimenId)}/schedule-history`,
    );
    if (!response.ok) return { ok: false, message: "The schedule history couldn't load." };
    const parsed = concreteScheduleHistorySchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

const REFUSAL: Record<string, string> = {
  forbidden:
    'Only the Lead Project Engineer, a designated reviewer or a Lab Manager with the project’s concrete grant can reschedule.',
  version_conflict: 'Someone changed this specimen’s schedule first. Review the current schedule.',
  hold_specimen: 'HOLD specimens are released or changed through HOLD actions, not rescheduled.',
  edit_on_draft: 'This set is still a draft: its technician changes the ages on the field report.',
  no_casting_time: 'This specimen has no casting time, so it has no target to move.',
  report_void: 'The field report is Void.',
  set_void: 'The set is Void.',
  idempotency_key_reused: 'This change was already sent differently. Reload and try again.',
};

export type RescheduleResult =
  | { ok: true; data: ConcreteRescheduleResult }
  | { ok: false; message: string; field?: 'newAge' | 'reason' };

export async function rescheduleSpecimen(
  specimenId: string,
  body: ConcreteRescheduleRequest,
): Promise<RescheduleResult> {
  let response: Response;
  try {
    response = await apiFetch(
      `/api/concrete/specimens/${encodeURIComponent(specimenId)}/reschedule`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  const json = (await response.json().catch(() => null)) as {
    code?: string;
    errors?: { field: string; message: string }[];
  } | null;
  if (response.ok) {
    const parsed = concreteRescheduleResultSchema.safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  }
  const error = json?.errors?.[0];
  if (error && (error.field === 'newAge' || error.field === 'reason')) {
    return { ok: false, message: error.message, field: error.field };
  }
  return {
    ok: false,
    message: REFUSAL[json?.code ?? ''] ?? 'The reschedule wasn’t saved. Try again.',
  };
}
