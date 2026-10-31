import type { ActionRequest } from '@materialmule/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { formatExpiry } from '../lib/format';
import {
  ACTION_REQUESTS_CHANGED_EVENT,
  fetchActionRequests,
  fetchOpenCount,
  pendingActionsLabel,
} from './api';

const POLL_MS = 60_000;
/** How many of the newest open requests the bell's preview lists (MISC-10). */
export const BELL_PREVIEW_LIMIT = 5;

type Preview =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: ActionRequest[] };

/**
 * Header Pending actions control (MM-T27, renamed in MM-T91): how many action requests wait on
 * the signed-in person. Personal accounts only (`action_item.read`); the layout doesn't render it
 * for LAB. Refreshes on navigation, on focus, after an action and every minute. Routine activity
 * (moves, progress, comments) never counts here, and neither do notifications: the Notifications
 * control beside it has its own unread count, and the two are never added together. Reading a
 * notification never changes this count; only the real workflow action resolves a request.
 *
 * MISC-10: clicking it opens a preview of the newest open requests without leaving the page.
 * Each entry only links to the item; nothing here approves or resolves anything.
 */
export function ActionRequestsBell({ inert = false }: { inert?: boolean } = {}) {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
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

  // Any navigation (a preview link, Back) closes the preview.
  const [shownAt, setShownAt] = useState(location.pathname);
  if (shownAt !== location.pathname) {
    setShownAt(location.pathname);
    setOpen(false);
  }

  // Only the latest load may update the preview, so a slow answer can't overwrite a retry.
  const loadId = useRef(0);
  const loadPreview = useCallback(() => {
    const id = ++loadId.current;
    setPreview({ state: 'loading' });
    fetchActionRequests('open', 'mine')
      .then((list) => {
        if (id !== loadId.current) return;
        const items = [...list.items]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, BELL_PREVIEW_LIMIT);
        setPreview({ state: 'ready', items });
      })
      .catch(() => {
        if (id === loadId.current) setPreview({ state: 'error' });
      });
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    loadId.current++;
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const label = pendingActionsLabel(count);
  return (
    <div className="action-bell-wrap" ref={wrapRef} inert={inert}>
      <button
        ref={buttonRef}
        type="button"
        className="action-bell"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? 'action-bell-panel' : undefined}
        onClick={() => {
          if (open) {
            close(true);
          } else {
            setOpen(true);
            loadPreview();
          }
        }}
      >
        {/* A clipboard with a check: work waiting on you, distinct from the Notifications bell. */}
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path
            d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4Zm0 9.5 2 2 4-4.5"
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
      </button>
      {open ? (
        <section
          id="action-bell-panel"
          className="action-bell-panel"
          aria-label="Latest action requests"
        >
          <h2 className="action-bell-heading">Latest action requests</h2>
          {preview.state === 'loading' ? (
            <p className="action-bell-state" role="status">
              Loading…
            </p>
          ) : preview.state === 'error' ? (
            <div className="action-bell-state" role="alert">
              <p>Action requests couldn’t be loaded.</p>
              <button type="button" onClick={loadPreview}>
                Retry
              </button>
            </div>
          ) : preview.items.length === 0 ? (
            <p className="action-bell-state">Nothing is waiting on you.</p>
          ) : (
            <ul className="action-bell-list">
              {preview.items.map((item) => (
                <li key={item.id}>
                  <Link to={item.href} className="action-bell-item" onClick={() => setOpen(false)}>
                    <span className="action-bell-item-title">
                      <strong>{item.routeTag}:</strong> {item.title}
                    </span>
                    <span className="action-bell-item-meta">
                      {item.projectNumber} · requested{' '}
                      <time dateTime={item.createdAt}>{formatExpiry(item.createdAt)}</time>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link to="/action-requests" className="action-bell-all" onClick={() => setOpen(false)}>
            View all action requests
          </Link>
        </section>
      ) : null}
    </div>
  );
}
