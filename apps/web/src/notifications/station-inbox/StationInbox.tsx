import {
  formatRecordDate,
  inboxAge,
  labCalendarDate,
  type InboxItem,
  type StationInboxPage,
} from '@materialmule/shared';
import { Bell, CircleAlert, CircleDot, Lock, RotateCw } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRecordingPerson } from '../../session/recording-person';
import { fetchStationInbox } from './api';

// The station Inbox (STRATA-27; DESIGN.md › Inbox › LAB station). On a shared LAB computer the
// Inbox page shows the picked person's Inbox only when they chose to share it; otherwise a lock
// and how to turn it on. Read-only: no read, dismiss or decide here, only links to the records
// (following one never grants access). Everything is keyed by the person, so switching person or
// signing off drops what was shown.

type Load =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'private'; name: string }
  | {
      state: 'shared';
      name: string;
      items: InboxItem[];
      total: number;
      page: number;
      more: 'idle' | 'busy' | 'failed';
    };

/** Renders nothing until someone is picked (the station guard sends the station to the picker). */
export function StationInbox() {
  const { isStation, person } = useRecordingPerson();
  if (!isStation || !person) return null;
  return <PersonInbox key={person.id} personId={person.id} pickedName={person.displayName} />;
}

function fromPage(answer: StationInboxPage): Load {
  if (answer.state === 'private') return { state: 'private', name: answer.person.name };
  return {
    state: 'shared',
    name: answer.person.name,
    items: answer.page.items,
    total: answer.page.total,
    page: answer.page.page,
    more: 'idle',
  };
}

