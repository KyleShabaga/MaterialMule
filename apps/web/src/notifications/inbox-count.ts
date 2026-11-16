import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { ACTION_REQUESTS_CHANGED_EVENT } from '../action-requests/api';
import { useSession } from '../session/context';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import { NOTIFICATIONS_CHANGED_EVENT } from './api';
import { inboxSummarySource, type InboxFeedSource } from './inbox-feed';
import { fetchStationInboxSummary } from './station-inbox/api';

/**
 * One unread count for the bell badge, the bell's heading and the sidebar's Inbox badge
 * (DESIGN.md › Sidebar › Inbox, "One count, one wording"). Every consumer reads the same value
 * from one fetch and one poll: the first consumer starts it, the last one stops it. Refreshes on
 * navigation (once per path, however many consumers), on window focus, after a notification or
 * action-request change and every 60 seconds.
 *
 * Whose count it is: a personal account's own Inbox (`me`), or on a shared LAB station the picked
 * person's (`station:<userId>`, STRATA-27), read from GET /api/station/inbox/summary. A person
 * who keeps their Inbox private has no count anywhere on the station (sidebar and bell). The
 * value is stored with its owner, so switching person or signing off drops it at once: a count
 * is only ever shown to the owner it was read for.
 */

const POLL_MS = 60_000;

/** The shared value and whose it is. */
interface Entry {
  owner: string;
  /** null hides the badge (private, or not read yet). */
  count: number | null;
  /** Set when the picked person keeps their Inbox private: their name, as the server gives it. */
  privateName: string | null;
}

let source: InboxFeedSource = inboxSummarySource;
let owner: string | null = null;
let entry: Entry | null = null;
let consumers = 0;
let timer: number | undefined;
let lastPath: string | null = null;
let inFlight = false;
let again = false;
/** Bumped when the owner changes or the last consumer leaves, so a late answer never lands. */
let generation = 0;
const listeners = new Set<() => void>();

const ME = 'me';
const STATION_PREFIX = 'station:';

function emit(): void {
  for (const listener of listeners) listener();
}

function setEntry(next: Entry | null): void {
  if (
    next === entry ||
    (next &&
      entry &&
      next.owner === entry.owner &&
      next.count === entry.count &&
      next.privateName === entry.privateName)
  ) {
    return;
  }
  entry = next;
  emit();
}

/** Sets the shared count (e.g. from a mutation's answer) and tells every consumer. */
export function setInboxUnreadCount(next: number | null): void {
  if (!owner) return;
  setEntry({ owner, count: next, privateName: null });
}

async function read(forOwner: string): Promise<Entry | null> {
  if (forOwner === ME) {
    const count = await source.fetchUnreadCount();
    return count === null ? null : { owner: forOwner, count, privateName: null };
  }
  const summary = await fetchStationInboxSummary(forOwner.slice(STATION_PREFIX.length));
  if (!summary) return null;
  return summary.state === 'private'
    ? { owner: forOwner, count: null, privateName: summary.person.name }
    : { owner: forOwner, count: summary.summary.counts.badge, privateName: null };
}

/** Asks the server again; a request already on its way is followed by one more, never two. */
export function refreshInboxUnreadCount(): void {
  if (consumers === 0 || !owner) return;
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  const mine = generation;
  void read(owner)
    .then((next) => {
      // A failed read keeps the last known count rather than hiding it.
      if (mine === generation && next !== null) setEntry(next);
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

function forget(): void {
  generation += 1;
  lastPath = null;
  inFlight = false;
  again = false;
  setEntry(null);
}

/** Whose count the consumers show now; a new owner drops the old value before anything else. */
function setOwner(next: string): void {
  if (next === owner) return;
  owner = next;
  forget();
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
      owner = null;
      forget();
    }
  };
}

function subscribeNothing(): () => void {
  return () => undefined;
}

function snapshot(): Entry | null {
  return entry;
}

function refreshForPath(path: string): void {
  if (path === lastPath) return;
  lastPath = path;
  refreshInboxUnreadCount();
}

/**
 * Whether this session has a personal Inbox. The shared LAB account has none of its own (its
 * station shows the picked person's, with their consent: useInboxBadge).
 */
export function useHasInbox(): boolean {
  const { session } = useSession();
  if (session.status !== 'active') return false;
  const { me } = session;
  return me.accountType !== 'shared_lab' && me.permissions.includes('notification.read');
}

export interface InboxBadge {
  /** True on a shared LAB station (the counts are the picked person's, if they share them). */
  station: boolean;
  /** The picked person on a station; null on a personal account or with nobody picked. */
  person: { id: string; name: string } | null;
  /** The badge count; null hides every badge (loading, unreadable, private, nobody picked). */
  count: number | null;
  /** On a station: the picked person's name when they keep their Inbox private, else null. */
  privateName: string | null;
}

/** Whose Inbox the shell's counts are for, and the shared count for exactly that owner. */
export function useInboxBadge(): InboxBadge {
  const personal = useHasInbox();
  const { session } = useSession();
  const recording = useOptionalRecordingPerson();
  const station =
    recording?.isStation ??
    (session.status === 'active' && session.me.accountType === 'shared_lab');
  const picked = station ? (recording?.person ?? null) : null;
  const key = station ? (picked ? `${STATION_PREFIX}${picked.id}` : null) : personal ? ME : null;
  const { pathname } = useLocation();
  const shared = useSyncExternalStore(key ? subscribe : subscribeNothing, snapshot, snapshot);
  useEffect(() => {
    if (!key) return;
    setOwner(key);
    refreshForPath(pathname);
  }, [key, pathname]);
  // Only a value read for this owner counts: a switch of person hides the old one at once.
  const mine = key && shared?.owner === key ? shared : null;
  return {
    station,
    person: picked ? { id: picked.id, name: picked.displayName } : null,
    count: mine?.count ?? null,
    privateName: mine?.privateName ?? null,
  };
}

/**
 * The number of unread Inbox items for the sidebar's Inbox badge and the bell. null means hide
 * the badge: still loading, couldn't be read, no Inbox of one's own and nobody picked, or the
 * picked person keeps their Inbox private on the station.
 */
export function useInboxUnreadCount(): number | null {
  return useInboxBadge().count;
}

/** Tests only: swap the feed and get the default (the single Inbox summary) back. */
export function setInboxFeedSourceForTests(next: InboxFeedSource | null): void {
  source = next ?? inboxSummarySource;
}

export function inboxFeedSource(): InboxFeedSource {
  return source;
}
