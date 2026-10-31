import {
  projectCapabilitiesSchema,
  projectGrantReviewsSchema,
  projectTeamJoinRequestsSchema,
  projectPeopleSchema,
  projectReportIssuersSchema,
  projectReviewersSchema,
  projectTeamSchema,
  receiverListResponseSchema,
  reviewScopesSchema,
  type FieldError,
  type GrantReportIssuerRequest,
  type ProjectCapabilities,
  type ProjectGrantReviews,
  type ProjectTeamJoinRequests,
  type ProjectPeople,
  type ProjectReportIssuers,
  type ProjectReviewers,
  type ProjectTeam,
  type ReceiverOption,
  type RevocationKind,
  type ReviewScope,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';
import type { LoadResult } from './api';

// Team & Permissions (MM-AO05) calls on the MM-AO03 project-access API. Reads resolve to a
// LoadResult; writes to a WriteOutcome so the screen keeps the person's input when the server
// refuses, and refreshes its capabilities when the refusal says authority changed.

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";

type Schema<T> = { safeParse(data: unknown): { success: true; data: T } | { success: false } };

async function load<T>(path: string, schema: Schema<T>): Promise<LoadResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    return { ok: false, notFound: false, message: UNREACHABLE };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      notFound: response.status === 404,
      message:
        response.status === 404
          ? 'Project not found.'
          : response.status === 403
            ? "You don't have permission to see this."
            : 'Material Mule had a problem loading this. Try again.',
    };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, notFound: false, message: 'Material Mule returned an unexpected response.' };
}

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** `forbidden`: the server says this person may no longer do it; reload capabilities. */
      kind: 'forbidden' | 'conflict' | 'invalid' | 'not_found' | 'network' | 'error';
      message: string;
      errors: FieldError[];
    };

/** Server error codes in words. Unlisted codes fall back to the field messages. */
const MESSAGES: Record<string, string> = {
  already_assigned: 'They’re already active here. The list now shows the current state.',
  idempotency_key_reused: 'That was already sent. The list now shows the current state.',
  invalid_recipient: 'Choose an active staff member.',
  not_eligible: 'This person isn’t an eligible reviewer for that scope.',
  invalid_scope: 'Choose a review scope.',
  invalid_expiry: 'Expiry must be in the future.',
  grant_review_decided: 'That grant was already reviewed. The list now shows the current state.',
  team_join_request_decided:
    'That request was already decided. The list now shows the current state.',
};

async function write<T>(
  path: string,
  method: 'POST' | 'DELETE',
  body: unknown,
  schema: Schema<T>,
): Promise<WriteOutcome<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, { method, body: JSON.stringify(body) });
  } catch {
    return {
      ok: false,
      kind: 'network',
      message: `${UNREACHABLE} Your entries are kept; reload to see whether it was saved.`,
      errors: [],
    };
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
    return {
      ok: false,
      kind: 'error',
      message: 'Material Mule returned an unexpected response.',
      errors: [],
    };
  }
  const code = typeof json?.code === 'string' ? json.code : '';
  const errors = Array.isArray(json?.errors) ? (json.errors as FieldError[]) : [];
  const fallback = errors.map((error) => error.message).join(' ');
  if (response.status === 403) {
    return {
      ok: false,
      kind: 'forbidden',
      message:
        'You can no longer make this change here. Nothing was saved; the page now shows what you can do.',
      errors: [],
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      kind: 'not_found',
      message: 'That record is no longer there. The page now shows the current state.',
      errors: [],
    };
  }
  if (response.status === 409) {
    return {
      ok: false,
      kind: 'conflict',
      message: MESSAGES[code] ?? 'Someone else changed this first. The page now shows it.',
      errors,
    };
  }
  if (response.status === 400 || response.status === 422) {
    return {
      ok: false,
      kind: 'invalid',
      message: MESSAGES[code] ?? (fallback || 'Check the details.'),
      errors,
    };
  }
  return { ok: false, kind: 'error', message: 'Nothing was saved. Try again.', errors: [] };
}

