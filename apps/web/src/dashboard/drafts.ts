import type { MeResponse } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { isStale, visibleTo, type StoredDraft } from '../receiving/drafts/record';
import { indexedDbDraftStore, toStorageError } from '../receiving/drafts/store';

// Receiving drafts stored in this browser (MM-T11), as the dashboard shows them: a count on the
// Receive samples card and the "Drafts on this computer" card. Only drafts this session may see
// (LAB drafts for LAB, personal drafts for their owner). Discarding stays on Receive samples.

export type DraftsState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; drafts: StoredDraft[] };

export function useDashboardDrafts(me: MeResponse): DraftsState {
  const [drafts, setDrafts] = useState<DraftsState>({ state: 'loading' });
  useEffect(() => {
    let active = true;
    indexedDbDraftStore.list().then(
      ({ drafts: all }) => {
        if (active) setDrafts({ state: 'ready', drafts: all.filter((d) => visibleTo(d, me)) });
      },
      (error: unknown) => {
        if (active) setDrafts({ state: 'error', message: toStorageError(error).message });
      },
    );
    return () => {
      active = false;
    };
  }, [me]);
  return drafts;
}

export function resumeDraftPath(record: StoredDraft): string {
  return `/receiving-log/new?draft=${encodeURIComponent(record.draftId)}`;
}

/** "2 drafts on this computer · 1 stale" */
export function draftCountText(drafts: StoredDraft[], now = new Date()): string {
  const stale = drafts.filter((d) => isStale(d, now)).length;
  const count = drafts.length === 1 ? '1 draft' : `${drafts.length} drafts`;
  return `${count} on this computer${stale > 0 ? ` · ${stale} stale` : ''}`;
}
