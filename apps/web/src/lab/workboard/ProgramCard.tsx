import {
  WORKBOARD_COLUMN_TAG,
  type WorkboardColumn,
  type WorklistItem,
} from '@materialmule/shared';
import { ClipboardCheck, Clock, Flag, ListChecks } from 'lucide-react';
import { Link } from 'react-router';
import { StageStripe } from '@/components/strata/stage-stripe';
import { StageTag } from '@/components/strata/stage-tag';
import { Button } from '@/components/ui/button';
import { Item } from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { oldestOpenText, programHref, progressOf } from './program-facts';

export function UrgentTag() {
  return <StageTag variant="outline" label="Urgent · Priority" icon={Flag} />;
}

/**
 * One program on the board (DESIGN.md › Soils lab, Workboard): LP number, project, Urgent, "n of
 * m tests", oldest open and its stage stripe, with explicit links only. No Start (tests start on
 * the program page, Kyle 2026-11-12) and no drag. Review shows only when the server says this
 * account may review it.
 */
export function ProgramCard({ item, column }: { item: WorklistItem; column: WorkboardColumn }) {
  const { done, total, percent } = progressOf(item);
  const tag = WORKBOARD_COLUMN_TAG[column];
  return (
    <Item
      variant="outline"
      role="listitem"
      aria-label={item.programNumber}
      data-program-id={item.programId}
      className="relative min-w-0 flex-col flex-nowrap items-stretch gap-2 overflow-hidden rounded-xl bg-card py-3 pr-3 pl-4"
    >
      <StageStripe stage={tag.stage} variant="edge" />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <Button
          asChild
          variant="link"
          className="h-auto p-0 font-mono text-sm font-semibold whitespace-nowrap text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover]:underline"
        >
          <Link to={programHref(item)}>{item.programNumber}</Link>
        </Button>
        {item.priority === 'urgent' ? <UrgentTag /> : null}
      </div>
      <p className="flex min-w-0 gap-2 text-sm">
        <span className="shrink-0 font-mono">{item.project.projectNumber}</span>
        <span className="truncate text-muted-foreground">{item.project.name}</span>
      </p>
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Progress
          value={percent}
          aria-label={`${done} of ${total} tests done`}
          className="h-1.5 w-16 shrink-0"
        />
        <span className="tabular-nums">
          {done} of {total} tests
        </span>
      </span>
      <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Clock aria-hidden="true" className="size-3.5" />
        {oldestOpenText(item)}
      </p>
      <span className="sr-only">{tag.label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {column === 'review' && item.canReview ? (
          <Button asChild variant="outline" size="sm">
            <Link to={programHref(item, 'review')} aria-label={`Review ${item.programNumber}`}>
              <ClipboardCheck aria-hidden="true" />
              Review
            </Link>
          </Button>
        ) : null}
        {column === 'pull' ? (
          <Button asChild variant="outline" size="sm">
            <Link
              to={programHref(item, 'units-to-pull')}
              aria-label={`Pull list for ${item.programNumber}`}
            >
              <ListChecks aria-hidden="true" />
              Pull list
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm" className="text-link">
          <Link to={programHref(item)} aria-label={`Open ${item.programNumber}`}>
            Open
          </Link>
        </Button>
      </div>
    </Item>
  );
}
