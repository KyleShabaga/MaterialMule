import {
  staffListResponseSchema,
  staffMemberSchema,
  type PreprovisionStaffRequest,
  type StaffMember,
  type StaffRole,
  type StaffStatus,
  type UpdateStaffRequest,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

/** A failed staff API call with a message fit to show the admin. */
export class StaffApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    /** HTTP status; 403 means the caller is no longer an administrator (MM-T52). */
    readonly status: number | null = null,
  ) {
    super(message);
  }

  get forbidden(): boolean {
    return this.status === 403;
  }
}

async function readError(response: Response): Promise<StaffApiError> {
  let body: { code?: string; message?: string; issues?: { message: string }[] } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Not JSON: fall through to the generic message.
  }
  const message =
    body.issues?.[0]?.message ??
    (typeof body.message === 'string' ? body.message : null) ??
    (response.status === 403
      ? 'You no longer have permission to manage staff.'
      : "That change didn't go through. Try again.");
  return new StaffApiError(message, body.code ?? null, response.status);
}

async function send(path: string, method: string, body?: unknown): Promise<StaffMember> {
  const response = await apiFetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response);
  return staffMemberSchema.parse(await response.json());
}

export async function listStaff(filter: {
  search: string;
  status: StaffStatus | '';
}): Promise<StaffMember[]> {
  const params = new URLSearchParams();
  if (filter.search.trim()) params.set('search', filter.search.trim());
  if (filter.status) params.set('status', filter.status);
  const query = params.toString();
  const response = await apiFetch(`/api/staff${query ? `?${query}` : ''}`);
  if (!response.ok) throw await readError(response);
  return staffListResponseSchema.parse(await response.json());
}

export const staffApi = {
  preprovision: (body: PreprovisionStaffRequest) => send('/api/staff', 'POST', body),
  approve: (id: string) => send(`/api/staff/${id}/approve`, 'POST'),
  disable: (id: string, reason: string) => send(`/api/staff/${id}/disable`, 'POST', { reason }),
  enable: (id: string) => send(`/api/staff/${id}/enable`, 'POST'),
  setRoles: (id: string, roles: StaffRole[], reason?: string) =>
    send(`/api/staff/${id}/roles`, 'PUT', { roles, reason }),
  update: (id: string, body: UpdateStaffRequest) => send(`/api/staff/${id}`, 'PATCH', body),
};
