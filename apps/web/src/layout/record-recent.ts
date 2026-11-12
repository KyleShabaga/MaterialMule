import { sidebarRecordListSchema, type SidebarRecordKind } from '@materialmule/shared';
import { useContext, useEffect } from 'react';
import { apiFetch } from '../api/client';
import { RecordingPersonContext } from '../session/recording-person-store';
import { SessionContext } from '../session/context';
import { RECENTS_CHANGED_EVENT } from './sidebar-prefs';

// STRATA-40: the sidebar's Recent keeps the last records the person opened. A record page calls
// useRecordRecent once it has the record's UUID; the server checks access when Recent is read.

/**
 * Records that `id` (a record of `kind`) was opened, once per page and record. Personal accounts
 * only: never on the shared LAB account (a station shows no one's recents) and never for an
 * account without personal settings. Quiet when it fails: Recent is a convenience.
 */
export function useRecordRecent(kind: SidebarRecordKind, id: string | null | undefined): void {
  const session = useContext(SessionContext)?.session;
  const station = useContext(RecordingPersonContext)?.isStation ?? false;
  const me = session?.status === 'active' ? session.me : null;
  const allowed =
    me !== null &&
    !station &&
    me.accountType !== 'shared_lab' &&
    me.permissions.includes('personal_settings.manage');

  useEffect(() => {
    if (!allowed || !id) return;
    let active = true;
    void apiFetch('/api/me/recents', { method: 'POST', body: JSON.stringify({ kind, id }) })
      .then(async (response) => {
        if (!active || !response.ok) return;
        const list = sidebarRecordListSchema.safeParse(await response.json());
        if (!list.success) return;
        window.dispatchEvent(new CustomEvent(RECENTS_CHANGED_EVENT, { detail: list.data.items }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [allowed, kind, id]);
}
