import { Bell, CircleDot } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { formatAge, formatExpiry } from '../lib/format';
import { notificationsLabel } from './api';
import { inboxFeedSource, setInboxUnreadCount, useInboxUnreadCount } from './inbox-count';
import {
  BELL_PREVIEW_SIZE,
  bellBadgeText,
  INBOX_HREF,
  inboxHeading,
  type InboxPreviewItem,
} from './inbox-feed';

type Preview =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; items: InboxPreviewItem[]; now: number };

/**
 * The top bar's bell (STRATA-13, DESIGN.md › Shell › Notifications): a 44 px outline icon button
 * that is a link to Inbox, with a 20 px primary count badge when anything is unread ("9+" past
 * nine). Hovering it, or focusing it from the keyboard, previews Inbox after 150 ms (closing 200 ms
 * after leaving): the unread heading, the newest three items in Inbox's words, Mark all read and
 * Open Inbox. The count is the shared Inbox count (useInboxUnreadCount), so the badge, the heading
 * and the sidebar's Inbox badge always agree. Personal accounts only (`notification.read`); the
 * shell decides whether to render it.
 */
export function NotificationsBell({ inert = false }: { inert?: boolean } = {}) {
  const count = useInboxUnreadCount();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
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

  const loadPreview = useCallback(() => {
    setPreview((current) => (current.state === 'ready' ? current : { state: 'loading' }));
    inboxFeedSource()
      .fetchNewest(BELL_PREVIEW_SIZE)
      .then(
        (items) => {
          if (mounted.current) setPreview({ state: 'ready', items, now: Date.now() });
        },
        () => {
          if (mounted.current) setPreview({ state: 'error' });
        },
      );
  }, []);

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
      open={inert ? false : open}
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
        <BellPreview
          count={count}
          preview={preview}
          marking={marking}
          onMarkAll={() => void markAll()}
          onNavigate={() => setOpen(false)}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

function BellPreview({
  count,
  preview,
  marking,
  onMarkAll,
  onNavigate,
}: {
  count: number | null;
  preview: Preview;
  marking: 'idle' | 'busy' | 'failed';
  onMarkAll: () => void;
  onNavigate: () => void;
}) {
  const nothingUnread = count === 0;
  return (
    <div className="flex flex-col">
      <p className="border-b px-4 py-3 text-sm font-semibold">{inboxHeading(count)}</p>
      <div className="px-2 py-2">
        {nothingUnread ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">Nothing unread in your Inbox.</p>
        ) : preview.state === 'error' ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            Your Inbox couldn’t be loaded. Open Inbox to try again.
          </p>
        ) : preview.state === 'ready' ? (
          preview.items.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">Nothing in your Inbox.</p>
          ) : (
            <ul className="flex flex-col" aria-label="Newest in your Inbox">
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
        {count ? (
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
