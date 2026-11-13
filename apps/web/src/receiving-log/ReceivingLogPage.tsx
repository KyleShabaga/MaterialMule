import {
  RECEIPT_LOG_STATUS_LABELS,
  type ReceiptLogItem,
  type ReceiptLogPage as ReceiptLogPageData,
} from '@materialmule/shared';
import { ArrowDownToLine } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  DataTable,
  DENSITY_VIEW_OPTIONS,
  useTableDensity,
  type DataTableColumn,
} from '@/components/strata/data-table';
import {
  PeekSplit,
  PeekToolbar,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '@/components/strata/peek';
import { PersonCell } from '@/components/strata/person-avatar';
import type { QueryFilterOption } from '@/components/strata/query-chips';
import { StageTag } from '@/components/strata/stage-tag';
import { TableToolbar } from '@/components/strata/table-toolbar';
import {
  useTableQuery,
  type SortLabels,
  type SortOption,
  type TableQuery,
} from '@/components/strata/table-query';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { usePageTitle } from '../layout/page-title';
import { useOnline } from '../lib/online';
import { DraftItems } from '../receiving/drafts/DraftItems';
import {
  deleteDraft,
  registerPendingDrafts,
  useDraftOwnership,
} from '../receiving/drafts/ownership';
import { visibleTo, type StoredDraft } from '../receiving/drafts/record';
import { indexedDbDraftStore } from '../receiving/drafts/store';
import { useMe } from '../session/context';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import { fetchReceiptLog, type ReceiptLogResult } from './api';
import { formatClock, formatReceiver } from './format';
import { continueDraftPath, START_DELIVERY_PATH } from './paths';
import { ReceiptRecord } from './ReceiptDetailPage';
import {
  STATUS_FILTER,
  clearedParams,
  hasActiveFilters,
  normalizeFilters,
  projectFilter,
  receiptLogQueryFor,
  receiptLogSearchParams,
  receiverFilter,
} from './url-state';

/** Where the receipt page's breadcrumb returns to. */
export interface ReceiptLinkState {
  from?: string;
}

type Loaded = { key: string; result: ReceiptLogResult<ReceiptLogPageData> };

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Newest first', sort: null },
  { label: 'Oldest first', sort: { key: 'received', dir: 'asc' } },
  { label: 'Most units first', sort: { key: 'units', dir: 'desc' } },
];
const SORT_LABELS: SortLabels = {
  received: { asc: 'Received, oldest first', desc: 'Received, newest first' },
  project: { asc: 'Project A–Z', desc: 'Project Z–A' },
  units: { asc: 'Fewest units first', desc: 'Most units first' },
};

/** Searching waits this long after typing before asking the server. */
const SEARCH_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, delay: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return shown;
}

/**
 * Receiving log (MM-T51, STRATA-78, canvas R2LogContent): "Drafts on this computer" (Items with
 * Continue and Delete draft, never inventory) above the confirmed receipts in the table tools
 * pattern: server-backed search, filters (project, received by, status), sort and paging, all in
 * the URL. Receipts have no number, so the received date and time is the row's link; rows open
 * the receipt in the drawer (`?open=`) on wide screens and the receipt page otherwise.
 */
