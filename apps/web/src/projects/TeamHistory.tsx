import type { AccessHistoryEvent } from '@materialmule/shared';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAccessHistory } from './team-api';
import { historyAction, isoDateTime } from './team-format';

// Team & permissions › History (STRATA-85): assignments and grants as recorded, with who and
// why, newest first, a server page at a time ("Show older"). The person drawer shows the same
// list narrowed to one person.

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; events: AccessHistoryEvent[]; total: number; page: number };

export function HistoryList({
  projectId,
  userId,
  reloadKey,
  label,
  empty = 'No changes recorded yet.',
}: {
  projectId: string;
  userId?: string;
  /** Bumped after every change on the tab, so the newest page is read again. */
  reloadKey: number;
  /** The list's accessible name. */
  label: string;
  empty?: string;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  const loadFirst = useCallback(() => {
    let cancelled = false;
    void fetchAccessHistory(projectId, { userId }).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? {
              status: 'ready',
              events: result.data.events,
              total: result.data.total,
              page: 1,
            }
          : { status: 'failed' },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, userId]);

  useEffect(() => loadFirst(), [loadFirst, reloadKey]);

  if (state.status === 'loading') {
    return (
      <div aria-busy="true" aria-label={label} className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <Alert>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          The history couldn’t be loaded.
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setState({ status: 'loading' });
              loadFirst();
            }}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (state.events.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }

  const more = state.events.length < state.total;
  return (
    <div className="flex flex-col gap-2">
      <ItemGroup aria-label={label}>
        {state.events.map((event) => (
          <Item key={event.id} role="listitem" size="sm" className="px-0">
            <ItemMedia>
              <PersonAvatar name={event.by?.name} userId={event.by?.userId} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="flex-wrap font-normal">
                <span className="font-semibold">{event.by?.name || 'Someone'}</span>{' '}
                <span>{historyAction(event)}</span>
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                {event.reason ? (
                  <>
                    {event.kind === 'lead_nominated' ? 'Note: ' : ''}“{event.reason}”
                    <br />
                  </>
                ) : null}
                <span className="font-mono text-xs whitespace-nowrap">{isoDateTime(event.at)}</span>
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {state.events.length} of {state.total}
        </span>
        {more ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              const next = await fetchAccessHistory(projectId, { userId, page: state.page + 1 });
              setLoadingMore(false);
              if (!next.ok) {
                setMoreFailed(true);
                return;
              }
              setMoreFailed(false);
              setState((current) =>
                current.status === 'ready'
                  ? {
                      status: 'ready',
                      // A change since the first page can shift rows; never show one twice.
                      events: [
                        ...current.events,
                        ...next.data.events.filter(
                          (e) => !current.events.some((seen) => seen.id === e.id),
                        ),
                      ],
                      total: next.data.total,
                      page: next.data.page,
                    }
                  : current,
              );
            }}
          >
            <ChevronDown aria-hidden="true" />
            Show older
          </Button>
        ) : null}
        {moreFailed ? <span role="alert">Older changes couldn’t be loaded. Try again.</span> : null}
      </div>
    </div>
  );
}
