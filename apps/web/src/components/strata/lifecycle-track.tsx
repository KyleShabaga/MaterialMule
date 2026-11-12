import type { StageKey } from '@materialmule/shared';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STAGE_MARK_BG, STAGE_MARK_RING, STAGE_SOLID_CLASS, STAGE_TAG_CLASS } from './stage';

export interface LifecycleStep {
  /** Stable key; `current` names one of these (the API returns it, DESIGN.md › Lifecycle). */
  key: string;
  /** Full name, always given to screen readers and the title. */
  name: string;
  /** Optional shorter visible label ("Short-term" for "Short-term storage"). */
  short?: string;
  stage: StageKey;
}

/** Storage unit lifecycle in Kyle's order (2026-11-12): lab testing first, then storage terms. */
// eslint-disable-next-line react-refresh/only-export-components -- step lists belong with the track
export const STORAGE_UNIT_STEPS: readonly LifecycleStep[] = [
  { key: 'received', name: 'Received', stage: 'draft' },
  { key: 'in_lab', name: 'In lab', stage: 'lab' },
  { key: 'short_term', name: 'Short-term storage', short: 'Short-term', stage: 'storage' },
  { key: 'long_term', name: 'Long-term storage', short: 'Long-term', stage: 'storage' },
  { key: 'disposed', name: 'Disposed', stage: 'closed' },
];

/** Concrete specimen sets (DESIGN.md › Lifecycle): stages follow the concrete column there. */
// eslint-disable-next-line react-refresh/only-export-components -- step lists belong with the track
export const CONCRETE_SET_STEPS: readonly LifecycleStep[] = [
  { key: 'cast', name: 'Cast', stage: 'draft' },
  { key: 'received', name: 'Received', stage: 'storage' },
  { key: 'testing', name: 'Testing', stage: 'lab' },
  { key: 'reported', name: 'Reported', stage: 'closed' },
];

type StepState = 'past' | 'skipped' | 'current' | 'future';

const SR_SUFFIX: Record<StepState, string> = {
  past: ', done',
  skipped: ', skipped',
  current: ', current',
  future: '',
};

export interface LifecycleTrackProps {
  steps: readonly LifecycleStep[];
  /** Key of the current step, derived on the server. Unknown keys render every step as future. */
  current: string;
  /** Accessible name of the list. */
  label?: string;
  /** Rows and the unit drawer: small squares with the current step written beside them. */
  compact?: boolean;
  /**
   * Keys of past steps the record passed without doing (a unit never sent to the lab passes In
   * lab). Shown as past, without a check, and read as "skipped" so no lab work is implied.
   */
  passedWithout?: readonly string[];
  className?: string;
}

/**
 * The lifecycle track (STRATA-59, DESIGN.md › Lifecycle). One `ol` with `aria-current="step"` on
 * the current item; each step's state is also written as sr-only text, never colour alone.
 */
export function LifecycleTrack({
  steps,
  current,
  label = 'Lifecycle',
  compact = false,
  passedWithout = [],
  className,
}: LifecycleTrackProps) {
  // -1 when the key is unknown: every step is then "future" rather than a guessed position.
  const at = steps.findIndex((step) => step.key === current);
  const stateOf = (index: number, key: string): StepState =>
    index === at
      ? 'current'
      : index < at
        ? passedWithout.includes(key)
          ? 'skipped'
          : 'past'
        : 'future';

  if (compact) {
    const now = at >= 0 ? steps[at] : undefined;
    return (
      <div data-slot="lifecycle-track" className={cn('flex items-center gap-2.5', className)}>
        <ol aria-label={label} className="flex items-center">
          {steps.map((step, i) => {
            const state = stateOf(i, step.key);
            return (
              <li
                key={step.key}
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
                className="flex items-center"
              >
                {i > 0 ? (
                  <span
                    aria-hidden="true"
                    className={cn('h-0.5 w-3', i <= at ? 'bg-input' : 'bg-border')}
                  />
                ) : null}
                {/* 8 px squares with 1 px corners: filled when reached, outlined when not. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-2 shrink-0 rounded-[1px]',
                    state === 'future'
                      ? 'border border-input bg-transparent'
                      : cn(STAGE_MARK_BG[step.stage], 'forced-colors:bg-[CanvasText]'),
                    state === 'current' &&
                      cn(
                        'ring-2 ring-offset-2 ring-offset-background',
                        STAGE_MARK_RING[step.stage],
                      ),
                  )}
                />
                <span className="sr-only">
                  {step.name}
                  {SR_SUFFIX[state]}
                </span>
              </li>
            );
          })}
        </ol>
        {/* The list already says which step is current, so this visible copy is hidden. */}
        {now ? (
          <span aria-hidden="true" className="text-[13px] font-semibold">
            {now.name}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <ol
      aria-label={label}
      data-slot="lifecycle-track"
      className={cn('flex w-full gap-1', className)}
    >
      {steps.map((step, i) => {
        const state = stateOf(i, step.key);
        const short = step.short && step.short !== step.name ? step.short : undefined;
        return (
          <li
            key={step.key}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className={cn(
              // Squared segments (2 px corners); forced-colors keeps a CanvasText edge.
              'flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-sm px-2 text-[12px] font-semibold forced-colors:border forced-colors:border-[CanvasText]',
              state === 'future' && 'bg-muted font-medium text-muted-foreground',
              (state === 'past' || state === 'skipped') && STAGE_TAG_CLASS[step.stage],
              state === 'current' &&
                cn(
                  STAGE_SOLID_CLASS[step.stage],
                  'forced-colors:border-2 forced-colors:border-[Highlight]',
                ),
            )}
          >
            {state === 'past' ? <Check aria-hidden="true" className="size-3 shrink-0" /> : null}
            {short ? (
              <span className="truncate" title={step.name}>
                <span aria-hidden="true">{short}</span>
                <span className="sr-only">{step.name}</span>
              </span>
            ) : (
              <span className="truncate">{step.name}</span>
            )}
            {SR_SUFFIX[state] ? <span className="sr-only">{SR_SUFFIX[state]}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
