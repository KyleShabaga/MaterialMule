import {
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  STORAGE_UNIT_SHELF_CELL_LABELS,
  type EffectiveStorageTerm,
  type InventoryItem,
  type StageKey,
} from '@materialmule/shared';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { StageStripe } from '../components/strata/stage-stripe';
import { itemRecordStatus, unitPath, type UnitLinkState } from './unit-record';

/** The stage word's text colour (stage `fg`). Literal classes so Tailwind finds them. */
const STAGE_TEXT: Record<StageKey, string> = {
  draft: 'text-stage-draft-fg',
  storage: 'text-stage-storage-fg',
  lab: 'text-stage-lab-fg',
  due: 'text-stage-due-fg',
  danger: 'text-stage-danger-fg',
  closed: 'text-stage-closed-fg',
};

const CELL =
  'relative flex h-auto min-h-16 w-full min-w-0 flex-col items-start justify-start gap-0.5 rounded-lg py-2 pr-3 pl-4 text-left font-normal';

/**
 * Counted cells (STRATA-74): one per place on the shelf, from the location's real capacity. A
 * filled cell is a button with an inset stage stripe, the short stage word and the unit ID; it
 * opens the unit drawer (or the unit's page where there is no drawer). Empty places are dashed.
 * The app records no positions, so cells are counted, not numbered places.
 */
export function ShelfCells({
  items,
  capacity,
  term,
  openId,
  onOpen,
  linkState,
}: {
  items: readonly InventoryItem[];
  capacity: number | null;
  term: EffectiveStorageTerm | undefined;
  openId: string | null;
  /** Opens the drawer; null where there is no drawer (cells link to the unit page). */
  onOpen: ((readableId: string) => void) | null;
  linkState: UnitLinkState;
}) {
  const empty = capacity === null ? 0 : Math.max(0, capacity - items.length);
  return (
    <ol
      aria-label="Places on this shelf"
      className="grid grid-cols-2 gap-2 @min-[44rem]:grid-cols-4"
    >
      {items.map((item) => {
        const status = itemRecordStatus(item, term);
        const stage = item.stage ?? STORAGE_UNIT_RECORD_STATUS_STAGE[status];
        const word = STORAGE_UNIT_SHELF_CELL_LABELS[status];
        const content = (
          <>
            <StageStripe stage={stage} className="top-2 bottom-2 left-1.5" />
            <span className={cn('truncate text-[13px] font-medium', STAGE_TEXT[stage])}>
              {word}
            </span>
            <span className="font-mono text-[13px] leading-5 font-semibold whitespace-nowrap">
              {item.readableId}
            </span>
          </>
        );
        const open = openId === item.readableId;
        return (
          <li key={item.id}>
            {onOpen ? (
              <Button
                type="button"
                variant="outline"
                aria-label={`${item.readableId}, ${word}. Open in the drawer`}
                aria-pressed={open}
                onClick={() => onOpen(item.readableId)}
                className={cn(CELL, 'bg-card', open && 'bg-accent ring-2 ring-ring/50')}
              >
                {content}
              </Button>
            ) : (
              <Button asChild variant="outline" className={cn(CELL, 'bg-card')}>
                <Link
                  to={unitPath(item.readableId)}
                  state={linkState}
                  aria-label={`${item.readableId}, ${word}`}
                >
                  {content}
                </Link>
              </Button>
            )}
          </li>
        );
      })}
      {Array.from({ length: empty }, (_, index) => (
        <li key={`empty-${index}`}>
          <div className="flex h-full min-h-16 w-full flex-col justify-center rounded-lg border border-dashed border-input/60 py-2 pr-3 pl-4">
            <span className="text-[13px] text-muted-foreground">Empty place</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
