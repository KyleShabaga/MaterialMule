import type { StorageLocation } from '@materialmule/shared';
import { ChevronDown, ChevronRight, Lock, MapPin, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  PeekSplit,
  PeekToolbar,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '../../components/strata/peek';
import { TableToolbar } from '../../components/strata/table-toolbar';
import { tableQueryKeys, useTableQuery } from '../../components/strata/table-query';
import { notifySuccess } from '../../components/strata/toast';
import { useMe } from '../../session/context';
import { listLocations } from './api';
import { LocationDrawer, LocationStatusBadge } from './LocationDrawer';
import { LocationForm } from './LocationForm';
import { MANAGE_PERMISSION, NOT_ALLOWED_TEXT, inventoryLink } from './location-links';
import {
  PLACES_PER_PAGE,
  buildTree,
  clampPage,
  locationsText,
  pageCount,
  pagePlaces,
  unitsText,
  visibleLocations,
  type TopLevelPlace,
} from './location-tree';

// Lab admin › Locations (STRATA-102 + STRATA-128; DESIGN.md › Round 9: settings; MM-T37 rules).
// AdminLayout renders the tabs, the h1 and the one-line description; this is the rest: the main
// action, the toolbar, the location tree paged by top-level place (10 per page, so a branch never
// splits) with a footer pager that stays in view, and the right drawer for one location
// (`?open=<id>`; a Sheet under 1024 px). Everyone signed in reads the list and prints labels
// (MISC-04: the print-only view); only `location.manage` adds, edits and retires, and the server
// enforces the same rule, so a LAB station never gains them from the person selected.
//
// TODO(STRATA-106, lane B): add the Storage term column ("Long-term · Set here", "From WH-A",
// "Overrides WH-B") between Code and Places once the API carries a storage term per location.

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; locations: StorageLocation[]; total: number };

const RETIRED_FILTER = 'retired';
const FILTERS = [{ id: RETIRED_FILTER, label: 'Include retired' }] as const;

/** Touch screens get a 44 px hit area; desktop and LAB stations keep the compact control. */
const TOUCH_TARGET = 'relative pointer-coarse:after:absolute pointer-coarse:after:-inset-3';

const HIDE_PLACES = '@max-[34rem]/list:hidden';

function InStockLink({ location }: { location: StorageLocation }) {
  if (location.inStockCount === 0) return <span className="text-muted-foreground">0</span>;
  return (
    <Link
      to={inventoryLink(location)}
      aria-label={`${unitsText(location.inStockCount)} at ${location.code}`}
      className={cn('text-link tabular-nums underline-offset-4 hover:underline', TOUCH_TARGET)}
    >
      {location.inStockCount}
    </Link>
  );
}

function LocationRow({
  location,
  nested,
  openId,
  onOpen,
}: {
  location: StorageLocation;
  nested: boolean;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const locked = location.codeLocked || location.isSystem;
  return (
    <TableRow data-state={openId === location.id ? 'selected' : undefined}>
      <TableCell className={cn('truncate', nested ? 'pl-10' : 'pl-4')}>
        <button
          type="button"
          data-peek-id={location.id}
          aria-current={openId === location.id ? 'true' : undefined}
          className={cn(
            'max-w-full truncate rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50',
            TOUCH_TARGET,
          )}
          onClick={() => onOpen(location.id)}
        >
          {location.name}
        </button>
      </TableCell>
      <TableCell className="font-mono">
        <span className="inline-flex items-center gap-1.5">
          <span>{location.code}</span>
          {locked ? (
            <>
              <Lock aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="sr-only">(code locked)</span>
            </>
          ) : null}
        </span>
      </TableCell>
      <TableCell className={cn('text-right text-muted-foreground', HIDE_PLACES)}>—</TableCell>
      <TableCell className="text-right">
        <InStockLink location={location} />
      </TableCell>
      <TableCell>
        <LocationStatusBadge location={location} />
      </TableCell>
    </TableRow>
  );
}

function PlaceRows({
  place,
  collapsed,
  onToggle,
  openId,
  onOpen,
}: {
  place: TopLevelPlace;
  collapsed: boolean;
  onToggle: () => void;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  if (place.kind === 'location') {
    return (
      <TableBody>
        <LocationRow location={place.location} nested={false} openId={openId} onOpen={onOpen} />
      </TableBody>
    );
  }
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <TableBody>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableHead scope="rowgroup" className="h-10 pl-2 font-semibold text-foreground">
          {/* The area's name is the toggle, so the row header reads as the area alone. */}
          <button
            type="button"
            aria-expanded={!collapsed}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-sm px-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              TOUCH_TARGET,
            )}
            onClick={onToggle}
          >
            <Chevron aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{place.area}</span>
          </button>
        </TableHead>
        <TableCell />
        <TableCell className={cn('text-right tabular-nums', HIDE_PLACES)}>
          <span className="sr-only">{locationsText(place.locations.length)}</span>
          <span aria-hidden="true">{place.locations.length}</span>
        </TableCell>
        <TableCell className="text-right tabular-nums">{place.inStock}</TableCell>
        <TableCell />
      </TableRow>
      {collapsed
        ? null
        : place.locations.map((location) => (
            <LocationRow
              key={location.id}
              location={location}
              nested
              openId={openId}
              onOpen={onOpen}
            />
          ))}
    </TableBody>
  );
}

