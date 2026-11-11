import {
  concreteExceptionNoteListSchema,
  concreteReportVersionDetailSchema,
  concreteReportVersionListSchema,
  concreteStrengthReportDetailSchema,
  concreteStrengthReportListSchema,
  concreteStrengthReportSnapshotSchema,
  concreteStrengthExclusionStateSchema,
  type ConcreteExceptionNoteList,
  type ConcreteStrengthExclusionState,
  type ConcreteExceptionNoteRequest,
  type ConcreteReportAction,
  type ConcreteReportVersionList,
  type ConcreteStrengthReportDetail,
  type ConcreteStrengthReportList,
  type ConcreteStrengthReportSnapshot,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';
import { ReviewApiError } from './api';

// MM-V2-C39: strength reports, addressed by their specimen set.

async function failure(response: Response): Promise<ReviewApiError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    errors?: unknown;
  } | null;
  const errors = Array.isArray(body?.errors)
    ? (body.errors as { field?: unknown; message?: unknown }[]).map((e) => ({
        field: String(e.field ?? ''),
        message: String(e.message ?? ''),
      }))
    : [];
  return new ReviewApiError(
    response.status,
    typeof body?.code === 'string' ? body.code : null,
    errors,
  );
}

async function getJson<T>(path: string, parse: (body: unknown) => T): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw await failure(response);
  return parse(await response.json());
}

async function postJson<T>(path: string, body: unknown, parse: (body: unknown) => T): Promise<T> {
  const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw await failure(response);
  return parse(await response.json());
}

const strengthPath = (setId: string, rest = '') =>
  `/api/concrete/specimen-sets/${encodeURIComponent(setId)}/strength-report${rest}`;

export function fetchStrengthReport(setId: string): Promise<ConcreteStrengthReportDetail> {
  return getJson(strengthPath(setId), (b) => concreteStrengthReportDetailSchema.parse(b));
}

export function fetchStrengthVersions(setId: string): Promise<ConcreteReportVersionList> {
  return getJson(strengthPath(setId, '/versions'), (b) => concreteReportVersionListSchema.parse(b));
}

export async function fetchStrengthSnapshot(
  setId: string,
  versionNo: number,
): Promise<ConcreteStrengthReportSnapshot> {
  const version = await getJson(strengthPath(setId, `/versions/${versionNo}`), (b) =>
    concreteReportVersionDetailSchema.parse(b),
  );
  return concreteStrengthReportSnapshotSchema.parse(version.snapshot);
}

export function fetchStrengthNotes(
  setId: string,
  versionNo: number,
): Promise<ConcreteExceptionNoteList> {
  return getJson(strengthPath(setId, `/versions/${versionNo}/exception-notes`), (b) =>
    concreteExceptionNoteListSchema.parse(b),
  );
}

export function documentStrengthException(
  setId: string,
  versionNo: number,
  body: ConcreteExceptionNoteRequest,
): Promise<ConcreteExceptionNoteList> {
  return postJson(strengthPath(setId, `/versions/${versionNo}/exception-notes`), body, (b) =>
    concreteExceptionNoteListSchema.parse(b),
  );
}

export function sendStrengthCommand(
  setId: string,
  action: ConcreteReportAction,
  body: Record<string, unknown> & { version: number; idempotencyKey: string },
): Promise<ConcreteStrengthReportDetail> {
  return postJson(strengthPath(setId, `/${action}`), body, (b) =>
    concreteStrengthReportDetailSchema.parse(b),
  );
}

export function fetchStrengthReports(query: {
  projectId?: string;
  needsLab?: boolean;
}): Promise<ConcreteStrengthReportList> {
  const params = new URLSearchParams();
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.needsLab) params.set('needsLab', 'true');
  const text = params.toString();
  return getJson(`/api/concrete/strength-reports${text ? `?${text}` : ''}`, (b) =>
    concreteStrengthReportListSchema.parse(b),
  );
}

/** A plain sentence for a strength-report refusal (never echoes a value). */
/** MM-V2-C24: exclude a specimen from its strength test (or reinstate it), with a reason. */
export async function setStrengthExclusion(
  specimenId: string,
  excluded: boolean,
  reason: string,
): Promise<ConcreteStrengthExclusionState> {
  const response = await apiFetch(
    `/api/concrete/specimens/${encodeURIComponent(specimenId)}/strength-exclusion`,
    {
      method: 'PUT',
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), excluded, reason }),
    },
  );
  if (!response.ok) throw await failure(response);
  return concreteStrengthExclusionStateSchema.parse(await response.json());
}

export function strengthProblemText(error: unknown): string {
  if (error instanceof ReviewApiError) {
    switch (error.code) {
      case 'own_result':
        return 'You tested or entered this result. Another reviewer decides whether to exclude it.';
      case 'result_not_complete':
        return 'This specimen has no complete result yet. Exclude it once its result is entered.';
      case 'result_on_strength_report':
        return 'This specimen is on a submitted or issued strength report. Return, recall or revise the report first.';
      case 'already_excluded':
      case 'not_excluded':
        return 'Someone changed this specimen while you had it open. Reload and try again.';
      case 'own_report':
        return 'You entered or tested these results alone. Someone else must review or issue this report.';
      case 'first_age_incomplete':
      case 'no_new_age':
      case 'no_ages':
      case 'set_void':
        return error.errors[0]?.message ?? 'This report can’t be submitted yet.';
      case 'version_conflict':
        return 'Someone changed this report while you had it open. Reload and try again.';
      case 'routed_to_another_reviewer':
        return 'This version is routed to another reviewer. Only they or the Lead Project Engineer can act on it.';
      case 'exceptions_unresolved':
        return `Resolve or document every exception first: ${error.errors.map((e) => e.message).join('; ')}.`;
      case 'invalid_transition':
        return 'The report moved on since this page loaded. Reload to see where it stands.';
      case 'forbidden':
        return 'Your account can’t do this on this project.';
      default:
        if (error.status === 400) {
          return (
            error.errors.map((e) => e.message).join('; ') || 'Check the entries and try again.'
          );
        }
    }
    return 'The server had a problem. Try again in a minute.';
  }
  return 'Material Mule couldn’t be reached. Check the connection and try again.';
}
