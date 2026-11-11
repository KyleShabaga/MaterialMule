import type { ReactNode } from 'react';

/**
 * A Concrete tab's title row (canvas "ProjectConcrete"): the tab's heading and a line under it at
 * the left, its filters and actions at the right, over a 2 px ink rule. Wraps on a phone.
 */
export function TabHead({
  id,
  title,
  hint,
  level = 2,
  children,
}: {
  /** The heading's id, for the section's aria-labelledby. */
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  level?: 2 | 3;
  /** Filters and actions, right of the title. */
  children?: ReactNode;
}) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <div className="concrete-head">
      <div className="concrete-head-title">
        <Heading id={id}>{title}</Heading>
        {hint ? <p className="concrete-head-hint">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
