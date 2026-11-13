import {
  CONCRETE_EXCEPTION_LABEL,
  CONCRETE_REPORT_KIND_LABEL,
  CONCRETE_REVIEW_QUEUE_PAGE_SIZE,
  type ConcreteReviewQueue,
  type ConcreteReviewQueueFilter,
  type ConcreteReviewQueueRow,
} from '@materialmule/shared';
import { CheckCheck, SearchX, TriangleAlert, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Kbd } from '@/components/ui/kbd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DataTable,
  DENSITY_VIEW_OPTIONS,
  useTableDensity,
  type DataTableColumn,
} from '../components/strata/data-table';
import { usePeekKeys } from '../components/strata/peek';
import { PersonCell } from '../components/strata/person-avatar';
import { type QueryFilterOption } from '../components/strata/query-chips';
import { TableToolbar } from '../components/strata/table-toolbar';
import { useTableQuery, type SortLabels, type SortOption } from '../components/strata/table-query';
import { shortDateTime } from '../dashboard/format';
import { useMe } from '../session/context';
import { fetchReviewQueue } from './api';

// STRATA-97 (DESIGN.md › Concrete review, round 8; boards R8Queue*): the review queue. Tabs are
// server filters on the reports' actual states (Waiting for review, Returned, Reviewed but not
// issued, Exceptions = waiting or returned with exceptions not yet documented, and Issued); the
// table tools (search, filters, sort) go to the server, which pages and orders the rows. Rows open
// the exact report and version; J/K move between rows in the order shown, Enter opens one.
// The server lists every report the caller may read and says per row whether they can act now;
// an empty tab means no accessible matching report, never that no work exists elsewhere.

type QueueTab = ConcreteReviewQueueFilter;

const TABS: { id: QueueTab; label: string; caption: string }[] = [
  { id: 'awaiting_review', label: 'Waiting for review', caption: 'Waiting for review' },
  { id: 'returned', label: 'Returned', caption: 'Returned for correction' },
  {
    id: 'reviewed_awaiting_issue',
    label: 'Reviewed, not issued',
    caption: 'Reviewed, not yet issued',
  },
  { id: 'open_exceptions', label: 'Exceptions', caption: 'Reports with open exceptions' },
  { id: 'issued', label: 'Issued', caption: 'Issued reports' },
];

const DEFAULT_ORDER: Record<QueueTab, string> = {
  awaiting_review: 'Oldest submitted first',
  open_exceptions: 'Oldest submitted first',
  returned: 'Most recently returned first',
  reviewed_awaiting_issue: 'Oldest reviewed first',
  issued: 'Most recently issued first',
};

function sortOptions(tab: QueueTab): SortOption[] {
  const oldest = DEFAULT_ORDER[tab] === 'Oldest submitted first';
  return [
    { label: DEFAULT_ORDER[tab], sort: null },
    ...(oldest
      ? []
      : [{ label: 'Oldest submitted first', sort: { key: 'submitted', dir: 'asc' } }]),
    { label: 'Newest submitted first', sort: { key: 'submitted', dir: 'desc' } },
    { label: 'Project', sort: { key: 'project', dir: 'asc' } },
    { label: 'Report date, newest first', sort: { key: 'report_date', dir: 'desc' } },
  ] as SortOption[];
}

const SORT_LABELS: SortLabels = {
  submitted: { asc: 'Oldest submitted first', desc: 'Newest submitted first' },
  project: { asc: 'Project A–Z', desc: 'Project Z–A' },
  report_date: { asc: 'Report date, oldest first', desc: 'Report date, newest first' },
};

const SORT_KEYS = new Set(['submitted', 'project', 'report_date']);

const NO_ROWS: ConcreteReviewQueueRow[] = [];

type Load =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; queue: ConcreteReviewQueue };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Where a row opens: the exact report and version (strength reports open by their set). */
function rowHref(row: ConcreteReviewQueueRow): string {
  if (row.reportType === 'strength' && row.setId) return `/concrete/strength/${row.setId}`;
  return `/concrete/review/${row.reportId}?version=${row.versionNo}`;
}

