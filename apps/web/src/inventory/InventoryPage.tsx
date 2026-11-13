import {
  INVENTORY_STAGE_TABS,
  INVENTORY_STAGE_TAB_LABELS,
  type InventoryListItem,
  type InventoryListPage,
  type InventoryLocation,
  type InventoryStageCounts,
  type InventoryStageTab,
} from '@materialmule/shared';
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Move,
  PackageOpen,
  Printer,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { DENSITY_VIEW_OPTIONS, useTableDensity } from '../components/strata/data-table';
import {
  PeekSplit,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '../components/strata/peek';
import type { QueryFilterOption } from '../components/strata/query-chips';
import {
  readTableQuery,
  writeTableQuery,
  type SortLabels,
  type SortOption,
  type TableQuery,
} from '../components/strata/table-query';
import { TableToolbar } from '../components/strata/table-toolbar';
import { usePageTitle } from '../layout/page-title';
import { movePathForUnits, type MoveLinkState } from '../moves/move-link';
import { usePendingMoves } from '../moves/usePendingMoves';
import { MAX_CHOSEN_LABELS, unitsLabelPrintPath } from '../printing/print-paths';
import { START_DELIVERY_PATH } from '../receiving-log/paths';
import { CameraScanButton } from '../scanning/CameraScanButton';
import { useMe } from '../session/context';
import { fetchInventoryList, fetchLocations } from './api';
import { STORAGE_UNIT_COLUMNS } from './list-columns';
import { InventoryFilterChips } from './list-filter-chips';
import { StorageUnitTable } from './StorageUnitTable';
import { UnitDrawer } from './UnitDrawer';
import { UNIT_DRAWER_TITLE_ID } from './unit-record';
import { useLatestSearchParams } from './useLatestSearchParams';
import {
  INVENTORY_FILTERS,
  INVENTORY_FILTER_LABELS,
  clearedParams,
  filterHasValue,
  hasActiveFilters,
  inventoryRequest,
  inventoryRequestParams,
  readInventoryTable,
  readStage,
  selectionScope,
  withPendingFilter,
  withStage,
  withoutFilter,
  type InventoryFilter,
} from './url-state';

/** Where the detail page's "Back to inventory" link returns to. */
export interface InventoryLinkState {
  from?: string;
}

type Loaded =
  { key: string; ok: true; data: InventoryListPage } | { key: string; ok: false; message: string };

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Received, newest first', sort: null },
  { label: 'Received, oldest first', sort: { key: 'received', dir: 'asc' } },
  { label: 'ID', sort: { key: 'id', dir: 'asc' } },
  { label: 'Retain until, soonest first', sort: { key: 'retain_until', dir: 'asc' } },
  { label: 'Where', sort: { key: 'where', dir: 'asc' } },
];
const SORT_LABELS: SortLabels = {
  received: { asc: 'Received, oldest first', desc: 'Received, newest first' },
  id: { asc: 'ID A–Z', desc: 'ID Z–A' },
  retain_until: { asc: 'Retain until, soonest first', desc: 'Retain until, latest first' },
  project: { asc: 'Project A–Z', desc: 'Project Z–A' },
  type: { asc: 'Type A–Z', desc: 'Type Z–A' },
  where: { asc: 'Where A–Z', desc: 'Where Z–A' },
  stage: { asc: 'Stage, lifecycle order', desc: 'Stage, reverse lifecycle order' },
};

const FILTER_OPTIONS: QueryFilterOption[] = INVENTORY_FILTERS.map((id) => ({
  id,
  label: INVENTORY_FILTER_LABELS[id],
}));

const COLUMNS_STORAGE_KEY = 'materialmule:inventory-hidden-columns';
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

/** Hidden columns, remembered in this browser (locked columns can't be hidden). */
function useHiddenColumns(): [string[], (ids: string[]) => void] {
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(COLUMNS_STORAGE_KEY) ?? '[]');
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  });
  const set = useCallback((ids: string[]) => {
    const allowed = ids.filter((id) =>
      STORAGE_UNIT_COLUMNS.some((c) => c.id === id && !('locked' in c && c.locked)),
    );
    setHidden(allowed);
    try {
      window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(allowed));
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, []);
  return [hidden, set];
}

