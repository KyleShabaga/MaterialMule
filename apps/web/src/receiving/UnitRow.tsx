import { CopyPlus, Ellipsis, MapPin, Plus, Trash2 } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { unitName, type UnitDraft } from './draft';

/**
 * One storage unit of a receipt (STRATA-76): its number, a heading for assistive technology, the
 * row's fields (UnitEditor) and an actions menu. No ID: IDs are issued only when the receipt is
 * confirmed. Enter on the last row adds a unit; Shift+Enter copies this one below (the page
 * handles both through `onKeyDown`).
 */
export function UnitRow({
  unit,
  index,
  canRemove,
  invalid = false,
  onAddHole,
  onUseLocation,
  onCopy,
  onRemove,
  onKeyDown,
  onKeyDownCapture,
  children,
}: {
  unit: UnitDraft;
  index: number;
  /** False for the only row: a receipt needs at least one unit. */
  canRemove: boolean;
  /** The row has a problem on show. */
  invalid?: boolean;
  /** Buckets: puts focus in the test hole search, to add another hole ("Also holds"). */
  onAddHole?: () => void;
  /** Tubes and new bulk samples: the source is a standalone location instead of a test hole. */
  onUseLocation?: () => void;
  onCopy: () => void;
  onRemove: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLElement>) => void;
  /** The unit's fields. */
  children: ReactNode;
}) {
  const name = unitName(index, unit);
  const headingId = `unit-${unit.clientRowId}-heading`;
  /** An action moves focus itself (the new row, the search): the menu must not take it back. */
  const acted = useRef(false);
  const act = (action: () => void) => () => {
    acted.current = true;
    action();
  };
  return (
    <li
      className={cn(
        'border-t px-4 py-4 first:border-t-0 sm:px-5',
        invalid && 'bg-stage-danger-bg/40',
      )}
    >
      <section
        id={`unit-${unit.clientRowId}`}
        aria-labelledby={headingId}
        className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3"
        onKeyDown={onKeyDown}
        onKeyDownCapture={onKeyDownCapture}
      >
        <span
          aria-hidden="true"
          className="text-muted-foreground flex h-11 items-center self-start pt-5 font-mono text-[13px] tabular-nums"
        >
          {index + 1}
        </span>
        <div className="min-w-0">
          <h3 id={headingId} tabIndex={-1} className="sr-only">
            {name}
          </h3>
          {children}
        </div>
        <div className="pt-5">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${name} actions`}
                title={`${name} actions`}
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-64"
              onCloseAutoFocus={(event) => {
                if (acted.current) event.preventDefault();
                acted.current = false;
              }}
            >
              {onAddHole ? (
                <DropdownMenuItem onSelect={act(onAddHole)}>
                  <Plus aria-hidden="true" />
                  Add a test hole to this unit
                </DropdownMenuItem>
              ) : null}
              {onUseLocation ? (
                <DropdownMenuItem onSelect={act(onUseLocation)}>
                  <MapPin aria-hidden="true" />
                  Use a location reference instead
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={act(onCopy)}>
                <CopyPlus aria-hidden="true" />
                Copy this unit below
                <DropdownMenuShortcut>Shift+Enter</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={!canRemove}
                onSelect={act(onRemove)}
              >
                <Trash2 aria-hidden="true" />
                Remove {name}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>
    </li>
  );
}
