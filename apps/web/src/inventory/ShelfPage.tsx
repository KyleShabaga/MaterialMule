import {
  STORAGE_UNIT_RECORD_STATUS_LABELS,
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  formatPerson,
  formatRecordDate,
  locationKindLabel,
  type InventoryItem,
  type InventoryPage,
  type LocationActivity,
  type LocationDetail,
  type PrintJob,
} from '@materialmule/shared';
import { ArrowDownToLine, CircleAlert, Ellipsis, Link2, MapPinX, Printer } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type DataTableColumn } from '../components/strata/data-table';
import {
  PeekSplit,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '../components/strata/peek';
import { PersonAvatar } from '../components/strata/person-avatar';
import { StageTag } from '../components/strata/stage-tag';
import { TableToolbar } from '../components/strata/table-toolbar';
import { useTableQuery, type SortOption } from '../components/strata/table-query';
import { notifyError, notifySuccess } from '../components/strata/toast';
import { usePageTitle } from '../layout/page-title';
import { moveToPath } from '../moves/move-link';
import { PrintJobStatus } from '../printing/PrintJobStatus';
import { useMe } from '../session/context';
import { printLocationLabel } from '../settings/locations/api';
import {
  fetchInventory,
  fetchLocationActivity,
  fetchLocationDetail,
  resolveLocationCode,
} from './api';
import './inventory.css';
import { ShelfCells } from './ShelfCells';
import { UnitContentsLine } from './UnitContents';
import { UnitDrawer } from './UnitDrawer';
import { RecordBreadcrumb, RecordNotFound, UnitSection } from './UnitRecordParts';
import {
  formatEventTime,
  itemRecordStatus,
  locationCapacity,
  placesUsedText,
  shelfPath,
  storageTermText,
  unitPath,
  UNIT_DRAWER_TITLE_ID,
  type UnitLinkState,
} from './unit-record';

/** Units listed on one shelf page; shelves hold 4–40 places, so this is every unit. */
const SHELF_PAGE_SIZE = 100;

type Shelf =
  | { state: 'loading'; key: string }
  | { state: 'missing'; key: string }
  | { state: 'error'; key: string; message: string }
  | {
      state: 'ready';
      key: string;
      detail: LocationDetail;
      units: InventoryPage;
      activity: LocationActivity;
    };

interface ShelfRow {
  item: InventoryItem;
  hereSince: string | null;
}

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Unit ID', sort: null },
  { label: 'Here since, newest first', sort: { key: 'here', dir: 'desc' } },
  { label: 'Retention due, soonest first', sort: { key: 'retention', dir: 'asc' } },
];
const FILTERS = [
  { id: 'due', label: 'Retention due' },
  { id: 'conflict', label: 'Location conflict' },
] as const;

function isDue(item: InventoryItem) {
  return Boolean(
    item.retention && !item.retention.retentionExempt && item.retention.eligibleByDate,
  );
}

/**
 * Shelf page (STRATA-74, DESIGN.md › Storage unit record › Shelf page): where a scanned shelf
 * label lands. The code large in mono with its path, places used and storage term; counted cells
 * from the location's capacity; the units here in a table with the table tools; the last 30 days
 * of comings and goings. A cell or row opens the unit drawer beside the page (1024 px and up).
 */
