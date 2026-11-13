import {
  WORKBOARD_COLUMNS,
  type WorkboardColumn,
  type Worklist,
  type WorklistSort,
} from '@materialmule/shared';
import { CircleAlert, RotateCw, SquareKanban } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  describeSort,
  useTableQuery,
  type SortOption,
  type TableQuery,
} from '@/components/strata/table-query';
import { TableToolbar } from '@/components/strata/table-toolbar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkboardBoard, WorkboardBoardSkeleton } from './workboard/WorkboardBoard';
import { WorkboardList } from './workboard/WorkboardList';
import { fetchWorkboard, workboardParams, type WorkboardQuery } from './workboard/workboard-api';
import { WORKBOARD_VIEWS, useWorkboardView, type WorkboardView } from './workboard/workboard-view';

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Priority, then oldest open', sort: null },
  { label: 'Oldest open first', sort: { key: 'oldest', dir: 'asc' } },
  { label: 'Newest submitted', sort: { key: 'newest', dir: 'asc' } },
];

const SEARCH_DEBOUNCE_MS = 250;

type Answer =
  | { state: 'board'; columns: Record<WorkboardColumn, Worklist> }
  | { state: 'list'; list: Worklist }
  | { state: 'error' };

/** The server query for the toolbar's state (filters: Urgent only, With open tests, projects). */
function serverQuery(filters: readonly string[], sortKey: string, search: string): WorkboardQuery {
  const sort: WorklistSort =
    sortKey === 'oldest' ? 'oldest' : sortKey === 'newest' ? 'newest' : 'priority';
  return {
    search: search.trim() || undefined,
    priority: filters.includes('urgent') ? 'urgent' : undefined,
    open: filters.includes('open'),
    projectIds: filters.filter((f) => f.startsWith('project:')).map((f) => f.slice(8)),
    sort,
  };
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Lab Testing → Workboard (`/lab-testing`, STRATA-88; MM-T24's Worklist, renamed by STRATA-10).
 * Two views of the same authorized work: Board (default) by where each program is, and List, a
 * table. The view is in the URL (`view=`) and remembered per person. Ordering and placement are
 * display only; they never change a status. Search, filters and order are applied on the server.
 */
export function WorklistPage() {
  const [query, setQuery] = useTableQuery();
  const [params, setParams] = useSearchParams();
  // setSearchParams changes with every URL change; the fetch effect must not re-run for that.
  const setParamsRef = useRef(setParams);
  useEffect(() => {
    setParamsRef.current = setParams;
  }, [setParams]);
  const replaceUrlView = useCallback(
    (view: WorkboardView) =>
      setParamsRef.current(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('view', view);
          return next;
        },
        { replace: true },
      ),
    [],
  );
  const [view, rememberView] = useWorkboardView(query.view, replaceUrlView);
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  // Typing is sent once it settles; clearing the search applies at once.
  const settled = useDebounced(query.search, SEARCH_DEBOUNCE_MS);
  const search = query.search === '' ? '' : settled;
  const filterKey = query.filters.join('|');
  const sortKey = query.sort?.key ?? '';
  const request = useMemo(
    () => serverQuery(filterKey ? filterKey.split('|') : [], sortKey, search),
    [filterKey, sortKey, search],
  );
  const requestKey = `${view}|${workboardParams(request).toString()}|${view === 'list' ? page : 1}`;
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; value: Answer } | null>(null);
  // Every project with a matching program, kept while the next answer loads (BUG-006).
  const [projects, setProjects] = useState<Worklist['projects']>([]);

  useEffect(() => {
    const controller = new AbortController();
    const key = requestKey;
    const done = (value: Answer) => {
      if (!controller.signal.aborted) setAnswer({ key, value });
    };
    const load =
      view === 'board'
        ? Promise.all(
            WORKBOARD_COLUMNS.map((column) =>
              fetchWorkboard({ ...request, column }, controller.signal),
            ),
          ).then((lists) => {
            if (!controller.signal.aborted) setProjects(lists[0]!.projects);
            done({
              state: 'board',
              columns: Object.fromEntries(
                WORKBOARD_COLUMNS.map((column, i) => [column, lists[i]!]),
              ) as Record<WorkboardColumn, Worklist>,
            });
          })
        : fetchWorkboard({ ...request, page }, controller.signal).then((list) => {
            if (controller.signal.aborted) return;
            setProjects(list.projects);
            const lastPage = Math.max(1, Math.ceil(list.total / list.pageSize));
            // Programs can leave the Workboard between pages: step back to the last page.
            if (list.items.length === 0 && page > lastPage) {
              setParamsRef.current(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (lastPage > 1) next.set('page', String(lastPage));
                  else next.delete('page');
                  return next;
                },
                { replace: true },
              );
              return;
            }
            done({ state: 'list', list });
          });
    load.catch(() => done({ state: 'error' }));
    return () => controller.abort();
    // `attempt` reloads the same request (Try again).
  }, [requestKey, view, request, page, attempt]);

  const current = answer?.key === requestKey ? answer.value : null;

  const filters = useMemo(
    () => [
      { id: 'urgent', label: 'Urgent only' },
      { id: 'open', label: 'With open tests' },
      ...projects.map((p) => ({ id: `project:${p.id}`, label: p.projectNumber })),
    ],
    [projects],
  );

  const onQueryChange = (patch: Partial<TableQuery>) => {
    if ('view' in patch) {
      const next: WorkboardView = patch.view === 'list' ? 'list' : 'board';
      rememberView(next);
      // Board is the default view; keep it written in the URL when this person's default is List.
      setQuery({ ...patch, view: next });
      return;
    }
    setQuery(patch);
  };
  const setPage = (next: number) =>
    setParams((currentParams) => {
      const copy = new URLSearchParams(currentParams);
      if (next > 1) copy.set('page', String(next));
      else copy.delete('page');
      return copy;
    });

  const totals =
    current?.state === 'board'
      ? WORKBOARD_COLUMNS.reduce(
          (sum, column) => ({
            total: sum.total + current.columns[column].total,
            urgent: sum.urgent + current.columns[column].urgentTotal,
          }),
          { total: 0, urgent: 0 },
        )
      : current?.state === 'list'
        ? { total: current.list.total, urgent: current.list.urgentTotal }
        : null;
  const narrowed = query.search.trim() !== '' || query.filters.length > 0;
  const order = describeSort(query.sort, SORT_OPTIONS);

  const empty = narrowed ? (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SquareKanban aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No program matches this search or these filters.</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => setQuery({ search: '', filters: [] })}>
          Clear search and filters
        </Button>
      </EmptyContent>
    </Empty>
  ) : (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SquareKanban aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Nothing is waiting in the lab.</EmptyTitle>
        <EmptyDescription>
          Submitted programs appear here for review, then move through Units to pull, In testing and
          Ready to close.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );

  let body: React.ReactNode;
  if (!current) {
    body = (
      <div aria-busy="true" aria-label="Loading the Workboard" role="group">
        {view === 'board' ? (
          <WorkboardBoardSkeleton />
        ) : (
          <div aria-hidden="true" className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-6 w-full" />
            ))}
          </div>
        )}
        <p role="status" className="sr-only">
          Loading the Workboard…
        </p>
      </div>
    );
  } else if (current.state === 'error') {
    body = (
      <Alert variant="destructive" role="alert">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>The Workboard couldn’t be loaded.</AlertTitle>
        <AlertDescription>
          Couldn’t reach Material Mule. Check the connection and try again. Programs and their tests
          are unchanged.
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              className="text-foreground"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  } else if (totals?.total === 0) {
    body = empty;
  } else if (current.state === 'board') {
    body = <WorkboardBoard columns={current.columns} />;
  } else {
    const list = current.list;
    const first = (list.page - 1) * list.pageSize + 1;
    const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
    body = (
      <>
        <WorkboardList items={list.items} empty={empty} />
        {list.total > list.pageSize ? (
          <nav aria-label="Pages" className="flex flex-wrap items-center justify-end gap-3 text-sm">
            <span role="status" className="text-muted-foreground">
              Showing {first}–{first + list.items.length - 1} of {list.total} programs
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={list.page <= 1}
              onClick={() => setPage(list.page - 1)}
            >
              Previous
            </Button>
            <span className="tabular-nums">
              Page {list.page} of {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={list.page >= pages}
              onClick={() => setPage(list.page + 1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </>
    );
  }

  return (
    <section aria-labelledby="workboard-heading" className="@container flex min-w-0 flex-col gap-4">
      <h2 id="workboard-heading" className="sr-only">
        Workboard
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" aria-live="polite">
          {totals ? (
            <>
              <span className="font-semibold">
                {totals.total} {totals.total === 1 ? 'program' : 'programs'}
              </span>
              <span className="text-muted-foreground">
                {totals.urgent > 0 ? ` · ${totals.urgent} urgent` : ''} · {order.toLowerCase()}
              </span>
            </>
          ) : null}
        </p>
        <TableToolbar
          label="Workboard tools"
          query={{ ...query, view }}
          onQueryChange={onQueryChange}
          filters={filters}
          sortOptions={SORT_OPTIONS}
          views={WORKBOARD_VIEWS}
          searchPlaceholder="Search the Workboard…"
        />
      </div>
      {body}
    </section>
  );
}
