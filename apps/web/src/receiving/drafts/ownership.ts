import {
  receiptDraftDeleteForbiddenSchema,
  receiptDraftOwnershipListSchema,
  receiptDraftOwnershipSchema,
  type PersonSnapshot,
  type ReceiptDraftDeleteReason,
  type ReceiptDraftOwnership,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import type { StoredDraft } from './record';
import type { DraftStore } from './store';

// Draft ownership on the server (STRATA-108). Only metadata travels: the draft's ID and who is
// acting. The draft's contents never leave this browser. Registering is best effort (offline it
// is retried later); deleting always asks the server first, and the local copy goes only once
// the server has authorized and recorded it.

const REQUEST_OPTIONS = { reportUnauthenticated: false };

/** Registers a draft. Ownership on success, `refused` for another account's draft, else null. */
export async function registerDraft(
  draftId: string,
  personUserId?: string,
): Promise<ReceiptDraftOwnership | 'refused' | null> {
  try {
    const response = await apiFetch(
      '/api/receipt-drafts',
      {
        method: 'POST',
        body: JSON.stringify({ draftId, ...(personUserId ? { personUserId } : {}) }),
      },
      REQUEST_OPTIONS,
    );
    if (response.status === 409) return 'refused';
    if (!response.ok) return null;
    const parsed = receiptDraftOwnershipSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Ownership of each draft for the current actor, or null when the server can't be asked. */
export async function fetchDraftOwnership(
  draftIds: readonly string[],
  personUserId?: string | null,
): Promise<Map<string, ReceiptDraftOwnership> | null> {
  if (draftIds.length === 0) return new Map();
  const params = new URLSearchParams({ ids: draftIds.join(',') });
  if (personUserId) params.set('personUserId', personUserId);
  try {
    const response = await apiFetch(`/api/receipt-drafts?${params}`, {}, REQUEST_OPTIONS);
    if (!response.ok) return null;
    const parsed = receiptDraftOwnershipListSchema.safeParse(
      await response.json().catch(() => null),
    );
    return parsed.success ? new Map(parsed.data.items.map((item) => [item.draftId, item])) : null;
  } catch {
    return null;
  }
}

/**
 * Tells the server that automatic clean-up (MM-T45) deleted this registered draft, so it is no
 * longer counted as open (migration 0049). Best effort: true when the server answered, false on
 * any failure, never throws.
 */
export async function closeExpiredDraft(draftId: string): Promise<boolean> {
  try {
    const response = await apiFetch(
      `/api/receipt-drafts/${encodeURIComponent(draftId)}/close`,
      { method: 'POST', body: JSON.stringify({ reason: 'expired' }) },
      REQUEST_OPTIONS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

export type DraftDeleteProblem = 'refused' | 'offline' | 'failed';

export class DraftDeleteError extends Error {
  constructor(
    readonly problem: DraftDeleteProblem,
    message: string,
    readonly reason: ReceiptDraftDeleteReason | null = null,
    readonly starter: PersonSnapshot | null = null,
  ) {
    super(message);
    this.name = 'DraftDeleteError';
  }
}

const DELETE_MESSAGES: Record<DraftDeleteProblem, string> = {
  refused: 'Only the person who started this draft or a Lab Manager can delete it.',
  offline: "Material Mule couldn't be reached. Deleting a draft needs a connection; try again.",
  failed: "The draft couldn't be deleted. Try again.",
};

/** Asks the server to authorize and record the deletion. Throws DraftDeleteError when it won't. */
export async function authorizeDraftDelete(draftId: string, personUserId?: string | null) {
  let response: Response;
  try {
    response = await apiFetch(
      `/api/receipt-drafts/${encodeURIComponent(draftId)}/delete`,
      { method: 'POST', body: JSON.stringify(personUserId ? { personUserId } : {}) },
      REQUEST_OPTIONS,
    );
  } catch {
    throw new DraftDeleteError('offline', DELETE_MESSAGES.offline);
  }
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => null);
  const refused = receiptDraftDeleteForbiddenSchema.safeParse(body);
  if (refused.success) {
    const { reason, starter } = refused.data;
    const message =
      reason === 'pick_person'
        ? 'Choose who is working at this station, then delete the draft.'
        : starter
          ? `Only ${starter.name} or a Lab Manager can delete this draft.`
          : 'Only a Lab Manager can delete this draft.';
    throw new DraftDeleteError('refused', message, reason, starter);
  }
  throw new DraftDeleteError('failed', DELETE_MESSAGES.failed);
}

/**
 * Deletes a draft the way a person does (STRATA-108): the server authorizes and records it
 * first, and only then is the local copy removed. Automatic clean-up (MM-T45) is an admin policy
 * and removes drafts directly instead.
 */
export async function deleteDraft(
  store: DraftStore,
  record: Pick<StoredDraft, 'draftId'>,
  personUserId?: string | null,
): Promise<void> {
  await authorizeDraftDelete(record.draftId, personUserId);
  await store.remove(record.draftId);
}

/**
 * Registers drafts listed here that are still unregistered (offline at their first save). A LAB
 * draft is registered only with the starter it already recorded; legacy drafts never are.
 */
export async function registerPendingDrafts(
  store: DraftStore,
  drafts: readonly StoredDraft[],
): Promise<void> {
  for (const draft of drafts) {
    if (draft.legacy || draft.registeredAt) continue;
    const lab = draft.owner.type === 'lab';
    if (lab && !draft.starter) continue;
    const result = await registerDraft(draft.draftId, lab ? draft.starter!.userId : undefined);
    if (!result || result === 'refused') continue;
    try {
      // Read again just before writing, so a save made meanwhile in another tab is kept.
      const current = await store.get(draft.draftId);
      if (current && !current.registeredAt) {
        await store.put({
          ...current,
          starter: result.starter ?? current.starter,
          registeredAt: new Date().toISOString(),
        });
      }
    } catch {
      // Storage refused: it is registered on the server; the flag is retried next time.
    }
  }
}

export type DraftOwnershipState =
  | { state: 'loading' }
  | { state: 'ready'; byId: Map<string, ReceiptDraftOwnership> }
  /** The server couldn't be asked (offline): Delete is offered and the server decides. */
  | { state: 'unavailable' };

/** Ownership of the listed drafts for the current actor; re-read when the list or pick changes. */
export function useDraftOwnership(
  drafts: readonly StoredDraft[] | null,
  personUserId: string | null,
): DraftOwnershipState {
  const key = drafts ? drafts.map((d) => d.draftId).join(',') : null;
  const [loaded, setLoaded] = useState<{ key: string; value: DraftOwnershipState } | null>(null);
  const requestKey = key === null ? null : `${key}|${personUserId ?? ''}`;
  useEffect(() => {
    if (requestKey === null || key === null) return;
    let current = true;
    void fetchDraftOwnership(key ? key.split(',') : [], personUserId).then((byId) => {
      if (current) {
        setLoaded({
          key: requestKey,
          value: byId ? { state: 'ready', byId } : { state: 'unavailable' },
        });
      }
    });
    return () => {
      current = false;
    };
  }, [requestKey, key, personUserId]);
  if (requestKey === null || loaded?.key !== requestKey) return { state: 'loading' };
  return loaded.value;
}

/**
 * Whether Delete draft is offered, and the ownership behind it. It waits while ownership loads;
 * when the server can't be asked it stays available, and the server decides on the request.
 */
export function deleteAvailability(
  ownership: DraftOwnershipState,
  draftId: string,
): { allowed: boolean; ownership: ReceiptDraftOwnership | null } {
  if (ownership.state !== 'ready')
    return { allowed: ownership.state === 'unavailable', ownership: null };
  const item = ownership.byId.get(draftId) ?? null;
  return { allowed: item?.canDelete ?? false, ownership: item };
}
