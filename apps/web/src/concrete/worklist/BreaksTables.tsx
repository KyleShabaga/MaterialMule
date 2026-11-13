import {
  CONCRETE_EQUIPMENT_FLAG_LABEL,
  CONCRETE_WORKLIST_FLAG_LABEL,
  CONCRETE_WORKLIST_PENDING_EXCEPTION_SOURCES,
  type ConcreteWorklist,
  type ConcreteWorklistFlag,
  type ConcreteWorklistGroup,
  type ConcreteWorklistView,
} from '@materialmule/shared';
import { useId } from 'react';
import { Link } from 'react-router';
import { StageStripe } from '@/components/strata/stage-stripe';
import { StageTag } from '@/components/strata/stage-tag';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  ageText,
  setCheckState,
  setRowsOf,
  specimenLabel,
  toggleSet,
  type SetRow,
} from './breaks-model';

const HEAD = 'h-9 px-3 text-[13px] font-semibold text-muted-foreground';
const CELL = 'px-3 py-2.5 align-top';

/** Flags worth a word on the row (an overdue row already says how late it is). */
const SHOWN_FLAGS: readonly ConcreteWorklistFlag[] = [
  'weekend_target',
  'holiday_target',
  'rescheduled',
  'report_draft',
];

function GroupHead({
  group,
  sets,
  id,
}: {
  group: ConcreteWorklistGroup;
  sets: number;
  id: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
      <h2 id={id} className="text-base font-semibold">
        <span className="font-mono">{group.projectNumber}</span> · {group.projectName}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        <span>
          {sets} {sets === 1 ? 'set' : 'sets'}
        </span>{' '}
        ·{' '}
        <span>
          {group.count} {group.count === 1 ? 'specimen' : 'specimens'}
        </span>
      </p>
    </div>
  );
}

/**
 * One project's due specimens (Today, Overdue, Next 7 days): one row per set and test, the set
 * checkbox (all, some or none) and one checkbox per due specimen in the Specimens cell.
 */
export function BreaksGroup({
  group,
  view,
  selected,
  onSelectedChange,
}: {
  group: ConcreteWorklistGroup;
  view: Exclude<ConcreteWorklistView, 'hold' | 'exceptions'>;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
}) {
  const headingId = useId();
  const sets = setRowsOf(group);
  const overdue = view === 'overdue';
  return (
    <section aria-labelledby={headingId} className="@container/table flex min-w-0 flex-col gap-2">
      <GroupHead group={group} sets={sets.length} id={headingId} />
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table className="table-fixed">
          <TableCaption className="sr-only">{group.projectNumber} specimens</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, 'w-11')}>
                <span className="sr-only">Select set</span>
              </TableHead>
              <TableHead className={cn(HEAD, 'w-[12rem]')}>Set</TableHead>
              <TableHead className={cn(HEAD, 'w-[6.5rem] @max-[34rem]/table:hidden')}>
                Test age
              </TableHead>
              <TableHead className={HEAD}>Specimens due</TableHead>
              <TableHead className={cn(HEAD, 'w-[8.5rem]')}>
                {overdue ? 'Due · late' : 'Due'}
              </TableHead>
              <TableHead className={cn(HEAD, 'w-[8.5rem] @max-[44rem]/table:hidden')}>
                Cast
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sets.map((set) => (
              <SetLine
                key={set.key}
                set={set}
                overdue={overdue}
                selected={selected}
                onSelectedChange={onSelectedChange}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function SetLine({
  set,
  overdue,
  selected,
  onSelectedChange,
}: {
  set: SetRow;
  overdue: boolean;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
}) {
  const state = setCheckState(set, selected);
  const late = overdue || set.rows.some((row) => row.flags.includes('overdue'));
  const flags = SHOWN_FLAGS.filter((flag) => set.rows.some((row) => row.flags.includes(flag)));
  const ticked = state !== false;
  return (
    <TableRow data-state={ticked ? 'selected' : undefined} data-set={set.setLabel}>
      <TableCell className={cn(CELL, 'relative')}>
        <StageStripe stage={late ? 'danger' : 'lab'} />
        <Checkbox
          className="relative mt-0.5 ml-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5"
          checked={state}
          onCheckedChange={() => onSelectedChange(toggleSet(set, selected))}
          aria-label={`Select set ${set.setLabel} (${ageText(set.assignedAge)})`}
        />
      </TableCell>
      <TableCell className={cn(CELL, 'whitespace-normal')}>
        <span className="flex flex-col gap-1">
          <span className="font-mono font-semibold">{set.setLabel}</span>
          <span className="sr-only">{late ? 'Overdue' : 'In lab'}</span>
          <span className="text-[13px] text-muted-foreground @min-[34rem]/table:hidden">
            {ageText(set.assignedAge)}
          </span>
          {!set.numbered ? (
            <span className="text-[13px] text-muted-foreground">Not numbered yet</span>
          ) : null}
          {flags.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {flags.map((flag) => (
                <StageTag key={flag} variant="outline" label={CONCRETE_WORKLIST_FLAG_LABEL[flag]} />
              ))}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, '@max-[34rem]/table:hidden')}>
        {ageText(set.assignedAge)}
      </TableCell>
      <TableCell className={cn(CELL, 'whitespace-normal')}>
        <ul className="flex flex-wrap gap-x-4 gap-y-2" aria-label={`Specimens of ${set.setLabel}`}>
          {set.rows.map((row) => {
            const label = specimenLabel(row);
            const id = `specimen-${row.specimenId}`;
            return (
              <li key={row.specimenId} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  className="relative pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5"
                  checked={selected.has(row.specimenId)}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected);
                    if (checked === true) next.add(row.specimenId);
                    else next.delete(row.specimenId);
                    onSelectedChange(next);
                  }}
                  aria-label={`Select ${label}`}
                />
                <Label htmlFor={id} className="specimen-id cursor-pointer font-mono font-semibold">
                  {label}
                </Label>
              </li>
            );
          })}
        </ul>
      </TableCell>
      <TableCell className={CELL}>
        <span className="flex flex-col">
          <span className="font-mono">{set.targetDate ?? '—'}</span>
          {late && set.daysOverdue !== null ? (
            <span className="text-[13px] font-medium text-stage-danger-fg">
              {set.daysOverdue} {set.daysOverdue === 1 ? 'day' : 'days'} late
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, 'font-mono @max-[44rem]/table:hidden')}>
        {set.castingDate}
      </TableCell>
    </TableRow>
  );
}

