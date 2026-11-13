import {
  describeStorageUnitCorrection,
  formatPerson,
  storageUnitHistoryActionLabel,
  type StorageUnitHistoryEvent,
  type StorageUnitHistoryPage,
} from '@materialmule/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '../components/strata/person-avatar';
import { fetchStorageUnitHistory } from './api';
import { formatEventTime } from './unit-record';

type Loaded =
  | { key: string; ok: true; data: StorageUnitHistoryPage }
  | { key: string; ok: false; message: string };

/** Test identities' actions carry the TEST badge (MTR-3, MM-T33). */
function ActorTestBadge({ accountType }: { accountType: string | null }) {
  if (accountType !== 'test') return null;
  return (
    <>
      {' '}
      <Badge variant="outline" className="h-5 px-1.5 text-[11px]" title="Done by a test account">
        TEST
      </Badge>
    </>
  );
}

/** One audit value as text: a location (or any `{name, code}`) reads "name (code)" (MTR-64). */
function formatHistoryValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && typeof record.code === 'string') {
    return `${record.name} (${record.code})`;
  }
  return JSON.stringify(value);
}

function changes(event: StorageUnitHistoryEvent): string[] {
  // A hold's or extension's label says it all; its audit values are bookkeeping (MTR-59).
  if (!event.before || !event.after || event.action.startsWith('retention.')) return [];
  return Object.keys(event.after)
    .filter((key) => key in event.before!)
    .map(
      (key) =>
        `${key}: ${formatHistoryValue(event.before![key])} → ${formatHistoryValue(event.after![key])}`,
    );
}

function EventText({ event }: { event: StorageUnitHistoryEvent }) {
  const label = storageUnitHistoryActionLabel(event.action, event.after);
  if (event.action === 'storage_unit.corrected') {
    // e.g. "KCS changed received date 2026-10-23 → 2026-10-21 · Reason: wrong date on tag"
    return (
      <>
        <span className="font-medium">{label}</span>{' '}
        <span>
          {event.actor.initials ?? event.actor.name ?? 'Unknown'}
          <ActorTestBadge accountType={event.actor.accountType} /> changed{' '}
          {describeStorageUnitCorrection(event.before, event.after).join('; ')}
          {event.reason ? ` · Reason: ${event.reason}` : ''}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="font-medium">{label}</span>{' '}
      <span>
        by {formatPerson(event.actor.initials, event.actor.name)}
        <ActorTestBadge accountType={event.actor.accountType} />
        {event.receiver ? ` for ${formatPerson(event.receiver.initials, event.receiver.name)}` : ''}
      </span>
      {event.reason ? <span className="text-muted-foreground"> Reason: {event.reason}</span> : null}
      {changes(event).map((change) => (
        <span key={change} className="text-muted-foreground">
          {' '}
          {change}
        </span>
      ))}
    </>
  );
}

/**
 * History (STRATA-72): a timeline, newest first, with the person's avatar, what happened and when;
 * 20 per page from the history API, never loaded in full. Sticky beside the facts from 56rem.
 */
export function UnitHistory({
  storageUnitId,
  refresh,
  disposed,
  className,
}: {
  storageUnitId: string;
  refresh: number;
  disposed: boolean;
  className?: string;
}) {
  const [page, setPage] = useState(1);
  const key = `${storageUnitId}:${page}:${refresh}`;
  const [result, setResult] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchStorageUnitHistory(storageUnitId, page).then((response) => {
      if (cancelled) return;
      setResult(
        response.ok
          ? { key, ok: true, data: response.data }
          : { key, ok: false, message: response.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [storageUnitId, page, key, reloads]);

  let body: ReactNode;
  let meta = disposed ? 'Kept in full' : 'Newest first';
  if (!result || result.key !== key) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-4">
        {[0, 1, 2].map((n) => (
          <div key={n} className="flex gap-3">
            <Skeleton className="size-6 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
        <span className="sr-only">Loading history</span>
      </div>
    );
  } else if (!result.ok) {
    body = (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{result.message}</p>
        <Button variant="outline" size="sm" onClick={() => setReloads((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  } else if (result.data.items.length === 0) {
    body = <p className="text-sm text-muted-foreground">No history yet.</p>;
  } else {
    const { items, total, pageSize } = result.data;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    meta = `${total} ${total === 1 ? 'event' : 'events'}`;
    body = (
      <>
        <ol aria-label="History events" className="flex flex-col">
          {items.map((event, index) => {
            const system = !event.actor.name && !event.actor.initials;
            return (
              <li
                key={event.id}
                className={cn(
                  'relative flex items-start gap-3 pb-4 text-sm',
                  event.action === 'storage_unit.corrected' && 'history-event-corrected',
                )}
              >
                {index < items.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-7 bottom-0 left-3 w-px bg-border"
                  />
                ) : null}
                <PersonAvatar name={event.actor.name ?? event.actor.initials} system={system} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-pretty break-words">
                    <EventText event={event} />
                  </p>
                  <time
                    dateTime={event.occurredAt}
                    className="font-mono text-[13px] text-muted-foreground"
                  >
                    {formatEventTime(event.occurredAt)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
        {totalPages > 1 ? (
          <nav aria-label="History pages" className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Newer
            </Button>
            <span className="font-mono text-[13px] text-muted-foreground tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Older
            </Button>
          </nav>
        ) : null}
      </>
    );
  }

  return (
    <Card
      id="history"
      role="region"
      aria-labelledby="history-heading"
      className={cn('gap-4 p-5 shadow-none', className)}
    >
      <div className="flex items-baseline justify-between gap-4">
        <CardTitle role="heading" aria-level={2} id="history-heading" className="text-base">
          History
        </CardTitle>
        <span className="text-[13px] text-muted-foreground">{meta}</span>
      </div>
      {body}
    </Card>
  );
}
