import {
  concreteTestResultSaveResultSchema,
  concreteTestResultSchema,
  concreteTestingTableSchema,
  type ConcreteTestResult,
  type ConcreteTestResultSaveRequest,
  type ConcreteTestingTable,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// Concrete Lab → Testing table (MM-V2-C23). Every call resolves; failures carry a readable
// message (never a typed value).

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';

export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

export async function fetchTestingTable(query: {
  includeOverdue: boolean;
  /** Read one project on the server, so the row limit applies within it. */
  projectId?: string | null;
  /**
   * STRATA-95: just these specimens (a Breaks selection's Record breaks), whatever their target
   * date; at most 200.
   */
  specimenIds?: readonly string[] | null;
}): Promise<LoadResult<ConcreteTestingTable>> {
  const params = new URLSearchParams({ includeOverdue: String(query.includeOverdue) });
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.specimenIds && query.specimenIds.length > 0) {
    params.set('specimenIds', query.specimenIds.join(','));
  }
  try {
    const response = await apiFetch(`/api/concrete/testing-table?${params.toString()}`);
    if (!response.ok) return { ok: false, message: "The testing table couldn't load." };
    const parsed = concreteTestingTableSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

const REFUSAL: Record<string, string> = {
  forbidden: 'Entering results needs a Lab Technician, Lab Manager or the LAB station.',
  version_conflict: 'Someone else changed this result first. Reload the table to see it.',
  report_void: 'The field report is Void.',
  set_void: 'The set is Void.',
  entered_by_invalid: 'Choose who is testing (Tested by) on this station.',
  tester_invalid: 'The tester must be active staff with confirmed initials.',
  idempotency_key_reused: 'This save was already sent differently. Reload and try again.',
  concrete_specimen_not_found: 'This specimen no longer exists.',
  own_exclusion:
    'The reviewer who excluded this specimen can’t also test or enter its result. Reinstate it first, or have someone else enter it.',
};

export type SaveOutcome =
  | { ok: true; result: ConcreteTestResult }
  | { ok: false; kind: 'reason_required'; corrections: string[] }
  | {
      ok: false;
      kind: 'failed';
      message: string;
      /** The server's copy after a version conflict. */
      current?: ConcreteTestResult | null;
    };

export async function saveTestResult(
  specimenId: string,
  resultId: string,
  body: ConcreteTestResultSaveRequest,
): Promise<SaveOutcome> {
  let response: Response;
  try {
    response = await apiFetch(
      `/api/concrete/specimens/${encodeURIComponent(specimenId)}/test-results/${encodeURIComponent(resultId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    );
  } catch {
    return { ok: false, kind: 'failed', message: UNREACHABLE };
  }
  const json = (await response.json().catch(() => null)) as {
    code?: string;
    corrections?: string[];
    current?: unknown;
    errors?: { field: string; message: string }[];
  } | null;
  if (response.ok) {
    const parsed = concreteTestResultSaveResultSchema.safeParse(json);
    return parsed.success
      ? { ok: true, result: parsed.data.result }
      : { ok: false, kind: 'failed', message: UNEXPECTED };
  }
  if (json?.code === 'reason_required') {
    return { ok: false, kind: 'reason_required', corrections: json.corrections ?? [] };
  }
  if (json?.code === 'version_conflict') {
    const current = concreteTestResultSchema.safeParse(json.current);
    return {
      ok: false,
      kind: 'failed',
      message: REFUSAL.version_conflict!,
      current: current.success ? current.data : null,
    };
  }
  const error = json?.errors?.[0];
  if (error) return { ok: false, kind: 'failed', message: error.message };
  return {
    ok: false,
    kind: 'failed',
    message: REFUSAL[json?.code ?? ''] ?? 'Not saved. Try again.',
  };
}
