import {
  messagesByField,
  projectConflictResponseSchema,
  projectDetailSchema,
  projectListPageSchema,
  projectVersionConflictResponseSchema,
  validationErrorResponseSchema,
  type ProjectDetail,
  type ProjectListPage,
  type ProjectSummary,
  type UpdateProjectRequest,
} from '@trapezoid/shared';
import { apiFetch } from '../api/client';

// Projects list, detail and edit (TRP-T35). Every call resolves; failures carry a readable message.

export type LoadResult<T> =
  { ok: true; data: T } | { ok: false; notFound: boolean; message: string };

const UNREACHABLE = "Trapezoid couldn't be reached. Check the connection.";

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
          : `Request failed (HTTP ${response.status}).`;
    return { ok: false, notFound: response.status === 404, message };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, notFound: false, message: 'Trapezoid returned an unexpected response.' };
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
    return { kind: 'failed', message: UNREACHABLE };
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
  return { kind: 'failed', message: `Saving failed (HTTP ${response.status}).` };
}
