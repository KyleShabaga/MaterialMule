import type * as React from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  describeSort,
  sameSort,
  type SortLabels,
  type SortOption,
  type TableQuery,
} from './table-query';

export interface QueryFilterOption {
  id: string;
  label: string;
  count?: number;
}

export interface ActiveQueryChipsProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  query: TableQuery;
  onQueryChange: (patch: Partial<TableQuery>) => void;
  /** The page's filters, for their labels. An active id not listed shows as itself. */
  filters?: readonly QueryFilterOption[];
  /** The Sort menu; the first entry is the default order. */
  sortOptions?: readonly SortOption[];
  /** Words for heading sorts that aren't in the menu. */
  sortLabels?: SortLabels;
}

/**
 * The active sort and filters as chips (STRATA-65), shown before the toolbar icons: one chip for
 * a non-default sort (heading or menu, they are one setting) and one per filter. Each chip's ×
 * clears just that one. Search isn't repeated here; it shows in its own box. Renders nothing when
 * nothing is active.
 */
export function ActiveQueryChips({
  query,
  onQueryChange,
  filters = [],
  sortOptions = [],
  sortLabels,
  className,
  ...props
}: ActiveQueryChipsProps) {
  const defaultSort = sortOptions[0]?.sort ?? null;
  const showSort = query.sort !== null && !sameSort(query.sort, defaultSort);
  if (!showSort && query.filters.length === 0) return null;

  const chips: { key: string; text: string; clear: () => void }[] = [];
  if (showSort) {
    chips.push({
      key: 'sort',
      text: describeSort(query.sort, sortOptions, sortLabels),
      clear: () => onQueryChange({ sort: null }),
    });
  }
  for (const id of query.filters) {
    chips.push({
      key: `filter:${id}`,
      text: filters.find((f) => f.id === id)?.label ?? id,
      clear: () => onQueryChange({ filters: query.filters.filter((f) => f !== id) }),
    });
  }

  return (
    <div
      role="group"
      aria-label="Active sort and filters"
      className={cn('flex flex-wrap items-center gap-1', className)}
      {...props}
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-7 items-center gap-0.5 rounded-full border bg-card pr-0.5 pl-2.5 text-[13px] font-medium whitespace-nowrap text-foreground"
        >
          {chip.text}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Clear ${chip.text}`}
            onClick={chip.clear}
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        </span>
      ))}
    </div>
  );
}
