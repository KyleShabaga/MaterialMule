import type {
  ProgramUnit,
  ProgramUnits,
  UnitsToPull as UnitsToPullList,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '../components/app-ui';
import { StageTag } from '../components/strata/stage-tag';
import { fetchProgramUnits, fetchUnitsToPull } from './api';

/**
 * Field Ledger phone lab screen, first block: storage units still to pull for open tests, with
 * where each one is now, then a scan action to check them out. Read-only; the server decides what
 * is listed. Shown above the worklist on every screen size; on a phone it leads the page.
 */
export function UnitsToPull() {
  const [list, setList] = useState<UnitsToPullList | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetchUnitsToPull().then(
      (value) => live && setList(value),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  if (failed) {
    return <p className="field-hint">The units to pull couldn’t be loaded.</p>;
  }
  if (!list) return null;
  return (
    <section className="lab-pull" aria-labelledby="lab-pull-heading">
      <h2 id="lab-pull-heading" className="lab-pull-head">
        To pull now · {list.total} unit{list.total === 1 ? '' : 's'}
      </h2>
      {list.units.length === 0 ? (
        <p className="lab-pull-empty">Nothing to pull: every covered unit is at the lab.</p>
      ) : (
        <ul className="lab-pull-list">
          {list.units.map((unit) => (
            <li key={unit.storageUnitId}>
              <Link
                className="lab-pull-row"
                to={`/sample-storage/${encodeURIComponent(unit.readableId)}`}
              >
                <span className="lab-pull-id">
                  <span className="mono">{unit.readableId}</span>
                  <span className="lab-pull-where">
                    {unit.location.area ? `${unit.location.area} · ` : ''}
                    {unit.location.name}
                  </span>
                </span>
                <span className="lab-pull-meta">
                  {unit.urgent ? <StatusBadge tone="danger">Urgent</StatusBadge> : null}
                  <span className="mono">{unit.project.projectNumber}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {list.total > list.units.length ? (
        <p className="lab-pull-empty">
          Showing the first {list.units.length} of {list.total}.
        </p>
      ) : null}
      {list.units.length > 0 ? (
        // Secondary: New lab program is this screen's one flag action. The scanned unit opens
        // on its own page, where it is moved to the lab.
        <Link className="button lab-pull-scan" to="/sample-storage/scan">
          Scan a unit to pull
        </Link>
      ) : null}
    </section>
  );
}

function where(unit: ProgramUnit): string {
  if (!unit.location) return 'No longer in stock';
  return `${unit.location.area ? `${unit.location.area} · ` : ''}${unit.location.name}`;
}

/**
 * The program page's Units to pull (STRATA-87): every storage unit in the program's frozen
 * coverage, where it is now, the lines it is for and whether the lab still has to pull it.
 * Coverage is potential material, never a record of what was tested. `version` reloads it after
 * the program changes.
 */
export function ProgramUnitsToPull({
  programId,
  open,
  version,
  onLoaded,
}: {
  programId: string;
  /** The program is submitted (a closed program pulls nothing). */
  open: boolean;
  version: number;
  onLoaded?: (units: ProgramUnits) => void;
}) {
  const [units, setUnits] = useState<ProgramUnits | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetchProgramUnits(programId).then(
      (value) => {
        if (!live) return;
        setUnits(value);
        setFailed(false);
        onLoaded?.(value);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // onLoaded is a notification only; reloading on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId, version, attempt]);

  const summary =
    units && units.units.length > 0
      ? open
        ? `${units.toPull} to pull · ${units.atLab} at the lab`
        : `${units.units.length} covered`
      : null;
  return (
    <section
      id="units-to-pull"
      aria-labelledby="units-to-pull-heading"
      className="flex scroll-mt-20 flex-col gap-2"
    >
      <div className="flex items-baseline gap-2">
        <h2 id="units-to-pull-heading" className="text-base font-semibold">
          Units to pull
        </h2>
        {summary ? <span className="text-sm text-muted-foreground">{summary}</span> : null}
      </div>
      {failed ? (
        <p className="text-sm text-muted-foreground">
          The units couldn’t be loaded.{' '}
          <Button variant="link" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </p>
      ) : !units ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading units…
        </p>
      ) : units.units.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No storage unit is linked to this program yet.
        </p>
      ) : (
        <>
          {open && units.toPull === 0 ? (
            <p className="text-sm">Nothing to pull: every covered unit is at the lab.</p>
          ) : null}
          <Table>
            <TableCaption className="sr-only">Units for this program</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Where it is</TableHead>
                <TableHead>For lines</TableHead>
                {open ? <TableHead>State</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.units.map((unit) => (
                <TableRow key={unit.storageUnitId}>
                  <TableCell>
                    <Button variant="link" asChild className="h-auto p-0 font-mono">
                      <Link to={`/sample-storage/${encodeURIComponent(unit.readableId)}`}>
                        {unit.readableId}
                      </Link>
                    </Button>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {where(unit)}
                    {unit.location ? (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {unit.location.code}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>{unit.lineNumbers.map((n) => `L${n}`).join(', ')}</TableCell>
                  {open ? (
                    <TableCell>
                      {unit.toPull ? (
                        <StageTag stage="due" label="To pull" />
                      ) : unit.atLab ? (
                        <StageTag stage="lab" label="At the lab" />
                      ) : (
                        <span className="text-muted-foreground">Not needed now</span>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            Covered material is what the lab may use, not a record of what was tested.
          </p>
        </>
      )}
    </section>
  );
}
