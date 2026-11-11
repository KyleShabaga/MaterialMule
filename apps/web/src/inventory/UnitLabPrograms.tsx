import type { StorageUnitLabProgram } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  CountedCells,
  EmptyState,
  ErrorState,
  SectionHead,
  type CountedCellState,
} from '../components/ui';
import { fetchStorageUnitLabPrograms, type InventoryResult } from './api';

/** The tests on the lines covering this unit as counted cells: done, in progress, not started. */
function programCells(program: StorageUnitLabProgram): CountedCellState[] {
  return [
    ...Array<CountedCellState>(program.done).fill('done'),
    ...Array<CountedCellState>(program.inProgress).fill('current'),
    ...Array<CountedCellState>(program.notStarted).fill('empty'),
  ];
}

function total(program: StorageUnitLabProgram) {
  return program.done + program.inProgress + program.notStarted;
}

/**
 * Lab program progress on the unit page (Field Ledger): each program whose frozen coverage
 * includes this unit, with one cell per test (ink done, flag in progress, sheet not started).
 * Progress only; results live in the program.
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
  if (!result || result.key !== key) {
    body = <p aria-busy="true">Loading…</p>;
  } else if (!result.value.ok) {
    body = (
      <ErrorState message={result.value.message} onRetry={() => setReloads((count) => count + 1)} />
    );
  } else if (result.value.data.programs.length === 0) {
    body = <EmptyState>No lab program covers this unit.</EmptyState>;
  } else {
    body = (
      <ul className="unit-programs">
        {result.value.data.programs.map((program) => {
          const name = program.programNumber ?? 'Lab program';
          const count = total(program);
          return (
            <li key={program.id} className="unit-program" data-row>
              <div className="unit-program-head">
                <Link to={`/lab-testing/programs/${encodeURIComponent(program.id)}`}>{name}</Link>
                <span className="mono unit-program-count">
                  {program.done} of {count} {count === 1 ? 'test' : 'tests'} done
                  {program.status === 'closed' ? ' · closed' : ''}
                </span>
              </div>
              <CountedCells
                cells={programCells(program)}
                label={`${name}: ${program.done} done, ${program.inProgress} in progress, ${program.notStarted} not started`}
              />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="unit-section" aria-labelledby="unit-programs-heading">
      <SectionHead id="unit-programs-heading" title="Lab programs" meta="Progress only" />
      {body}
    </section>
  );
}
