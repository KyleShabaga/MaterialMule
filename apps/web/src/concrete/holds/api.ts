import {
  CONCRETE_HOLD_PROBLEM_LABEL,
  concreteDisposalReadySchema,
  concreteHoldActionResultSchema,
  concreteHoldHistorySchema,
  concreteHoldListSchema,
  type ConcreteDisposalReady,
  type ConcreteHoldActionResult,
  type ConcreteHoldAuthorizeDisposalRequest,
  type ConcreteHoldHistory,
  type ConcreteHoldList,
  type ConcreteHoldProblemCode,
  type ConcreteHoldScheduleTestRequest,
  type ConcreteHoldStatusFilter,
  type ConcreteHoldUntilRequest,
  type ConcreteRecordDisposalRequest,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// Lab Testing → HOLD and Ready for disposal's concrete filter (MM-V2-C26). Every call resolves;
// failures carry a readable message.

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';

export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function load<T>(
  path: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  failed: string,
): Promise<LoadResult<T>> {
  try {
    const response = await apiFetch(path);
    if (!response.ok) return { ok: false, message: failed };
    const parsed = schema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

export function fetchHolds(query: {
  kind: 'all' | 'ordinary' | 'failed';
  status: ConcreteHoldStatusFilter;
  projectId: string;
  page: number;
}): Promise<LoadResult<ConcreteHoldList>> {
  const params = new URLSearchParams({
    kind: query.kind,
    status: query.status,
    page: String(query.page),
  });
  if (query.projectId) params.set('projectId', query.projectId);
  return load(
    `/api/concrete/holds?${params.toString()}`,
    concreteHoldListSchema,
    "The HOLD list couldn't load.",
  );
}

export function fetchHoldHistory(specimenId: string): Promise<LoadResult<ConcreteHoldHistory>> {
  return load(
    `/api/concrete/specimens/${encodeURIComponent(specimenId)}/hold-history`,
    concreteHoldHistorySchema,
    "The HOLD history couldn't load.",
  );
}

export function fetchConcreteReady(page: number): Promise<LoadResult<ConcreteDisposalReady>> {
  return load(
    `/api/concrete/disposal/ready?page=${page}`,
    concreteDisposalReadySchema,
    "The concrete specimens ready for disposal couldn't load.",
  );
}

const REFUSAL: Record<string, string> = {
  forbidden:
    'You can’t act on some of these specimens. An ordinary HOLD is released by the Lead Project Engineer or a Lab Manager; a failed-specimen hold by the Lead Project Engineer or a Lab Manager with the project’s concrete grant; disposal is recorded by lab staff.',
  idempotency_key_reused: 'This action was already sent differently. Reload and try again.',
};

export interface ActionProblem {
  specimenId: string;
  code: ConcreteHoldProblemCode;
  label: string;
}

export type ActionResult =
  | { ok: true; data: ConcreteHoldActionResult }
  | {
      ok: false;
      message: string;
      field?: string;
      problems?: ActionProblem[];
      refused?: string[];
    };

async function command(path: string, body: unknown): Promise<ActionResult> {
  let response: Response;
  try {
    response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  const json = (await response.json().catch(() => null)) as {
    code?: string;
    specimens?: string[];
    problems?: { specimenId: string; code: ConcreteHoldProblemCode }[];
    errors?: { field: string; message: string }[];
  } | null;
  if (response.ok) {
    const parsed = concreteHoldActionResultSchema.safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  }
  if (json?.code === 'not_eligible' && json.problems) {
    return {
      ok: false,
      message: 'Nothing was changed: some specimens aren’t eligible.',
      problems: json.problems.map((p) => ({ ...p, label: CONCRETE_HOLD_PROBLEM_LABEL[p.code] })),
    };
  }
  const error = json?.errors?.[0];
  if (error) return { ok: false, message: error.message, field: error.field };
  return {
    ok: false,
    message: REFUSAL[json?.code ?? ''] ?? 'Nothing was changed. Try again.',
    refused: json?.specimens,
  };
}

export const scheduleTest = (body: ConcreteHoldScheduleTestRequest) =>
  command('/api/concrete/holds/schedule-test', body);
/**
 * STRATA-121: Breaks selection bar → Hold until. Scheduled specimens (with their versions) go on
 * an ordinary HOLD until `holdUntil` (YYYY-MM-DD, after today) with a reason. All or nothing:
 * `problems` names each ineligible specimen, `refused` those the caller may not hold.
 */
export const holdUntil = (body: ConcreteHoldUntilRequest) =>
  command('/api/concrete/holds/hold-until', body);
export const authorizeDisposal = (body: ConcreteHoldAuthorizeDisposalRequest) =>
  command('/api/concrete/holds/authorize-disposal', body);
export const recordDisposal = (body: ConcreteRecordDisposalRequest) =>
  command('/api/concrete/disposal/record', body);
