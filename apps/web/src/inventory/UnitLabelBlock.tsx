import {
  formatCoreRuns,
  formatSampleIdentity,
  storageUnitTypeLabel,
  type StageKey,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { StageStripe } from '../components/strata/stage-stripe';
import { holeSummaryCells } from './unit-record';

/**
 * The unit label block (DESIGN.md › Components): the on-screen version of the printed label.
 * Holder type and project, the ID in mono, then per test hole its SAMPLE#/DEPTH summary and depth
 * range in mono (text, never a bar). Never individual samples. A disposed unit's ID is drawn in
 * the closed tone; the printed label itself is never restyled.
 */
export function UnitLabelBlock({
  unit,
  stage,
  compact = false,
  headingLevel = 1,
  headingId,
}: {
  unit: Pick<
    StorageUnitDetail,
    'readableId' | 'unitType' | 'status' | 'project' | 'holes' | 'sample' | 'coreRunCount'
  >;
  stage: StageKey;
  compact?: boolean;
  headingLevel?: 1 | 2;
  headingId?: string;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const disposed = unit.status === 'disposed';
  return (
    <Card
      data-slot="unit-label-block"
      className={cn(
        'relative block gap-0 overflow-hidden shadow-none',
        compact ? 'py-3 pr-4 pl-5' : 'py-4 pr-5 pl-6',
      )}
    >
      <StageStripe stage={stage} variant="edge" />
      <p className="text-[13px] text-muted-foreground">
        {storageUnitTypeLabel(unit.unitType)} ·{' '}
        <span className="font-mono whitespace-nowrap">{unit.project.projectNumber}</span>{' '}
        {unit.project.name}
      </p>
      <Heading
        id={headingId}
        tabIndex={-1}
        className={cn(
          'mt-1 font-mono font-bold whitespace-nowrap outline-none',
          compact ? 'text-xl leading-7' : 'text-[28px] leading-[34px]',
          disposed && 'text-stage-closed-fg',
        )}
      >
        {unit.readableId}
      </Heading>
      {unit.sample ? (
        <p className="mt-3 font-mono text-sm">{formatSampleIdentity(unit.sample)}</p>
      ) : unit.holes.length > 0 ? (
        <ul
          aria-label="Test holes on this unit"
          className="mt-3 grid grid-cols-[auto_auto_1fr] gap-x-4 gap-y-1 font-mono text-sm"
        >
          {unit.holes.map((hole) => {
            const cells = holeSummaryCells(hole);
            return (
              <li key={hole.testHoleId} className="contents">
                <span className="font-semibold">{hole.testHoleName}</span>
                <span>{cells.samples}</span>
                <span className="whitespace-nowrap">{cells.depth}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {unit.coreRunCount ? (
        <p className="mt-1 font-mono text-sm">{formatCoreRuns(unit.coreRunCount)}</p>
      ) : null}
    </Card>
  );
}
