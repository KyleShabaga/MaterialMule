import {
  currentLocationName,
  formatPerson,
  type LocationConflictDetail,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StageStripe } from '../components/strata/stage-stripe';
import { fetchConflict } from '../moves/api';
import { PendingMoveNote } from '../moves/LocationConflictSection';
import { fetchLocationActivity } from './api';
import { formatEventTime, shelfPath, storageTermText } from './unit-record';
import { UnitFact, UnitFacts, UnitSection } from './UnitRecordParts';

/** When this unit arrived at its saved location (the shelf's activity), if it ever moved there. */
function useHereSince(unit: Pick<StorageUnitDetail, 'id' | 'location' | 'status'>) {
  const [since, setSince] = useState<{ key: string; at: string | null } | null>(null);
  const key = `${unit.id}:${unit.location.id}`;
  const disposed = unit.status === 'disposed';
  useEffect(() => {
    if (disposed) return;
    let cancelled = false;
    void fetchLocationActivity(unit.location.id).then((result) => {
      if (cancelled) return;
      const arrival = result.ok
        ? result.data.arrivals.find((a) => a.storageUnitId === unit.id)
        : undefined;
      setSince({ key, at: arrival?.arrivedAt ?? null });
    });
    return () => {
      cancelled = true;
    };
  }, [key, unit.id, unit.location.id, disposed]);
  return since?.key === key ? since.at : undefined;
}

/**
 * The open conflict as a danger alert (DESIGN.md › Round 1): what disagrees and what to do, with
 * an outline link to the other shelf. The full stories and the confirm form stay in
 * LocationConflictSection below.
 */
function ConflictAlert({ conflictId, version }: { conflictId: string; version: number }) {
  const [conflict, setConflict] = useState<LocationConflictDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchConflict(conflictId).then((result) => {
      if (!cancelled && result.kind === 'ok') setConflict(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [conflictId, version]);
  const contested = conflict
    ? [...conflict.events].reverse().find((event) => event.kind === 'contested')
    : undefined;
  const saved = conflict?.storageUnit.savedLocation;
  return (
    <Alert variant="destructive" className="relative overflow-hidden">
      <StageStripe stage="danger" variant="edge" />
      <CircleAlert aria-hidden="true" />
      <AlertTitle className="line-clamp-none">Two places are recorded for this unit</AlertTitle>
      <AlertDescription>
        {contested && saved ? (
          <p>
            The last move put it on{' '}
            <span className="font-mono whitespace-nowrap">{saved.code}</span>, but{' '}
            {formatPerson(contested.actor.initials, contested.actor.name)} scanned it on{' '}
            <span className="font-mono whitespace-nowrap">{contested.to.code}</span> at{' '}
            {formatEventTime(contested.savedAt)}. Find it, then move it to the shelf it is on; the
            move clears the conflict.
          </p>
        ) : (
          <p>
            Moves of this unit disagree. Find it, then move it to the shelf it is on; the move
            clears the conflict.
          </p>
        )}
        {contested ? (
          <div className="mt-2">
            <Button asChild variant="outline" size="sm" className="text-foreground">
              <Link to={shelfPath(contested.to.code)}>
                Open <span className="font-mono whitespace-nowrap">{contested.to.code}</span>
              </Link>
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Where it is: the saved location (linking to its shelf), code, storage term, here since. */
export function UnitWhere({ unit }: { unit: StorageUnitDetail }) {
  const disposed = unit.status === 'disposed';
  const hereSince = useHereSince(unit);
  return (
    <UnitSection id="location" title="Where it is">
      {disposed ? (
        // MISC-12: a disposed unit has no current location; its moves stay in History.
        <UnitFacts wide>
          <UnitFact term="Place">{currentLocationName(unit)}</UnitFact>
        </UnitFacts>
      ) : (
        <UnitFacts wide>
          <UnitFact term="Place">
            <Button asChild variant="link" className="h-auto p-0 has-[>svg]:px-0">
              <Link
                to={shelfPath(unit.location.code)}
                aria-label={`${unit.location.name} (${unit.location.code})`}
              >
                {unit.location.name}
              </Link>
            </Button>
          </UnitFact>
          <UnitFact term="Code">
            <span className="font-mono whitespace-nowrap">{unit.location.code}</span>
          </UnitFact>
          <UnitFact term="Storage">{storageTermText(unit.storageTerm)}</UnitFact>
          <UnitFact term="Here since">
            {hereSince === undefined ? (
              <span className="text-muted-foreground">Checking…</span>
            ) : hereSince ? (
              <span className="font-mono whitespace-nowrap">{formatEventTime(hereSince)}</span>
            ) : (
              <>
                Received here on{' '}
                <span className="font-mono whitespace-nowrap">{unit.receivedDate}</span>
              </>
            )}
          </UnitFact>
          <UnitFact term="Pending move">
            <PendingMoveNote unitId={unit.id} />
          </UnitFact>
        </UnitFacts>
      )}
      {unit.locationConflict ? (
        <ConflictAlert
          conflictId={unit.locationConflict.id}
          version={unit.locationConflict.version}
        />
      ) : null}
    </UnitSection>
  );
}
