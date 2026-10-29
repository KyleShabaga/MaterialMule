import {
  actionRequestAssigneesSchema,
  actionRequestCountSchema,
  actionRequestListSchema,
  actionRequestSchema,
  notificationPreferencesSchema,
  type ActionRequest,
  type ActionRequestList,
  type ActionRequestScope,
  type NotificationPreferences,
  type PersonSnapshot,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

/** Fired after anything that may change the open count, so the header bell refreshes at once. */
export const ACTION_REQUESTS_CHANGED_EVENT = 'materialmule:action-requests-changed';

export function announceActionRequestsChanged(): void {
  window.dispatchEvent(new Event(ACTION_REQUESTS_CHANGED_EVENT));
}

export async function fetchOpenCount(): Promise<number | null> {
  const response = await apiFetch('/api/action-items/count');
  if (!response.ok) return null;
  return actionRequestCountSchema.parse(await response.json()).open;
}

export async function fetchActionRequests(
  status: 'open' | 'resolved',
  scope: ActionRequestScope,
): Promise<ActionRequestList> {
  const response = await apiFetch(`/api/action-items?status=${status}&scope=${scope}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return actionRequestListSchema.parse(await response.json());
}

export async function fetchAssignees(id: string): Promise<PersonSnapshot[]> {
  const response = await apiFetch(`/api/action-items/${id}/assignees`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return actionRequestAssigneesSchema.parse(await response.json()).people;
}

export type ReassignOutcome = { ok: true; item: ActionRequest } | { ok: false; message: string };

const REASSIGN_ERRORS: Record<string, string> = {
  action_item_resolved: 'This request was resolved meanwhile. Refresh to see who resolved it.',
  recipient_cannot_reassign: 'You can’t pass on a request that is yours to decide.',
  assignee_not_eligible: 'That person can’t act on this request.',
  already_assigned: 'It is already assigned to that person.',
};

export async function reassign(
  id: string,
  toUserId: string,
  reason: string,
  idempotencyKey: string,
): Promise<ReassignOutcome> {
  try {
    const response = await apiFetch(`/api/action-items/${id}/reassign`, {
      method: 'POST',
      body: JSON.stringify({ toUserId, reason, idempotencyKey }),
    });
    if (response.ok) {
      return { ok: true, item: actionRequestSchema.parse(await response.json()) };
    }
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    return {
      ok: false,
      message: REASSIGN_ERRORS[body.code ?? ''] ?? 'The request couldn’t be reassigned.',
    };
  } catch {
    return { ok: false, message: 'Material Mule couldn’t be reached. Try again.' };
  }
}

/** Null when they can't be read (LAB, offline, or an unreadable answer); never throws. */
export async function fetchPreferences(): Promise<NotificationPreferences | null> {
  try {
    const response = await apiFetch('/api/me/notification-preferences');
    if (!response.ok) return null;
    return notificationPreferencesSchema.parse(await response.json());
  } catch {
    return null;
  }
}

export async function savePreferences(
  emailActionRequests: boolean,
  version: number,
): Promise<NotificationPreferences | 'stale' | 'error'> {
  try {
    const response = await apiFetch('/api/me/notification-preferences', {
      method: 'PUT',
      body: JSON.stringify({ emailActionRequests, version }),
    });
    if (response.status === 409) return 'stale';
    if (!response.ok) return 'error';
    return notificationPreferencesSchema.parse(await response.json());
  } catch {
    return 'error';
  }
}
