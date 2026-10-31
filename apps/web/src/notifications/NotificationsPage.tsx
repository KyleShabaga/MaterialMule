import {
  ACTION_REQUEST_RESOLUTION_LABEL,
  type Notification,
  type NotificationFilter,
  type NotificationLinkedRequest,
} from '@materialmule/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, PageHeader, StatusBadge, type BadgeTone } from '../components/ui';
import { formatAge, formatExpiry } from '../lib/format';
import { useMe } from '../session/context';
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllRead,
  NOTIFICATIONS_CHANGED_EVENT,
  NotificationsForbiddenError,
  updateNotification,
  type NotificationAction,
} from './api';

/**
 * The rows loaded so far for one filter, newest first. `nextCursor` is where the next, older page
 * starts (null: nothing older matches); `more` is the state of loading that page.
 */
type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'forbidden' }
  | {
      state: 'ready';
      items: Notification[];
      nextCursor: string | null;
      more: 'idle' | 'loading' | 'error';
    };

const FILTER_LABEL: Record<NotificationFilter, string> = {
  active: 'Active',
  unread: 'Unread',
  all: 'All',
};

const EMPTY: Record<NotificationFilter, string> = {
  active: 'No notifications.',
  unread: 'You have read every notification.',
  all: 'No notifications in the last 90 days.',
};

const REFUSED = 'Notifications are for personal accounts. Sign in with your own account.';

/** What happened, as of when it happened. The live status of the request is shown separately. */
function eventText(item: Notification): string {
  return item.kind === 'action_request.opened'
    ? 'Sent to you for action'
    : 'Your request was decided';
}

/** The linked request's state now: never a stale "needs action". */
function linkedStatus(request: NotificationLinkedRequest): {
  text: string;
  tone: BadgeTone;
} {
  if (request.status === 'resolved') {
    const by = request.resolvedBy ? ` by ${request.resolvedBy.name}` : '';
    const how = request.resolution
      ? ` · ${ACTION_REQUEST_RESOLUTION_LABEL[request.resolution]}`
      : '';
    return { text: `Resolved${by}${how}`, tone: 'success' };
  }
  return request.stillYours
    ? { text: 'Pending — waiting on you', tone: 'warning' }
    : { text: 'No longer waiting on you', tone: 'neutral' };
}

function When({ iso, now }: { iso: string; now: number }) {
  const absolute = formatExpiry(iso);
  const seconds = (now - new Date(iso).getTime()) / 1000;
  const text = seconds >= 0 && seconds < 86_400 ? `${formatAge(seconds)} ago` : absolute;
  return (
    <time dateTime={iso} title={absolute}>
      {text}
    </time>
  );
}

/**
 * Notifications (MM-T91): what happened that concerns the signed-in person, with unread/read and
 * a dismiss that can be undone. A notification is not the work itself: reading, dismissing or
 * opening one never approves or resolves the linked action request, which only its real workflow
 * action does. Each row shows the request's current status, so a decided request never reads as
 * still waiting.
 */
export function NotificationsPage() {
  const me = useMe();
  // The shared LAB account has no notifications, so don't ask the server for any.
  if (!me.permissions.includes('notification.read')) {
    return (
      <div className="notifications-page">
        <PageHeader title="Notifications" />
        <EmptyState>{REFUSED}</EmptyState>
      </div>
    );
  }
  return <NotificationCenter />;
}

