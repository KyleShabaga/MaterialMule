import type { LabProgram, LabProgramSummary, ProgramWork } from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { PeekToolbar, peekNeighbours, usePeekKeys } from '../components/strata/peek';
import { PersonCell } from '../components/strata/person-avatar';
import { fetchProgram, fetchWork } from './api';
import { lineTitle, recordDate, requestName } from './format';
import { PriorityTag, ProgramStatusTag, programPhase } from './program-tags';
import { ProgressMeter } from './ProgressCells';
import { TestStateTag } from './WorkedProgram';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; program: LabProgram; work: ProgramWork | null };

/**
 * A program in the list's drawer (STRATA-87, board R5ListPeek): who asked, status and progress as
 * the row shows them, the lines with each test's state, and Open as full page, where the work is
 * done. Read-only.
 */
export function ProgramPeek({
  programId,
  summary,
  ids,
  onOpen,
  onClose,
}: {
  programId: string;
  summary: LabProgramSummary | null;
  ids: readonly string[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetchProgram(programId).then(
      async (program) => {
        if (!live) return;
        if (!program) return setLoad({ state: 'error' });
        const work = await fetchWork(program.id).catch(() => null);
        if (live) setLoad({ state: 'ready', program, work });
      },
      () => live && setLoad({ state: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [programId, attempt]);

  const near = peekNeighbours(ids, programId);
  const previous = near.previousId ? () => onOpen(near.previousId!) : undefined;
  const next = near.nextId ? () => onOpen(near.nextId!) : undefined;
  usePeekKeys({ enabled: true, onClose, onPrevious: previous, onNext: next });
  const href = `/lab-testing/programs/${programId}`;

  return (
    <div className="flex min-h-0 flex-col" aria-labelledby={titleId}>
      <PeekToolbar
        onClose={onClose}
        fullPageHref={href}
        position={{ index: near.index, total: near.total }}
        onPrevious={previous}
        onNext={next}
      />
      <div className="flex flex-col gap-4 p-4">
        {load.state === 'loading' ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : load.state === 'error' ? (
          <p className="text-sm">
            The program couldn’t be loaded.{' '}
            <Button variant="link" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </p>
        ) : (
          <PeekBody
            titleId={titleId}
            program={load.program}
            work={load.work}
            summary={summary}
            href={href}
          />
        )}
      </div>
    </div>
  );
}

function PeekBody({
  titleId,
  program,
  work,
  summary,
  href,
}: {
  titleId: string;
  program: LabProgram;
  work: ProgramWork | null;
  summary: LabProgramSummary | null;
  href: string;
}) {
  const requester = program.submittedFor ?? program.requestedBy;
  const statusOf = (
    id: string,
    fallback: LabProgram['lines'][number]['requests'][number]['status'],
  ) => work?.requests.find((r) => r.testRequestId === id)?.status ?? fallback;
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{program.project.projectNumber}</span> {program.project.name}
        </p>
        <h2 id={titleId} className="font-mono text-xl font-bold">
          {program.programNumber}
        </h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {summary ? <ProgramStatusTag phase={programPhase(summary)} /> : null}
        {program.priority === 'urgent' ? <PriorityTag priority="urgent" /> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Requested by</dt>
        <dd>
          <PersonCell name={requester.name} userId={requester.userId} />
        </dd>
        {program.submittedAt ? (
          <>
            <dt className="text-muted-foreground">Submitted</dt>
            <dd className="font-mono">{recordDate(program.submittedAt)}</dd>
          </>
        ) : null}
        {summary ? (
          <>
            <dt className="text-muted-foreground">Progress</dt>
            <dd>
              <ProgressMeter progress={summary.progress} size="header" />
            </dd>
          </>
        ) : null}
      </dl>
      <section aria-label="Lines" className="flex flex-col gap-3">
        {program.lines.map((line) => (
          <div key={line.id} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">
              Line {line.lineNumber} · {lineTitle(line)}
            </h3>
            <ul role="list" data-slot="item-group" className="group/item-group flex flex-col">
              {line.requests.map((request) => {
                const status = statusOf(request.id, request.status);
                return (
                  <Item key={request.id} asChild size="sm" className="px-0 py-1.5">
                    <li>
                      <ItemContent>
                        <ItemTitle
                          className={
                            status === 'cancelled' ? 'line-through text-muted-foreground' : ''
                          }
                        >
                          {requestName(request)}
                        </ItemTitle>
                      </ItemContent>
                      <ItemActions>
                        <TestStateTag status={status} />
                      </ItemActions>
                    </li>
                  </Item>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
      <Button asChild variant="outline" className="self-start">
        <Link to={href}>Open program page</Link>
      </Button>
    </>
  );
}
