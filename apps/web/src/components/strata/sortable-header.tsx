import type * as React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { nextHeadingSort, type SortState } from './table-query';

/**
 * A sortable column heading (STRATA-49): a `th` with `aria-sort` holding one button. Clicking
 * cycles ascending, descending, default. It is controlled: `sort` is the table's one sort state
 * (the same value the toolbar's Sort menu and chips use) and `onSortChange` writes it.
 */
export function SortableTableHead({
  sortKey,
  sort,
  onSortChange,
  children,
  align = 'start',
  className,
  ...props
}: {
  sortKey: string;
  sort: SortState | null;
  onSortChange: (next: SortState | null) => void;
  children: React.ReactNode;
  align?: 'start' | 'end';
} & Omit<React.ComponentProps<'th'>, 'children' | 'align'>) {
  const dir = sort?.key === sortKey ? sort.dir : null;
  const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  const Arrow = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <TableHead
      aria-sort={ariaSort}
      className={cn(align === 'end' && 'text-right', className)}
      {...props}
    >
      <button
        type="button"
        // data-slot keeps wave 0's legacy bare-button rules off it (they skip [data-slot]).
        data-slot="table-sort-button"
        onClick={() => onSortChange(nextHeadingSort(sort, sortKey))}
        className={cn(
          'group/sort -mx-1 inline-flex max-w-full items-center gap-1 rounded-sm px-1 py-0.5 font-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          align === 'end' && 'flex-row-reverse',
        )}
      >
        <span className="truncate">{children}</span>
        <Arrow
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0',
            dir
              ? 'text-link'
              : 'text-muted-foreground opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100',
          )}
        />
      </button>
    </TableHead>
  );
}
