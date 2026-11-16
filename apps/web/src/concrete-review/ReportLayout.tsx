import { Check, ChevronsRight, PanelRightOpen, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '../components/useMediaQuery';

// STRATA-96/99 (DESIGN.md › Concrete review, round 8; boards R8Report*, R8Strength*): the report
// page frame shared by review, issue and the strength report. A header with the steps (Review,
// then Issue), the title, status and version; then the report as paper on the left and a 22rem
// panel on the right with its decision pinned at the foot. Between a tablet and 1280 px (the
// 1024 px window) the panel is a drawer (Sheet) over the report; on a phone it follows the report.

/** The window range where the panel becomes a drawer over the report. */
const REPORT_DRAWER_QUERY = '(min-width: 768px) and (max-width: 1279.98px)';

export type StepState = 'now' | 'done' | 'later';

export function ReportSteps({ review, issue }: { review: StepState; issue: StepState }) {
  const step = (n: number, label: string, state: StepState) => (
    <li
      aria-current={state === 'now' ? 'step' : undefined}
      className={cn(
        'flex items-center gap-1.5 text-sm',
        state === 'now' ? 'font-semibold text-foreground' : 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 items-center justify-center rounded-full text-[11px] font-semibold',
          state === 'now'
            ? 'bg-primary text-primary-foreground'
            : state === 'done'
              ? 'bg-stage-closed-bg text-stage-closed-fg'
              : 'border text-muted-foreground',
        )}
      >
        {state === 'done' ? <Check className="size-3" /> : n}
      </span>
      {label}
      {state === 'done' ? <span className="sr-only">, done</span> : null}
    </li>
  );
  return (
    <ol aria-label="Steps" className="flex items-center gap-2">
      {step(1, 'Review', review)}
      <li aria-hidden="true" className="h-px w-6 bg-border" />
      {step(2, 'Issue', issue)}
    </ol>
  );
}

export function ReportCrumbs({ current }: { current: ReactNode }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/concrete/review">Review</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export function ReportHeader({
  crumb,
  steps,
  title,
  meta,
  tags,
}: {
  crumb: ReactNode;
  steps?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  tags?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b pb-4" data-slot="record-header">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <ReportCrumbs current={crumb} />
        {steps}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {meta ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {meta}
          </div>
        ) : null}
        {tags ? <div className="flex flex-wrap items-center gap-2">{tags}</div> : null}
      </div>
    </header>
  );
}

/**
 * The paper: the report as it would print, black on white even in dark mode (`.r8-paper`
 * re-declares the light tokens), with its label above it.
 */
export function ReportPaper({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{label}</span>
      </p>
      <div className="r8-paper mx-auto w-full max-w-[52rem] rounded-sm border p-6 shadow-sm sm:p-10">
        {children}
      </div>
    </div>
  );
}

/** One titled section of the panel. */
export function PanelSection({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 border-b px-4 py-4 last:border-b-0"
    >
      <h2 id={id} className="flex items-baseline gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && count !== null ? (
          <span className="font-normal text-muted-foreground">{count}</span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

/**
 * Report left, panel right. `panelLabel` names the panel (its complementary landmark); `footer`
 * is the decision, pinned at the panel's foot. `alert` sits above the paper (a stale version).
 */
export function ReportSplit({
  paper,
  panel,
  footer,
  panelLabel,
  alert,
  drawerOpen,
  onDrawerOpenChange,
}: {
  paper: ReactNode;
  panel: ReactNode;
  footer?: ReactNode;
  panelLabel: string;
  alert?: ReactNode;
  /** Controlled drawer state (to open it from a comment marker); uncontrolled when omitted. */
  drawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
}) {
  const drawer = useMediaQuery(REPORT_DRAWER_QUERY);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = drawerOpen ?? ownOpen;
  const setOpen = onDrawerOpenChange ?? setOwnOpen;

  const body = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">{panel}</div>
      {footer ? (
        <div className="flex flex-col gap-2 border-t bg-background px-4 py-3">{footer}</div>
      ) : null}
    </>
  );

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-muted/60 p-3 sm:p-5">
        {drawer ? (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setOpen(true)}>
              <PanelRightOpen aria-hidden="true" />
              {panelLabel}
            </Button>
          </div>
        ) : null}
        {alert}
        {paper}
      </div>
      {drawer ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="flex w-[22rem] max-w-full flex-col gap-0 p-0 sm:max-w-[22rem]"
          >
            <div className="flex items-center justify-between border-b px-4 py-2">
              <SheetTitle className="text-sm font-semibold">{panelLabel}</SheetTitle>
              <SheetDescription className="sr-only">
                The {panelLabel.toLowerCase()} for this report.
              </SheetDescription>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close the panel"
                onClick={() => setOpen(false)}
              >
                <ChevronsRight aria-hidden="true" />
              </Button>
            </div>
            <aside aria-label={panelLabel} className="flex min-h-0 flex-1 flex-col">
              {body}
            </aside>
          </SheetContent>
        </Sheet>
      ) : (
        <aside
          aria-label={panelLabel}
          className="flex min-w-0 flex-col rounded-lg border bg-card xl:sticky xl:top-4 xl:max-h-[calc(100dvh-7rem)]"
        >
          {body}
        </aside>
      )}
    </div>
  );
}

/** The page while the report loads: the frame as skeletons. */
export function ReportLoading({ label = 'Loading the report' }: { label?: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 border-b pb-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
      <p role="status" className="sr-only">
        {label}
      </p>
    </div>
  );
}