function routedText(row: ConcreteReviewQueueRow, myId: string): string {
  const name = (person: { userId: string; name: string } | null) =>
    person ? (person.userId === myId ? 'You' : person.name) : null;
  switch (row.status) {
    case 'awaiting_review':
      return name(row.route.routedTo) ?? 'Any designated reviewer';
    case 'returned':
      return row.returnedBy
        ? `Returned by ${name(row.returnedBy)}${row.returnedAt ? `, ${shortDateTime(row.returnedAt)}` : ''}`
        : 'Returned';
    case 'reviewed_awaiting_issue':
      return row.reviewedBy
        ? `Reviewed by ${name(row.reviewedBy)}${row.reviewedAt ? `, ${shortDateTime(row.reviewedAt)}` : ''}`
        : 'Reviewed';
    case 'issued':
      return row.issuedBy
        ? `Issued by ${name(row.issuedBy)}${row.issuedAt ? `, ${shortDateTime(row.issuedAt)}` : ''}`
        : 'Issued';
  }
}

function ExceptionsCell({ row }: { row: ConcreteReviewQueueRow }) {
  const total = row.exceptions.reduce((n, e) => n + e.count, 0);
  if (total === 0) return <span className="text-muted-foreground">None</span>;
  const open = Math.max(0, total - row.documentedCount);
  const names = row.exceptions
    .map((e) => `${CONCRETE_EXCEPTION_LABEL[e.code]}${e.count > 1 ? ` ×${e.count}` : ''}`)
    .join(', ');
  const waiting = row.status === 'awaiting_review' || row.status === 'returned';
  return (
    <span className="flex min-w-0 items-center gap-2" title={names}>
      {waiting && open > 0 ? (
        <Badge variant="danger" className="shrink-0">
          {open} open
        </Badge>
      ) : (
        <Badge variant="closed" className="shrink-0">
          {total} documented
        </Badge>
      )}
      <span className="min-w-0 truncate text-muted-foreground">{names}</span>
    </span>
  );
}

/** A modified click (new tab) follows the link; a plain one opens the row like the table. */
function rowLinkClick(event: MouseEvent<HTMLAnchorElement>, open: () => void) {
  event.stopPropagation();
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  open();
}

