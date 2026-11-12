import * as React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useMediaQuery } from '../useMediaQuery';
import { SortableTableHead } from './sortable-header';
import type { Stage } from './stage';
import { StageStripe } from './stage-stripe';
import type { SortState } from './table-query';

// Strata list table (DESIGN.md › Components › Tables, › Tables: column priority; STRATA-124, 30,
// 49, 64). Rows arrive from the server already sorted and filtered: this component renders them in
// the order given and never reorders them (STRATA-50).

/** Container widths an attribute column may hide below. Literal classes so Tailwind finds them. */
export type HideBreakpoint =
  '25rem' | '30rem' | '35rem' | '40rem' | '48rem' | '56rem' | '60rem' | '64rem';

/** Hides a cell while the table's container (`@container/table`) is narrower than the breakpoint. */
const HIDE_BELOW: Record<HideBreakpoint, string> = {
  '25rem': '@max-[25rem]/table:hidden',
  '30rem': '@max-[30rem]/table:hidden',
  '35rem': '@max-[35rem]/table:hidden',
  '40rem': '@max-[40rem]/table:hidden',
  '48rem': '@max-[48rem]/table:hidden',
  '56rem': '@max-[56rem]/table:hidden',
  '60rem': '@max-[60rem]/table:hidden',
  '64rem': '@max-[64rem]/table:hidden',
};

/** The inverse: shows folded content (hidden by default) below the same breakpoint. */
const SHOW_BELOW: Record<HideBreakpoint, string> = {
  '25rem': '@max-[25rem]/table:inline-flex',
  '30rem': '@max-[30rem]/table:inline-flex',
  '35rem': '@max-[35rem]/table:inline-flex',
  '40rem': '@max-[40rem]/table:inline-flex',
  '48rem': '@max-[48rem]/table:inline-flex',
  '56rem': '@max-[56rem]/table:inline-flex',
  '60rem': '@max-[60rem]/table:inline-flex',
  '64rem': '@max-[64rem]/table:inline-flex',
};

/**
 * Column rank (DESIGN.md › Tables: column priority): identity (the record's ID or name, its
 * project), then state (stage or status word), then attributes. Only attributes ever hide.
 */
export type ColumnPriority = 'identity' | 'state' | 'attribute';

export interface DataTableColumn<Row> {
  id: string;
  /** Heading content. Give icon-only headings sr-only text. */
  header: React.ReactNode;
  cell: (row: Row) => React.ReactNode;
  priority: ColumnPriority;
  /**
   * Attribute columns only: hide the column (th and td) while the table's container is narrower
   * than this. Ignored, with a dev warning, on identity and state columns.
   */
  hideBelow?: HideBreakpoint;
  /**
   * Fold, don't drop: while this column is hidden (`hideBelow`), render `fold(row)` inside the
   * identity cell instead, e.g. an icon with a tooltip and sr-only text. Needs `hideBelow`.
   */
  fold?: (row: Row) => React.ReactNode;
  /** Column id to fold into; default the first identity column. */
  foldInto?: string;
  /** Fixed width, e.g. '11ch' (a mono ISO date) or '8rem'. The free column has none (keep ≥ 7rem). */
  width?: string;
  /** Makes the heading a SortableTableHead for this server sort key. */
  sortKey?: string;
  align?: 'start' | 'end';
  /** Mono text (IDs, dates). Give mono columns a fixed width so they are never cut. */
  mono?: boolean;
  /** Tabular figures, right aligned. */
  numeric?: boolean;
  /** May wrap to two lines instead of clipping (status cells: a status is never cut off). */
  wrap?: boolean;
  /** Holds a control (checkbox, button, menu): not clipped, so focus rings show. */
  control?: boolean;
  /** Density 'table' only: a Notion-style gutter cell with no borders (e.g. the Inbox kind icon). */
  gutter?: boolean;
  className?: string;
  headClassName?: string;
}

