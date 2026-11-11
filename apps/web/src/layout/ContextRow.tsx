import type { ReactNode } from 'react';

/**
 * Field Ledger context row (docs/redesign/design.md, "Shell additions"): one row at the top of
 * the page content, above the title, holding what pages used to put in the top strip: back
 * links, draft or status tags, the step control, section switches and the page's actions.
 * A row that holds only actions is right-aligned (`align="end"`); one that starts with a back
 * link, tag or switch stays left-aligned (the default).
 */
export function ContextRow({
  align = 'start',
  className,
  children,
}: {
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
}) {
  const classes = ['context-row', align === 'end' ? 'context-row-end' : null, className]
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}
