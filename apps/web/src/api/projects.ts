import {
  bulkGroupListSchema,
  projectConflictResponseSchema,
  projectSearchResponseSchema,
  projectSummarySchema,
  staffOptionsResponseSchema,
  testHoleConflictResponseSchema,
  testHoleListResponseSchema,
  testHoleSchema,
  validationErrorResponseSchema,
  messagesByField,
  staffGrantsSchema,
  type StaffGrants,
  type BulkGroupSummary,
  type CreateProjectRequest,
  type CreateTestHoleRequest,
  type ProjectSummary,
  type StaffOption,
  type TestHole,
} from '@materialmule/shared';
import { apiFetch } from './client';

// Project and test-hole lookup and creation for receiving (MM-T08).

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function getJson<T>(path: string, parse: (body: unknown) => T): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  return parse(await response.json());
}

export function searchProjects(query: string): Promise<ProjectSummary[]> {
  return getJson(`/api/projects/search?q=${encodeURIComponent(query)}&limit=10`, (body) =>
    projectSearchResponseSchema.parse(body),
  );
}

export function listActiveStaff(): Promise<StaffOption[]> {
  return getJson('/api/staff/active', (body) => staffOptionsResponseSchema.parse(body));
}

export function listTestHoles(projectId: string, query = ''): Promise<TestHole[]> {
  return getJson(
    `/api/projects/${encodeURIComponent(projectId)}/test-holes?q=${encodeURIComponent(query)}`,
    (body) => testHoleListResponseSchema.parse(body),
  );
}

/** A project's bulk samples, for the receiving picker and the correction form (MM-T36). */
export function listBulkGroups(projectId: string): Promise<BulkGroupSummary[]> {
  return getJson(`/api/projects/${encodeURIComponent(projectId)}/bulk-groups`, (body) =>
    bulkGroupListSchema.parse(body),
  );
}

/** Outcome of a create: the new record, the existing one (409), or field errors (400). */
export type CreateResult<T> =
  | { kind: 'created'; record: T }
  | { kind: 'exists'; existing: T }
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> };

async function postCreate<T>(
  path: string,
  body: unknown,
  parseRecord: (body: unknown) => T,
  parseExisting: (body: unknown) => T,
): Promise<CreateResult<T>> {
  const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (response.status === 201) {
    return { kind: 'created', record: parseRecord(await response.json()) };
  }
  if (response.status === 409) {
    return { kind: 'exists', existing: parseExisting(await response.json()) };
  }
  if (response.status === 400) {
    const parsed = validationErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return { kind: 'invalid', fieldErrors: messagesByField(parsed.data.errors) };
    }
  }
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null;
    // MM-AO04: leading a new project yourself needs "Can create and lead projects".
    if (body?.code === 'self_appointment_not_permitted') {
      return {
        kind: 'invalid',
        fieldErrors: {
          appointSelfAsLead: [
            'You don’t hold “Can create and lead projects”. Nominate a lead instead, or leave it for an admin.',
          ],
        },
      };
    }
  }
  throw new ApiError(response.status);
}

/** The signed-in person's own grants (MM-AO03), e.g. "Can create and lead projects". */
export function fetchMyGrants(): Promise<StaffGrants> {
  return getJson('/api/me/grants', (body) => staffGrantsSchema.parse(body));
}

export function createProject(input: CreateProjectRequest): Promise<CreateResult<ProjectSummary>> {
  return postCreate(
    '/api/projects',
    input,
    (body) => projectSummarySchema.parse(body),
    (body) => projectConflictResponseSchema.parse(body).existing,
  );
}

export function createTestHole(
  projectId: string,
  input: CreateTestHoleRequest,
): Promise<CreateResult<TestHole>> {
  return postCreate(
    `/api/projects/${encodeURIComponent(projectId)}/test-holes`,
    input,
    (body) => testHoleSchema.parse(body),
    (body) => testHoleConflictResponseSchema.parse(body).existing,
  );
}
