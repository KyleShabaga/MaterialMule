import { Bell, CircleDot } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '../components/useMediaQuery';
import { formatAge, formatExpiry } from '../lib/format';
import { notificationsLabel } from './api';
import { inboxFeedSource, setInboxUnreadCount, useInboxBadge } from './inbox-count';
import {
  BELL_PREVIEW_SIZE,
  bellBadgeText,
  INBOX_HREF,
  inboxHeading,
  toPreviewItem,
  type InboxPreviewItem,
} from './inbox-feed';
import { fetchStationInboxSummary } from './station-inbox/api';

/** Each preview remembers whose Inbox it shows (`me` or `station:<person ID>`). */
type Preview = { owner: string } & (
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'private'; name: string }
  | { state: 'ready'; items: InboxPreviewItem[]; now: number }
);

/** "Pat Example's notifications stay private on this computer." */
// eslint-disable-next-line react-refresh/only-export-components -- wording shared with tests
export function stationPrivateText(name: string): string {
  return `${name}’s notifications stay private on this computer.`;
}

/** The station preview's heading: "Pat Example's Inbox · 3 unread". */
// eslint-disable-next-line react-refresh/only-export-components -- wording shared with tests
export function stationInboxHeading(name: string, count: number | null): string {
  return count ? `${name}’s Inbox · ${count} unread` : `${name}’s Inbox`;
}

/**
 * The top bar's bell (STRATA-13, DESIGN.md › Shell › Notifications): a 44 px outline icon button
 * that is a link to Inbox, with a 20 px primary count badge when anything is unread ("9+" past
 * nine). Hovering it, or focusing it from the keyboard, previews Inbox after 150 ms (closing 200 ms
 * after leaving): the unread heading, the newest three items in Inbox's words, Mark all read and
 * Open Inbox. The count is the shared Inbox count (useInboxBadge), so the badge, the heading
 * and the sidebar's Inbox badge always agree. The shell decides whether to render it.
 *
 * On a shared LAB station (STRATA-27) it shows the picked person's Inbox, read-only, when they
 * chose to share it (no Mark all read); when they keep it private there is no badge and the
 * preview only says so. Switching person or signing off drops what was shown.
 */
