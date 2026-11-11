import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ACTION_REQUESTS_CHANGED_EVENT, fetchOpenCount, pendingActionsLabel } from './api';

const POLL_MS = 60_000;

/**
 * Pending actions (MM-T27, renamed in MM-T91): how many action requests wait on the signed-in
 * person, as a rail-footer link to the Action requests page (Field Ledger: the top bar holds only
 * search and the notification bell, so the MISC-10 in-place preview is gone). Personal accounts
 * only (`action_item.read`); the layout doesn't render it for LAB. Refreshes on navigation, on
 * focus, after an action and every minute. Routine activity (moves, progress, comments) never
 * counts here, and neither do notifications: the Notifications bell has its own unread count, and
 * the two are never added together. Only the real workflow action resolves a request.
 */
export function PendingActionsLink({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [count, setCount] = useState<number | null>(null);
  const location = useLocation();

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void fetchOpenCount()
        .then((value) => {
          if (active && value !== null) setCount(value);
        })
        .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener(ACTION_REQUESTS_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(ACTION_REQUESTS_CHANGED_EVENT, refresh);
    };
  }, [location.pathname]);

  const label = pendingActionsLabel(count);
  const here =
    location.pathname === '/action-requests' || location.pathname.startsWith('/action-requests/');
  return (
    <Link
      to="/action-requests"
      className="rail-link rail-footer-link pending-actions-link"
      aria-label={label}
      aria-current={here ? 'page' : undefined}
      onClick={onNavigate}
    >
      {/* A clipboard with a check: work waiting on you, distinct from the Notifications bell. */}
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4Zm0 9.5 2 2 4-4.5" />
      </svg>
      <span>Pending actions</span>
      {count ? (
        <span className="rail-count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