/**
 * On HOLD: listed for reference, never broken from here (Holds schedules a test or decides
 * disposal). The danger stripe marks each row.
 */
export function HoldGroup({ group }: { group: ConcreteWorklistGroup }) {
  const headingId = useId();
  const sets = setRowsOf(group);
  return (
    <section aria-labelledby={headingId} className="@container/table flex min-w-0 flex-col gap-2">
      <GroupHead group={group} sets={sets.length} id={headingId} />
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table className="table-fixed">
          <TableCaption className="sr-only">{group.projectNumber} specimens</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, 'w-[12rem] pl-5')}>Set</TableHead>
              <TableHead className={HEAD}>Specimens on HOLD</TableHead>
              <TableHead className={cn(HEAD, 'w-[8.5rem]')}>Hold until</TableHead>
              <TableHead className={cn(HEAD, 'w-[12rem] @max-[40rem]/table:hidden')}>
                Kind
              </TableHead>
              <TableHead className={cn(HEAD, 'w-[9rem]')}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sets.map((set) => {
              const due = set.rows.some((row) => row.flags.includes('hold_review_due'));
              return (
                <TableRow key={set.key}>
                  <TableCell className={cn(CELL, 'relative pl-5')}>
                    <StageStripe stage="danger" />
                    <span className="font-mono font-semibold">{set.setLabel}</span>
                    <span className="sr-only"> On HOLD</span>
                  </TableCell>
                  <TableCell className={cn(CELL, 'whitespace-normal')}>
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      {set.rows.map((row) => (
                        <span key={row.specimenId} className="specimen-id font-mono font-semibold">
                          {specimenLabel(row)}
                        </span>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className={CELL}>
                    <span className="flex flex-col">
                      <span className="font-mono">{set.holdExpiresOn ?? 'No expiry'}</span>
                      {due ? (
                        <span className="text-[13px] font-medium text-stage-danger-fg">
                          {CONCRETE_WORKLIST_FLAG_LABEL.hold_review_due}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className={cn(CELL, 'whitespace-normal @max-[40rem]/table:hidden')}>
                    {set.rows.some((row) => row.holdKind === 'ordinary') ? 'Ordinary HOLD' : 'HOLD'}
                  </TableCell>
                  <TableCell className={CELL}>
                    <Button asChild variant="outline" size="sm">
                      <Link
                        to="/lab-testing/concrete/holds"
                        aria-label={`Open ${set.setLabel} in Holds`}
                      >
                        Open in Holds
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** Exceptions: only the sources that exist are checked; the rest are named as not checked yet. */
export function ExceptionsPanel({ list }: { list: ConcreteWorklist }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      {list.exceptions.length === 0 ? (
        <p className="text-sm">
          <span className="font-semibold">No open exceptions from the sources checked so far.</span>{' '}
          <span className="text-muted-foreground">
            Checked: the testing machine’s flags for today.
          </span>
        </p>
      ) : (
        <ul aria-label="Open exceptions" className="flex flex-col gap-2">
          {list.exceptions.map((item) => (
            <li
              key={`${item.kind}-${item.equipmentId}`}
              className="relative flex flex-wrap items-center gap-2 rounded-md border py-2 pr-3 pl-4"
            >
              <StageStripe stage="danger" variant="edge" className="rounded-l-md" />
              <span className="font-semibold">Testing machine: {item.label}</span>
              {item.flags.map((flag) => (
                <StageTag key={flag} stage="danger" label={CONCRETE_EQUIPMENT_FLAG_LABEL[flag]} />
              ))}
              {item.nextDueOn ? (
                <span className="text-[13px] text-muted-foreground">
                  Next calibration due <span className="font-mono">{item.nextDueOn}</span>.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="text-sm text-muted-foreground">
        <p>Not checked here yet:</p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {CONCRETE_WORKLIST_PENDING_EXCEPTION_SOURCES.map((source) => (
            <li key={source.source}>{source.label}: not checked yet</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
