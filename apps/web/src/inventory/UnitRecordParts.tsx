import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ScanLine, type LucideIcon } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

// Shared parts of the record pattern (STRATA-72/74): the context-row breadcrumb, record
// sections with their own headings, fact lists and the not-found state with Scan again.

/** Where the scanner lands: the scan page (wedge scanner or camera). */
export const SCAN_PATH = '/sample-storage/scan';

/** "Inventory › BKT-2026-000019": back to where the page was opened from. */
export function RecordBreadcrumb({
  back,
  current,
}: {
  back: { to: string; label: string };
  current: string;
}) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to={back.to}>{back.label}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage className="font-mono whitespace-nowrap">{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** "No storage unit has this ID." with the code asked for, Scan again and one way out. */
export function RecordNotFound({
  icon: Icon,
  title,
  code,
  description,
  secondary,
}: {
  icon: LucideIcon;
  title: string;
  code: string;
  description: string;
  secondary?: { to: string; label: string };
}) {
  return (
    <Empty className="px-6 py-20">
      <EmptyHeader className="max-w-[440px]">
        <EmptyMedia variant="icon" className="text-muted-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </EmptyMedia>
        <EmptyTitle>
          <h1 className="font-semibold">{title}</h1>
        </EmptyTitle>
        <EmptyDescription>
          You asked for{' '}
          <span className="font-mono font-semibold whitespace-nowrap text-foreground">{code}</span>.{' '}
          {description}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center gap-2">
        <Button asChild>
          <Link to={SCAN_PATH}>
            <ScanLine aria-hidden="true" />
            Scan again
          </Link>
        </Button>
        {secondary ? (
          <Button asChild variant="outline">
            <Link to={secondary.to}>{secondary.label}</Link>
          </Button>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}

/** A row of a section's facts: term on the left, value on the right. */
export function UnitFact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

export function UnitFacts({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <dl
      className={
        wide
          ? 'grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm'
          : 'grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-2 text-sm'
      }
    >
      {children}
    </dl>
  );
}

/** A record section: a card with its own heading; a region named by that heading. */
export function UnitSection({
  id,
  title,
  meta,
  children,
  className,
  flush = false,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  /** The body runs edge to edge (a table): the heading row keeps the card's side padding. */
  flush?: boolean;
}) {
  return (
    <Card
      id={id}
      role="region"
      aria-labelledby={`${id}-heading`}
      className={className ?? 'gap-4 p-5 shadow-none'}
    >
      <div className={`flex items-baseline justify-between gap-4${flush ? ' px-5' : ''}`}>
        <CardTitle role="heading" aria-level={2} id={`${id}-heading`} className="text-base">
          {title}
        </CardTitle>
        {meta ? <span className="text-[13px] text-muted-foreground">{meta}</span> : null}
      </div>
      {children}
    </Card>
  );
}
