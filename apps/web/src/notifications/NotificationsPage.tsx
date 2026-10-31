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
  markAllRead,
  NotificationsForbiddenError,
  updateNotification,
  type NotificationAction,
} from './api';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'forbidden' }
  | { state: 'ready'; items: Notification[] };

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
  const messageRef = useRef<HTMLParagraphElement>(null);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let active = true;
    fetchNotifications(filter)
      .then((list) => {
        if (active) setLoad({ state: 'ready', items: list.items });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoad({ state: error instanceof NotificationsForbiddenError ? 'forbidden' : 'error' });
      });
    return () => {
      active = false;
    };
  }, [filter, tick]);

  /** Applies a successful change to the rows on screen; rows the filter no longer shows go. */
  const apply = useCallback(
    (id: string, action: NotificationAction) => {
      setLoad((current) =>
        current.state !== 'ready'
          ? current
          : {
              state: 'ready',
              items: current.items
                .map((item) => (item.id === id ? changed(item, action) : item))
                .filter((item) => shown(item, filter)),
            },
      );
    },
    [filter],
  );

  const announce = (text: string, moveFocus: boolean) => {
    setMessage(text);
    if (moveFocus) window.setTimeout(() => messageRef.current?.focus(), 0);
  };

  const unreadShown =
    load.state === 'ready' && load.items.some((item) => !item.readAt && !item.dismissedAt);

  async function readAll() {
    setBulkBusy(true);
    const unread = await markAllRead();
    setBulkBusy(false);
    if (unread === null) {
      announce('Notifications couldn’t be marked read. Try again.', false);
      return;
    }
    const readAt = new Date().toISOString();
    setLoad((current) =>
      current.state !== 'ready'
        ? current
        : {
            state: 'ready',
            items: current.items
              .map((item) => ({ ...item, readAt: item.readAt ?? readAt }))
              .filter((item) => shown(item, filter)),
          },
    );
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
          <button type="button" disabled={!unreadShown || bulkBusy} onClick={() => void readAll()}>
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
      {load.state === 'ready' && load.items.length === 0 ? (
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
