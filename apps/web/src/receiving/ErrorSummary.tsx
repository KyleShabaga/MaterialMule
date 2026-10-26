import { useEffect, useRef, type MouseEvent } from 'react';
import { fieldId, type DraftProblem } from './draft';
import { focusField } from './focus';

/**
 * "Fix these before continuing" list at the top of a step, each problem linking to its field.
 * Takes focus when it appears (or the problems change after another attempt).
 */
export function ErrorSummary({
  problems,
  attempt,
  title,
}: {
  problems: DraftProblem[];
  /** Bumped on every blocked Next/Confirm so focus returns to the summary. */
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
      className="error-summary"
      role="alert"
      tabIndex={-1}
      aria-labelledby="receipt-error-summary-title"
    >
      <h2 id="receipt-error-summary-title">
        {title ??
          `Fix ${problems.length === 1 ? 'this problem' : `these ${problems.length} problems`} to continue`}
      </h2>
      <ul>
        {problems.map((problem) => (
          <li key={`${problem.field}|${problem.message}`}>
            <a href={`#${fieldId(problem.field)}`} onClick={(e) => onClick(e, problem.field)}>
              {problem.where ? `${problem.where}: ` : ''}
              {problem.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