const projectPath = (projectId: string, rest: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/${rest}`;

export const fetchCapabilities = (projectId: string): Promise<LoadResult<ProjectCapabilities>> =>
  load(projectPath(projectId, 'capabilities'), projectCapabilitiesSchema);

/** MTR-21: each person on the project with job title and permissions here. */
export const fetchPeople = (projectId: string): Promise<LoadResult<ProjectPeople>> =>
  load(projectPath(projectId, 'people'), projectPeopleSchema);

export const fetchScopes = (): Promise<LoadResult<ReviewScope[]>> =>
  load('/api/review-scopes', reviewScopesSchema);

/** People with active eligibility for a scope, narrowed by initials or name. */
export async function fetchEligibleReviewers(
  scopeCode: string,
  search = '',
): Promise<LoadResult<ReceiverOption[]>> {
  const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  return load(
    `/api/review-scopes/${encodeURIComponent(scopeCode)}/eligible-reviewers${query}`,
    receiverListResponseSchema,
  );
}

// Project team (D04)

export const fetchTeam = (projectId: string): Promise<LoadResult<ProjectTeam>> =>
  load(projectPath(projectId, 'team-members'), projectTeamSchema);

export const addTeamMember = (
  projectId: string,
  body: { userId: string; reason: string; idempotencyKey: string },
) => write(projectPath(projectId, 'team-members'), 'POST', body, projectTeamSchema);

export const removeTeamMember = (projectId: string, id: string, reason: string) =>
  write(
    projectPath(projectId, `team-members/${encodeURIComponent(id)}`),
    'DELETE',
    { reason },
    projectTeamSchema,
  );

// Scoped reviewers (D04/D05)

export const fetchReviewers = (projectId: string): Promise<LoadResult<ProjectReviewers>> =>
  load(projectPath(projectId, 'reviewer-assignments'), projectReviewersSchema);

export const assignReviewer = (
  projectId: string,
  body: { reviewerUserId: string; scopeCode: string; reason: string; idempotencyKey: string },
) => write(projectPath(projectId, 'reviewer-assignments'), 'POST', body, projectReviewersSchema);

export const removeReviewer = (projectId: string, id: string, reason: string) =>
  write(
    projectPath(projectId, `reviewer-assignments/${encodeURIComponent(id)}`),
    'DELETE',
    { reason },
    projectReviewersSchema,
  );

/** MISC-08: the project's Lead Project Engineer approves an assigned reviewer to review. */
export const approveReviewer = (projectId: string, id: string, idempotencyKey: string) =>
  write(
    projectPath(projectId, `reviewer-assignments/${encodeURIComponent(id)}/approval`),
    'POST',
    { idempotencyKey },
    projectReviewersSchema,
  );

export const withdrawApproval = (projectId: string, id: string, reason: string) =>
  write(
    projectPath(projectId, `review-approvals/${encodeURIComponent(id)}`),
    'DELETE',
    { reason },
    projectReviewersSchema,
  );

// Authorized report issuers (D06/D07)

export const fetchIssuers = (projectId: string): Promise<LoadResult<ProjectReportIssuers>> =>
  load(projectPath(projectId, 'report-issuers'), projectReportIssuersSchema);

export const grantIssuer = (projectId: string, body: GrantReportIssuerRequest) =>
  write(projectPath(projectId, 'report-issuers'), 'POST', body, projectReportIssuersSchema);

export const revokeIssuer = (
  projectId: string,
  id: string,
  body: { reason: string; kind: RevocationKind },
) =>
  write(
    projectPath(projectId, `report-issuers/${encodeURIComponent(id)}`),
    'DELETE',
    body,
    projectReportIssuersSchema,
  );

// Inherited grants after a lead change (MTR-25)

export const fetchGrantReviews = (projectId: string): Promise<LoadResult<ProjectGrantReviews>> =>
  load(projectPath(projectId, 'grant-reviews'), projectGrantReviewsSchema);

export const decideGrantReview = (
  projectId: string,
  id: string,
  action: 'keep' | 'revoke',
  reason: string,
) =>
  write(
    projectPath(projectId, `grant-reviews/${encodeURIComponent(id)}/${action}`),
    'POST',
    { reason },
    projectGrantReviewsSchema,
  );

// Team self-join with lead acceptance (MISC-07)

export const fetchJoinRequests = (
  projectId: string,
): Promise<LoadResult<ProjectTeamJoinRequests>> =>
  load(projectPath(projectId, 'team-join-requests'), projectTeamJoinRequestsSchema);

export const requestToJoin = (projectId: string, idempotencyKey: string) =>
  write(
    projectPath(projectId, 'team-join-requests'),
    'POST',
    { idempotencyKey },
    projectTeamJoinRequestsSchema,
  );

export const decideJoinRequest = (
  projectId: string,
  id: string,
  action: 'accept' | 'decline',
  reason?: string,
) =>
  write(
    projectPath(projectId, `team-join-requests/${encodeURIComponent(id)}/${action}`),
    'POST',
    reason ? { reason } : {},
    projectTeamJoinRequestsSchema,
  );
