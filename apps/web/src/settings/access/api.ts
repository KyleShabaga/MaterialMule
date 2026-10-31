import {
  accessSummarySchema,
  positionRulesSchema,
  reviewScopesSchema,
  staffGrantsSchema,
  type AccessSummary,
  type Position,
  type PositionRules,
  type ReviewScope,
  type StaffCapability,
  type StaffGrants,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';
import { StaffApiError } from '../staff/api';

// Access summaries and per-person grants (MM-AO06). Failures throw StaffApiError, whose
// `forbidden` (403) tells the screen the person's authority changed.

async function fail(response: Response): Promise<StaffApiError> {
  const body = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    errors?: { message: string }[];
  };
  const message =
    body.errors?.map((e) => e.message).join(' ') ||
    (typeof body.message === 'string' ? body.message : null) ||
    (response.status === 403
      ? "You don't have permission to do this."
      : response.status === 404
        ? 'Not found.'
        : "That didn't go through. Try again.");
  return new StaffApiError(message, body.code ?? null, response.status);
}

async function getJson<T>(path: string, parse: (body: unknown) => T): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw await fail(response);
  return parse(await response.json());
}

async function write(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<StaffGrants> {
  const response = await apiFetch(path, { method, body: JSON.stringify(body) });
  if (!response.ok) throw await fail(response);
  return staffGrantsSchema.parse(await response.json());
}

export const fetchMyAccess = (): Promise<AccessSummary> =>
  getJson('/api/me/access', (b) => accessSummarySchema.parse(b));

export const fetchStaffAccess = (id: string): Promise<AccessSummary> =>
  getJson(`/api/staff/${encodeURIComponent(id)}/access`, (b) => accessSummarySchema.parse(b));

export const fetchStaffGrants = (id: string): Promise<StaffGrants> =>
  getJson(`/api/staff/${encodeURIComponent(id)}/grants`, (b) => staffGrantsSchema.parse(b));

export const fetchReviewScopes = (): Promise<ReviewScope[]> =>
  getJson('/api/review-scopes', (b) => reviewScopesSchema.parse(b));

const staffPath = (id: string, rest: string) => `/api/staff/${encodeURIComponent(id)}/${rest}`;

export const grantsApi = {
  grantEligibility: (id: string, scopeCode: string, reason: string, idempotencyKey: string) =>
    write(staffPath(id, 'reviewer-eligibility'), 'POST', { scopeCode, reason, idempotencyKey }),
  revokeEligibility: (id: string, grantId: string, reason: string) =>
    write(staffPath(id, `reviewer-eligibility/${encodeURIComponent(grantId)}`), 'DELETE', {
      reason,
    }),
  grantCapability: (
    id: string,
    capability: StaffCapability,
    reason: string,
    idempotencyKey: string,
  ) => write(staffPath(id, 'capabilities'), 'POST', { capability, reason, idempotencyKey }),
  revokeCapability: (id: string, grantId: string, reason: string) =>
    write(staffPath(id, `capabilities/${encodeURIComponent(grantId)}`), 'DELETE', { reason }),
  // MISC-08: `scopeCode` null excludes them from every review scope.
  addExclusion: (id: string, scopeCode: string | null, reason: string, idempotencyKey: string) =>
    write(staffPath(id, 'reviewer-exclusions'), 'POST', { scopeCode, reason, idempotencyKey }),
  removeExclusion: (id: string, exclusionId: string, reason: string) =>
    write(staffPath(id, `reviewer-exclusions/${encodeURIComponent(exclusionId)}`), 'DELETE', {
      reason,
    }),
};

/** MISC-08: position-based review eligibility rules (admin). */
export const fetchPositionRules = (): Promise<PositionRules> =>
  getJson('/api/review-eligibility/position-rules', (b) => positionRulesSchema.parse(b));

async function writeRules(path: string, method: 'POST' | 'DELETE', body: unknown) {
  const response = await apiFetch(path, { method, body: JSON.stringify(body) });
  if (!response.ok) throw await fail(response);
  return positionRulesSchema.parse(await response.json());
}

export const rulesApi = {
  enable: (position: Position, scopeCode: string, reason: string, idempotencyKey: string) =>
    writeRules('/api/review-eligibility/position-rules', 'POST', {
      position,
      scopeCode,
      reason,
      idempotencyKey,
    }),
  disable: (id: string, reason: string) =>
    writeRules(`/api/review-eligibility/position-rules/${encodeURIComponent(id)}`, 'DELETE', {
      reason,
    }),
};
