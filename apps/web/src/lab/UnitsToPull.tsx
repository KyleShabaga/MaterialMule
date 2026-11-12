import type { UnitsToPull as UnitsToPullList } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../components/app-ui';
import { fetchUnitsToPull } from './api';

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