/**
 * 'comfortable' 52 px and 'compact' 36 px rows for list tables; 'table' is the dense Inbox Table
 * view: 28 px rows, Notion borders, checkboxes shown on row hover, focus or selection only.
 */
export type DataTableDensity = 'comfortable' | 'compact' | 'table';

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  /** Rows in server order. Never sorted here. */
  data: readonly Row[];
  getRowId: (row: Row) => string;
  /** The row's accessible name, e.g. its unit ID; used in "Select <label>". */
  rowLabel: (row: Row) => string;
  density?: DataTableDensity;
  sort?: SortState | null;
  onSortChange?: (next: SortState | null) => void;
  /** Draws the stage stripe in the first cell; `null` for rows without a stage. */
  stage?: (row: Row) => Stage | null;
  /** Both given: adds a leading checkbox column. */
  selectedIds?: ReadonlySet<string>;
  onSelectedIdsChange?: (next: Set<string>) => void;
  onOpenRow?: (row: Row) => void;
  openRowId?: string | null;
  /** sr-only caption naming the table. */
  caption: React.ReactNode;
  /** Shown in one full-width row when `data` is empty. */
  empty?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

const ROW_HEIGHT: Record<DataTableDensity, string> = {
  comfortable: 'h-13',
  compact: 'h-9',
  table: 'h-7',
};

const CELL_DENSITY: Record<DataTableDensity, string> = {
  comfortable: 'px-3 py-2',
  compact: 'px-3 py-1',
  table: 'px-2 py-0',
};

const SKELETON_ROWS = 3;

const isDev = import.meta.env.DEV;

/** Shown in density 'table' only while the row is hovered, focused or ticked, or any row is ticked. */
const HOVER_CHECKBOX =
  'opacity-0 transition-opacity duration-100 ease-out motion-reduce:transition-none group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=checked]:opacity-100 data-[state=indeterminate]:opacity-100 group-has-[[data-state=checked]]/table:opacity-100 [@media(hover:none)]:opacity-100';

/** 44 px hit area on touch screens only (Kyle: 44 px is touch-only). */
const TOUCH_TARGET = 'relative pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5';

function effectiveHide<Row>(column: DataTableColumn<Row>): HideBreakpoint | undefined {
  return column.priority === 'attribute' ? column.hideBelow : undefined;
}

function isTypingTarget(el: Element | null): boolean {
  return !!el?.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], button, a[href], [role="checkbox"], [role="combobox"], [role="menuitem"]',
  );
}

/**
 * A list table on TanStack Table (manual sorting and filtering: the server orders the rows).
 *
 * Column priority: attribute columns hide with a container query on the table's own wrapper
 * (`@container/table`), so a drawer or narrow page hides them, not the window size. Identity and
 * state columns never hide. An attribute column with `fold` shows `fold(row)` inside the identity
 * cell (or `foldInto`) while it is hidden, at the same breakpoint.
 *
 * Keyboard: rows are one tab stop (roving tabindex). J/K or ArrowDown/ArrowUp move between rows,
 * Enter opens the row, Space ticks it. Keys only act while the row itself has focus, never while
 * typing in a field or on a control inside the row.
 */
