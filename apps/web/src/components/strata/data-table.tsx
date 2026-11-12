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
import type { StageKey, TableDensity } from '@materialmule/shared';
import { StageStripe } from './stage-stripe';
import type { SortState } from './table-query';

// Strata list table (DESIGN.md › Components › Tables, › Tables: column priority; STRATA-124, 30,
// 49, 64). Rows arrive from the server already sorted and filtered: this component renders them in
// the order given and never reorders them (STRATA-50).

/** Container widths an attribute column may hide below. Literal classes so Tailwind finds them. */
export type HideBreakpoint =
  | '20rem'
  | '22rem'
  | '24rem'
  | '25rem'
  | '26rem'
  | '28rem'
  | '30rem'
  | '32rem'
  | '34rem'
  | '35rem'
  | '36rem'
  | '38rem'
  | '40rem'
  | '42rem'
  | '44rem'
  | '46rem'
  | '48rem'
  | '50rem'
  | '52rem'
  | '54rem'
  | '56rem'
  | '58rem'
  | '60rem'
  | '62rem'
  | '64rem'
  | '66rem'
  | '68rem'
  | '70rem'
  | '72rem'
  | '74rem'
  | '76rem'
  | '78rem'
  | '80rem'
  | '82rem'
  | '84rem'
  | '86rem'
  | '88rem'
  | '90rem'
  | '92rem'
  | '94rem'
  | '96rem';

/** Every breakpoint, narrowest first (the hide plan rounds up to one of these). */
// eslint-disable-next-line react-refresh/only-export-components -- breakpoint list beside its table
export const HIDE_BREAKPOINTS_REM: readonly number[] = [
  20, 22, 24, 25, 26, 28, 30, 32, 34, 35, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62,
  64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96,
];

/** Hides a cell while the table's container (`@container/table`) is narrower than the breakpoint. */
const HIDE_BELOW: Record<HideBreakpoint, string> = {
  '20rem': '@max-[20rem]/table:hidden',
  '22rem': '@max-[22rem]/table:hidden',
  '24rem': '@max-[24rem]/table:hidden',
  '25rem': '@max-[25rem]/table:hidden',
  '26rem': '@max-[26rem]/table:hidden',
  '28rem': '@max-[28rem]/table:hidden',
  '30rem': '@max-[30rem]/table:hidden',
  '32rem': '@max-[32rem]/table:hidden',
  '34rem': '@max-[34rem]/table:hidden',
  '35rem': '@max-[35rem]/table:hidden',
  '36rem': '@max-[36rem]/table:hidden',
  '38rem': '@max-[38rem]/table:hidden',
  '40rem': '@max-[40rem]/table:hidden',
  '42rem': '@max-[42rem]/table:hidden',
  '44rem': '@max-[44rem]/table:hidden',
  '46rem': '@max-[46rem]/table:hidden',
  '48rem': '@max-[48rem]/table:hidden',
  '50rem': '@max-[50rem]/table:hidden',
  '52rem': '@max-[52rem]/table:hidden',
  '54rem': '@max-[54rem]/table:hidden',
  '56rem': '@max-[56rem]/table:hidden',
  '58rem': '@max-[58rem]/table:hidden',
  '60rem': '@max-[60rem]/table:hidden',
  '62rem': '@max-[62rem]/table:hidden',
  '64rem': '@max-[64rem]/table:hidden',
  '66rem': '@max-[66rem]/table:hidden',
  '68rem': '@max-[68rem]/table:hidden',
  '70rem': '@max-[70rem]/table:hidden',
  '72rem': '@max-[72rem]/table:hidden',
  '74rem': '@max-[74rem]/table:hidden',
  '76rem': '@max-[76rem]/table:hidden',
  '78rem': '@max-[78rem]/table:hidden',
  '80rem': '@max-[80rem]/table:hidden',
  '82rem': '@max-[82rem]/table:hidden',
  '84rem': '@max-[84rem]/table:hidden',
  '86rem': '@max-[86rem]/table:hidden',
  '88rem': '@max-[88rem]/table:hidden',
  '90rem': '@max-[90rem]/table:hidden',
  '92rem': '@max-[92rem]/table:hidden',
  '94rem': '@max-[94rem]/table:hidden',
  '96rem': '@max-[96rem]/table:hidden',
};