function Pager({
  page,
  pages,
  places,
  total,
}: {
  page: number;
  pages: number;
  places: number;
  total: number;
}) {
  const [, setParams] = useSearchParams();
  const routerLocation = useLocation();
  const key = tableQueryKeys().page;
  const first = places === 0 ? 0 : (page - 1) * PLACES_PER_PAGE + 1;
  const last = Math.min(page * PLACES_PER_PAGE, places);

  function href(target: number): string {
    const next = new URLSearchParams(routerLocation.search);
    if (target <= 1) next.delete(key);
    else next.set(key, String(target));
    const search = next.toString();
    return `${routerLocation.pathname}${search ? `?${search}` : ''}`;
  }
  function go(event: MouseEvent, target: number) {
    event.preventDefault();
    if (target < 1 || target > pages || target === page) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (target <= 1) next.delete(key);
      else next.set(key, String(target));
      return next;
    });
  }

  return (
    <div
      data-slot="locations-pager"
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t bg-background px-1 py-2"
    >
      <p className="text-sm text-muted-foreground tabular-nums">
        Places {first}–{last} of {places} · {locationsText(total)}
      </p>
      {pages > 1 ? (
        <Pagination aria-label="Locations pages" className="mx-0 ml-auto w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href={href(page - 1)}
                aria-disabled={page === 1 ? 'true' : undefined}
                className={cn('h-9', page === 1 && 'pointer-events-none opacity-50')}
                onClick={(event) => go(event, page - 1)}
              />
            </PaginationItem>
            {Array.from({ length: pages }, (_, index) => index + 1).map((target) => (
              <PaginationItem key={target}>
                <PaginationLink
                  href={href(target)}
                  isActive={target === page}
                  aria-label={`Page ${target}`}
                  className="size-9"
                  onClick={(event) => go(event, target)}
                >
                  {target}
                </PaginationLink>
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext
                href={href(page + 1)}
                aria-disabled={page === pages ? 'true' : undefined}
                className={cn('h-9', page === pages && 'pointer-events-none opacity-50')}
                onClick={(event) => go(event, page + 1)}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  );
}

/** Lab admin › Locations (MM-T37, STRATA-102). */
export function LocationsPage() {
  const me = useMe();
  const canManage = me.permissions.includes(MANAGE_PERMISSION);
  const [query, setQuery] = useTableQuery();
  const [params] = useSearchParams();
  const includeRetired = query.filters.includes(RETIRED_FILTER);
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();
  const titleId = useId();
  const [reloads, setReloads] = useState(0);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const reload = () => setReloads((count) => count + 1);
  // These dialogs open without a Radix trigger, so they say where focus goes back to (MTR-136).
  const addRef = useRef<HTMLButtonElement>(null);
  const lastOpenId = useRef<string | null>(null);
  useEffect(() => {
    if (peek.openId) lastOpenId.current = peek.openId;
  }, [peek.openId]);

  // The URL follows every keystroke; the request waits for a pause.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listLocations({ search: query.search, includeRetired }).then((result) => {
        if (cancelled) return;
        setLoad(
          result.ok
            ? { state: 'ready', ...result.data }
            : { state: 'error', message: `Locations couldn’t load. ${result.message}` },
        );
      });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query.search, includeRetired, reloads]);

  const places = useMemo(() => (load.state === 'ready' ? buildTree(load.locations) : []), [load]);
  const page = clampPage(params.get(tableQueryKeys().page), places);
  const shown = pagePlaces(places, page);
  const visible = visibleLocations(shown, collapsed);
  const neighbours = peekNeighbours(
    visible.map((location) => location.id),
    peek.openId,
  );
  const open = (id: string) => peek.open(id);
  const previous = neighbours.previousId;
  const next = neighbours.nextId;

  usePeekKeys({
    enabled: peek.openId !== null && peekAvailable,
    onClose: peek.close,
    onPrevious: previous ? () => open(previous) : undefined,
    onNext: next ? () => open(next) : undefined,
  });

  function toggle(key: string) {
    setCollapsed((current) => {
      const nextSet = new Set(current);
      if (nextSet.has(key)) nextSet.delete(key);
      else nextSet.add(key);
      return nextSet;
    });
  }

  const retiredCount =
    load.state === 'ready' ? load.locations.filter((location) => !location.active).length : 0;

  const toolbar = (
    <PeekToolbar
      onClose={peek.close}
      position={neighbours.index >= 0 ? neighbours : undefined}
      onPrevious={previous ? () => open(previous) : undefined}
      onNext={next ? () => open(next) : undefined}
    />
  );
  const drawer = peek.openId ? (
    <LocationDrawer
      key={peek.openId}
      locationId={peek.openId}
      titleId={titleId}
      toolbar={toolbar}
      inSheet={!peekAvailable}
      onChanged={reload}
    />
  ) : null;

  let body;
  if (load.state === 'loading') {
    body = (
      <div aria-busy="true" className="grid gap-2 py-2">
        <span className="sr-only">Loading locations…</span>
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-9 w-full" />
        ))}
      </div>
    );
  } else if (load.state === 'error') {
    body = (
      <Alert variant="destructive">
        <AlertDescription>
          {load.message}
          <Button size="sm" variant="outline" className="mt-2 w-fit" onClick={reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (load.locations.length === 0) {
    body = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MapPin aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {query.search.trim() ? 'No locations match this search.' : 'No locations yet.'}
          </EmptyTitle>
          <EmptyDescription>
            {query.search.trim()
              ? 'Search by code, name or area.'
              : 'Shelves, benches and staging areas where storage units are kept.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div className="grid gap-3">
        {load.total > load.locations.length ? (
          <Alert role="status">
            <AlertDescription>
              Showing the first {load.locations.length} of {load.total} locations. Search by code,
              name or area to find the rest.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="overflow-hidden rounded-xl border">
          <Table className="table-fixed text-sm">
            <TableCaption className="sr-only">Locations</TableCaption>
            <TableHeader className="bg-muted">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-10 pl-4 font-semibold text-muted-foreground">
                  Location
                </TableHead>
                <TableHead className="h-10 w-36 font-semibold text-muted-foreground">
                  Code
                </TableHead>
                <TableHead
                  className={cn(
                    'h-10 w-20 text-right font-semibold text-muted-foreground',
                    HIDE_PLACES,
                  )}
                >
                  Places
                </TableHead>
                <TableHead className="h-10 w-20 text-right font-semibold text-muted-foreground">
                  In stock
                </TableHead>
                <TableHead className="h-10 w-24 font-semibold text-muted-foreground">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            {shown.map((place) => (
              <PlaceRows
                key={place.key}
                place={place}
                collapsed={collapsed.has(place.key)}
                onToggle={() => toggle(place.key)}
                openId={peek.openId}
                onOpen={open}
              />
            ))}
          </Table>
        </div>
      </div>
    );
  }

  const list = (
    <div className="flex min-h-full flex-col gap-3">
      <div className="flex-1">{body}</div>
      {load.state === 'ready' && load.locations.length > 0 ? (
        <Pager page={page} pages={pageCount(places)} places={places.length} total={load.total} />
      ) : null}
    </div>
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {load.state === 'ready'
            ? `${locationsText(load.total)}${includeRetired ? ` · ${retiredCount} retired` : ''}`
            : null}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <TableToolbar
            label="Locations tools"
            query={query}
            onQueryChange={setQuery}
            filters={FILTERS}
            searchPlaceholder="Search locations…"
          />
          {canManage ? (
            <Button ref={addRef} size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              Add location
            </Button>
          ) : null}
        </div>
      </div>
      {canManage ? null : <p className="text-sm text-muted-foreground">{NOT_ALLOWED_TEXT}</p>}

      {peekAvailable ? (
        <PeekSplit
          className="h-[calc(100svh-16rem)] min-h-96"
          open={peek.openId !== null}
          openId={peek.openId}
          listLabel="Locations list"
          drawerLabelledBy={titleId}
          list={<div className="pr-1">{list}</div>}
          drawer={drawer}
        />
      ) : (
        <>
          <div className="@container/list">{list}</div>
          <Sheet
            open={peek.openId !== null}
            onOpenChange={(isOpen) => (isOpen ? null : peek.close())}
          >
            <SheetContent
              side="right"
              showCloseButton={false}
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                const row = lastOpenId.current
                  ? document.querySelector<HTMLElement>(
                      `[data-peek-id="${CSS.escape(lastOpenId.current)}"]`,
                    )
                  : null;
                if (!row) return;
                event.preventDefault();
                row.focus();
              }}
              className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg"
            >
              {drawer}
            </SheetContent>
          </Sheet>
        </>
      )}

      {canManage ? (
        <Dialog open={adding} onOpenChange={setAdding}>
          <DialogContent
            className="sm:max-w-md"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              addRef.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add location</DialogTitle>
              <DialogDescription>
                A shelf, bench or staging area where storage units are kept. Its code is printed on
                its own label as LOC-CODE.
              </DialogDescription>
            </DialogHeader>
            {adding ? (
              <LocationForm
                location={null}
                submitLabel="Add location"
                busyLabel="Adding…"
                onConflict={() => undefined}
                onSaved={(_location, message) => {
                  setAdding(false);
                  notifySuccess(message);
                  reload();
                }}
                footer={(submit) => (
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="outline" size="sm">
                        Cancel
                      </Button>
                    </DialogClose>
                    {submit}
                  </DialogFooter>
                )}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
