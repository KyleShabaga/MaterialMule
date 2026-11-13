import type { StageKey } from '@materialmule/shared';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** The stage colour families in strata-theme.css (`--stage-<key>-bg/fg/mark`); lane 1C's keys. */
export type { StageKey };

/**
 * A record's stage as a written tag in its stage colour (DESIGN.md › Lifecycle; STRATA-60).
 * Local to search until lane 1B's shared StageTag lands; same name and props so it can be
 * swapped for that one without touching the callers.
 */
export function StageTag({
  stage,
  children,
  className,
}: {
  stage: StageKey;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge variant={stage} data-stage={stage} className={cn('shrink-0', className)}>
      {children}
    </Badge>
  );
}
