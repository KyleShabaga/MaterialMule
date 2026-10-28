import {
  projectRetentionSchema,
  storageUnitRetentionSchema,
  type ProjectRetention,
  type StorageUnitRetention,
} from '@materialmule/shared';
import { announceActionRequestsChanged } from '../action-requests/api';
import { apiFetch } from '../api/client';

export async function fetchUnitRetention(id: string): Promise<StorageUnitRetention | null> {
  const response = await apiFetch(`/api/storage-units/${encodeURIComponent(id)}/retention`);
  if (!response.ok) return null;
  return storageUnitRetentionSchema.parse(await response.json());
}

export async function fetchProjectRetention(id: string): Promise<ProjectRetention | null> {
  const response = await apiFetch(`/api/projects/${id}/retention`);
  if (!response.ok) return null;
  return projectRetentionSchema.parse(await response.json());
}

const MESSAGES: Record<string, string> = {
  forbidden: 'You can’t change retention for this project. Send a request instead.',
  stale_retention: 'Someone changed this meanwhile. The latest is shown; check it and try again.',
  already_released: 'This was already released. The latest is shown.',
  request_decided: 'This request was already decided. The latest is shown.',
  unit_not_in_project: 'A chosen unit isn’t in this project.',
  storage_unit_disposed: 'A chosen unit is already disposed.',
  validation_failed:
    'Check the form: a reason is required, and an extension needs a date or months.',
};

export type MutationOutcome = { ok: true } | { ok: false; message: string };

/** POSTs a retention change; returns a plain-language message on refusal. */
export async function postRetention(path: string, body: unknown): Promise<MutationOutcome> {
  try {
    const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
    if (response.ok) {
      announceActionRequestsChanged();
      return { ok: true };
    }
    const problem = (await response.json().catch(() => ({}))) as { code?: string };
    return { ok: false, message: MESSAGES[problem.code ?? ''] ?? 'That didn’t work. Try again.' };
  } catch {
    return { ok: false, message: 'Material Mule couldn’t be reached. Try again.' };
  }
}
