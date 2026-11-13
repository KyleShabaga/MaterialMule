import { LAB_PROGRAM_STATUS_STAGE, type StorageUnitLabProgram } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { StageTag } from '../components/strata/stage-tag';
import { fetchStorageUnitLabPrograms, type InventoryResult } from './api';
import { UnitSection } from './UnitRecordParts';

function total(program: StorageUnitLabProgram) {
  return program.done + program.inProgress + program.notStarted;
}

/**
 * Lab program progress on the unit page (STRATA-72): each program whose frozen coverage includes
 * this unit, written "n of m tests" with a neutral Progress bar. Progress only; results live in
 * the program.
 */
export function UnitLabPrograms({ unitId }: { unitId: string }) {
  const [result, setResult] = useState<{
    key: string;
    value: InventoryResult<{ programs: StorageUnitLabProgram[] }>;
  } | null>(null);
  const [reloads, setReloads] = useState(0);
  const key = `${unitId}:${reloads}`;

  useEffect(() => {
    let cancelled = false;
    void fetchStorageUnitLabPrograms(unitId).then((value) => {
      if (!cancelled) setResult({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [unitId, key]);

  let body;
  let meta: string | undefined = 'Progress only';
  if (!result || result.key !== key) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-1.5 w-64" />
        <span className="sr-only">Loading lab programs</span>
      </div>
    );
  } else if (!result.value.ok) {
    body = (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{result.value.message}</p>
        <Button variant="outline" size="sm" onClick={() => setReloads((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  } else if (result.value.data.programs.length === 0) {
    body = <p className="text-sm text-muted-foreground">No lab program covers this unit.</p>;
  } else {
    const programs = result.value.data.programs;
    meta = `${programs.length} ${programs.length === 1 ? 'program' : 'programs'}`;
    body = (
      <ul aria-label="Lab programs on this unit" className="flex flex-col divide-y">
        {programs.map((program) => {
          const name = program.programNumber ?? 'Lab program';
          const count = total(program);
          const percent = count === 0 ? 0 : Math.round((program.done / count) * 100);
          const progress = `${program.done} of ${count} ${count === 1 ? 'test' : 'tests'}`;
          return (
            <li key={program.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button asChild variant="link" className="h-auto p-0 font-mono font-semibold">
                  <Link to={`/lab-testing/programs/${encodeURIComponent(program.id)}`}>{name}</Link>
                </Button>
                <StageTag
                  stage={LAB_PROGRAM_STATUS_STAGE[program.status]}
                  label={program.status === 'closed' ? 'Closed' : 'In lab'}
                />
              </div>
              <div className="flex items-center gap-3">
                <Progress
                  value={percent}
                  aria-label={`${name}: ${progress} done, ${program.inProgress} in progress, ${program.notStarted} not started`}
                  className="h-1.5 max-w-64"
                />
                <span className="font-mono text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">
                  {progress}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <UnitSection id="unit-programs" title="Lab programs" meta={meta}>
      {body}
    </UnitSection>
  );
}
