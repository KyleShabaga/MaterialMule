import {
  draftSettingsSchema,
  draftSettingsVersionConflictResponseSchema,
  validationErrorResponseSchema,
  type DraftSettings,
  type FieldError,
  type PutDraftSettingsRequest,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// Draft auto-delete setting (MM-T45). Every call resolves; failures carry a readable message.

export const DRAFT_SETTINGS_PATH = '/api/settings/drafts';

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";

export type LoadResult = { ok: true; data: DraftSettings } | { ok: false; message: string };

export type SaveResult =
  | { ok: true; data: DraftSettings }
  | { ok: false; kind: 'conflict'; current: DraftSettings; message: string }
  | { ok: false; kind: 'invalid'; errors: FieldError[]; message: string }
  | { ok: false; kind: 'failed'; message: string };

/**
 * Reads the setting. Receiving calls it with `reportUnauthenticated: false`: a station whose
 * session ended keeps its drafts (nothing is deleted) and isn't sent to sign-in from here.
 */
export async function fetchDraftSettings(
  options: { reportUnauthenticated?: boolean } = {},
): Promise<LoadResult> {
  let response: Response;
  try {
    response = await apiFetch(DRAFT_SETTINGS_PATH, {}, options);
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (!response.ok) {
    return { ok: false, message: "The setting couldn't load. Try again." };
  }
  const parsed = draftSettingsSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, message: 'Material Mule returned an unexpected response.' };
}

export async function saveDraftSettings(request: PutDraftSettingsRequest): Promise<SaveResult> {
  let response: Response;
  try {
    response = await apiFetch(DRAFT_SETTINGS_PATH, {
      method: 'PUT',
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, kind: 'failed', message: UNREACHABLE };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = draftSettingsSchema.safeParse(body);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, kind: 'failed', message: 'Material Mule returned an unexpected response.' };
  }
  if (response.status === 409) {
    const conflict = draftSettingsVersionConflictResponseSchema.safeParse(body);
    if (conflict.success) {
      return {
        ok: false,
        kind: 'conflict',
        current: conflict.data.current,
        message:
          'Someone else changed this setting while you were editing. The current setting is shown; make your change again.',
      };
    }
  }
  if (response.status === 400) {
    const invalid = validationErrorResponseSchema.safeParse(body);
    if (invalid.success) {
      return {
        ok: false,
        kind: 'invalid',
        errors: invalid.data.errors,
        message: 'Check the highlighted field.',
      };
    }
  }
  return {
    ok: false,
    kind: 'failed',
    message:
      response.status === 403
        ? 'Only Lab Managers and administrators can change this.'
        : "The setting wasn't saved. Try again.",
  };
}
