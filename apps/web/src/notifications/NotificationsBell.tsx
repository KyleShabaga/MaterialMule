import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ACTION_REQUESTS_CHANGED_EVENT } from '../action-requests/api';
import { fetchUnreadCount, NOTIFICATIONS_CHANGED_EVENT, notificationsLabel } from './api';

const POLL_MS = 60_000;

/**
 * Header Notifications control (MM-T91): how many notifications the signed-in person hasn't read,
 * linking to the notification center. Unread is not the same as pending: the Pending actions
 * control beside it counts requests that wait on you, and the two counts are never added
 * together. Personal accounts only (`notification.read`); the layout doesn't render it for LAB.
 * Refreshes on navigation, on focus, after a notification or action-request change and every
 * minute.
 */
export function NotificationsBell({ inert = false }: { inert?: boolean } = {}) {
  const [count, setCount] = useState<number | null>(null);
  const location = useLocation();

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void fetchUnreadCount()
        .then((value) => {
          if (active && value !== null) setCount(value);
        })
        .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    // A workflow action may raise a notification for someone, including the signed-in person.
    window.addEventListener(ACTION_REQUESTS_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
      window.removeEventListener(ACTION_REQUESTS_CHANGED_EVENT, refresh);
    };
  }, [location.pathname]);

  const label = notificationsLabel(count);
  const here = location.pathname === '/notifications';
  return (
    <Link
      to="/notifications"
      className="action-bell notifications-bell"
      aria-label={label}
      title={label}
      aria-current={here ? 'page' : undefined}
      inert={inert}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path
          d="M12 3a6 6 0 0 0-6 6v3.6L4.4 15.2A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.8L18 12.6V9a6 6 0 0 0-6-6Zm-2.5 15.5a2.5 2.5 0 0 0 5 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {count ? (
        <span className="action-bell-count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
