import {
  currentLocationName,
  formatStorageUnitHoleSummary,
  storageUnitStatusLabel,
  storageUnitTypeLabel,
  type InventoryItem,
  type InventoryPage,
} from '@materialmule/shared';
import { ChevronDown, Lock, PackageOpen, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DataTable,
  DENSITY_VIEW_OPTIONS,
  useTableDensity,
  type DataTableColumn,
} from '../components/strata/data-table';
import {
  PeekSplit,
  PeekToolbar,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '../components/strata/peek';
import { StageTag, UnitStatusTag } from '../components/strata/stage-tag';
import { TableToolbar } from '../components/strata/table-toolbar';
import { useTableQuery, type SortOption, type TableQuery } from '../components/strata/table-query';
import { fetchInventory } from '../inventory/api';
import type { LoadResult } from './api';
import { useDebounced } from './project-format';
import { useProjectLayout } from './project-layout-context';
import { LoadErrorAlert, TablePager } from './project-ui';

const PAGE_SIZE = 25;

/** Stage tabs over the inventory API's filters (status, retention, conflict). */
const UNIT_STAGES = [
  { id: 'current', label: 'Current stock' },
  { id: 'retention', label: 'Retention due' },
  { id: 'on_hold', label: 'On hold' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'disposed', label: 'Disposed' },
  { id: 'all', label: 'All' },
] as const;
type UnitStage = (typeof UNIT_STAGES)[number]['id'];

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Received, newest first', sort: null },
  { label: 'Received, oldest first', sort: { key: 'received', dir: 'asc' } },
  { label: 'ID', sort: { key: 'id', dir: 'asc' } },
  { label: 'Retain until, soonest first', sort: { key: 'retain_until', dir: 'asc' } },
];
const SORT_LABELS = {
  received: { asc: 'Received, oldest first', desc: 'Received, newest first' },
  id: { asc: 'ID A–Z', desc: 'ID Z–A' },
  retain_until: { asc: 'Retain until, soonest first', desc: 'Retain until, latest first' },
};
const SORT_KEYS = new Set(['received', 'id', 'retain_until']);

function readStage(params: URLSearchParams): UnitStage {
  const value = params.get('stage');
  return UNIT_STAGES.some((s) => s.id === value) ? (value as UnitStage) : 'current';
}

/** The unit's test holes, as written in the Test hole column. */
function holeNames(item: InventoryItem): string {
  const names = item.holes.map((h) => h.testHoleName);
  const source = item.sample?.source;
  if (source?.type === 'test_hole' && !names.includes(source.testHoleName)) {
    names.push(source.testHoleName);
  }
  return names.join(', ');
}

function StatusCell({ item }: { item: InventoryItem }) {
  if (item.recordStatus) return <UnitStatusTag status={item.recordStatus} />;
  return (
    <StageTag
      stage={item.status === 'disposed' ? 'closed' : 'storage'}
      label={storageUnitStatusLabel(item.status)}
    />
  );
}

/**
 * The project's Storage units tab (STRATA-84, canvas R4Units*): the inventory list API filtered to
 * the project (and `?hole=`), stage tabs, table tools and chips; rows open the shared peek drawer
 * (`?open=`) at 1024 px and wider, the unit page otherwise.
 */
