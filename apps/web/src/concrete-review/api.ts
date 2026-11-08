import {
  concreteExceptionNoteListSchema,
  concreteFieldReportDetailSchema,
  concreteProjectSettingsSchema,
  concreteReportVersionDetailSchema,
  concreteReportVersionListSchema,
  concreteReviewQueueSchema,
  projectReportIssuersSchema,
  type ConcreteExceptionNoteList,
  type ConcreteExceptionNoteRequest,
  type ConcreteFieldReportDetail,
  type ConcreteProjectSettings,
  type ConcreteReportVersionDetail,
  type ConcreteReportVersionList,
  type ConcreteReviewQueue,
  type ConcreteReviewQueueQueryInput,
  type ProjectReportIssuers,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// MM-V2-C28: the review queue, a report's versions and exception notes, and C09's commands.

export class ReviewApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly errors: { field: string; message: string }[] = [],
    readonly current: ConcreteFieldReportDetail | null = null,
  ) {
    super(code ?? `HTTP ${status}`);
  }
}

async function failure(response: Response): Promise<ReviewApiError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    errors?: unknown;
    current?: unknown;
  } | null;
  const code = typeof body?.code === 'string' ? body.code : null;
  const errors = Array.isArray(body?.errors)
    ? (body.errors as { field?: unknown; message?: unknown }[]).map((e) => ({
        field: String(e.field ?? ''),
        message: String(e.message ?? ''),
      }))
    : [];
  const current = concreteFieldReportDetailSchema.safeParse(body?.current);
  return new ReviewApiError(response.status, code, errors, current.success ? current.data : null);
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

export function queueSearch(query: ConcreteReviewQueueQueryInput): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function fetchReviewQueue(
  query: ConcreteReviewQueueQueryInput,
): Promise<ConcreteReviewQueue> {
  return getJson(`/api/concrete/review-queue${queueSearch(query)}`, (b) =>
    concreteReviewQueueSchema.parse(b),
  );
}

const reportPath = (id: string, rest = '') =>
  `/api/concrete/field-reports/${encodeURIComponent(id)}${rest}`;

export function fetchReport(id: string): Promise<ConcreteFieldReportDetail> {
  return getJson(reportPath(id), (b) => concreteFieldReportDetailSchema.parse(b));
}

export function fetchVersions(id: string): Promise<ConcreteReportVersionList> {
  return getJson(reportPath(id, '/versions'), (b) => concreteReportVersionListSchema.parse(b));
}

export function fetchVersion(id: string, versionNo: number): Promise<ConcreteReportVersionDetail> {
  return getJson(reportPath(id, `/versions/${versionNo}`), (b) =>
    concreteReportVersionDetailSchema.parse(b),
  );
}

export function fetchExceptionNotes(
  id: string,
  versionNo: number,
): Promise<ConcreteExceptionNoteList> {
  return getJson(reportPath(id, `/versions/${versionNo}/exception-notes`), (b) =>
    concreteExceptionNoteListSchema.parse(b),
  );
}

export function documentException(
  id: string,
  versionNo: number,
  body: ConcreteExceptionNoteRequest,
): Promise<ConcreteExceptionNoteList> {
  return postJson(reportPath(id, `/versions/${versionNo}/exception-notes`), body, (b) =>
    concreteExceptionNoteListSchema.parse(b),
  );
}

export type ReviewCommand = 'review' | 'return' | 'issue' | 'revise';

export function sendCommand(
  id: string,
  action: ReviewCommand,
  body: Record<string, unknown> & { version: number; idempotencyKey: string },
): Promise<ConcreteFieldReportDetail> {
  return postJson(reportPath(id, `/${action}`), body, (b) =>
    concreteFieldReportDetailSchema.parse(b),
  );
}

export function fetchConcreteSettings(projectId: string): Promise<ConcreteProjectSettings> {
  return getJson(`/api/projects/${encodeURIComponent(projectId)}/concrete-settings`, (b) =>
    concreteProjectSettingsSchema.parse(b),
  );
}

/** Personal accounts may read a project's issuers; LAB gets 403 (shown as "not available"). */
export function fetchReportIssuers(projectId: string): Promise<ProjectReportIssuers> {
  return getJson(`/api/projects/${encodeURIComponent(projectId)}/report-issuers`, (b) =>
    projectReportIssuersSchema.parse(b),
  );
}

/** A plain sentence for an API refusal on the review screens. */
export function problemText(error: unknown): string {
  if (!(error instanceof ReviewApiError)) {
    return 'Material Mule couldn’t be reached. Check the connection and try again.';
  }
  switch (error.code) {
    case 'version_conflict':
      return 'Someone changed this report while you had it open. It has been reloaded; check it and try again.';
    case 'routed_to_another_reviewer':
      return 'This version is routed to another reviewer. Only they or the Lead Project Engineer can act on it.';
    case 'own_report':
    case 'not_own_report':
      return 'You are this report’s technician. Someone else must review or issue it.';
    case 'exceptions_unresolved':
      return `Resolve or document every exception first: ${error.errors.map((e) => e.message).join('; ')}.`;
    case 'exception_already_documented':
      return 'This exception was already documented with a different note.';
    case 'version_not_awaiting_review':
      return 'Only the version awaiting review can be documented.';
    case 'invalid_transition':
      return 'The report moved on since this page loaded. Reload to see where it stands.';
    case 'forbidden':
      return 'Your account can’t do this on this project.';
    default:
      if (error.status === 400) {
        return error.errors.map((e) => e.message).join('; ') || 'Check the entries and try again.';
      }
      return 'The server had a problem. Try again in a minute.';
  }
}
