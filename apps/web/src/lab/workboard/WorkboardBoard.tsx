import {
  WORKBOARD_COLUMNS,
  WORKBOARD_COLUMN_LABEL,
  type WorkboardColumn,
  type Worklist,
} from '@materialmule/shared';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { ProgramCard } from './ProgramCard';

const SCROLLER =
  'relative flex gap-4 overflow-x-auto pb-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';
// Two columns at a time below a 60rem container (1024 px with the sidebar), sideways scroll;
// all four share the width above it.
const COLUMN =
  'flex w-[21rem] max-w-[85%] shrink-0 flex-col gap-3 rounded-xl bg-muted/60 p-3 @min-[60rem]:w-auto @min-[60rem]:max-w-none @min-[60rem]:min-w-0 @min-[60rem]:flex-1 @min-[60rem]:shrink';

/**
 * The board view (STRATA-88): four columns by where each program is (server-derived
 * `column`), Urgent first then the oldest open test in each. Cards hold explicit links; no drag.
 * The scroller is focusable so the keyboard can scroll it sideways.
 */
export function WorkboardBoard({ columns }: { columns: Record<WorkboardColumn, Worklist> }) {
  return (
    <div role="region" aria-label="Workboard by status" tabIndex={0} className={SCROLLER}>
      {WORKBOARD_COLUMNS.map((column) => {
        const list = columns[column];
        const id = `workboard-col-${column}`;
        return (
          <section key={column} aria-labelledby={id} className={COLUMN}>
            <h3 id={id} className="flex items-baseline gap-2 px-1 text-sm font-semibold">
              {WORKBOARD_COLUMN_LABEL[column]}
              <span
                aria-hidden="true"
                className="text-[13px] font-normal text-muted-foreground tabular-nums"
              >
                {list.total}
              </span>
              <span className="sr-only">{`, ${list.total} ${list.total === 1 ? 'program' : 'programs'}`}</span>
            </h3>
            {list.items.length === 0 ? (
              <p className="px-1 text-[13px] text-muted-foreground">Nothing here.</p>
            ) : (
              <ItemGroup role="list" aria-label={WORKBOARD_COLUMN_LABEL[column]} className="gap-2">
                {list.items.map((item) => (
                  <ProgramCard key={item.programId} item={item} column={column} />
                ))}
              </ItemGroup>
            )}
            {list.total > list.items.length ? (
              <p className="px-1 text-[13px] text-muted-foreground">
                Showing the first {list.items.length} of {list.total}. The list view shows them all.
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function WorkboardBoardSkeleton() {
  return (
    <div className={SCROLLER} aria-hidden="true">
      {WORKBOARD_COLUMNS.map((column) => (
        <div key={column} className={COLUMN}>
          <Skeleton className="h-4 w-32" />
          {[0, 1].map((n) => (
            <div key={n} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-2 w-24" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
