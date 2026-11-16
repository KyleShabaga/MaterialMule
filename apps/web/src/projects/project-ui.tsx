import type { LabProgramSummary } from '@materialmule/shared';
import { ChevronLeft, ChevronRight, CircleAlert, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { programProgress } from './project-format';

// Small pieces the Strata project screens share (STRATA-83, STRATA-84).

/** "Projects couldn't load" with the server's words and Try again (canvas R4ListError, R4Error). */
export function LoadErrorAlert({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive" className="relative overflow-hidden">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-stage-danger-mark" />
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message} Nothing has changed.</p>
        <div className="mt-2">
          <Button variant="outline" size="sm" className="text-foreground" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** "1–25 of 214 projects" and Previous / Next page, under a server-paged table. */
export function TablePager({
  page,
  pageSize,
  total,
  noun,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Plural noun, e.g. "projects". */
  noun: string;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-4 pt-2 text-sm text-muted-foreground">
      <span role="status">
        {first.toLocaleString('en-CA')}–{last.toLocaleString('en-CA')} of{' '}
        {total.toLocaleString('en-CA')} {noun}
      </span>
      {pages > 1 ? (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A section of the Overview: heading, a quiet count or note beside it, an action at the right. */
export function OverviewSection({
  id,
  title,
  meta,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {meta ? <span className="text-sm text-muted-foreground">{meta}</span> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "2 of 5" with a thin bar; the bar's name says what it counts. */
export function ProgramProgress({ program }: { program: LabProgramSummary }) {
  const { done, total } = programProgress(program);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Progress
        value={total === 0 ? 0 : (done / total) * 100}
        aria-label={`${done} of ${total} tests done`}
        className="h-1.5 w-16 shrink-0"
      />
      <span className="font-mono text-xs whitespace-nowrap tabular-nums">
        {done} of {total}
      </span>
    </div>
  );
}
