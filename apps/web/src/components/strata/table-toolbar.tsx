import * as React from 'react';
import {
  ArrowUpDown,
  ListFilter,
  Search,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ActiveQueryChips, type QueryFilterOption } from './query-chips';
import {
  describeSort,
  sameSort,
  type SortLabels,
  type SortOption,
  type TableQuery,
} from './table-query';

export interface TableToolbarPageAction {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}

export interface TableToolbarProps {
  /** Accessible name of the toolbar, e.g. "Inbox tools". */
  label: string;
  query: TableQuery;
  onQueryChange: (patch: Partial<TableQuery>) => void;
  /** The page's own action, first in the toolbar (Inbox: Mark all read). */
  pageAction?: TableToolbarPageAction;
  /** Filter menu entries; omit for no Filter button. */
  filters?: readonly QueryFilterOption[];
  /** Sort menu entries; the first is the default order (`sort: null`). Omit for no Sort button. */
  sortOptions?: readonly SortOption[];
  /** Words for heading sorts that aren't in the Sort menu. */
  sortLabels?: SortLabels;
  /** View menu entries; omit for no View button. `query.view === null` is the first. */
  views?: readonly { id: string; label: string }[];
  searchPlaceholder?: string;
  /**
   * Show the active filters as chips before the tools (default). A page that draws its own chip
   * row with values and pickers (Inventory) passes false; the sort chip still shows here.
   */
  filterChips?: boolean;
  /**
   * View › Columns: one checkbox per column, checked while shown. `locked` columns (identity and
   * state) stay checked and disabled. Given alone, it still shows the View button.
   */
  columns?: readonly TableToolbarColumn[];
  /** Ids of the hidden columns (with `columns`). */
  hiddenColumns?: readonly string[];
  onHiddenColumnsChange?: (ids: string[]) => void;
  className?: string;
}

export interface TableToolbarColumn {
  id: string;
  label: string;
  /** Always shown (identity and state columns): checked and disabled. */
  locked?: boolean;
}

const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const DURATION = 200;
/** Marks the tools that slide when the search box opens or closes (FLIP). */
const FLIP_ATTR = 'data-toolbar-flip';

