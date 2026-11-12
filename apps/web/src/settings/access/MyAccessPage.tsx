import type { AccessSummary } from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { ErrorState } from '../../components/app-ui';
import { useMe } from '../../session/context';
import { StaffApiError } from '../staff/api';
import { SettingsHead, SettingsSub } from '../SettingsHead';
import { GLOBAL_ABILITIES } from './abilities';
import { AccessSummaryView } from './AccessSummaryView';
import { YesNoList } from './YesNoList';
import { fetchMyAccess } from './api';

type State =
  | { state: 'loading' }
  | { state: 'error'; message: string; lab: boolean }
  | { state: 'ready'; data: AccessSummary };

/**
 * Settings → My access (MM-AO06): the signed-in person's own current roles, grants and project
 * responsibilities with their sources. Always one's own (the server reads the session, not an
 * ID). Refreshes when the window regains focus, so a grant or revocation made meanwhile shows.
 */
export function MyAccessPage() {
  const me = useMe();
  // MTR-2: LAB has no personal access, so don't ask the server for it.
  if (me.accountType === 'shared_lab') {
    return (
      <section aria-labelledby="my-access-heading" className="my-access">
        <SettingsHead id="my-access-heading" title="My access" />
        <p className="empty-state">{LAB_TEXT}</p>
      </section>
    );
  }
  return <MyAccess />;
}

const LAB_TEXT =
  'My access is for personal accounts. The shared LAB account has no personal access; sign in with your own account to see yours.';

function MyAccess() {
  const me = useMe();
  const [page, setPage] = useState<State>({ state: 'loading' });
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let current = true;
    fetchMyAccess().then(
      (data) => current && setPage({ state: 'ready', data }),
      (error: unknown) =>
        current &&
        setPage({
          state: 'error',
          lab: error instanceof StaffApiError && error.forbidden,
          message:
            error instanceof StaffApiError
              ? error.message
              : "Material Mule couldn't be reached. Check the connection.",
        }),
    );
    return () => {
      current = false;
    };
  }, [reloads]);

  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);

  return (
    <section aria-labelledby="my-access-heading" className="my-access">
      <SettingsHead
        id="my-access-heading"
        title="My access"
        who="What your account can do, and where. Read-only; an administrator changes it."
        actions={
          <button type="button" onClick={reload}>
            Refresh
          </button>
        }
      />
      <p className="field-hint">
        What you can do and why: your roles, what an administrator has granted you, and your part in
        each project. Everyone can see all projects; this lists only where you have a role.
      </p>
      <SettingsSub title="What you can do" meta="From your roles and grants" />
      <YesNoList
        label="What you can do"
        items={GLOBAL_ABILITIES.map((ability) => ({
          key: ability.permission,
          yes: me.permissions.includes(ability.permission),
          what: ability.what,
          note: ability.note,
        }))}
      />
      <p className="settings-foot">
        Concrete authority is always per project. Being an administrator or a Lab Manager does not
        give it by itself.
      </p>
      {page.state === 'loading' ? <p role="status">Loading…</p> : null}
      {page.state === 'error' ? (
        page.lab ? (
          <p className="empty-state">{LAB_TEXT}</p>
        ) : (
          <ErrorState message={page.message} onRetry={reload} />
        )
      ) : null}
      {page.state === 'ready' ? <AccessSummaryView summary={page.data} headingLevel={3} /> : null}
    </section>
  );
}
