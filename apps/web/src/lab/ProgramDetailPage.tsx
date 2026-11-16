import type { LabProgram } from '@materialmule/shared';
import { FileQuestion, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageTitle } from '../layout/page-title';
import { useRecordRecent } from '../layout/record-recent';
import { fetchProgram } from './api';
import { ProgramEditor } from './ProgramEditor';
import { WorkedProgram } from './WorkedProgram';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'missing' }
  | { state: 'ready'; program: LabProgram };

/**
 * /lab-testing/programs/:id (STRATA-87): a draft opens in the editor (Continue editing), a
 * submitted or closed program on its record page. Loading, failed and "no such program / someone
 * else's draft" states are their own.
 */
export function ProgramDetailPage({
  renderSubmitted,
}: {
  /** The program page; WorkedProgram unless a route swaps in another view. */
  renderSubmitted?: (program: LabProgram, reload: () => void) => ReactNode;
}) {
  const { programId = '' } = useParams();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const reload = useCallback(() => {
    fetchProgram(programId).then(
      (program) => setLoad(program ? { state: 'ready', program } : { state: 'missing' }),
      () => setLoad({ state: 'error' }),
    );
  }, [programId]);
  useEffect(reload, [reload]);
  usePageTitle(load.state === 'ready' ? (load.program.programNumber ?? 'Draft lab program') : null);
  useRecordRecent('lab_program', load.state === 'ready' ? load.program.id : null);

  if (load.state === 'loading') {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <p className="sr-only">Loading program…</p>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>The program couldn’t be loaded.</EmptyTitle>
          <EmptyDescription>Check the connection and try again.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (load.state === 'missing') {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>This program isn’t available to you.</EmptyTitle>
          <EmptyDescription>
            This program doesn’t exist, or it is someone else’s draft.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" asChild>
            <Link to="/lab-testing/programs">Back to programs</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const { program } = load;
  if (program.status === 'draft')
    return <ProgramEditor key={program.id} draft={program} onReload={reload} />;
  return (
    <>
      {renderSubmitted ? (
        renderSubmitted(program, reload)
      ) : (
        <WorkedProgram program={program} reload={reload} />
      )}
    </>
  );
}