export function ReviewQueuePage() {
  const me = useMe();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const [density, setDensity] = useTableDensity('concrete-review-queue');
  const tab: QueueTab = TABS.find((t) => t.id === params.get('status'))?.id ?? 'awaiting_review';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const search = useDebounced(query.search, 250);
  const [attempt, setAttempt] = useState(0);
  const filters = query.filters;
  const sort = query.sort && SORT_KEYS.has(query.sort.key) ? query.sort : null;

  // Filters: both of a pair on is the same as neither.
  const exceptions =
    tab === 'open_exceptions'
      ? 'any'
      : filters.includes('with') === filters.includes('without')
        ? 'any'
        : filters.includes('with')
          ? 'with'
          : 'without';
  const reportType =
    filters.includes('field') === filters.includes('strength')
      ? undefined
      : filters.includes('field')
        ? 'field'
        : 'strength';
  const mine = filters.includes('mine');

  // Each answer is kept with the request it answers; one for an earlier tab, page, search or
  // retry never fills the table (it reads as loading until the current answer arrives).
  const request = {
    status: tab,
    search: search.trim() || undefined,
    exceptions,
    reportType,
    mine: mine ? ('true' as const) : undefined,
    sort: sort?.key as 'submitted' | 'project' | 'report_date' | undefined,
    dir: sort?.dir,
    page,
  };
  const requestKey = JSON.stringify([request, attempt]);
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };
  // Tab counts stay from the last answer while the next one loads.
  const [counts, setCounts] = useState<Record<QueueTab, number> | null>(null);

  useEffect(() => {
    let current = true;
    fetchReviewQueue(JSON.parse(requestKey)[0]).then(
      (queue) => {
        if (!current) return;
        setCounts({ ...queue.counts, open_exceptions: queue.openExceptionCount });
        setAnswer({ key: requestKey, load: { state: 'ready', queue } });
      },
      () => current && setAnswer({ key: requestKey, load: { state: 'error' } }),
    );
    return () => {
      current = false;
    };
  }, [requestKey]);

  const rows = load.state === 'ready' ? load.queue.items : NO_ROWS;
  const total = load.state === 'ready' ? load.queue.total : 0;
  const pageSize = load.state === 'ready' ? load.queue.pageSize : CONCRETE_REVIEW_QUEUE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;

  const setPage = (next: number) =>
    setParams((currentParams) => {
      const copy = new URLSearchParams(currentParams);
      if (next > 1) copy.set('page', String(next));
      else copy.delete('page');
      return copy;
    });

  const changeTab = (next: string) =>
    setParams((currentParams) => {
      const copy = new URLSearchParams(currentParams);
      if (next === 'awaiting_review') copy.delete('status');
      else copy.set('status', next);
      copy.delete('page');
      // A sort or filter the next tab doesn't offer is dropped with the tab change.
      if (next === 'open_exceptions') {
        const kept = copy.getAll('filter').filter((f) => f !== 'with' && f !== 'without');
        copy.delete('filter');
        for (const f of kept) copy.append('filter', f);
      }
      return copy;
    });

  const open = useCallback((row: ConcreteReviewQueueRow) => navigate(rowHref(row)), [navigate]);

  // J/K from anywhere on the page start on the first row; once a row has focus the table moves
  // between rows itself, in the order shown (the server's sort and filters).
  const tableId = 'review-queue-table';
  usePeekKeys({
    enabled: rows.length > 0,
    onNext: () => focusRow(tableId, 'next'),
    onPrevious: () => focusRow(tableId, 'previous'),
  });

  const filterOptions: QueryFilterOption[] = [
    { id: 'mine', label: 'Needs my action' },
    ...(tab === 'open_exceptions'
      ? []
      : [
          { id: 'with', label: 'With exceptions' },
          { id: 'without', label: 'Without exceptions' },
        ]),
    { id: 'field', label: 'Field reports' },
    { id: 'strength', label: 'Strength reports' },
  ];

  const columns = useQueueColumns(me.id, open);
  const caption = TABS.find((t) => t.id === tab)!.caption;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Concrete review</h1>
      <Tabs value={tab} onValueChange={changeTab} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList
            aria-label="Queue status"
            className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
          >
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
                {counts ? (
                  <span className="text-muted-foreground tabular-nums">{counts[t.id]}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <TableToolbar
            label="Review queue tools"
            query={{ ...query, view: density === 'comfortable' ? null : density }}
            onQueryChange={(patch) => {
              if (patch.view !== undefined) {
                setDensity(
                  DENSITY_VIEW_OPTIONS.find((v) => v.id === patch.view)?.id ?? 'comfortable',
                );
                return;
              }
              setQuery(patch);
            }}
            filters={filterOptions}
            sortOptions={sortOptions(tab)}
            sortLabels={SORT_LABELS}
            views={DENSITY_VIEW_OPTIONS}
            searchPlaceholder="Search reports…"
          />
        </div>
        <TabsContent value={tab} className="flex min-w-0 flex-col gap-3">
          {load.state === 'error' ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Couldn’t load the review queue</AlertTitle>
              <AlertDescription>
                <p>
                  Check that this computer is on the office network, then try again. Nothing was
                  changed.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  <RotateCw aria-hidden="true" />
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : load.state === 'ready' && rows.length === 0 ? (
            <QueueEmpty
              tab={tab}
              search={search.trim()}
              filtered={filters.length > 0}
              onClear={() => setQuery({ search: '', filters: [] })}
            />
          ) : (
            <>
              {load.state === 'ready' ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {total > pageSize
                    ? `Showing ${first}–${first + rows.length - 1} of ${total} reports`
                    : `${total} ${total === 1 ? 'report' : 'reports'}`}
                </p>
              ) : null}
              <div id={tableId}>
                <DataTable
                  caption={`Concrete review: ${caption}`}
                  columns={columns}
                  data={rows}
                  getRowId={(row) => row.reportId}
                  rowLabel={(row) =>
                    `${row.projectNumber} ${CONCRETE_REPORT_KIND_LABEL[row.reportType]}`
                  }
                  density={density}
                  loading={load.state === 'loading'}
                  sort={sort}
                  onSortChange={(next) => setQuery({ sort: next })}
                  stage={(row) => STATUS_STAGE[row.status]}
                  onOpenRow={open}
                />
              </div>
              {load.state === 'ready' ? (
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Kbd>J</Kbd> <Kbd>K</Kbd> move between reports · <Kbd>Enter</Kbd> opens
                  </span>
                  <span>Your own reports are listed but reviewed by someone else.</span>
                </p>
              ) : null}
            </>
          )}
          {total > pageSize ? (
            <nav className="flex items-center justify-end gap-2" aria-label="Pages">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="text-sm tabular-nums">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </nav>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

const STATUS_STAGE = {
  awaiting_review: 'due',
  returned: 'danger',
  reviewed_awaiting_issue: 'due',
  issued: 'closed',
} as const;

/** Moves focus to the next or previous row from the focused one, or to the first row. */
function focusRow(tableId: string, direction: 'next' | 'previous') {
  const rows = Array.from(
    document.querySelectorAll<HTMLTableRowElement>(`#${tableId} tr[data-row-id]`),
  );
  if (rows.length === 0) return;
  const at = rows.findIndex((row) => row === document.activeElement);
  const index =
    at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (direction === 'next' ? 1 : -1)));
  rows[index]!.focus();
}

function QueueEmpty({
  tab,
  search,
  filtered,
  onClear,
}: {
  tab: QueueTab;
  search: string;
  filtered: boolean;
  onClear: () => void;
}) {
  if (search || filtered) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {search ? `No reports match “${search}”.` : 'No reports match these filters.'}
          </EmptyTitle>
          <EmptyDescription>
            Search looks at project numbers and names, technicians and set labels.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onClear}>
            Clear search and filters
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCheck aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          {tab === 'issued' ? 'No issued reports to show.' : 'Nothing here needs your action.'}
        </EmptyTitle>
        <EmptyDescription>
          Only reports on projects you can see are listed. A report appears here when it reaches
          this stage.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function useQueueColumns(
  myId: string,
  open: (row: ConcreteReviewQueueRow) => void,
): DataTableColumn<ConcreteReviewQueueRow>[] {
  return useMemo(
    () => [
      {
        id: 'project',
        header: 'Project',
        priority: 'identity',
        sortKey: 'project',
        control: true,
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2" title={row.projectName}>
            <Button
              variant="link"
              asChild
              className="h-auto p-0 font-mono font-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid [&:hover]:underline"
            >
              <Link to={rowHref(row)} onClick={(event) => rowLinkClick(event, () => open(row))}>
                {row.projectNumber}
              </Link>
            </Button>
            <span className="min-w-0 truncate text-muted-foreground">{row.projectName}</span>
          </span>
        ),
      },
      {
        id: 'reportDate',
        header: 'Report date',
        priority: 'identity',
        mono: true,
        width: '10ch',
        sortKey: 'report_date',
        cell: (row) => row.reportDate ?? '—',
      },
      {
        id: 'type',
        header: 'Report type',
        priority: 'identity',
        width: '11rem',
        cell: (row) =>
          `${CONCRETE_REPORT_KIND_LABEL[row.reportType]}${row.setLabel ? ` ${row.setLabel}` : ''}`,
      },
      {
        id: 'technician',
        header: 'Technician',
        priority: 'attribute',
        width: '10rem',
        hideOrder: 3,
        cell: (row) =>
          row.technician ? (
            <PersonCell name={row.technician.name} userId={row.technician.userId} />
          ) : (
            '—'
          ),
      },
      {
        id: 'routed',
        header: 'Routed to',
        priority: 'attribute',
        width: '13rem',
        hideOrder: 2,
        wrap: true,
        cell: (row) => (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{routedText(row, myId)}</span>
            {row.canAct ? (
              <Badge variant="outline" className="shrink-0">
                Your action
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'version',
        header: 'Version',
        priority: 'attribute',
        width: '7rem',
        hideOrder: 1,
        control: true,
        cell: (row) => (
          <span className="flex items-center gap-2">
            <span className="font-mono">v{row.versionNo}</span>
            {row.revised ? <Badge variant="outline">Revised</Badge> : null}
          </span>
        ),
      },
      {
        id: 'exceptions',
        header: 'Exceptions',
        priority: 'state',
        width: '12rem',
        cell: (row) => <ExceptionsCell row={row} />,
      },
    ],
    [myId, open],
  );
}