function prefersReducedMotion(): boolean {
  return (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function ToolTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const iconButtonClass =
  'relative text-muted-foreground hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground';

/**
 * Table tools (STRATA-46): the page action, Filter, Sort, View and Search at the far right, with
 * the active sort and filters as chips before them. Controlled: the table's one query (from
 * `useTableQuery`) comes in, patches go out. The only state kept here is whether the search box is
 * open; it is also open whenever `query.search` has text (a reload or Back with a search).
 */
export function TableToolbar({
  label,
  query,
  onQueryChange,
  pageAction,
  filters,
  sortOptions,
  sortLabels,
  views,
  searchPlaceholder = 'Search…',
  filterChips = true,
  columns,
  hiddenColumns = [],
  onHiddenColumnsChange,
  className,
}: TableToolbarProps) {
  const [boxOpen, setBoxOpen] = React.useState(query.search !== '');
  // A search that arrives from outside (reload, Back) opens the box and keeps it open after the
  // text is cleared, like one typed here.
  if (query.search !== '' && !boxOpen) setBoxOpen(true);
  const open = boxOpen || query.search !== '';

  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const searchButtonRef = React.useRef<HTMLButtonElement>(null);
  const flipFrom = React.useRef<Map<Element, number> | null>(null);
  const focusAfter = React.useRef<'input' | 'button' | null>(null);

  const movers = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLElement>(`[${FLIP_ATTR}]`) ?? []);

  // FLIP, step 1: remember where the other tools sit before the layout changes.
  const setOpenAnimated = (next: boolean, focus: 'input' | 'button' | null) => {
    flipFrom.current = new Map(movers().map((el) => [el, el.getBoundingClientRect().left]));
    focusAfter.current = focus;
    setBoxOpen(next);
  };

  // FLIP, step 2: the layout has changed at once; slide each tool from where it was, and open the
  // box with clip-path. No width transition. Then move focus.
  React.useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    if (from && !prefersReducedMotion()) {
      const transition = `transform ${DURATION}ms ${EASE}`;
      for (const el of movers()) {
        const before = from.get(el);
        if (before === undefined) continue;
        const dx = before - el.getBoundingClientRect().left;
        if (!dx) continue;
        el.style.transition = 'none';
        el.style.transform = `translateX(${dx}px)`;
        void el.getBoundingClientRect();
        el.style.transition = transition;
        el.style.transform = '';
      }
      const box = boxRef.current;
      if (box && open) {
        box.style.transition = 'none';
        box.style.clipPath = 'inset(0 0 0 calc(100% - 36px) round 6px)';
        void box.getBoundingClientRect();
        box.style.transition = `clip-path ${DURATION}ms ${EASE}`;
        box.style.clipPath = 'inset(0 round 6px)';
      }
    }
    const focus = focusAfter.current;
    focusAfter.current = null;
    if (focus === 'input') inputRef.current?.focus();
    else if (focus === 'button') searchButtonRef.current?.focus();
  }, [open]);

  const closeSearch = () => {
    setOpenAnimated(false, 'button');
    if (query.search) onQueryChange({ search: '' });
  };

  const filterCount = query.filters.length;
  const filterName = filterCount ? `Filter, ${filterCount} on` : 'Filter';
  const sortName = `Sort, ${describeSort(query.sort, sortOptions, sortLabels)}`;
  const sortValue = sortOptions
    ? String(sortOptions.findIndex((o) => sameSort(o.sort, query.sort)))
    : '-1';
  const viewValue = query.view ?? views?.[0]?.id ?? '';
  const viewLabel = views?.find((v) => v.id === viewValue)?.label ?? views?.[0]?.label ?? '';
  const viewName = viewLabel ? `View, ${viewLabel}` : 'View';
  const searchName = searchPlaceholder.replace(/…$|\.\.\.$/, '').trim() || 'Search';

  const toggleFilter = (id: string, on: boolean) =>
    onQueryChange({
      filters: on
        ? query.filters.includes(id)
          ? query.filters
          : [...query.filters, id]
        : query.filters.filter((f) => f !== id),
    });

  const flip = { [FLIP_ATTR]: '' };

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label={label}
        className={cn('flex items-center gap-0.5', className)}
      >
        <ActiveQueryChips
          {...flip}
          className="mr-1"
          query={filterChips ? query : { ...query, filters: [] }}
          onQueryChange={onQueryChange}
          filters={filters}
          sortOptions={sortOptions}
          sortLabels={sortLabels}
        />

        {pageAction ? (
          <>
            <ToolTip label={pageAction.label}>
              <Button
                {...flip}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={pageAction.label}
                disabled={pageAction.disabled}
                onClick={pageAction.onClick}
                className={iconButtonClass}
              >
                <pageAction.icon aria-hidden="true" />
              </Button>
            </ToolTip>
            <Separator {...flip} orientation="vertical" className="mx-1 h-5! self-center" />
          </>
        ) : null}

        {filters ? (
          <DropdownMenu>
            <ToolTip label={filterName}>
              <DropdownMenuTrigger asChild>
                <Button
                  {...flip}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={filterName}
                  className={cn(iconButtonClass, filterCount > 0 && 'text-link hover:text-link')}
                >
                  <ListFilter aria-hidden="true" />
                  {filterCount > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-link"
                    />
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
            </ToolTip>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Filter</DropdownMenuLabel>
              {filters.map((f) => (
                <DropdownMenuCheckboxItem
                  key={f.id}
                  checked={query.filters.includes(f.id)}
                  // "Unread, 4" rather than "Unread4" from the two spans.
                  aria-label={f.count !== undefined ? `${f.label}, ${f.count}` : undefined}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) => toggleFilter(f.id, on === true)}
                >
                  <span className="flex-1">{f.label}</span>
                  {f.count !== undefined ? (
                    <span className="text-xs text-muted-foreground tabular-nums">{f.count}</span>
                  ) : null}
                </DropdownMenuCheckboxItem>
              ))}
              {filterCount > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onQueryChange({ filters: [] })}>
                    <X aria-hidden="true" />
                    Clear filters
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {sortOptions ? (
          <DropdownMenu>
            <ToolTip label={sortName}>
              <DropdownMenuTrigger asChild>
                <Button
                  {...flip}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={sortName}
                  className={iconButtonClass}
                >
                  <ArrowUpDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </ToolTip>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Sort</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortValue}
                onValueChange={(v) => {
                  const option = sortOptions[Number(v)];
                  if (option) onQueryChange({ sort: option.sort });
                }}
              >
                {sortOptions.map((o, i) => (
                  <DropdownMenuRadioItem key={o.label} value={String(i)}>
                    {o.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {(views && views.length > 0) || (columns && columns.length > 0) ? (
          <DropdownMenu>
            <ToolTip label={viewName}>
              <DropdownMenuTrigger asChild>
                <Button
                  {...flip}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={viewName}
                  className={iconButtonClass}
                >
                  <SlidersHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </ToolTip>
            <DropdownMenuContent align="end" className="w-56">
              {views && views.length > 0 ? (
                <>
                  <DropdownMenuLabel>View</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={viewValue}
                    onValueChange={(id) => onQueryChange({ view: id === views[0]?.id ? null : id })}
                  >
                    {views.map((v) => (
                      <DropdownMenuRadioItem key={v.id} value={v.id}>
                        {v.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
              {columns && columns.length > 0 ? (
                <>
                  {views && views.length > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>Columns</DropdownMenuLabel>
                  {columns.map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.id}
                      checked={c.locked || !hiddenColumns.includes(c.id)}
                      disabled={c.locked}
                      // Keep the menu open so several columns can be toggled in one go.
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(on) =>
                        onHiddenColumnsChange?.(
                          on === true
                            ? hiddenColumns.filter((id) => id !== c.id)
                            : [...hiddenColumns.filter((id) => id !== c.id), c.id],
                        )
                      }
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {open ? (
          <InputGroup ref={boxRef} className="h-9 w-56 shrink-0 bg-background">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              type="search"
              value={query.search}
              placeholder={searchPlaceholder}
              aria-label={searchName}
              onChange={(e) => onQueryChange({ search: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  closeSearch();
                }
              }}
              onBlur={() => {
                // Skip the blur a browser fires while Escape is already closing the box, so it
                // can't cancel the focus return.
                if (!query.search && flipFrom.current === null) setOpenAnimated(false, null);
              }}
              className="h-full px-2 [&::-webkit-search-cancel-button]:hidden"
            />
            {query.search ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear search"
                  // Keep focus in the box so clearing doesn't close it.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onQueryChange({ search: '' });
                    inputRef.current?.focus();
                  }}
                >
                  <X aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        ) : (
          <ToolTip label="Search">
            <Button
              ref={searchButtonRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Search"
              onClick={() => setOpenAnimated(true, 'input')}
              className={iconButtonClass}
            >
              <Search aria-hidden="true" />
            </Button>
          </ToolTip>
        )}
      </div>
    </TooltipProvider>
  );
}
