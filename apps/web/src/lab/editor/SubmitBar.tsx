import { CircleAlert, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { EditorProblem } from './program-state';

// The editor's sticky bar (STRATA-86): "3 lines · 5 tests", what still keeps the program from
// going to the lab (each one jumps to its line), and the one primary action.

export function SubmitBar({
  counts,
  problems,
  onProblem,
  blockedReason,
  busy,
  label = 'Submit to the lab',
  onSubmit,
  secondary,
}: {
  counts: string;
  problems: EditorProblem[];
  onProblem: (problem: EditorProblem) => void;
  /** Why Submit is off for a reason that isn't a line problem ("Reload first."). */
  blockedReason?: string | null;
  busy: boolean;
  label?: string;
  onSubmit: () => void;
  secondary?: ReactNode;
}) {
  const blocked = problems.length > 0 || Boolean(blockedReason);
  return (
    <div
      role="region"
      aria-label="Submit"
      className="sticky bottom-0 z-20 -mx-4 mt-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-8 sm:px-8"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm font-medium" aria-live="polite">
          {counts}
        </span>
        {problems.length > 0 ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-stage-danger-fg">
              <CircleAlert aria-hidden="true" className="size-4" />
              {problems.length === 1
                ? '1 thing to fix before submitting'
                : `${problems.length} things to fix before submitting`}
            </span>
            <ul className="flex flex-wrap gap-x-1 gap-y-1" aria-label="To fix before submitting">
              {problems.slice(0, 6).map((problem, i) => (
                <li key={`${problem.lineKey ?? 'program'}-${problem.field}-${i}`}>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-1 py-0 text-[13px] pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover]:underline"
                    onClick={() => onProblem(problem)}
                  >
                    {problem.barMessage}
                  </Button>
                </li>
              ))}
              {problems.length > 6 ? (
                <li className="px-1 text-[13px] text-muted-foreground">
                  and {problems.length - 6} more
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <span className="flex-1 text-[13px] text-muted-foreground">
            {blockedReason ??
              'Each test starts as Waiting. The lab records progress only, never results.'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {secondary}
          <Button
            type="button"
            className="pointer-coarse:h-11"
            size="sm"
            disabled={busy || blocked}
            onClick={onSubmit}
          >
            {busy ? <Spinner aria-hidden="true" /> : <Send aria-hidden="true" />}
            {label}
          </Button>
        </div>
      </div>
      {problems.length > 0 && blockedReason ? (
        <p className="mt-1 text-[13px] text-muted-foreground">{blockedReason}</p>
      ) : null}
    </div>
  );
}
