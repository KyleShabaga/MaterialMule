import { cn } from '@/lib/utils';
import type { StageKey } from '@materialmule/shared';
import { STAGE_MARK_BG } from './stage';

export type StageStripeVariant = 'row' | 'dense' | 'edge';

const VARIANT: Record<StageStripeVariant, string> = {
  // Rows: an inset, fully round 4 px bar, 10 px from the row's top and bottom and 4 px from the
  // edge, so stacked rows of one stage read as separate bars (Kyle, 2026-11-12).
  row: 'left-1 top-2.5 bottom-2.5 w-1 rounded-full',
  // The 28 px dense table: 4 px from top and bottom.
  dense: 'left-1 top-1 bottom-1 w-1 rounded-full',
  // Cards and banners keep a full-height edge (the parent clips it to its radius).
  edge: 'left-0 inset-y-0 w-1',
};

/**
 * The 4 px stage stripe on the left inside edge of a row, card or banner. Decoration only: the
 * stage is always written elsewhere (a tag, or sr-only text in dense cells). The parent must be
 * `relative` (rows: the first cell; cards: the card with `overflow-hidden`).
 */
export function StageStripe({
  stage,
  variant = 'row',
  className,
}: {
  stage: StageKey;
  variant?: StageStripeVariant;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="stage-stripe"
      data-stage={stage}
      className={cn(
        'pointer-events-none absolute forced-colors:bg-[CanvasText]',
        VARIANT[variant],
        STAGE_MARK_BG[stage],
        className,
      )}
    />
  );
}
