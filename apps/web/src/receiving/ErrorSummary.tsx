import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, type MouseEvent } from 'react';
import { fieldId, formatFixCount, type DraftProblem } from './draft';
import { focusField } from './focus';

/**
 * The problems that block Confirm, each linking to its field (inline errors repeat them on their
 * rows). Takes focus when it appears, or when the problems change after another attempt.
 */
export function ErrorSummary({
  problems,
  attempt,
  title,
}: {
  problems: DraftProblem[];
  /** Bumped on every blocked Confirm so focus returns to the summary. */
  attempt: number;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (attempt > 0) ref.current?.focus();
  }, [attempt]);

  if (problems.length === 0) return null;

  function onClick(event: MouseEvent<HTMLAnchorElement>, field: string) {
    event.preventDefault();
    focusField(fieldId(field || 'projectId'));
  }

  return (
    <div
      ref={ref}
      className="error-summary bg-card text-destructive-text relative grid grid-cols-[1rem_1fr] gap-x-3 overflow-hidden rounded-lg border py-3 pr-4 pl-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      role="alert"
      tabIndex={-1}
      aria-labelledby="receipt-error-summary-title"
    >
      <span aria-hidden="true" className="bg-stage-danger-mark absolute inset-y-0 left-0 w-1" />
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4" />
      <div className="min-w-0">
        <h2 id="receipt-error-summary-title" className="m-0 text-sm font-semibold">
          {title ?? formatFixCount(problems.length)}
        </h2>
        <ul className="m-0 mt-1 list-none p-0">
          {problems.map((problem) => (
            <li key={`${problem.field}|${problem.message}`}>
              <a
                data-slot="error-link"
                className="text-destructive-text inline-flex min-h-6 items-center text-sm underline underline-offset-3"
                href={`#${fieldId(problem.field)}`}
                onClick={(e) => onClick(e, problem.field)}
              >
                {problem.where ? `${problem.where}: ` : ''}
                {problem.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
