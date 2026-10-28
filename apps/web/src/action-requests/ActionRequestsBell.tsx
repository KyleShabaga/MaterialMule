import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ACTION_REQUESTS_CHANGED_EVENT, fetchOpenCount } from './api';

const POLL_MS = 60_000;

/**
 * Header bell (MM-T27): how many action requests wait on the signed-in person. Personal accounts
 * only; the layout doesn't render it for LAB. Refreshes on navigation, on focus, after an action
 * and every minute. Routine activity (moves, progress, comments) never counts here.
 */
export function ActionRequestsBell() {
  const [open, setOpen] = useState<number | null>(null);
  const location = useLocation();

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void fetchOpenCount()
        .then((count) => {
          if (active && count !== null) setOpen(count);
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

  const label = open === null ? 'Action requests' : `Action requests, ${open} open`;
  return (
    <Link to="/action-requests" className="action-bell" aria-label={label} title={label}>
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
      {open ? (
        <span className="action-bell-count" aria-hidden="true">
          {open > 99 ? '99+' : open}
        </span>
      ) : null}
    </Link>
  );
}
