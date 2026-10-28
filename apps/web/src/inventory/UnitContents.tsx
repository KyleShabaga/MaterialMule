import {
  formatBulkBadge,
  formatSampleIdentity,
  formatStorageUnitHoleSummary,
  type BulkMembership,
  type SampleIdentity,
} from '@materialmule/shared';
import { unitContentsText, type UnitContentsSource } from './unit-contents';

// What a storage unit holds, the same way on every list (MM-T36): its SAMPLE#/DEPTH summary per
// test hole, a Shelby tube's own sampling source ("Embankment Location 03: T5"), or a bulk soil
// bucket's bulk sample ("TH26-21: B1 at 1.5–2 m") with a "Bulk sample · B1 · bucket 1 of 2"
// badge. The bulk sample reference is never the unit's storage ID; the badge says which bucket.

/** Standard rows: one chip per summary, or the sample identity and its bulk badge. */
export function UnitContentsList({
  unit,
  listClassName = 'hole-list',
  itemClassName = 'hole-tag',
}: {
  unit: UnitContentsSource;
  listClassName?: string;
  itemClassName?: string;
}) {
  if (unit.sample) {
    return (
      <ul className={listClassName}>
        <li className={itemClassName}>{formatSampleIdentity(unit.sample)}</li>
        {unit.bulkGroup ? (
          <li className="bulk-badge-item">
            <BulkBadge sample={unit.sample} membership={unit.bulkGroup} />
          </li>
        ) : null}
      </ul>
    );
  }
  return (
    <ul className={listClassName}>
      {unit.holes.map((hole) => (
        <li key={hole.testHoleId} className={itemClassName}>
          {hole.testHoleName}: {formatStorageUnitHoleSummary(hole)}
        </li>
      ))}
    </ul>
  );
}

/** Compact rows: everything on one line, cut short with "…" but read in full (title). */
export function UnitContentsLine({ unit }: { unit: UnitContentsSource }) {
  const text = unitContentsText(unit);
  return (
    <span className="hole-line" title={text}>
      {text}
    </span>
  );
}

/** "Bulk sample · B1 · bucket 1 of 2" */
export function BulkBadge({
  sample,
  membership,
}: {
  sample: Pick<SampleIdentity, 'sampleReference'>;
  membership: Pick<BulkMembership, 'memberNumber' | 'memberCount'>;
}) {
  return <span className="badge badge-bulk">{formatBulkBadge(sample, membership)}</span>;
}
