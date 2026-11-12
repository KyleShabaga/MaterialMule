import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { ACTION_REQUESTS_CHANGED_EVENT } from '../action-requests/api';
import { useSession } from '../session/context';
import { NOTIFICATIONS_CHANGED_EVENT } from './api';
import { inboxSummarySource, type InboxFeedSource } from './inbox-feed';

/**
 * One unread count for the bell badge, the bell's heading and the sidebar's Inbox badge
 * (DESIGN.md › Sidebar › Inbox, "One count, one wording"). Every consumer reads the same value
 * from one fetch and one poll: the first consumer starts it, the last one stops it. Refreshes on
 * navigation (once per path, however many consumers), on window focus, after a notification or
 * action-request change and every 60 seconds.
 */

const POLL_MS = 60_000;

let source: InboxFeedSource = inboxSummarySource;
let value: number | null = null;
let consumers = 0;
let timer: number | undefined;
let lastPath: string | null = null;
let inFlight = false;
let again = false;
/** Bumped when the last consumer leaves, so a late answer never lands in a fresh session. */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Sets the shared count (e.g. from a mutation's answer) and tells every consumer. */
export function setInboxUnreadCount(next: number | null): void {
  if (next === value) return;
  value = next;
  emit();
}

/** Asks the server again; a request already on its way is followed by one more, never two. */
export function refreshInboxUnreadCount(): void {
  if (consumers === 0) return;
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  const mine = generation;
  void source
    .fetchUnreadCount()
    .then((next) => {
      // A failed read keeps the last known count rather than hiding it.
      if (mine === generation && next !== null) setInboxUnreadCount(next);
    })
    .catch(() => undefined)
    .finally(() => {
      if (mine !== generation) return;
      inFlight = false;
      if (again) {
        again = false;
        refreshInboxUnreadCount();
      }
    });
}

function onEvent(): void {
  refreshInboxUnreadCount();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  consumers += 1;
  if (consumers === 1) {
    timer = window.setInterval(onEvent, POLL_MS);
    window.addEventListener('focus', onEvent);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onEvent);
    // A workflow action may raise a notification for someone, including the signed-in person.
    window.addEventListener(ACTION_REQUESTS_CHANGED_EVENT, onEvent);
  }
  return () => {
    listeners.delete(listener);
    consumers -= 1;
    if (consumers === 0) {
      window.clearInterval(timer);
      window.removeEventListener('focus', onEvent);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onEvent);
      window.removeEventListener(ACTION_REQUESTS_CHANGED_EVENT, onEvent);
      generation += 1;
      value = null;
      lastPath = null;
      inFlight = false;
      again = false;
    }
  };
}

function subscribeNothing(): () => void {
  return () => undefined;
}

function snapshot(): number | null {
  return value;
}

function refreshForPath(path: string): void {
  if (path === lastPath) return;
  lastPath = path;
  refreshInboxUnreadCount();
}

/**
 * Whether this session has a personal Inbox. The shared LAB account has none of its own, so its
 * counts stay hidden (a picked person's shared Inbox, STRATA-27, is not built yet).
 */
export function useHasInbox(): boolean {
  const { session } = useSession();
  if (session.status !== 'active') return false;
  const { me } = session;
  return me.accountType !== 'shared_lab' && me.permissions.includes('notification.read');
}

/**
 * The number of unread Inbox items for the sidebar's Inbox badge and the bell. null means hide
 * the badge: still loading, couldn't be read, or no personal Inbox (the shared LAB account).
 */
export function useInboxUnreadCount(): number | null {
  const enabled = useHasInbox();
  const { pathname } = useLocation();
  const shared = useSyncExternalStore(enabled ? subscribe : subscribeNothing, snapshot, snapshot);
  useEffect(() => {
    if (enabled) refreshForPath(pathname);
  }, [enabled, pathname]);
  return enabled ? shared : null;
}

/** Tests only: swap the feed and get the default (the single Inbox summary) back. */
export function setInboxFeedSourceForTests(next: InboxFeedSource | null): void {
  source = next ?? inboxSummarySource;
}

export function inboxFeedSource(): InboxFeedSource {
  return source;
}