export function ReceivingLogPage() {
  usePageTitle('Receiving log');
  const me = useMe();
  const online = useOnline();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [table, setTableRaw] = useTableQuery();
  const setTable = useCallback(
    (patch: Partial<TableQuery>) =>
      setTableRaw(patch.filters ? { ...patch, filters: normalizeFilters(patch.filters) } : patch),
    [setTableRaw],
  );
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();
  const [density, setDensity] = useTableDensity('receiving-log');

  // Older links (projectId=, receiverUserId=) become the table tools' filters.
  useEffect(() => {
    const project = params.get('projectId');
    const receiver = params.get('receiverUserId');
    if (!project && !receiver) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('projectId');
        next.delete('receiverUserId');
        if (project) next.append('filter', projectFilter(project));
        if (receiver) next.append('filter', receiverFilter(receiver));
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);

  const search = useDebounced(table.search, SEARCH_DEBOUNCE_MS);
  const { query, ignored } = useMemo(
    () => receiptLogQueryFor({ ...table, search }, params),
    [table, search, params],
  );
  const requestKey = receiptLogSearchParams(query).toString();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchReceiptLog(new URLSearchParams(requestKey)).then((result) => {
      // Only the newest query's answer is shown; an older, slower one is dropped.
      if (!cancelled) setLoaded({ key: requestKey, result });
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);

  const current = loaded?.key === requestKey ? loaded.result : null;
  // While a newer query loads, the previous rows stay visible but marked busy.
  const shown = loaded?.result.ok ? loaded.result.data : null;
  const failed = current && !current.ok ? current : null;
  const loading = current === null;
  const filtered = hasActiveFilters(table, params);
  const totalPages = shown ? Math.max(1, Math.ceil(shown.total / shown.pageSize)) : 1;

  // Labels for the project and person filters, learnt from the rows (and kept once seen).
  const [labels, setLabels] = useState<Map<string, string>>(() => new Map());
  const rows = useMemo(() => shown?.items ?? [], [shown]);
  // Merged while rendering when new rows arrive (no effect: React's "adjust state on change").
  const [labelledRows, setLabelledRows] = useState(rows);
  if (labelledRows !== rows) {
    setLabelledRows(rows);
    const next = new Map(labels);
    for (const row of rows) {
      next.set(projectFilter(row.project.id), `Project ${row.project.projectNumber}`);
      next.set(receiverFilter(row.receiver.userId), `Received by ${row.receiver.name}`);
    }
    setLabels(next);
  }

  const filters = useMemo<QueryFilterOption[]>(() => {
    const options: QueryFilterOption[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      options.push({ id, label });
    };
    if (me.accountType !== 'shared_lab') add(receiverFilter(me.id), 'Received by me');
    // The projects and people on this page, then any active one from a link.
    for (const row of rows.slice(0, 25)) {
      if (options.length >= 8) break;
      add(projectFilter(row.project.id), `Project ${row.project.projectNumber}`);
    }
    for (const row of rows.slice(0, 25)) {
      if (options.length >= 12) break;
      add(receiverFilter(row.receiver.userId), `Received by ${row.receiver.name}`);
    }
    for (const id of table.filters) {
      if (id.startsWith('project:') || id.startsWith('receiver:')) {
        add(id, labels.get(id) ?? (id.startsWith('project:') ? 'Project' : 'Received by'));
      }
    }
    add(STATUS_FILTER.confirmed, RECEIPT_LOG_STATUS_LABELS.confirmed);
    add(STATUS_FILTER.corrected, RECEIPT_LOG_STATUS_LABELS.corrected);
    return options;
  }, [me, rows, table.filters, labels]);

  const linkState: ReceiptLinkState = { from: location.search };
  const openRow = peekAvailable ? peek.openId : null;
  const nav = peekNeighbours(
    rows.map((r) => r.id),
    openRow,
  );
  usePeekKeys({
    enabled: openRow !== null,
    onClose: peek.close,
    onPrevious: nav.previousId ? () => peek.open(nav.previousId!) : undefined,
    onNext: nav.nextId ? () => peek.open(nav.nextId!) : undefined,
  });

  const openReceipt = useCallback(
    (row: ReceiptLogItem) => {
      if (peekAvailable) peek.open(row.id);
      else navigate(`/receiving-log/${row.id}`, { state: linkState });
    },
    // linkState is rebuilt every render from location.search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [peekAvailable, peek, navigate, location.search],
  );

  function turnPage(by: number) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const page = Math.max(1, query.page + by);
      if (page === 1) next.delete('page');
      else next.set('page', String(page));
      return next;
    });
  }

  function clearFilters() {
    setParams((prev) => clearedParams(prev));
  }

  const view = table.view ?? density;
  const tableDensity = view === 'compact' ? 'compact' : 'comfortable';

  const list = (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Receiving log</h1>
          <p className="text-sm text-muted-foreground">Every delivery, newest first.</p>
        </div>
        <Button asChild>
          <Link to={START_DELIVERY_PATH}>
            <ArrowDownToLine aria-hidden="true" />
            Receive samples
          </Link>
        </Button>
      </header>

      <LocalDrafts />

      <section aria-labelledby="receiving-log-receipts" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h2 id="receiving-log-receipts" className="text-base font-semibold">
              Receipts
            </h2>
            <span
              className="text-sm text-muted-foreground tabular-nums"
              role="status"
              aria-live="polite"
            >
              {loading && !shown
                ? 'Loading receipts…'
                : failed
                  ? 'Receipts didn’t load.'
                  : shown
                    ? `${shown.total.toLocaleString('en-CA')} ${shown.total === 1 ? 'receipt' : 'receipts'}`
                    : ''}
            </span>
          </div>
          <TableToolbar
            label="Receipt tools"
            query={table}
            onQueryChange={(patch) => {
              if (patch.view !== undefined && patch.view !== null) {
                setDensity(patch.view === 'compact' ? 'compact' : 'comfortable');
              }
              setTable(patch);
            }}
            filters={filters}
            sortOptions={SORT_OPTIONS}
            sortLabels={SORT_LABELS}
            views={DENSITY_VIEW_OPTIONS}
            searchPlaceholder="Search receipts…"
          />
        </div>

        {ignored ? (
          <p className="text-sm text-muted-foreground" role="status">
            Part of this link wasn’t valid and was left out.
          </p>
        ) : null}

        {failed ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Receipts didn’t load</EmptyTitle>
              <EmptyDescription>
                {failed.kind === 'offline' && !online
                  ? 'You’re offline. The Receiving log needs a connection to Material Mule. Drafts on this computer still open from the list above.'
                  : failed.message}
              </EmptyDescription>
            </EmptyHeader>
            {failed.kind !== 'unauthenticated' ? (
              <EmptyContent>
                <Button variant="outline" onClick={() => setReloads((n) => n + 1)}>
                  Try again
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : shown && shown.total === 0 && !loading ? (
          filtered ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No receipts match these filters.</EmptyTitle>
                <EmptyDescription>Change the search or clear the filters.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No receipts yet.</EmptyTitle>
                <EmptyDescription>
                  Confirmed deliveries are listed here, newest first.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild>
                  <Link to={START_DELIVERY_PATH}>Receive samples</Link>
                </Button>
              </EmptyContent>
            </Empty>
          )
        ) : (
          <div aria-busy={loading}>
            <ReceiptTable
              rows={rows}
              loading={loading && !shown}
              density={tableDensity}
              sort={table.sort}
              onSortChange={(sort) => setTable({ sort })}
              onOpen={openReceipt}
              openId={openRow}
              linkState={linkState}
              peekAvailable={peekAvailable}
            />
          </div>
        )}

        {!failed && shown && shown.total > shown.pageSize ? (
          <nav className="flex items-center gap-2 text-sm" aria-label="Pages">
            <Button
              variant="outline"
              size="sm"
              disabled={query.page <= 1}
              onClick={() => turnPage(-1)}
            >
              Previous
            </Button>
            <span className="text-muted-foreground tabular-nums">
              Page {query.page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={query.page >= totalPages}
              onClick={() => turnPage(1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );

  return (
    <PeekSplit
      className="h-full min-h-0"
      open={openRow !== null}
      openId={openRow}
      listLabel="Receiving log"
      drawerLabelledBy="receipt-peek-title"
      list={list}
      drawer={
        openRow ? (
          <>
            <PeekToolbar
              onClose={peek.close}
              fullPageHref={`/receiving-log/${openRow}`}
              position={{ index: nav.index, total: nav.total }}
              onPrevious={nav.previousId ? () => peek.open(nav.previousId!) : undefined}
              onNext={nav.nextId ? () => peek.open(nav.nextId!) : undefined}
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ReceiptRecord receiptId={openRow} variant="drawer" titleId="receipt-peek-title" />
            </div>
          </>
        ) : null
      }
    />
  );
}

function ReceiptTable({
  rows,
  loading,
  density,
  sort,
  onSortChange,
  onOpen,
  openId,
  linkState,
  peekAvailable,
}: {
  rows: ReceiptLogItem[];
  loading: boolean;
  density: 'comfortable' | 'compact';
  sort: TableQuery['sort'];
  onSortChange: (sort: TableQuery['sort']) => void;
  onOpen: (row: ReceiptLogItem) => void;
  openId: string | null;
  linkState: ReceiptLinkState;
  peekAvailable: boolean;
}) {
  const columns = useMemo<DataTableColumn<ReceiptLogItem>[]>(
    () => [
      {
        id: 'received',
        header: 'Received',
        priority: 'identity',
        sortKey: 'received',
        width: '10ch',
        cell: (row) => (
          <Link
            to={`/receiving-log/${row.id}`}
            state={linkState}
            className="grid justify-items-start text-foreground underline-offset-4 hover:underline"
            aria-label={`Open receipt: ${row.project.projectNumber}, received ${row.receivedDate} by ${formatReceiver(row.receiver)}`}
            onClick={(event: MouseEvent) => {
              // On wide screens the receipt opens in the drawer; modified clicks keep the link.
              if (!peekAvailable || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpen(row);
            }}
          >
            <span className="font-mono">{row.receivedDate}</span>
            <time className="text-xs text-muted-foreground" dateTime={row.confirmedAt}>
              {formatClock(row.confirmedAt)}
            </time>
          </Link>
        ),
      },
      {
        id: 'project',
        header: 'Project',
        priority: 'identity',
        sortKey: 'project',
        cell: (row) => (
          <span className="flex min-w-0 flex-col">
            <span className="font-mono">{row.project.projectNumber}</span>
            <span className="truncate text-muted-foreground">{row.project.name}</span>
          </span>
        ),
      },
      {
        id: 'units',
        header: 'Storage units',
        priority: 'attribute',
        sortKey: 'units',
        width: '14rem',
        hideOrder: 2,
        cell: (row) => {
          const ids = row.unitIds ?? [];
          const more = row.quantity - Math.min(ids.length, 1);
          return (
            <span className="flex items-baseline gap-2">
              <span className="tabular-nums">{row.quantity}</span>
              {ids[0] ? <span className="font-mono text-muted-foreground">{ids[0]}</span> : null}
              {ids[0] && more > 0 ? (
                <span className="text-muted-foreground" title={ids.join(', ')}>
                  +{more}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'receiver',
        header: 'Received by',
        priority: 'attribute',
        width: '11rem',
        hideOrder: 1,
        cell: (row) => (
          <PersonCell name={formatReceiver(row.receiver)} userId={row.receiver.userId} />
        ),
      },
      {
        id: 'status',
        header: 'Status',
        priority: 'state',
        width: '7rem',
        wrap: true,
        cell: (row) => (
          <StageTag stage="storage" label={RECEIPT_LOG_STATUS_LABELS[row.status ?? 'confirmed']} />
        ),
      },
    ],
    [linkState, onOpen, peekAvailable],
  );
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      rowLabel={(row) => `${row.project.projectNumber}, received ${row.receivedDate}`}
      density={density}
      sort={sort}
      onSortChange={onSortChange}
      stage={() => 'storage'}
      onOpenRow={onOpen}
      openRowId={openId}
      caption="Confirmed receipts"
      empty="No receipts."
      loading={loading}
      freeColumnMin="9rem"
    />
  );
}

/**
 * Drafts on this computer that the signed-in person may open (MM-T11 visibility), newest saved
 * first, with STRATA-108's delete rules. A draft never shows a storage unit ID.
 */
function LocalDrafts() {
  const me = useMe();
  const station = useOptionalRecordingPerson();
  const picked = station?.isStation ? (station.person?.id ?? null) : null;
  const [drafts, setDrafts] = useState<StoredDraft[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const { drafts: all } = await indexedDbDraftStore.list();
        const visible = all
          .filter((draft) => visibleTo(draft, me))
          .sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt));
        if (current) setDrafts(visible);
        // Drafts saved offline register now (best effort), so their starter is known.
        if (visible.some((d) => !d.legacy && !d.registeredAt)) {
          await registerPendingDrafts(indexedDbDraftStore, visible);
        }
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [me, reloads]);

  const ownership = useDraftOwnership(drafts, picked);

  if (failed) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Drafts on this computer couldn’t be read. They are still kept; open Receive samples to try
        again.
      </p>
    );
  }
  return (
    <DraftItems
      drafts={drafts}
      me={me}
      ownership={ownership}
      continueHref={(record) => continueDraftPath(record.draftId)}
      onDelete={async (record) => {
        await deleteDraft(indexedDbDraftStore, record, picked);
        setReloads((n) => n + 1);
      }}
    />
  );
}