export function NotificationsBell({ inert = false }: { inert?: boolean } = {}) {
  const badge = useInboxBadge();
  const { count } = badge;
  const stationPerson = badge.station ? badge.person : null;
  const stationPersonId = stationPerson?.id ?? null;
  const owner = badge.station ? `station:${stationPersonId ?? ''}` : 'me';
  const location = useLocation();
  const [open, setOpen] = useState(false);
  // A hover preview has no place on a touch screen: a tap would open it over the page and leave
  // it there (lane F: it covered the Staff tabs after a drawer's Close on a phone).
  const noHover = useMediaQuery('(hover: none)');
  const [stored, setPreview] = useState<Preview>({ owner, state: 'idle' });
  // A preview read for someone else (before a switch of person) is never shown.
  const preview: Preview = stored.owner === owner ? stored : { owner, state: 'idle' };
  const [marking, setMarking] = useState<'idle' | 'busy' | 'failed'>('idle');
  const mounted = useRef(true);
  /**
   * Whether the pointer is over the bell or it has focus, and whether it was just clicked. Radix
   * can leave an open timer behind (hover then focus each start one; leaving clears only the
   * last), so an opening is only taken while the bell is still engaged. Clicked: the Inbox is
   * opening, so no preview until the pointer leaves the bell.
   */
  const bell = useRef({ hovered: false, focused: false, clicked: false });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const station = badge.station;
  const loadPreview = useCallback(() => {
    setPreview((current) =>
      current.owner === owner && current.state === 'ready' ? current : { owner, state: 'loading' },
    );
    // An answer counts only for the owner it was read for (a switch of person drops it).
    const settle = (next: Preview) => {
      if (!mounted.current) return;
      setPreview((current) => (current.owner === next.owner ? next : current));
    };
    if (!station) {
      inboxFeedSource()
        .fetchNewest(BELL_PREVIEW_SIZE)
        .then(
          (items) => settle({ owner, state: 'ready', items, now: Date.now() }),
          () => settle({ owner, state: 'error' }),
        );
      return;
    }
    if (!stationPersonId) {
      settle({ owner, state: 'error' });
      return;
    }
    void fetchStationInboxSummary(stationPersonId).then((summary) => {
      if (!summary) settle({ owner, state: 'error' });
      else if (summary.state === 'private') {
        settle({ owner, state: 'private', name: summary.person.name });
      } else {
        settle({
          owner,
          state: 'ready',
          items: summary.summary.preview.slice(0, BELL_PREVIEW_SIZE).map(toPreviewItem),
          now: Date.now(),
        });
      }
    });
  }, [owner, station, stationPersonId]);

  async function markAll() {
    setMarking('busy');
    const next = await inboxFeedSource().markAllRead();
    if (!mounted.current) return;
    if (next === null) {
      setMarking('failed');
      return;
    }
    setMarking('idle');
    setInboxUnreadCount(next);
    // Reload so the rows lose their bold.
    loadPreview();
  }

  const label = notificationsLabel(count);
  const here = location.pathname === INBOX_HREF;
  const unread = count ?? 0;

  return (
    <HoverCard
      openDelay={150}
      closeDelay={200}
      open={inert || noHover ? false : open}
      onOpenChange={(next) => {
        const { hovered, focused, clicked } = bell.current;
        if (next && (clicked || !(hovered || focused))) return;
        setOpen(next);
        // Each opening shows the Inbox as it is now.
        if (next) loadPreview();
        else setMarking('idle');
      }}
    >
      <HoverCardTrigger asChild>
        <Button
          asChild
          variant="outline"
          size="icon"
          className={cn('notifications-bell relative', here && 'bg-accent text-accent-foreground')}
        >
          <Link
            to={INBOX_HREF}
            aria-label={label}
            aria-current={here ? 'page' : undefined}
            inert={inert}
            onClick={() => {
              // The preview would cover the Inbox it opens (it stays open under a still pointer).
              bell.current.clicked = true;
              setOpen(false);
            }}
            onPointerEnter={() => {
              bell.current.hovered = true;
            }}
            onPointerLeave={() => {
              bell.current.hovered = false;
              bell.current.clicked = false;
            }}
            onFocus={() => {
              bell.current.focused = true;
            }}
            onBlur={() => {
              bell.current.focused = false;
            }}
          >
            <Bell aria-hidden="true" className="size-5" />
            {unread > 0 ? (
              <Badge
                data-slot="bell-count"
                aria-hidden="true"
                className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 py-0 text-[11px] leading-none tabular-nums"
              >
                {bellBadgeText(unread)}
              </Badge>
            ) : null}
          </Link>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-80 p-0" aria-label="Inbox preview">
        {badge.privateName || preview.state === 'private' ? (
          // The picked person keeps their Inbox private on stations: this line and nothing else.
          <p className="px-4 py-3 text-sm">
            {stationPrivateText(
              badge.privateName ??
                (preview.state === 'private' ? preview.name : (stationPerson?.name ?? '')),
            )}
          </p>
        ) : (
          <BellPreview
            count={count}
            preview={preview}
            marking={marking}
            station={stationPerson ? stationPerson.name : null}
            onMarkAll={() => void markAll()}
            onNavigate={() => setOpen(false)}
          />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function BellPreview({
  count,
  preview,
  marking,
  station,
  onMarkAll,
  onNavigate,
}: {
  count: number | null;
  preview: Preview;
  marking: 'idle' | 'busy' | 'failed';
  /** The picked person's name on a LAB station (read-only there: no Mark all read). */
  station: string | null;
  onMarkAll: () => void;
  onNavigate: () => void;
}) {
  const nothingUnread = count === 0;
  const whose = station ? `${station}’s Inbox` : 'your Inbox';
  return (
    <div className="flex flex-col">
      <p className="border-b px-4 py-3 text-sm font-semibold">
        {station ? stationInboxHeading(station, count) : inboxHeading(count)}
      </p>
      <div className="px-2 py-2">
        {nothingUnread ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">Nothing unread in {whose}.</p>
        ) : preview.state === 'error' ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {station ? `${station}’s Inbox` : 'Your Inbox'} couldn’t be loaded. Open Inbox to try
            again.
          </p>
        ) : preview.state === 'ready' ? (
          preview.items.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">Nothing in {whose}.</p>
          ) : (
            <ul className="flex flex-col" aria-label={`Newest in ${whose}`}>
              {preview.items.map((item) => (
                <PreviewRow key={item.id} item={item} now={preview.now} onNavigate={onNavigate} />
              ))}
            </ul>
          )
        ) : (
          <p className="px-2 py-2 text-sm text-muted-foreground" aria-busy="true">
            Loading your Inbox…
          </p>
        )}
      </div>
      {marking === 'failed' ? (
        <p role="alert" className="px-4 pb-2 text-sm text-destructive">
          Couldn’t mark them read. Try again.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t px-2 py-2">
        {count && !station ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={marking === 'busy'}
            onClick={onMarkAll}
          >
            Mark all read
          </Button>
        ) : (
          <span />
        )}
        <Button asChild variant="link" size="sm">
          <Link to={INBOX_HREF} onClick={onNavigate}>
            Open Inbox
          </Link>
        </Button>
      </div>
    </div>
  );
}

function PreviewRow({
  item,
  now,
  onNavigate,
}: {
  item: InboxPreviewItem;
  now: number;
  onNavigate: () => void;
}) {
  const request = item.type === 'request';
  return (
    <li>
      <Link
        to={item.href}
        onClick={onNavigate}
        className="flex items-start gap-3 rounded-md px-2 py-2 text-sm no-underline hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {/* Request vs update, never by colour alone: the icon, its fill and the Request pill. */}
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full',
            request ? 'bg-primary text-primary-foreground' : 'border bg-background',
          )}
        >
          {request ? <CircleDot className="size-3.5" /> : <Bell className="size-3.5" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {request ? (
              <Badge className="h-4 px-1.5 py-0 text-[10px]">Request</Badge>
            ) : (
              <span className="sr-only">Update:</span>
            )}
            <span>{item.kind}</span>
          </span>
          <span className={cn('text-foreground', item.unread && 'font-semibold')}>
            {item.unread ? <span className="sr-only">Unread: </span> : null}
            {item.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {item.projectNumber ? <>{item.projectNumber} · </> : null}
            <When iso={item.createdAt} now={now} />
          </span>
        </span>
        {item.unread ? (
          <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
      </Link>
    </li>
  );
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
