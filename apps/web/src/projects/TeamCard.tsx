import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * One section of the Team tab (boards R4Team*): a shadcn Card named by its h2, with an optional
 * count or note beside the heading and an action at the end of the header row.
 */
export function TeamCard({
  id,
  title,
  count,
  meta,
  action,
  className,
  children,
}: {
  id: string;
  title: string;
  /** Shown beside the heading in mono, e.g. the number of people. */
  count?: number;
  /** A short note beside the heading, e.g. "As the server reports it · checked 10:42". */
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <Card role="region" aria-labelledby={headingId} className={cn('min-w-0 gap-4 py-5', className)}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          {count !== undefined ? (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{count}</span>
          ) : null}
          {meta ? <span className="text-[13px] text-muted-foreground">{meta}</span> : null}
        </div>
        {action}
      </div>
      <CardContent className="flex min-w-0 flex-col gap-3 px-5">{children}</CardContent>
    </Card>
  );
}