export function DataTable<Row>({
  columns,
  data,
  getRowId,
  rowLabel,
  density = 'comfortable',
  sort = null,
  onSortChange,
  stage,
  selectedIds,
  onSelectedIdsChange,
  onOpenRow,
  openRowId = null,
  caption,
  empty,
  loading = false,
  className,
}: DataTableProps<Row>) {
  const dense = density === 'table';
  const selectable = !!selectedIds && !!onSelectedIdsChange;

  React.useEffect(() => {
    if (!isDev) return;
    for (const column of columns) {
      if (column.priority !== 'attribute' && column.hideBelow) {
        console.warn(
          `DataTable: column "${column.id}" is ${column.priority}; identity and state columns never hide, so hideBelow is ignored.`,
        );
      }
      if (column.fold && !effectiveHide(column)) {
        console.warn(`DataTable: column "${column.id}" has fold but never hides; fold is ignored.`);
      }
    }
  }, [columns]);

  const columnDefs = React.useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: () => column.header,
        cell: ({ row }) => column.cell(row.original),
      })),
    [columns],
  );

  // TanStack returns unmemoizable functions; the compiler skips this component, which is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable<Row>({
    data: data as Row[],
    columns: columnDefs,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
  });
  const rows = table.getRowModel().rows;
  const rowIds = rows.map((row) => row.id);

  const byId = React.useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  // Folds per target column id.
  const foldsByTarget = React.useMemo(() => {
    const firstIdentity = columns.find((c) => c.priority === 'identity')?.id;
    const map = new Map<string, DataTableColumn<Row>[]>();
    for (const column of columns) {
      if (!column.fold || !effectiveHide(column)) continue;
      const target = column.foldInto ?? firstIdentity;
      if (!target) continue;
      map.set(target, [...(map.get(target) ?? []), column]);
    }
    return map;
  }, [columns]);

  // Roving tabindex: the focused row, else the open row, else the first row.
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const tabStopId =
    focusId && rowIds.includes(focusId)
      ? focusId
      : openRowId && rowIds.includes(openRowId)
        ? openRowId
        : (rowIds[0] ?? null);
  const bodyRef = React.useRef<HTMLTableSectionElement>(null);

  const focusRowAt = (index: number) => {
    const el = bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]')[index];
    el?.focus();
  };

  const toggle = (id: string) => {
    if (!selectedIds || !onSelectedIdsChange) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedIdsChange(next);
  };

  const selectedOnPage = selectable ? rowIds.filter((id) => selectedIds.has(id)).length : 0;
  const allChecked = rowIds.length > 0 && selectedOnPage === rowIds.length;
  const headerChecked: boolean | 'indeterminate' = allChecked
    ? true
    : selectedOnPage > 0
      ? 'indeterminate'
      : false;
  const toggleAll = () => {
    if (!selectedIds || !onSelectedIdsChange) return;
    const next = new Set(selectedIds);
    if (allChecked) for (const id of rowIds) next.delete(id);
    else for (const id of rowIds) next.add(id);
    onSelectedIdsChange(next);
  };

  const visibleColumns = table.getVisibleLeafColumns();
  const columnCount = visibleColumns.length + (selectable ? 1 : 0);
  const firstPad = dense ? 'pl-5' : 'pl-4';

  /** Classes shared by a column's th and td. */
  const columnClasses = (column: DataTableColumn<Row>, index: number, head: boolean) => {
    const hide = effectiveHide(column);
    const isFirst = !selectable && index === 0;
    const isLast = index === visibleColumns.length - 1;
    return cn(
      CELL_DENSITY[density],
      hide && HIDE_BELOW[hide],
      (column.align === 'end' || column.numeric) && 'text-right',
      column.mono && 'font-mono',
      column.numeric && 'tabular-nums',
      // Safety net (DESIGN.md › Tables): text cells clip at their padding edge; controls don't.
      column.control
        ? null
        : column.wrap
          ? 'whitespace-normal break-words'
          : 'overflow-hidden text-ellipsis',
      dense && !column.gutter && !isLast && 'border-r',
      dense && head && !column.gutter && 'border-b',
      isFirst && cn('relative', firstPad),
    );
  };

  const headBase = dense
    ? 'h-8 bg-background text-[13px] font-medium text-muted-foreground'
    : 'h-10 bg-muted text-[13px] font-semibold text-muted-foreground';

  const checkboxCell = cn('relative pr-0', firstPad, dense ? 'py-0' : 'py-1');
  const checkboxWidth = dense ? '2.5rem' : '2.75rem';

  const renderBodyCell = (
    column: DataTableColumn<Row>,
    index: number,
    content: React.ReactNode,
    row: Row,
    isFirst: boolean,
    rowStage: Stage | null,
  ) => {
    const folds = foldsByTarget.get(column.id);
    return (
      <TableCell
        key={column.id}
        className={cn(columnClasses(column, index, false), column.className)}
      >
        {isFirst && rowStage ? (
          <StageStripe stage={rowStage} variant={dense ? 'dense' : 'row'} />
        ) : null}
        {folds ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{content}</span>
            {folds.map((fold) => (
              <span
                key={fold.id}
                data-fold={fold.id}
                className={cn('hidden shrink-0 items-center', SHOW_BELOW[effectiveHide(fold)!])}
              >
                {fold.fold!(row)}
              </span>
            ))}
          </span>
        ) : (
          content
        )}
      </TableCell>
    );
  };

  return (
    <div
      data-slot="data-table"
      data-density={density}
      className={cn(
        '@container/table overflow-hidden bg-card',
        dense ? 'border-y' : 'rounded-xl border',
        className,
      )}
    >
      <Table
        aria-busy={loading || undefined}
        className={cn('group/table w-full table-fixed', dense ? 'text-[13px]' : 'text-sm')}
      >
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader className={dense ? '[&_tr]:border-b-0' : undefined}>
          <TableRow className="group/row hover:bg-transparent">
            {selectable ? (
              <TableHead
                className={cn(headBase, checkboxCell, dense ? 'h-8' : 'h-10')}
                style={{ width: checkboxWidth }}
              >
                <Checkbox
                  aria-label="Select all rows"
                  checked={headerChecked}
                  disabled={rowIds.length === 0}
                  onCheckedChange={toggleAll}
                  className={cn(TOUCH_TARGET, dense && HOVER_CHECKBOX)}
                />
              </TableHead>
            ) : null}
            {table.getHeaderGroups()[0]?.headers.map((header, index) => {
              const column = byId.get(header.column.id)!;
              const content = flexRender(header.column.columnDef.header, header.getContext());
              const classes = cn(
                headBase,
                columnClasses(column, index, true),
                column.headClassName,
              );
              const style = column.width ? { width: column.width } : undefined;
              if (column.sortKey && onSortChange) {
                return (
                  <SortableTableHead
                    key={header.id}
                    sortKey={column.sortKey}
                    sort={sort}
                    onSortChange={onSortChange}
                    align={column.align === 'end' || column.numeric ? 'end' : 'start'}
                    className={classes}
                    style={style}
                  >
                    {content}
                  </SortableTableHead>
                );
              }
              return (
                <TableHead key={header.id} className={classes} style={style}>
                  {content}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody ref={bodyRef}>
          {loading ? (
            Array.from({ length: SKELETON_ROWS }, (_, r) => (
              <TableRow
                key={`skeleton-${r}`}
                data-slot="skeleton-row"
                className={ROW_HEIGHT[density]}
              >
                {selectable ? <TableCell className={checkboxCell} /> : null}
                {visibleColumns.map((col, index) => {
                  const column = byId.get(col.id)!;
                  return (
                    <TableCell key={column.id} className={columnClasses(column, index, false)}>
                      <Skeleton className="h-4 w-3/4" />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columnCount}
                className="h-24 px-4 text-center whitespace-normal text-muted-foreground"
              >
                {empty ?? 'Nothing to show.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, rowIndex) => {
              const original = row.original;
              const id = row.id;
              const selected = selectable && selectedIds.has(id);
              const open = openRowId === id;
              const rowStage = stage?.(original) ?? null;
              return (
                <TableRow
                  key={id}
                  data-row-id={id}
                  // PeekSplit returns focus to this row when the drawer closes (peek.tsx).
                  data-peek-id={id}
                  data-state={selected ? 'selected' : undefined}
                  aria-current={open ? 'true' : undefined}
                  tabIndex={tabStopId === id ? 0 : -1}
                  onFocus={() => setFocusId(id)}
                  onClick={(event) => {
                    if (!onOpenRow) return;
                    if (isTypingTarget(event.target as Element)) return;
                    onOpenRow(original);
                  }}
                  onKeyDown={(event) => {
                    // Only the row itself: controls inside it keep their own keys.
                    if (event.target !== event.currentTarget) return;
                    if (event.altKey || event.ctrlKey || event.metaKey) return;
                    switch (event.key) {
                      case 'j':
                      case 'J':
                      case 'ArrowDown':
                        event.preventDefault();
                        focusRowAt(Math.min(rowIndex + 1, rows.length - 1));
                        break;
                      case 'k':
                      case 'K':
                      case 'ArrowUp':
                        event.preventDefault();
                        focusRowAt(Math.max(rowIndex - 1, 0));
                        break;
                      case 'Enter':
                        if (!onOpenRow) return;
                        event.preventDefault();
                        onOpenRow(original);
                        break;
                      case ' ':
                        if (!selectable) return;
                        event.preventDefault();
                        toggle(id);
                        break;
                    }
                  }}
                  className={cn(
                    'group/row outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    'data-[state=selected]:bg-accent dark:data-[state=selected]:bg-muted aria-[current=true]:bg-accent',
                    ROW_HEIGHT[density],
                    onOpenRow && 'cursor-pointer',
                  )}
                >
                  {selectable ? (
                    <TableCell className={checkboxCell}>
                      {rowStage ? (
                        <StageStripe stage={rowStage} variant={dense ? 'dense' : 'row'} />
                      ) : null}
                      <Checkbox
                        aria-label={`Select ${rowLabel(original)}`}
                        checked={selected}
                        onCheckedChange={() => toggle(id)}
                        className={cn(TOUCH_TARGET, dense && HOVER_CHECKBOX)}
                      />
                    </TableCell>
                  ) : null}
                  {row.getVisibleCells().map((cell, index) => {
                    const column = byId.get(cell.column.id)!;
                    const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                    return renderBodyCell(
                      column,
                      index,
                      content,
                      original,
                      !selectable && index === 0,
                      rowStage,
                    );
                  })}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Density choice

export type TableDensityChoice = 'comfortable' | 'compact';

export const TABLE_DENSITY_STORAGE_PREFIX = 'materialmule:strata-table-density:';

/** Phones (640 px and narrower) always get comfortable rows. */
export const DENSITY_PHONE_QUERY = '(max-width: 640px)';

/** For the toolbar's View menu. */
// eslint-disable-next-line react-refresh/only-export-components -- View menu options belong with the table
export const DENSITY_VIEW_OPTIONS: readonly { id: TableDensityChoice; label: string }[] = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
];

function readDensity(tableKey: string): TableDensityChoice | null {
  try {
    const value = window.localStorage.getItem(TABLE_DENSITY_STORAGE_PREFIX + tableKey);
    return value === 'comfortable' || value === 'compact' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Comfortable or compact rows for one table. Precedence: this table's choice in this browser, then
 * the account default (Settings › Table rows, from preferences), then comfortable. Phones always
 * get comfortable, whatever is chosen. The setter stores the choice per table.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the density hook belongs with the table
export function useTableDensity(
  tableKey: string,
  accountDefault?: TableDensityChoice,
): [TableDensityChoice, (density: TableDensityChoice) => void] {
  const [stored, setStored] = React.useState(() => ({
    key: tableKey,
    value: readDensity(tableKey),
  }));
  const current = stored.key === tableKey ? stored.value : readDensity(tableKey);
  if (stored.key !== tableKey) setStored({ key: tableKey, value: current });
  const phone = useMediaQuery(DENSITY_PHONE_QUERY);
  const set = React.useCallback(
    (density: TableDensityChoice) => {
      setStored({ key: tableKey, value: density });
      try {
        window.localStorage.setItem(TABLE_DENSITY_STORAGE_PREFIX + tableKey, density);
      } catch {
        // Storage blocked (private window, policy): the choice lasts for this page only.
      }
    },
    [tableKey],
  );
  if (phone) return ['comfortable', set];
  return [current ?? accountDefault ?? 'comfortable', set];
}