function NotificationCenter() {
  const [filter, setFilter] = useState<NotificationFilter>('active');
  // Relative times are measured from when the page opened ("5 min ago").
  const [now] = useState(() => Date.now());
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [message, setMessage] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // The server's unread count: "Mark all read" covers every unread notification, not only the
  // ones loaded so far, so it is enabled from this count rather than from the rows on screen.
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  // Bumped whenever the list starts over (filter change, retry, mark all read), so an answer to
  // an earlier request, first page or "Load more", is ignored instead of mixing two lists.
  const generation = useRef(0);
  // The list as last rendered, for decisions made after an await (see apply).
  const latest = useRef<Load>(load);
  useEffect(() => {
    latest.current = load;
  }, [load]);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const id = ++generation.current;
    fetchNotifications(filter)
      .then((list) => {
        if (id !== generation.current) return;
        setLoad({ state: 'ready', items: list.items, nextCursor: list.nextCursor, more: 'idle' });
      })
      .catch((error: unknown) => {
        if (id !== generation.current) return;
        setLoad({ state: error instanceof NotificationsForbiddenError ? 'forbidden' : 'error' });
      });
  }, [filter, tick]);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void fetchUnreadCount()
        .then((value) => {
          if (active) setUnreadTotal(value);
        })
        .catch(() => undefined);
    refresh();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    };
  }, []);

  /** The next, older page for the current list. A failure keeps the rows and offers a retry. */
  const loadMore = useCallback(
    (cursor: string) => {
      const id = generation.current;
      setLoad((current) => (current.state === 'ready' ? { ...current, more: 'loading' } : current));
      fetchNotifications(filter, cursor)
        .then((list) => {
          if (id !== generation.current) return;
          setLoad((current) => {
            if (current.state !== 'ready') return current;
            const seen = new Set(current.items.map((item) => item.id));
            return {
              state: 'ready',
              items: [...current.items, ...list.items.filter((item) => !seen.has(item.id))],
              nextCursor: list.nextCursor,
              more: 'idle',
            };
          });
        })
        .catch(() => {
          if (id !== generation.current) return;
          setLoad((current) =>
            current.state === 'ready' ? { ...current, more: 'error' } : current,
          );
        });
    },
    [filter],
  );

  /**
   * Applies a successful change to the rows on screen; rows the filter no longer shows go. When
   * that empties the list but older matching rows exist, it fetches them (refill) rather than
   * claiming there are none. The cursor still points after the last row loaded, so nothing older
   * is skipped.
   */
  const apply = (id: string, action: NotificationAction) => {
    const update = (current: Load): Load =>
      current.state !== 'ready'
        ? current
        : {
            ...current,
            items: current.items
              .map((item) => (item.id === id ? changed(item, action) : item))
              .filter((item) => shown(item, filter)),
          };
    // Two rows can finish close together, so update from the latest state, never this render's.
    const next = update(latest.current);
    setLoad(update);
    if (
      next.state === 'ready' &&
      next.items.length === 0 &&
      next.nextCursor !== null &&
      next.more !== 'loading'
    ) {
      loadMore(next.nextCursor);
    }
  };

  const announce = (text: string, moveFocus: boolean) => {
    setMessage(text);
    if (moveFocus) window.setTimeout(() => messageRef.current?.focus(), 0);
  };

  const unreadShown =
    load.state === 'ready' && load.items.some((item) => !item.readAt && !item.dismissedAt);
  const anyUnread = unreadShown || (unreadTotal ?? 0) > 0;

  async function readAll() {
    setBulkBusy(true);
    const unread = await markAllRead();
    setBulkBusy(false);
    if (unread === null) {
      announce('Notifications couldn’t be marked read. Try again.', false);
      return;
    }
    setUnreadTotal(unread);
    // Every unread notification changed, loaded or not: start the list over from the top.
    reload();
    announce('All notifications marked read.', filter === 'unread');
  }

  if (load.state === 'forbidden') {
    return (
      <div className="notifications-page">
        <PageHeader title="Notifications" />
        <EmptyState>{REFUSED}</EmptyState>
      </div>
    );
  }

  return (
    <div className="notifications-page">
      <PageHeader
        title="Notifications"
        actions={
          <button type="button" disabled={!anyUnread || bulkBusy} onClick={() => void readAll()}>
            Mark all read
          </button>
        }
      />
      <p className="field-hint">
        Notifications tell you what happened. Reading or dismissing one never approves or resolves
        anything: requests still waiting on you are under Pending actions, and are resolved only
        where the decision is made.
      </p>
      <div className="action-requests-filters" role="group" aria-label="Show">
        {(['active', 'unread', 'all'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            className={filter === value ? 'primary' : undefined}
            onClick={() => {
              if (filter === value) return;
              setLoad({ state: 'loading' });
              setMessage(null);
              setFilter(value);
            }}
          >
            {FILTER_LABEL[value]}
          </button>
        ))}
      </div>
      <p className="notifications-message" role="status" tabIndex={-1} ref={messageRef}>
        {message}
      </p>
      {load.state === 'loading' ? <p>Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message="Notifications couldn’t load." onRetry={reload} />
      ) : null}
      {load.state === 'ready' && load.items.length === 0 && load.nextCursor === null ? (
        <EmptyState>{EMPTY[filter]}</EmptyState>
      ) : null}
      {load.state === 'ready' && load.items.length > 0 ? (
        <ul className="action-request-list">
          {load.items.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              now={now}
              onChanged={(action, unread) => {
                if (unread !== null) apply(item.id, action);
                const gone = unread !== null && !shown(changed(item, action), filter);
                if (unread === null) {
                  announce('This notification couldn’t be updated. Try again.', false);
                } else if (action !== 'read' || gone) {
                  announce(
                    action === 'dismiss'
                      ? 'Notification dismissed. Choose All to restore it.'
                      : action === 'restore'
                        ? 'Notification restored.'
                        : 'Notification marked read.',
                    gone,
                  );
                }
              }}
            />
          ))}
        </ul>
      ) : null}
      {load.state === 'ready' && load.more === 'loading' ? (
        <p>Loading older notifications…</p>
      ) : null}
      {load.state === 'ready' && load.more === 'error' && load.nextCursor !== null ? (
        <ErrorState
          message="Older notifications couldn’t load."
          onRetry={() => loadMore(load.nextCursor!)}
        />
      ) : null}
      {load.state === 'ready' &&
      load.more === 'idle' &&
      load.nextCursor !== null &&
      load.items.length > 0 ? (
        <button
          type="button"
          className="notifications-more"
          onClick={() => loadMore(load.nextCursor!)}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}

function changed(item: Notification, action: NotificationAction): Notification {
  const now = new Date().toISOString();
  if (action === 'read') return { ...item, readAt: item.readAt ?? now };
  if (action === 'dismiss') return { ...item, readAt: item.readAt ?? now, dismissedAt: now };
  return { ...item, dismissedAt: null };
}

function shown(item: Notification, filter: NotificationFilter): boolean {
  if (filter === 'all') return true;
  if (item.dismissedAt) return false;
  return filter === 'active' || !item.readAt;
}

function NotificationRow({
  item,
  now,
  onChanged,
}: {
  item: Notification;
  now: number;
  onChanged: (action: NotificationAction, unread: number | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const unread = !item.readAt;
  const status = item.linkedRequest ? linkedStatus(item.linkedRequest) : null;

  async function act(action: NotificationAction) {
    setBusy(true);
    const count = await updateNotification(item.id, action);
    setBusy(false);
    onChanged(action, count);
  }

  return (
    <li
      className={`action-request notification ${unread ? 'notification-unread' : 'notification-read'}`}
      aria-label={item.title}
    >
      <div className="action-request-main">
        <p className="action-request-title">
          {unread ? (
            <>
              <StatusBadge tone="info">Unread</StatusBadge>{' '}
            </>
          ) : null}
          {item.dismissedAt ? (
            <>
              <StatusBadge>Dismissed</StatusBadge>{' '}
            </>
          ) : null}
          <span className="notification-event">{eventText(item)}:</span> {item.title}
        </p>
        <p className="action-request-meta">
          {item.projectNumber ? <>{item.projectNumber} · </> : null}
          <When iso={item.createdAt} now={now} />
          {status ? (
            <>
              {' · '}
              <span className="visually-hidden">Request status: </span>
              <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
            </>
          ) : null}
        </p>
      </div>
      <div className="action-request-actions">
        <Link
          className="button"
          to={item.href}
          // Opening reads the notification; it never resolves the request it points to.
          onClick={() => {
            if (unread) void updateNotification(item.id, 'read');
          }}
        >
          Open
        </Link>
        {unread && !item.dismissedAt ? (
          <button type="button" disabled={busy} onClick={() => void act('read')}>
            Mark read
          </button>
        ) : null}
        {item.dismissedAt ? (
          <button type="button" disabled={busy} onClick={() => void act('restore')}>
            Restore
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void act('dismiss')}>
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}