/** The inverse: shows folded content (hidden by default) below the same breakpoint. */
const SHOW_BELOW: Record<HideBreakpoint, string> = {
  '20rem': '@max-[20rem]/table:inline-flex',
  '22rem': '@max-[22rem]/table:inline-flex',
  '24rem': '@max-[24rem]/table:inline-flex',
  '25rem': '@max-[25rem]/table:inline-flex',
  '26rem': '@max-[26rem]/table:inline-flex',
  '28rem': '@max-[28rem]/table:inline-flex',
  '30rem': '@max-[30rem]/table:inline-flex',
  '32rem': '@max-[32rem]/table:inline-flex',
  '34rem': '@max-[34rem]/table:inline-flex',
  '35rem': '@max-[35rem]/table:inline-flex',
  '36rem': '@max-[36rem]/table:inline-flex',
  '38rem': '@max-[38rem]/table:inline-flex',
  '40rem': '@max-[40rem]/table:inline-flex',
  '42rem': '@max-[42rem]/table:inline-flex',
  '44rem': '@max-[44rem]/table:inline-flex',
  '46rem': '@max-[46rem]/table:inline-flex',
  '48rem': '@max-[48rem]/table:inline-flex',
  '50rem': '@max-[50rem]/table:inline-flex',
  '52rem': '@max-[52rem]/table:inline-flex',
  '54rem': '@max-[54rem]/table:inline-flex',
  '56rem': '@max-[56rem]/table:inline-flex',
  '58rem': '@max-[58rem]/table:inline-flex',
  '60rem': '@max-[60rem]/table:inline-flex',
  '62rem': '@max-[62rem]/table:inline-flex',
  '64rem': '@max-[64rem]/table:inline-flex',
  '66rem': '@max-[66rem]/table:inline-flex',
  '68rem': '@max-[68rem]/table:inline-flex',
  '70rem': '@max-[70rem]/table:inline-flex',
  '72rem': '@max-[72rem]/table:inline-flex',
  '74rem': '@max-[74rem]/table:inline-flex',
  '76rem': '@max-[76rem]/table:inline-flex',
  '78rem': '@max-[78rem]/table:inline-flex',
  '80rem': '@max-[80rem]/table:inline-flex',
  '82rem': '@max-[82rem]/table:inline-flex',
  '84rem': '@max-[84rem]/table:inline-flex',
  '86rem': '@max-[86rem]/table:inline-flex',
  '88rem': '@max-[88rem]/table:inline-flex',
  '90rem': '@max-[90rem]/table:inline-flex',
  '92rem': '@max-[92rem]/table:inline-flex',
  '94rem': '@max-[94rem]/table:inline-flex',
  '96rem': '@max-[96rem]/table:inline-flex',
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
   * Attribute columns only: hide order when the table plans its own breakpoints (1 hides first).
   * The table hides columns in this order just before the free column (the one without a width)
   * would drop below `freeColumnMin`. An explicit `hideBelow` wins.
   */
  hideOrder?: number;
  /**
   * Fold, don't drop: while this column is hidden (`hideBelow`), render `fold(row)` inside the
   * identity cell instead, e.g. an icon with a tooltip and sr-only text. Needs `hideBelow`.
   */
  fold?: (row: Row) => React.ReactNode;
  /** Column id to fold into; default the first identity column. */
  foldInto?: string;
  /**
   * Fixed content width (the cell padding is added), e.g. '10ch' for a mono ISO date or '8rem'.
   * On a `mono` column, `ch` counts mono characters, so give the full value's length: IDs and
   * dates are never cut. The free column has none (keep ≥ 7rem).
   */
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
  stage?: (row: Row) => StageKey | null;
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
  /**
   * The narrowest the free column (title, name) may get before attribute columns with a
   * `hideOrder` hide, e.g. '16rem' (DESIGN.md › Tables: column priority). Default 16rem.
   */
  freeColumnMin?: `${number}rem`;
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

/**
 * A column's CSS width. `width` is the content width (e.g. '10ch' for an ISO date in mono);
 * cells are border-box, so the cell's side padding is added, and the value is never cut.
 */
function columnWidth(width: string, dense: boolean): string {
  return `calc(${width} + ${dense ? '1rem' : '1.5rem'})`;
}

/** Rough rem per `ch` at body size (Atkinson Hyperlegible Mono 14 px is about 8.4 px). */
const CH_REM = 0.6;

function widthRem(width: string | undefined, dense: boolean): number {
  if (!width) return 0;
  const pad = dense ? 1 : 1.5;
  const n = Number.parseFloat(width);
  if (Number.isNaN(n)) return pad;
  if (width.endsWith('ch')) return n * CH_REM + pad;
  if (width.endsWith('px')) return n / 16 + pad;
  return n + pad;
}

/**
 * Plans when each attribute column with a `hideOrder` hides (DESIGN.md › Tables: column
 * priority): starting with every column shown, the first in hide order hides below the width the
 * whole row needs (fixed widths plus the free column at `freeColumnMin`); then the next, with the
 * first already gone; and so on. Each width rounds up to a breakpoint. Pure, so it is tested
 * without layout.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure planner beside its table
export function planColumnHiding<Row>(
  columns: readonly DataTableColumn<Row>[],
  options: { freeColumnMin?: string; selectable?: boolean; dense?: boolean } = {},
): Map<string, HideBreakpoint> {
  const dense = options.dense ?? false;
  const freeMin = Number.parseFloat(options.freeColumnMin ?? '16rem');
  const plan = new Map<string, HideBreakpoint>();
  const shown = new Set(columns.map((c) => c.id));
  const needed = () =>
    (options.selectable ? (dense ? 2.5 : 2.75) : 0) +
    columns
      .filter((c) => shown.has(c.id))
      .reduce((sum, c) => sum + (c.width ? widthRem(c.width, dense) : freeMin), 0);
  const ordered = columns
    .filter((c) => c.priority === 'attribute' && c.hideOrder !== undefined && !c.hideBelow)
    .sort((a, b) => a.hideOrder! - b.hideOrder!);
  for (const column of ordered) {
    const want = needed();
    const bp =
      HIDE_BREAKPOINTS_REM.find((b) => b >= want) ??
      HIDE_BREAKPOINTS_REM[HIDE_BREAKPOINTS_REM.length - 1]!;
    plan.set(column.id, `${bp}rem` as HideBreakpoint);
    shown.delete(column.id);
  }
  return plan;
}

function effectiveHide<Row>(
  column: DataTableColumn<Row>,
  plan?: ReadonlyMap<string, HideBreakpoint>,
): HideBreakpoint | undefined {
  if (column.priority !== 'attribute') return undefined;
  return column.hideBelow ?? plan?.get(column.id);
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
  freeColumnMin = '16rem',
  className,
}: DataTableProps<Row>) {
  const dense = density === 'table';
  const selectable = !!selectedIds && !!onSelectedIdsChange;
  const plan = React.useMemo(
    () => planColumnHiding(columns, { freeColumnMin, selectable, dense }),
    [columns, freeColumnMin, selectable, dense],
  );

  React.useEffect(() => {
    if (!isDev) return;
    for (const column of columns) {
      if (column.priority !== 'attribute' && column.hideBelow) {
        console.warn(
          `DataTable: column "${column.id}" is ${column.priority}; identity and state columns never hide, so hideBelow is ignored.`,
        );
      }
      if (column.fold && !effectiveHide(column, plan)) {
        console.warn(`DataTable: column "${column.id}" has fold but never hides; fold is ignored.`);
      }
    }
  }, [columns, plan]);

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
      if (!column.fold || !effectiveHide(column, plan)) continue;
      const target = column.foldInto ?? firstIdentity;
      if (!target) continue;
      map.set(target, [...(map.get(target) ?? []), column]);
    }
    return map;
  }, [columns, plan]);

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
    const hide = effectiveHide(column, plan);
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
    rowStage: StageKey | null,
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
                className={cn(
                  'hidden shrink-0 items-center',
                  SHOW_BELOW[effectiveHide(fold, plan)!],
                )}
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
                column.mono && cn('font-mono', dense ? 'text-[13px]' : 'text-sm'),
                column.headClassName,
              );
              const style = column.width ? { width: columnWidth(column.width, dense) } : undefined;
              // Mono columns: the th uses the record font at body size, so a `ch` width counts
              // the mono characters the cells show (an ISO date is 10ch, DEMO-2601 9ch); the
              // label itself stays sans 13 px.
              const label = column.mono ? (
                <span className="font-sans text-[13px]">{content}</span>
              ) : (
                content
              );
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
                    {label}
                  </SortableTableHead>
                );
              }
              return (
                <TableHead key={header.id} className={classes} style={style}>
                  {label}
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

/** Comfortable or compact (shared `TableDensity`, the person's Preferences default). */
export type TableDensityChoice = TableDensity;

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