export function ShelfPage() {
  const { code = '' } = useParams();
  usePageTitle(code);
  const [reloads, setReloads] = useState(0);
  const key = `${code}:${reloads}`;
  const [shelf, setShelf] = useState<Shelf>({ state: 'loading', key });

  useEffect(() => {
    let cancelled = false;
    const done = (next: Shelf) => {
      if (!cancelled) setShelf(next);
    };
    void (async () => {
      const resolved = await resolveLocationCode(code);
      if (!resolved.ok) return done({ state: 'error', key, message: resolved.message });
      if (!resolved.data) return done({ state: 'missing', key });
      const id = resolved.data.id;
      const params = new URLSearchParams({
        locationId: id,
        status: 'current',
        pageSize: String(SHELF_PAGE_SIZE),
      });
      const [detail, units, activity] = await Promise.all([
        fetchLocationDetail(id),
        fetchInventory(params),
        fetchLocationActivity(id),
      ]);
      if (!detail.ok) {
        return detail.notFound
          ? done({ state: 'missing', key })
          : done({ state: 'error', key, message: detail.message });
      }
      if (!units.ok) return done({ state: 'error', key, message: units.message });
      if (!activity.ok) return done({ state: 'error', key, message: activity.message });
      done({
        state: 'ready',
        key,
        detail: detail.data,
        units: units.data,
        activity: activity.data,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [code, key]);

  const back = { to: '/sample-storage', label: 'Inventory' };

  if (shelf.key !== key || shelf.state === 'loading') {
    return (
      <Frame>
        <RecordBreadcrumb back={back} current={code} />
        <div aria-busy="true" className="flex flex-col gap-6">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-80" />
          <div className="grid grid-cols-2 gap-2 @min-[44rem]:grid-cols-4">
            {Array.from({ length: 8 }, (_, n) => (
              <Skeleton key={n} className="h-16" />
            ))}
          </div>
          <p className="sr-only" role="status">
            Loading shelf {code}
          </p>
        </div>
      </Frame>
    );
  }
  if (shelf.state === 'missing') {
    return (
      <Frame>
        <RecordBreadcrumb back={back} current={code} />
        <RecordNotFound
          icon={MapPinX}
          title="No location has this code."
          code={code}
          description="Check the label and scan it again, or find the unit in Inventory."
          secondary={{ to: '/sample-storage', label: 'Go to Inventory' }}
        />
      </Frame>
    );
  }
  if (shelf.state === 'error') {
    return (
      <Frame>
        <RecordBreadcrumb back={back} current={code} />
        <Alert variant="destructive">
          <AlertTitle className="line-clamp-none">{shelf.message}</AlertTitle>
          <AlertDescription>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 text-foreground"
              onClick={() => setReloads((n) => n + 1)}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </Frame>
    );
  }
  return <ReadyShelf shelf={shelf} back={back} />;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-6">
      {children}
    </div>
  );
}

function ReadyShelf({
  shelf,
  back,
}: {
  shelf: Extract<Shelf, { state: 'ready' }>;
  back: { to: string; label: string };
}) {
  const { location } = shelf.detail;
  const items = shelf.units.items;
  const total = shelf.units.total;
  const capacity = locationCapacity(location);
  const term = location.effectiveStorageTerm;
  const routerLocation = useLocation();
  const linkState: UnitLinkState = {
    backTo: `${routerLocation.pathname}${routerLocation.search}`,
    backLabel: location.code,
  };
  const peekAvailable = usePeekAvailable();
  const peek = usePeekParam();
  const openId = peekAvailable ? peek.openId : null;
  const [query, setQuery] = useTableQuery('u');

  const arrivals = useMemo(
    () => new Map(shelf.activity.arrivals.map((a) => [a.storageUnitId, a.arrivedAt])),
    [shelf.activity.arrivals],
  );

  // ≤100 rows, all loaded: search, filters and sort run here, in one place.
  const rows = useMemo<ShelfRow[]>(() => {
    const needle = query.search.trim().toLowerCase();
    let list = items.map((item) => ({ item, hereSince: arrivals.get(item.id) ?? null }));
    if (needle) {
      list = list.filter(({ item }) =>
        [item.readableId, item.project.projectNumber, ...item.holes.map((h) => h.testHoleName)]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    if (query.filters.includes('due')) list = list.filter(({ item }) => isDue(item));
    if (query.filters.includes('conflict')) {
      list = list.filter(({ item }) => itemRecordStatus(item, term) === 'location_conflict');
    }
    const sort = query.sort;
    if (sort?.key === 'here') {
      const at = (row: ShelfRow) => row.hereSince ?? row.item.receivedDate;
      list = [...list].sort((a, b) => at(a).localeCompare(at(b)) * (sort.dir === 'asc' ? 1 : -1));
    } else if (sort?.key === 'retention') {
      const at = (row: ShelfRow) => row.item.retention?.effectiveRetainUntil ?? '9999';
      list = [...list].sort((a, b) => at(a).localeCompare(at(b)) * (sort.dir === 'asc' ? 1 : -1));
    }
    return list;
  }, [items, arrivals, query, term]);

  const ids = rows.map((row) => row.item.readableId);
  const neighbours = peekNeighbours(ids, openId);
  const openRow = items.find((item) => item.readableId === openId);
  usePeekKeys({
    enabled: openId !== null,
    onClose: peek.close,
    onPrevious: neighbours.previousId ? () => peek.open(neighbours.previousId!) : undefined,
    onNext: neighbours.nextId ? () => peek.open(neighbours.nextId!) : undefined,
  });

  const conflicts = items.filter((item) => itemRecordStatus(item, term) === 'location_conflict');
  const dueCount = items.filter(isDue).length;
  const drawerOpen = openId !== null;

  const columns: DataTableColumn<ShelfRow>[] = [
    {
      id: 'id',
      header: 'ID',
      priority: 'identity',
      mono: true,
      // PREFIX-YYYY-NNNNNN in semibold mono plus the stage stripe: IDs are never cut.
      width: '17ch',
      cell: ({ item }) => (
        <Link
          className="font-semibold text-link hover:underline"
          to={unitPath(item.readableId)}
          state={linkState}
        >
          {item.readableId}
        </Link>
      ),
    },
    {
      id: 'project',
      header: 'Project',
      priority: 'attribute',
      hideOrder: 4,
      mono: true,
      width: '9ch',
      cell: ({ item }) => item.project.projectNumber,
    },
    {
      id: 'hole',
      header: 'Hole',
      priority: 'attribute',
      hideOrder: 3,
      cell: ({ item }) => <UnitContentsLine unit={item} />,
    },
    {
      id: 'stage',
      header: 'Stage',
      priority: 'state',
      width: '9rem',
      wrap: true,
      cell: ({ item }) => {
        const status = itemRecordStatus(item, term);
        return (
          <StageTag
            stage={item.stage ?? STORAGE_UNIT_RECORD_STATUS_STAGE[status]}
            label={STORAGE_UNIT_RECORD_STATUS_LABELS[status]}
          />
        );
      },
    },
    {
      id: 'here',
      header: 'Here since',
      priority: 'attribute',
      hideOrder: 2,
      mono: true,
      width: '10ch',
      cell: ({ item, hereSince }) => (hereSince ? formatRecordDate(hereSince) : item.receivedDate),
    },
    {
      id: 'retention',
      header: 'Retention due',
      priority: 'attribute',
      hideOrder: 1,
      mono: true,
      width: '10ch',
      cell: ({ item }) =>
        item.retention?.retentionExempt ? 'n/a' : (item.retention?.effectiveRetainUntil ?? '—'),
    },
  ];

  const list = (
    <div className="flex flex-col gap-8 py-1 pr-1">
      <div className="flex flex-col gap-4">
        <RecordBreadcrumb back={back} current={location.code} />
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="grid min-w-0 gap-1">
            <h1 className="font-mono text-3xl font-semibold tracking-tight whitespace-nowrap">
              {location.code}
            </h1>
            <p className="text-sm text-muted-foreground">
              {location.name}
              {location.area ? ` · ${location.area}` : ''} · {locationKindLabel(location.kind)}{' '}
              <span aria-hidden="true">·</span>{' '}
              <span className="font-medium text-foreground">{placesUsedText(total, capacity)}</span>
              {capacity === null ? ' · Capacity not set' : ''}
            </p>
            <p className="text-sm">
              {storageTermText(term)}
              {term?.source === 'inherited' && term.fromLocation ? (
                <span className="text-muted-foreground">
                  {' '}
                  (from <span className="font-mono">{term.fromLocation.code}</span>)
                </span>
              ) : null}
              {location.active ? null : (
                <>
                  {' '}
                  <StageTag stage="closed" label="Retired" />
                </>
              )}
            </p>
          </div>
          <ShelfActions locationId={location.id} code={location.code} active={location.active} />
        </header>
        {capacity !== null && total > capacity ? (
          <Alert className="relative overflow-hidden">
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              {total} units are recorded on a shelf with {capacity} places.
            </AlertTitle>
            <AlertDescription>
              Check the shelf, then move the extra units, or correct its capacity in Settings ›
              Locations.
            </AlertDescription>
          </Alert>
        ) : null}
        {conflicts.map((item) => (
          <Alert key={item.id} variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              <span className="font-mono whitespace-nowrap">{item.readableId}</span> has a location
              conflict.
            </AlertTitle>
            <AlertDescription>
              <p>
                It was scanned somewhere else too. Find it and move it to the shelf it is on; the
                move clears the conflict.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-2 text-foreground">
                <Link to={unitPath(item.readableId)} state={linkState}>
                  Open <span className="font-mono">{item.readableId}</span>
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        ))}
      </div>

      <section aria-labelledby="on-shelf" className="@container flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <h2 id="on-shelf" className="text-base font-semibold">
            On this shelf
          </h2>
          <span className="text-sm text-muted-foreground">
            {placesUsedText(total, capacity)}
            {dueCount > 0 ? ` · ${dueCount} due for retention` : ''}
          </span>
        </div>
        {items.length === 0 ? <p className="text-sm font-medium">Nothing is stored here.</p> : null}
        <ShelfCells
          items={items}
          capacity={capacity}
          term={term}
          openId={openId}
          onOpen={peekAvailable ? (id) => peek.open(id) : null}
          linkState={linkState}
        />
        {capacity === null ? (
          <p className="text-[13px] text-muted-foreground">
            Capacity not set, so only the units here are shown. Set it in Settings › Locations.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="shelf-units-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="shelf-units-heading" className="text-base font-semibold">
            Units here
          </h2>
          <TableToolbar
            label="Units here tools"
            query={query}
            onQueryChange={setQuery}
            filters={FILTERS}
            sortOptions={SORT_OPTIONS}
            searchPlaceholder="Search ID, project or hole"
          />
        </div>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.item.readableId}
          rowLabel={(row) => row.item.readableId}
          density="comfortable"
          stage={({ item }) =>
            item.stage ?? STORAGE_UNIT_RECORD_STATUS_STAGE[itemRecordStatus(item, term)]
          }
          onOpenRow={peekAvailable ? (row) => peek.open(row.item.readableId) : undefined}
          openRowId={openId}
          caption="Units here"
          freeColumnMin="10rem"
          empty={items.length === 0 ? 'Nothing is stored here.' : 'No units here match the search.'}
        />
        {total > items.length ? (
          <p className="text-[13px] text-muted-foreground">
            Showing {items.length} of {total}.{' '}
            <Link
              className="text-link hover:underline"
              to={`/sample-storage?locationId=${encodeURIComponent(location.id)}`}
            >
              See them all in Inventory
            </Link>
          </p>
        ) : null}
      </section>

      <UnitSection id="shelf-activity" title="Comings and goings" meta="Last 30 days">
        {shelf.activity.movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No units came or went in the last 30 days.
          </p>
        ) : (
          <ol aria-label="Comings and goings" className="flex flex-col">
            {shelf.activity.movements.map((move) => (
              <li key={move.id} className="flex items-start gap-3 pb-4 text-sm last:pb-0">
                <PersonAvatar name={move.actor.name ?? move.actor.initials} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p>
                    <span className="font-medium">
                      <span className="font-mono">{move.storageUnit.readableId}</span>{' '}
                      {move.direction === 'in' ? 'arrived' : 'left'}
                    </span>{' '}
                    {formatPerson(move.actor.initials, move.actor.name)}
                    {move.mover ? ` for ${formatPerson(move.mover.initials, move.mover.name)}` : ''}
                    , {move.direction === 'in' ? 'from' : 'to'}{' '}
                    <Link
                      className="text-link hover:underline"
                      to={shelfPath(move.otherLocation.code)}
                    >
                      {move.otherLocation.name}
                    </Link>
                  </p>
                  <time
                    dateTime={move.occurredAt}
                    className="font-mono text-[13px] text-muted-foreground"
                  >
                    {formatEventTime(move.occurredAt)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        )}
      </UnitSection>
    </div>
  );

  if (!peekAvailable) return <Frame>{list}</Frame>;
  return (
    <div className="h-[calc(100dvh_-_3.5rem_-_var(--page-pad)_*_2)] min-h-[32rem] overflow-hidden">
      <PeekSplit
        className="h-full"
        open={drawerOpen}
        openId={openId}
        listLabel={`Shelf ${location.code}`}
        drawerLabelledBy={UNIT_DRAWER_TITLE_ID}
        list={<div className="@container mx-auto w-full max-w-[1280px]">{list}</div>}
        drawer={
          openId ? (
            <UnitDrawer
              key={openId}
              readableId={openId}
              retention={openRow?.retention}
              toolbar={{
                onClose: peek.close,
                position: { index: neighbours.index, total: neighbours.total },
                onPrevious: neighbours.previousId
                  ? () => peek.open(neighbours.previousId!)
                  : undefined,
                onNext: neighbours.nextId ? () => peek.open(neighbours.nextId!) : undefined,
              }}
            />
          ) : null
        }
      />
    </div>
  );
}

/** Move units here (primary) and More: Print shelf label (not LAB, not retired) and Copy link. */
function ShelfActions({
  locationId,
  code,
  active,
}: {
  locationId: string;
  code: string;
  active: boolean;
}) {
  const me = useMe();
  const [job, setJob] = useState<PrintJob | null>(null);
  const [busy, setBusy] = useState(false);
  const canPrint = me.accountType !== 'shared_lab' && active;

  async function print() {
    setBusy(true);
    const result = await printLocationLabel(locationId, {});
    setBusy(false);
    if (result.ok) setJob(result.data);
    else notifyError('The shelf label wasn’t sent.', result.message);
  }

  async function copy() {
    const url = `${window.location.origin}${shelfPath(code)}`;
    try {
      await navigator.clipboard.writeText(url);
      notifySuccess('Link copied.');
    } catch {
      notifyError('The link couldn’t be copied.', url);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {active ? (
          <Button asChild>
            <Link to={moveToPath(code)}>
              <ArrowDownToLine aria-hidden="true" />
              Move units here
            </Link>
          </Button>
        ) : null}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="More actions">
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="font-mono">{code}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {canPrint ? (
              <DropdownMenuItem disabled={busy} onSelect={() => void print()}>
                <Printer aria-hidden="true" />
                Print shelf label
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => void copy()}>
              <Link2 aria-hidden="true" />
              Copy link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {job ? <PrintJobStatus job={job} /> : null}
    </div>
  );
}
