import type { InboxItem } from '@materialmule/shared';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { notifyError, notifySuccess } from '../components/strata/toast';
import { usePageTitle } from '../layout/page-title';
import { LoadErrorAlert } from '../projects/project-ui';
import { useMe } from '../session/context';
import { useRecordingPerson } from '../session/recording-person';
import { usePersonPreferences } from '../settings/account/preferences-api';
import { findInboxItem, markItemRead, markRequest, seenInboxItem, updateAction } from './inbox-api';
import { INBOX_PATH } from './inbox-model';
import { InboxItemDetail, type InboxItemActions } from './InboxItemDetail';
import { StationInbox } from './station-inbox/StationInbox';

// One Inbox item as a full page (`/inbox/:key`): Open as full page from the drawer, and every
// item on screens under 1024 px, where there is no drawer. Same body and rules as the drawer:
// opening marks it read; nothing here resolves a request.

type Load =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'error' }
  | { state: 'ready'; item: InboxItem };

export function InboxItemPage() {
  const { isStation } = useRecordingPerson();
  if (isStation) return <StationInbox />;
  return <PersonalInboxItem />;
}

function PersonalInboxItem() {
  const me = useMe();
  const { key = '' } = useParams();
  const location = useLocation();
  const prefs = usePersonPreferences();
  const passed = (location.state as { item?: InboxItem | null } | null)?.item ?? null;
  const known = passed?.key === key ? passed : seenInboxItem(me.id, key);
  const [load, setLoad] = useState<Load>(
    known ? { state: 'ready', item: known } : { state: 'loading' },
  );
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => new Date());
  const titleId = useId();
  const marked = useRef<string | null>(null);

  useEffect(() => {
    if (known) return;
    let active = true;
    findInboxItem(key).then(
      (item) => {
        if (active) setLoad(item ? { state: 'ready', item } : { state: 'missing' });
      },
      () => {
        if (active) setLoad({ state: 'error' });
      },
    );
    return () => {
      active = false;
    };
    // `known` comes from the key and the router state; looking again on each try is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tries]);

  const item = load.state === 'ready' ? load.item : null;
  usePageTitle(item?.title ?? null);

  // Opening marks it read, once.
  useEffect(() => {
    if (!item || !item.unread || marked.current === item.key) return;
    marked.current = item.key;
    void markItemRead(item).then((ok) => {
      if (ok) setLoad({ state: 'ready', item: { ...item, unread: false } });
    });
  }, [item]);

  const set = (change: Partial<InboxItem>) =>
    setLoad((current) =>
      current.state === 'ready'
        ? { state: 'ready', item: { ...current.item, ...change } as InboxItem }
        : current,
    );

  const act = async (work: () => Promise<boolean>, failed: string, done: () => void) => {
    setBusy(true);
    const ok = await work();
    setBusy(false);
    if (ok) done();
    else notifyError(failed, 'Check the connection and try again.');
  };

  let actions: InboxItemActions = { busy };
  if (item?.type === 'request') {
    actions = {
      busy,
      onMarkUnread: () =>
        void act(
          async () => (await markRequest(item.sourceId, false)) !== null,
          'It wasn’t marked unread.',
          () => {
            set({ unread: true });
            notifySuccess('Marked unread');
          },
        ),
    };
  } else if (item?.type === 'update') {
    actions = {
      busy,
      onDismiss: () =>
        void act(
          () => updateAction(item.sourceId, 'dismiss'),
          'It wasn’t dismissed.',
          () => {
            set({ dismissed: true, unread: false });
            notifySuccess('Dismissed');
          },
        ),
      onRestore: () =>
        void act(
          () => updateAction(item.sourceId, 'restore'),
          'It wasn’t restored.',
          () => {
            set({ dismissed: false });
            notifySuccess('Restored');
          },
        ),
    };
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
      <h1 className="sr-only">Inbox</h1>
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to={INBOX_PATH}>
            <ArrowLeft aria-hidden="true" />
            Inbox
          </Link>
        </Button>
      </div>
      {load.state === 'loading' ? (
        <p className="p-5 text-sm text-muted-foreground">Loading…</p>
      ) : null}
      {load.state === 'missing' ? (
        <p className="p-5 text-sm text-muted-foreground">
          This item isn’t in your Inbox any more. Inbox keeps 90 days.
        </p>
      ) : null}
      {load.state === 'error' ? (
        <LoadErrorAlert
          title="This item couldn’t load"
          message="Check the connection and try again."
          onRetry={() => {
            setLoad({ state: 'loading' });
            setTries((n) => n + 1);
          }}
        />
      ) : null}
      {item ? (
        <section aria-labelledby={titleId} className="rounded-xl border bg-card">
          <InboxItemDetail
            item={item}
            titleId={titleId}
            now={now}
            dateFormat={prefs.preferences.dateFormat}
            actions={actions}
          />
        </section>
      ) : null}
    </div>
  );
}
