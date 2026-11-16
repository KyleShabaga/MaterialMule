import {
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  testedRetentionNote,
  type InventoryItem,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LifecycleTrack, STORAGE_UNIT_STEPS } from '../components/strata/lifecycle-track';
import { PeekToolbar, type PeekToolbarProps } from '../components/strata/peek';
import { unitPrintPath } from '../printing/print-paths';
import { fetchStorageUnit } from './api';
import { UnitPrimaryButton, UnitStatusTags } from './UnitActions';
import { UnitLabelBlock } from './UnitLabelBlock';
import { UnitFact, UnitFacts, UnitSection } from './UnitRecordParts';
import { UnitWhere } from './UnitWhere';
import {
  passedWithout,
  unitLifecycleStep,
  unitPath,
  unitPrimaryAction,
  unitRecordStatus,
  unitTag,
  UNIT_DRAWER_TITLE_ID,
} from './unit-record';

type Loaded =
  | { key: string; ok: true; data: StorageUnitDetail }
  | { key: string; ok: false; notFound: boolean; message: string };

/**
 * The unit drawer (DESIGN.md › Round 1 › Unit drawer): opened from a shelf (and later any list) in
 * PeekSplit. The compact label block, tag, compact track, Where it is, Retention and the main
 * action with an outline Print label. History and lab programs stay on the full page.
 */
export function UnitDrawer({
  readableId,
  retention,
  toolbar,
}: {
  readableId: string;
  /** The row's retention facts, so the drawer needs no second retention read. */
  retention?: InventoryItem['retention'];
  toolbar: Omit<PeekToolbarProps, 'fullPageHref'>;
}) {
  const [result, setResult] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  const key = `${readableId}:${reloads}`;
  useEffect(() => {
    let cancelled = false;
    void fetchStorageUnit(readableId).then((response) => {
      if (cancelled) return;
      setResult(response.ok ? { key, ok: true, data: response.data } : { key, ...response });
    });
    return () => {
      cancelled = true;
    };
  }, [readableId, key]);

  let body;
  if (!result || result.key !== key) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-6 w-36 rounded-full" />
        <Skeleton className="h-32 w-full" />
        <span className="sr-only">Loading {readableId}</span>
      </div>
    );
  } else if (!result.ok) {
    body = (
      <Alert variant={result.notFound ? 'default' : 'destructive'}>
        <AlertTitle className="line-clamp-none">
          {result.notFound ? `No storage unit has the ID ${readableId}.` : result.message}
        </AlertTitle>
        {result.notFound ? null : (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 justify-self-start text-foreground"
            onClick={() => setReloads((count) => count + 1)}
          >
            Try again
          </Button>
        )}
      </Alert>
    );
  } else {
    const unit = result.data;
    const status = unitRecordStatus(unit);
    const step = unitLifecycleStep(unit.lifecycleStep, status, unit.storageTerm);
    const action = unitPrimaryAction(status);
    const disposed = unit.status === 'disposed';
    const exempt = Boolean(
      unit.testing?.reason && (unit.testing.removal || unit.testing.evidence.length > 0),
    );
    body = (
      <>
        <UnitLabelBlock
          unit={unit}
          stage={unit.stage ?? STORAGE_UNIT_RECORD_STATUS_STAGE[status]}
          compact
          headingLevel={2}
          headingId={UNIT_DRAWER_TITLE_ID}
        />
        <div className="flex flex-wrap items-center gap-3">
          <UnitStatusTags
            tag={unitTag(status, step, Boolean(unit.testing?.removal))}
            conflict={Boolean(unit.locationConflict)}
          />
          <LifecycleTrack
            compact
            steps={STORAGE_UNIT_STEPS}
            current={step}
            passedWithout={passedWithout(step, unit.neverTested)}
            label={`Lifecycle of ${unit.readableId}`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <UnitPrimaryButton unit={unit} action={action} />
          {disposed ? null : (
            <Button asChild variant="outline">
              <Link to={unitPrintPath(unit.readableId)}>
                <Printer aria-hidden="true" />
                Print label
              </Link>
            </Button>
          )}
        </div>
        <UnitWhere unit={unit} />
        <UnitSection id="drawer-retention" title="Retention">
          <UnitFacts>
            {exempt && unit.testing?.reason ? (
              <UnitFact term="Retention">{testedRetentionNote(unit.testing.reason)}</UnitFact>
            ) : (
              <>
                <UnitFact term="Retain until">
                  <span className="font-mono whitespace-nowrap">
                    {retention?.effectiveRetainUntil ?? unit.minimumRetainUntil}
                  </span>
                  {retention?.onHold ? ' · On hold' : ''}
                </UnitFact>
                {retention?.eligibleByDate && !retention.onHold ? (
                  <UnitFact term="Decision">Due: keep it longer or add it to disposal.</UnitFact>
                ) : null}
              </>
            )}
          </UnitFacts>
        </UnitSection>
      </>
    );
  }

  return (
    <>
      <PeekToolbar {...toolbar} fullPageHref={unitPath(readableId)} />
      <div className="flex flex-col gap-4 p-4">{body}</div>
    </>
  );
}
