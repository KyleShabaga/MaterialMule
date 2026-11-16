import type { TestProgress } from '@materialmule/shared';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { CountedCells } from '../components/app-ui';
import { progressCells, progressLabel, progressShort } from './format';

// Field Ledger progress (docs/redesign/design.md, "Counted cells"): one cell per test, ink =
// done, flag = in progress, sheet = not started, always with the count in words. Progress only:
// no result is ever shown or entered here. Cancelled tests get no cell; the text says so.

/** Counted cells and the "N of M done" text for one program's tests. */
export function ProgressCells({
  progress,
  size = 'row',
}: {
  progress: TestProgress;
  /** `row` in a table or list; `strip` in the program page's progress strip. */
  size?: 'row' | 'strip';
}) {
  const total = progress.done + progress.inProgress + progress.notStarted;
  if (total === 0) {
    return (
      <span className="lab-progress-none">
        {progress.cancelled > 0 ? `${progress.cancelled} cancelled` : 'No tests'}
      </span>
    );
  }
  return (
    <span className={`lab-progress lab-progress-${size}`}>
      <CountedCells cells={progressCells(progress)} label={progressLabel(progress)} />
      <span className="lab-progress-text" aria-hidden="true">
        {progress.done} of {total} done
        {progress.inProgress > 0 ? ` · ${progress.inProgress} in progress` : ''}
        {progress.cancelled > 0 ? ` · ${progress.cancelled} cancelled` : ''}
      </span>
    </span>
  );
}

/** The Done / In progress / Not started key under a list of counted cells. */
export function ProgressKey() {
  return (
    <ul className="lab-progress-key" aria-label="Progress key">
      <li>
        <span className="counted-cell counted-cell-done" aria-hidden="true" />
        Done
      </li>
      <li>
        <span className="counted-cell counted-cell-current" aria-hidden="true" />
        In progress
      </li>
      <li>
        <span className="counted-cell counted-cell-empty" aria-hidden="true" />
        Not started
      </li>
    </ul>
  );
}

/**
 * Strata progress (STRATA-87): "n of m" with a thin bar, cancelled tests counted apart and never
 * in m (the list, the drawer and the program page count the same way). Progress only.
 */
export function ProgressMeter({
  progress,
  size = 'row',
  className,
}: {
  progress: TestProgress;
  /** `row` in a table cell; `header` on the program page ("n of m tests done"). */
  size?: 'row' | 'header';
  className?: string;
}) {
  const { done, total } = progressShort(progress);
  const text =
    total === 0
      ? progress.cancelled > 0
        ? `${progress.cancelled} cancelled`
        : 'No tests'
      : size === 'header'
        ? `${done} of ${total} tests done`
        : `${done} of ${total}`;
  return (
    <span
      data-slot="progress-meter"
      className={cn('flex min-w-0 flex-col gap-1', size === 'header' ? 'w-48' : 'w-24', className)}
    >
      <span className="flex items-baseline gap-1.5 text-sm tabular-nums">
        <span className={size === 'header' ? 'font-semibold' : undefined}>{text}</span>
        {total > 0 && progress.cancelled > 0 ? (
          <span className="truncate text-xs text-muted-foreground">
            {progress.cancelled} cancelled
          </span>
        ) : null}
      </span>
      {total > 0 ? (
        <Progress
          value={(done / total) * 100}
          aria-label={progressLabel(progress)}
          className="h-1"
        />
      ) : null}
    </span>
  );
}