function countLabel(total: number): string {
  return `${total.toLocaleString('en-CA')} storage ${total === 1 ? 'unit' : 'units'}`;
}

/**
 * Inventory (`/sample-storage`, STRATA-79, canvas R3Inventory*): stage tabs with live counts in
 * lifecycle order (a Stage select when the list is under 40rem wide), the filter chip row, the
 * table tools, and the storage unit table, all searched, filtered, counted, sorted and paged on
 * the server. Rows open the unit drawer (`?open=<ID>`) at 1024 px and wider, the unit page
 * otherwise. Ticked rows show a selection bar (Move, Print labels, Clear). Selection is kept
 * across pages of one query and cleared when the tab, search or a filter changes; a sort change
 * keeps it (the same units).
 */
export function InventoryPage() {
  usePageTitle('Inventory');
  const [params, setParams] = useLatestSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const me = useMe();
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();
  const [density, setDensity] = useTableDensity('inventory');
  const [hiddenColumns, setHiddenColumns] = useHiddenColumns();
  const [openFilter, setOpenFilter] = useState<InventoryFilter | null>(null);

  // MM-T81: this device's unsaved moves for the signed-in account only. When one settles in
  // another tab, the rows are fetched again (same filters and page) for the new location or
  // conflict (review fix, #107).
  const [reloads, setReloads] = useState(0);
  const pendingMoves = usePendingMoves(me.id, { onSettled: () => setReloads((n) => n + 1) });

  const stage = readStage(params);
  const table = readInventoryTable(params);
  const search = useDebounced(table.search, SEARCH_DEBOUNCE_MS);
  const { query, ignored } = useMemo(() => inventoryRequest(params, search), [params, search]);
  const requestKey = inventoryRequestParams(query).toString();

  const [result, setResult] = useState<Loaded | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchInventoryList(new URLSearchParams(requestKey)).then((response) => {
      // Only the newest query's answer is shown; an older, slower one is dropped.
      if (cancelled) return;
      setResult(
        response.ok
          ? { key: requestKey, ok: true, data: response.data }
          : { key: requestKey, ok: false, message: response.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);

  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchLocations().then((response) => {
      if (!cancelled && response.ok) setLocations(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = !result || result.key !== requestKey;
  const failed = !loading && result && !result.ok ? result : null;
  // While a newer query loads, the previous rows (and counts) stay, marked busy.
  const [shown, setShown] = useState<InventoryListPage | null>(null);
  if (result?.ok && result.data !== shown) setShown(result.data);
  const page = shown;
  const items = useMemo(() => page?.items ?? [], [page]);
  const counts = page?.stageCounts ?? null;
  const filtered = hasActiveFilters(params);
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;
  const linkState: InventoryLinkState = { from: location.search };

  // Selection: readable ID → row, for the exact units ticked (STRATA-79).
  const scope = selectionScope(query);
  const [selection, setSelection] = useState<{
    scope: string;
    items: Map<string, InventoryListItem>;
  }>(() => ({ scope, items: new Map() }));
  if (selection.scope !== scope) setSelection({ scope, items: new Map() });
  // Until the reset above renders, a selection from another scope reads as empty.
  const selected = useMemo(
    () => (selection.scope === scope ? selection.items : new Map<string, InventoryListItem>()),
    [selection, scope],
  );
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const onSelectedIdsChange = (next: Set<string>) => {
    const map = new Map(selected);
    for (const item of items) {
      if (next.has(item.readableId)) map.set(item.readableId, item);
      else map.delete(item.readableId);
    }
    setSelection({ scope, items: map });
  };
  const clearSelection = () => setSelection({ scope, items: new Map() });
  const selectedItems = [...selected.values()];
  // Disposed units are never moved or given a fresh label (MTR-48).
  const movable = selectedItems.filter((item) => item.status !== 'disposed');
  const canMove = me.permissions.includes('storage_unit.move');
  const canPrint = me.permissions.includes('label.print');

  // The drawer.
  const openId = peekAvailable ? peek.openId : null;
  const openItem = openId ? items.find((item) => item.readableId === openId) : undefined;
  const nav = peekNeighbours(
    items.map((item) => item.readableId),
    openId,
  );
  usePeekKeys({
    enabled: openId !== null,
    onClose: peek.close,
    onPrevious: nav.previousId ? () => peek.open(nav.previousId!) : undefined,
    onNext: nav.nextId ? () => peek.open(nav.nextId!) : undefined,
  });
  const openRow = useCallback(
    (item: InventoryListItem) => {
      if (peekAvailable) peek.open(item.readableId);
      else
        navigate(`/sample-storage/${encodeURIComponent(item.readableId)}`, {
          state: { from: location.search } satisfies InventoryLinkState,
        });
    },
    [peekAvailable, peek, navigate, location.search],
  );

  // The table tools: the toolbar's Filter menu lists the chips; search and sort are lane 1B's
  // URL keys. Every change builds on the newest URL (MM-T46).
  const activeFilters = INVENTORY_FILTERS.filter(
    (f) => filterHasValue(params, f) || table.filters.includes(f),
  );
  const toolbarQuery: TableQuery = { ...table, filters: activeFilters, view: density };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    if (patch.view === 'comfortable' || patch.view === 'compact') setDensity(patch.view);
    if (patch.filters) {
      const next = patch.filters as InventoryFilter[];
      setParams((prev) => {
        let updated = prev;
        for (const f of activeFilters) if (!next.includes(f)) updated = withoutFilter(updated, f);
        for (const f of next) {
          if (!activeFilters.includes(f)) updated = withPendingFilter(updated, f, true);
        }
        return updated;
      });
    }
    if (patch.search !== undefined || patch.sort !== undefined) {
      setParams(
        (prev) => {
          const current = readTableQuery(prev);
          return writeTableQuery(prev, {
            ...current,
            ...(patch.search !== undefined ? { search: patch.search } : {}),
            ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
          });
        },
        { replace: Object.keys(patch).every((key) => key === 'search') },
      );
    }
  };

  function setStage(next: InventoryStageTab) {
    setParams((prev) => withStage(prev, next));
  }

  function turnPage(by: number) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = Math.max(1, Number.parseInt(prev.get('page') ?? '1', 10) || 1);
      const target = Math.max(1, current + by);
      if (target === 1) next.delete('page');
      else next.set('page', String(target));
      return next;
    });
  }

  const clearFilters = () => setParams((prev) => clearedParams(prev));

  const onListKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || selected.size === 0 || openId !== null) return;
    if ((event.target as HTMLElement).closest('input, [role="menu"], [role="dialog"]')) return;
    event.preventDefault();
    clearSelection();
  };

  const firstRow = page ? (page.page - 1) * page.pageSize + 1 : 0;
  const lastRow = page ? Math.min(page.total, page.page * page.pageSize) : 0;
  const sortWords =
    SORT_OPTIONS.find(
      (o) =>
        (o.sort === null && table.sort === null) ||
        (o.sort && table.sort && o.sort.key === table.sort.key && o.sort.dir === table.sort.dir),
    )?.label ??
    (table.sort ? SORT_LABELS[table.sort.key]?.[table.sort.dir] : undefined) ??
    'Received, newest first';

  let body;
  if (failed && !page) {
    body = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Storage units couldn’t load.</EmptyTitle>
          <EmptyDescription>
            {failed.message} Check that this computer is on the office network, then try again. If
            it keeps failing, tell your Lab Manager.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => setReloads((n) => n + 1)}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else if (page && page.total === 0 && !loading) {
    body = filtered ? (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No storage units match this search and these filters.</EmptyTitle>
          <EmptyDescription>
            Remove a filter, or check the ID and scan the label again.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        </EmptyContent>
      </Empty>
    ) : stage === 'all' ? (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PackageOpen aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No storage units yet.</EmptyTitle>
          <EmptyDescription>
            Receive samples to add the first. Each unit gets its ID and label when the receipt is
            confirmed.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link to={START_DELIVERY_PATH}>
              <ArrowDownToLine aria-hidden="true" />
              Receive samples
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    ) : (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>
            {stage === 'conflicts'
              ? 'No location conflicts.'
              : `No storage units in ${INVENTORY_STAGE_TAB_LABELS[stage]}.`}
          </EmptyTitle>
          <EmptyDescription>
            {stage === 'conflicts'
              ? 'Every storage unit has one place recorded.'
              : 'Units show here when they reach this stage.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div aria-busy={loading} onKeyDown={onListKeyDown}>
        {stage === 'conflicts' ? (
          <p className="mb-3 text-sm text-muted-foreground">
            Each unit has two places recorded. Scan it where it really is to fix it.
          </p>
        ) : null}
        <StorageUnitTable
          items={items}
          caption="Storage units"
          linkState={linkState}
          density={density}
          pendingMoves={pendingMoves}
          selectedIds={selectedIds}
          onSelectedIdsChange={onSelectedIdsChange}
          sort={table.sort}
          onSortChange={(sort) => onQueryChange({ sort })}
          onOpenRow={openRow}
          openRowId={openId}
          hiddenColumns={hiddenColumns}
          loading={!page}
        />
        {failed ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {failed.message}{' '}
            <Button variant="link" className="h-auto p-0" onClick={() => setReloads((n) => n + 1)}>
              Try again
            </Button>
          </p>
        ) : null}
      </div>
    );
  }

  const list = (
    <div className="flex min-h-full flex-col gap-3 px-6 pt-5 pb-24 @max-[40rem]/list:px-4">
      <h1 className="sr-only">Inventory</h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StageTabs stage={stage} counts={counts} onChange={setStage} />
        <div className="ml-auto flex items-center gap-1">
          <Button asChild variant="outline" size="sm" className="sm:hidden">
            <Link to="/sample-storage/scan">Scan labels</Link>
          </Button>
          <CameraScanButton />
          <TableToolbar
            label="Storage unit tools"
            query={toolbarQuery}
            onQueryChange={onQueryChange}
            pageAction={{
              label: 'Receive samples',
              icon: ArrowDownToLine,
              onClick: () => navigate(START_DELIVERY_PATH),
            }}
            filters={FILTER_OPTIONS}
            filterChips={false}
            sortOptions={SORT_OPTIONS}
            sortLabels={SORT_LABELS}
            views={DENSITY_VIEW_OPTIONS}
            columns={STORAGE_UNIT_COLUMNS}
            hiddenColumns={hiddenColumns}
            onHiddenColumnsChange={setHiddenColumns}
            searchPlaceholder="Search storage units…"
          />
        </div>
      </div>

      <InventoryFilterChips
        params={params}
        update={setParams}
        locations={locations}
        openFilter={openFilter}
        onOpenFilterChange={setOpenFilter}
        onClearFilters={clearFilters}
        filtered={filtered}
      />

      {ignored ? (
        <p className="text-sm text-muted-foreground" role="status">
          Part of this link wasn’t valid and was left out.
        </p>
      ) : null}

      {body}

      {page && page.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted-foreground">
          <p>
            <span className="tabular-nums">
              {firstRow.toLocaleString('en-CA')}–{lastRow.toLocaleString('en-CA')} of{' '}
            </span>
            <span role="status" aria-live="polite" aria-busy={loading}>
              {countLabel(page.total)}
            </span>
            <span> · {sortWords.charAt(0).toLowerCase() + sortWords.slice(1)}</span>
          </p>
          {page.total > page.pageSize ? (
            <nav aria-label="Pages" className="flex items-center gap-2">
              <span className="tabular-nums">
                Page {page.page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous page"
                disabled={page.page <= 1}
                onClick={() => turnPage(-1)}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next page"
                disabled={page.page >= totalPages}
                onClick={() => turnPage(1)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          ) : null}
        </div>
      ) : page && !loading ? (
        <p className="sr-only" role="status">
          {countLabel(page.total)}
        </p>
      ) : null}

      {selected.size > 0 ? (
        <div
          role="group"
          aria-label="Selection"
          onKeyDown={onListKeyDown}
          className="sticky bottom-4 z-20 mx-auto flex flex-wrap items-center gap-2 rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg dark:shadow-none"
        >
          <span className="text-sm font-semibold whitespace-nowrap">{selected.size} selected</span>
          <Separator orientation="vertical" className="mx-1 h-5!" />
          {canMove ? (
            <Button
              size="sm"
              disabled={movable.length === 0}
              title={movable.length === 0 ? 'Disposed units can’t be moved' : undefined}
              onClick={() => {
                const units = movable.map((item) => item.readableId);
                navigate(movePathForUnits(units), { state: { units } satisfies MoveLinkState });
              }}
            >
              <Move aria-hidden="true" />
              Move
            </Button>
          ) : null}
          {canPrint ? (
            <Button
              variant="outline"
              size="sm"
              disabled={movable.length === 0 || movable.length > MAX_CHOSEN_LABELS}
              title={
                movable.length > MAX_CHOSEN_LABELS
                  ? `Print up to ${MAX_CHOSEN_LABELS} labels at a time`
                  : movable.length === 0
                    ? 'Disposed units get no new label'
                    : undefined
              }
              onClick={() => navigate(unitsLabelPrintPath(movable.map((item) => item.readableId)))}
            >
              <Printer aria-hidden="true" />
              Print labels
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" title="Clear selection (Esc)" onClick={clearSelection}>
            <X aria-hidden="true" />
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <PeekSplit
      className="h-full min-h-0"
      open={openId !== null}
      openId={openId}
      listLabel="Storage units"
      drawerLabelledBy={UNIT_DRAWER_TITLE_ID}
      list={list}
      drawer={
        openId ? (
          <UnitDrawer
            key={openId}
            readableId={openId}
            retention={openItem?.retention}
            toolbar={{
              onClose: peek.close,
              position: nav.index >= 0 ? { index: nav.index, total: nav.total } : undefined,
              onPrevious: nav.previousId ? () => peek.open(nav.previousId!) : undefined,
              onNext: nav.nextId ? () => peek.open(nav.nextId!) : undefined,
            }}
          />
        ) : null
      }
    />
  );
}

/**
 * The stage tabs with their counts, in lifecycle order; under 40rem of list width (a drawer
 * open, a narrow window) a Stage select with the same options and counts, so tabs never wrap.
 */
function StageTabs({
  stage,
  counts,
  onChange,
}: {
  stage: InventoryStageTab;
  counts: InventoryStageCounts | null;
  onChange: (stage: InventoryStageTab) => void;
}) {
  const count = (tab: InventoryStageTab) =>
    counts ? (
      <span
        className={cn(
          'font-mono text-[11px] text-muted-foreground',
          tab === 'conflicts' && counts.conflicts > 0 && 'font-semibold text-stage-danger-fg',
        )}
      >
        {counts[tab].toLocaleString('en-CA')}
      </span>
    ) : null;
  return (
    <>
      <Tabs
        value={stage}
        onValueChange={(value) => onChange(value as InventoryStageTab)}
        className="max-w-full min-w-0 @max-[40rem]/list:hidden"
      >
        <TabsList aria-label="Stage" className="h-auto max-w-full justify-start">
          {INVENTORY_STAGE_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab} className="flex-none gap-1.5">
              {INVENTORY_STAGE_TAB_LABELS[tab]} {count(tab)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="hidden @max-[40rem]/list:block">
        <Select value={stage} onValueChange={(value) => onChange(value as InventoryStageTab)}>
          <SelectTrigger aria-label="Stage" className="h-9 w-52">
            <span className="text-[13px] text-muted-foreground">Stage</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INVENTORY_STAGE_TABS.map((tab) => (
              <SelectItem key={tab} value={tab}>
                {INVENTORY_STAGE_TAB_LABELS[tab]} {count(tab)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
