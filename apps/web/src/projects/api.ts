import {
  messagesByField,
  projectConflictResponseSchema,
  projectDetailSchema,
  projectLeadNominationsSchema,
  projectListPageSchema,
  projectVersionConflictResponseSchema,
  validationErrorResponseSchema,
  type ProjectDetail,
  type ProjectLeadNominations,
  type ProjectListPage,
  type ProjectSummary,
  type UpdateProjectRequest,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// Projects list, detail and edit (MM-T35). Every call resolves; failures carry a readable message.

export type LoadResult<T> =
  { ok: true; data: T } | { ok: false; notFound: boolean; message: string };

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";

async function getJson<T>(
  path: string,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
): Promise<LoadResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    return { ok: false, notFound: false, message: UNREACHABLE };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      response.status === 404
        ? 'Project not found.'
        : response.status === 403
          ? "You don't have permission to see this."
          : 'Material Mule had a problem loading this. Try again.';
    return { ok: false, notFound: response.status === 404, message };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, notFound: false, message: 'Material Mule returned an unexpected response.' };
}

/** `params` is the page's own URL query, which uses the API's parameter names. */
export function fetchProjects(params: URLSearchParams): Promise<LoadResult<ProjectListPage>> {
  const query = params.toString();
  return getJson(`/api/projects${query ? `?${query}` : ''}`, projectListPageSchema);
}

export function fetchProjectDetail(id: string): Promise<LoadResult<ProjectDetail>> {
  return getJson(`/api/projects/${encodeURIComponent(id)}`, projectDetailSchema);
}

export type UpdateResult =
  | { kind: 'saved'; project: ProjectDetail }
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> }
  /** Someone else saved first; `current` is what's there now. */
  | { kind: 'stale'; current: ProjectDetail }
  | { kind: 'number_taken'; existing: ProjectSummary }
  | { kind: 'failed'; message: string };

export async function updateProject(id: string, body: UpdateProjectRequest): Promise<UpdateResult> {
  let response: Response;
  try {
    response = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  } catch {
    // The save may have arrived before the connection dropped (MM-T61).
    return {
      kind: 'failed',
      message:
        "Material Mule couldn't be reached. Check the connection, then reload to see whether it was saved.",
    };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = projectDetailSchema.safeParse(json);
    if (parsed.success) return { kind: 'saved', project: parsed.data };
  }
  if (response.status === 400) {
    const parsed = validationErrorResponseSchema.safeParse(json);
    if (parsed.success)
      return { kind: 'invalid', fieldErrors: messagesByField(parsed.data.errors) };
  }
  if (response.status === 409) {
    const stale = projectVersionConflictResponseSchema.safeParse(json);
    if (stale.success) return { kind: 'stale', current: stale.data.current };
    const taken = projectConflictResponseSchema.safeParse(json);
    if (taken.success) return { kind: 'number_taken', existing: taken.data.existing };
  }
  if (response.status === 422) {
    const message = (json as { message?: unknown } | null)?.message;
    return {
      kind: 'invalid',
      fieldErrors: {
        projectNumber: [typeof message === 'string' ? message : "The project number can't change."],
      },
    };
  }
  if (response.status === 403) {
    return { kind: 'failed', message: "You don't have permission to make this change." };
  }
  return { kind: 'failed', message: "The project wasn't saved. Try again." };
}

// Lead Project Engineer nominations (MM-AO04, D01/D02).

export function fetchLeadNominations(id: string): Promise<LoadResult<ProjectLeadNominations>> {
  return getJson(
    `/api/projects/${encodeURIComponent(id)}/lead-nominations`,
    projectLeadNominationsSchema,
  );
}

export type NominationResult =
  { ok: true; value: ProjectLeadNominations } | { ok: false; message: string };

const NOMINATION_MESSAGES: Record<string, string> = {
  lead_already_appointed: 'This project already has a Lead Project Engineer.',
  nomination_pending: 'A nomination is already waiting for an admin.',
  nomination_decided: 'Someone already decided this nomination. Reload to see it.',
  invalid_recipient: 'Choose an active staff member.',
  idempotency_key_reused: 'That was already sent. Reload to see it.',
  forbidden: "You don't have permission to do this.",
};

async function postNomination(path: string, body: unknown): Promise<NominationResult> {
  let response: Response;
  try {
    response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    const parsed = projectLeadNominationsSchema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
  }
  if (response.status === 400) {
    const parsed = validationErrorResponseSchema.safeParse(json);
    if (parsed.success) {
      return { ok: false, message: parsed.data.errors.map((e) => e.message).join(' ') };
    }
  }
  const code = typeof json?.code === 'string' ? json.code : '';
  return { ok: false, message: NOMINATION_MESSAGES[code] ?? 'That didn’t work. Try again.' };
}

export function nominateLead(
  projectId: string,
  body: { nomineeUserId: string; note: string | null; idempotencyKey: string },
): Promise<NominationResult> {
  return postNomination(`/api/projects/${encodeURIComponent(projectId)}/lead-nominations`, body);
}

export function decideLeadNomination(
  projectId: string,
  nominationId: string,
  action: 'confirm' | 'reject' | 'withdraw',
  reason: string,
): Promise<NominationResult> {
  return postNomination(
    `/api/projects/${encodeURIComponent(projectId)}/lead-nominations/${encodeURIComponent(
      nominationId,
    )}/${action}`,
    // MISC-03: a blank reason on a confirmation is none.
    action === 'confirm' && !reason.trim() ? {} : { reason },
  );
}