export function ProjectUnitsTab() {
  const { project } = useProjectLayout();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const [density, setDensity] = useTableDensity('project-units');
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();
  const stage = readStage(params);
  const holeId = params.get('hole');
  const hole = project.testHoles.find((h) => h.id === holeId) ?? null;
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const sort = query.sort && SORT_KEYS.has(query.sort.key) ? query.sort : null;
  const search = useDebounced(query.search);

  const requestKey = useMemo(() => {
    const request = new URLSearchParams({ projectId: project.id, pageSize: String(PAGE_SIZE) });
    if (hole) request.set('testHoleId', hole.id);
    if (search.trim()) request.set('search', search.trim());
    if (stage === 'all') request.set('status', 'all');
    else if (stage === 'disposed') request.set('status', 'disposed');
    else if (stage === 'retention') request.set('retention', 'eligible_by_date');
    else if (stage === 'on_hold') request.set('retention', 'on_hold');
    else if (stage === 'conflicts') request.set('conflict', 'open');
    if (sort) {
      request.set('sort', sort.key);
      request.set('dir', sort.dir);
    }
    if (page > 1) request.set('page', String(page));
    return request.toString();
  }, [project.id, hole, search, stage, sort, page]);

  const [result, setResult] = useState<(LoadResult<InventoryPage> & { key: string }) | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchInventory(new URLSearchParams(requestKey)).then((response) => {
      if (cancelled) return;
      setResult(
        response.ok
          ? { ok: true, data: response.data, key: requestKey }
          : { ok: false, notFound: false, message: response.message, key: requestKey },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);

  const loading = !result || result.key !== requestKey;
  const data = result?.ok ? result.data : null;
  const items = useMemo(() => data?.items ?? [], [data]);
  const openItem = peekAvailable ? (items.find((i) => i.id === peek.openId) ?? null) : null;
  const nav = peekNeighbours(
    items.map((i) => i.id),
    openItem?.id ?? null,
  );
  usePeekKeys({
    enabled: openItem !== null,
    onClose: peek.close,
    onPrevious: nav.previousId ? () => peek.open(nav.previousId!) : undefined,
    onNext: nav.nextId ? () => peek.open(nav.nextId!) : undefined,
  });

  const setParam = (key: string, value: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== 'page') next.delete('page');
      return next;
    });

  const columns = useMemo<DataTableColumn<InventoryItem>[]>(
    () => [
      {
        id: 'id',
        header: 'ID',
        priority: 'identity',
        mono: true,
        width: '15ch',
        sortKey: 'id',
        cell: (item) => (
          <Button variant="link" asChild className="h-auto p-0 font-mono">
            <Link to={`/sample-storage/${encodeURIComponent(item.readableId)}`}>
              {item.readableId}
            </Link>
          </Button>
        ),
      },
      {
        id: 'hole',
        header: 'Test hole',
        priority: 'attribute',
        hideOrder: 3,
        cell: (item) => <span className="truncate font-mono">{holeNames(item) || '—'}</span>,
      },
      {
        id: 'type',
        header: 'Type',
        priority: 'attribute',
        width: '9rem',
        hideOrder: 2,
        cell: (item) => storageUnitTypeLabel(item.unitType),
      },
      {
        id: 'where',
        header: 'Where',
        priority: 'attribute',
        width: '10rem',
        hideOrder: 1,
        cell: (item) => <span className="truncate font-mono">{currentLocationName(item)}</span>,
      },
      {
        id: 'stage',
        header: 'Stage',
        priority: 'state',
        width: '10rem',
        wrap: true,
        cell: (item) => <StatusCell item={item} />,
      },
      {
        id: 'received',
        header: 'Received',
        priority: 'attribute',
        mono: true,
        width: '10ch',
        sortKey: 'received',
        hideOrder: 4,
        cell: (item) => item.receivedDate,
      },
      {
        id: 'retain',
        header: 'Retain until',
        priority: 'attribute',
        mono: true,
        width: '10ch',
        sortKey: 'retain_until',
        hideOrder: 5,
        cell: (item) =>
          item.retention?.retentionExempt ? '—' : (item.retention?.effectiveRetainUntil ?? '—'),
      },
    ],
    [],
  );

  const toolbarQuery: TableQuery = { ...query, sort, view: density };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    const { view, ...rest } = patch;
    if (view === 'comfortable' || view === 'compact') setDensity(view);
    if (Object.keys(rest).length > 0) setQuery(rest);
  };

  let list: ReactNode;
  if (result && !result.ok && !loading) {
    list = (
      <LoadErrorAlert
        title="Storage units couldn't load"
        message={result.message}
        onRetry={() => setReloads((n) => n + 1)}
      />
    );
  } else if (data && data.total === 0 && !loading) {
    const narrowed = Boolean(hole || query.search.trim() || stage !== 'current');
    list = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PackageOpen aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {narrowed
              ? 'No storage units match.'
              : 'No storage units received for this project yet.'}
          </EmptyTitle>
          <EmptyDescription>
            {narrowed
              ? 'Try another stage or test hole, or clear the search.'
              : 'Units appear here once a receipt for this project is confirmed.'}
          </EmptyDescription>
        </EmptyHeader>
        {narrowed ? (
          <EmptyContent>
            <Button
              variant="outline"
              onClick={() =>
                setParams((current) => {
                  const next = new URLSearchParams(current);
                  for (const key of ['hole', 'stage', 'search', 'page']) next.delete(key);
                  return next;
                })
              }
            >
              Clear filters
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  } else {
    list = (
      <>
        <DataTable
          columns={columns}
          data={items}
          getRowId={(item) => item.id}
          rowLabel={(item) => item.readableId}
          density={density}
          sort={sort}
          onSortChange={(next) => setQuery({ sort: next })}
          stage={(item) => item.stage ?? null}
          onOpenRow={(item) =>
            peekAvailable
              ? peek.open(item.id)
              : navigate(`/sample-storage/${encodeURIComponent(item.readableId)}`)
          }
          openRowId={openItem?.id ?? null}
          caption={`Storage units on ${project.projectNumber}`}
          loading={!data && loading}
        />
        {data ? (
          <TablePager
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            noun={data.total === 1 ? 'storage unit' : 'storage units'}
            onPage={(next) => setParam('page', next > 1 ? String(next) : null)}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          className="min-w-0 max-w-full"
          value={stage}
          onValueChange={(next) => setParam('stage', next === 'current' ? null : next)}
        >
          <TabsList
            aria-label="Stage"
            className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
          >
            {UNIT_STAGES.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <TableToolbar
          label="Storage units tools"
          query={toolbarQuery}
          onQueryChange={onQueryChange}
          sortOptions={SORT_OPTIONS}
          sortLabels={SORT_LABELS}
          views={DENSITY_VIEW_OPTIONS}
          searchPlaceholder="Search this project's units…"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Filters" role="group">
        <span
          title="Set by this project page"
          className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-muted-foreground"
        >
          <Lock aria-hidden="true" className="size-3.5" />
          Project <span className="font-mono text-foreground">{project.projectNumber}</span>
        </span>
        {hole ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-full border bg-secondary pr-0.5 pl-2.5">
            Test hole: <span className="font-mono">{hole.name}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove filter Test hole ${hole.name}`}
              onClick={() => setParam('hole', null)}
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        ) : project.testHoles.length > 0 ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Choose a test hole">
                Test hole: any
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
              <DropdownMenuRadioGroup value="" onValueChange={(value) => setParam('hole', value)}>
                {project.testHoles.map((h) => (
                  <DropdownMenuRadioItem key={h.id} value={h.id} className="font-mono">
                    {h.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <PeekSplit
        className="min-h-[24rem]"
        open={openItem !== null}
        openId={peek.openId}
        listLabel={`Storage units on ${project.projectNumber}`}
        drawerLabelledBy="project-unit-peek-title"
        list={<div aria-busy={loading}>{list}</div>}
        drawer={
          openItem ? (
            <>
              <PeekToolbar
                onClose={peek.close}
                fullPageHref={`/sample-storage/${encodeURIComponent(openItem.readableId)}`}
                position={{ index: nav.index, total: nav.total }}
                onPrevious={nav.previousId ? () => peek.open(nav.previousId!) : undefined}
                onNext={nav.nextId ? () => peek.open(nav.nextId!) : undefined}
              />
              <UnitPeek item={openItem} />
            </>
          ) : null
        }
      />
    </div>
  );
}

/** The unit summary in the drawer, with a link to the unit page. */
function UnitPeek({ item }: { item: InventoryItem }) {
  const facts: [string, ReactNode][] = [
    ['Type', storageUnitTypeLabel(item.unitType)],
    ['Where', <span className="font-mono">{currentLocationName(item)}</span>],
    ['Received', <span className="font-mono">{item.receivedDate}</span>],
    [
      'Retain until',
      item.retention?.retentionExempt ? (
        'Not applicable'
      ) : (
        <span className="font-mono">
          {item.retention?.effectiveRetainUntil ?? '—'}
          {item.retention?.onHold ? ' · On hold' : ''}
        </span>
      ),
    ],
  ];
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-2">
        <h2 id="project-unit-peek-title" className="font-mono text-xl font-bold">
          {item.readableId}
        </h2>
        <div>
          <StatusCell item={item} />
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {item.holes.length > 0 ? (
        <section aria-labelledby="project-unit-peek-holes" className="flex flex-col gap-2">
          <h3 id="project-unit-peek-holes" className="text-sm font-semibold">
            SAMPLE#/DEPTH by test hole
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {item.holes.map((h) => (
              <li key={h.testHoleId} className="flex gap-2">
                <span className="font-mono">{h.testHoleName}</span>
                <span className="text-muted-foreground">{formatStorageUnitHoleSummary(h)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Button variant="outline" asChild className="self-start">
        <Link to={`/sample-storage/${encodeURIComponent(item.readableId)}`}>
          Open the unit page
        </Link>
      </Button>
    </div>
  );
}
