import type { LucideIcon } from 'lucide-react';
import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

// STRATA-98: small pieces the project's Concrete screens share (canvas R8Project*, R8Mix*, R8Prop*).

/** A sub-tab's section: its heading at the left, its table tools at the right. */
export function ConcreteSection({
  id,
  title,
  tools,
  children,
  className,
}: {
  id: string;
  title: string;
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {tools ? <div className="flex flex-wrap items-center gap-2">{tools}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A quiet line under a list: what the list means, or who may change it. */
export function ConcreteNote({
  icon: Icon = Info,
  children,
  className,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('flex items-start gap-2 text-[13px] text-muted-foreground', className)}>
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** "1 of 3" with a thin bar, for a set's tested specimens. */
export function TestedProgress({ tested, scheduled }: { tested: number; scheduled: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="font-mono text-xs whitespace-nowrap tabular-nums">
        {tested} of {scheduled}
      </span>
      <Progress
        value={scheduled === 0 ? 0 : (tested / scheduled) * 100}
        aria-label={`${tested} of ${scheduled} tested`}
        className="h-1.5 w-14 shrink-0"
      />
    </div>
  );
}