function PersonInbox({ personId, pickedName }: { personId: string; pickedName: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchStationInbox(personId).then((answer) => {
      if (active) setLoad(answer ? fromPage(answer) : { state: 'failed' });
    });
    return () => {
      active = false;
    };
  }, [personId, attempt]);

  const retry = useCallback(() => {
    setLoad({ state: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  async function loadMore() {
    if (load.state !== 'shared') return;
    setLoad({ ...load, more: 'busy' });
    const answer = await fetchStationInbox(personId, load.page + 1);
    setLoad((current) => {
      if (current.state !== 'shared') return current;
      if (!answer || answer.state !== 'shared') {
        // Turned private in the meantime: show that rather than the old rows.
        return answer ? fromPage(answer) : { ...current, more: 'failed' };
      }
      const known = new Set(current.items.map((item) => item.key));
      return {
        ...current,
        items: [...current.items, ...answer.page.items.filter((item) => !known.has(item.key))],
        total: answer.page.total,
        page: answer.page.page,
        more: 'idle',
      };
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Inbox</h1>
      {load.state === 'private' ? (
        <PrivateInbox name={load.name} />
      ) : load.state === 'failed' ? (
        <div className="flex flex-col items-start gap-3 px-6 py-6">
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">{pickedName}’s Inbox couldn’t load.</AlertTitle>
            <AlertDescription>Check the connection, then try again.</AlertDescription>
          </Alert>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : load.state === 'loading' ? (
        <p aria-busy="true" className="px-6 py-6 text-sm text-muted-foreground">
          Loading {pickedName}’s Inbox…
        </p>
      ) : (
        <SharedInbox load={load} onMore={() => void loadMore()} />
      )}
    </div>
  );
}

function PrivateInbox({ name }: { name: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock aria-hidden="true" className="size-5" />
      </span>
      <div className="grid max-w-[460px] gap-2">
        <h2 className="text-lg font-semibold">{name}’s Inbox stays private here</h2>
        <p className="text-sm text-muted-foreground">
          {name} hasn’t chosen to show their Inbox on shared LAB computers. They can see it on their
          own computer. To show it here, they sign in with their own account and turn on Settings ›
          Preferences › Privacy › “Show my Inbox on shared LAB computers”.
        </p>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Work done at this station is still recorded under {name}’s name.
      </p>
    </div>
  );
}

function SharedInbox({
  load,
  onMore,
}: {
  load: Extract<Load, { state: 'shared' }>;
  onMore(): void;
}) {
  const [now] = useState(() => new Date());
  const groups = byDay(load.items, now);
  return (
    <>
      <div className="border-b px-6 py-3">
        <p className="rounded-md bg-accent px-3 py-2 text-[13px] text-accent-foreground">
          You’re seeing {load.name}’s Inbox. They chose to show it on shared LAB computers.
        </p>
      </div>
      {load.items.length === 0 ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">Nothing in {load.name}’s Inbox.</p>
      ) : (
        <ul className="divide-y" aria-label={`${load.name}’s Inbox, newest first`}>
          {groups.map((group) => (
            <Fragment key={group.day}>
              <li
                aria-hidden="true"
                className="border-b-0 px-6 pt-3 pb-1 text-[13px] font-medium text-muted-foreground"
              >
                {group.label}
              </li>
              {group.items.map((item) => (
                <StreamRow key={item.key} item={item} now={now} />
              ))}
            </Fragment>
          ))}
        </ul>
      )}
      {load.items.length < load.total ? (
        <div className="flex items-center gap-3 px-6 py-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={load.more === 'busy'}
            onClick={onMore}
          >
            Show more
          </Button>
          {load.more === 'failed' ? (
            <p role="alert" className="text-sm text-destructive-text">
              More couldn’t load. Try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function StreamRow({ item, now }: { item: InboxItem; now: Date }) {
  const request = item.type === 'request';
  return (
    <li>
      <Link
        to={item.href}
        className="flex w-full items-start gap-3 px-6 py-3 text-foreground no-underline outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {/* Request vs update, never by colour alone: the icon, its fill and the Request pill. */}
        <span
          aria-hidden="true"
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full',
            request ? 'bg-primary text-primary-foreground' : 'border text-muted-foreground',
          )}
        >
          {request ? <CircleDot className="size-4" /> : <Bell className="size-4" />}
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {request ? (
              <Badge className="h-4 px-1.5 py-0 text-[10px]">Request</Badge>
            ) : (
              <span className="sr-only">Update:</span>
            )}
            <span className="truncate">{item.task}</span>
            <time dateTime={item.receivedAt} className="ml-auto shrink-0 font-mono text-[13px]">
              {inboxAge(item.receivedAt, now)}
            </time>
          </span>
          <span className="flex items-center gap-2">
            {item.unread ? (
              <>
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
                <span className="sr-only">Unread. </span>
              </>
            ) : null}
            <span className={cn('truncate text-sm', item.unread && 'font-semibold')}>
              {item.title}
            </span>
          </span>
          <span className="truncate text-[13px] text-muted-foreground">
            <Detail item={item} />
          </span>
        </span>
      </Link>
    </li>
  );
}

function Detail({ item }: { item: InboxItem }) {
  const parts: ReactNode[] = [];
  if (item.jobNumber) parts.push(<span className="font-mono">{item.jobNumber}</span>);
  if (item.record && item.record.label !== item.jobNumber) {
    parts.push(<span className="font-mono">{item.record.label}</span>);
  }
  parts.push(item.from?.name ?? 'Material Mule');
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? ' · ' : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

interface DayGroup {
  day: string;
  label: string;
  items: InboxItem[];
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const weekdayName = new Intl.DateTimeFormat('en-CA', { weekday: 'long', timeZone: 'UTC' });

/** "Today", "Yesterday", the weekday within the last week, then the record date. */
function dayLabel(day: string, now: Date): string {
  const today = labCalendarDate(now) ?? '';
  if (day === today) return 'Today';
  if (day === shift(today, -1)) return 'Yesterday';
  if (day >= shift(today, -6) && day < today) {
    return weekdayName.format(new Date(`${day}T12:00:00Z`));
  }
  return formatRecordDate(day);
}

function byDay(items: InboxItem[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const day = labCalendarDate(item.receivedAt) ?? '';
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, label: dayLabel(day, now), items: [item] });
  }
  return groups;
}
