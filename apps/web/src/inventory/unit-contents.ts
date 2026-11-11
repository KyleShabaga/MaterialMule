import {
  formatBucketPosition,
  formatCoreRuns,
  formatSampleIdentity,
  formatStorageUnitHoleSummary,
  type BulkMembership,
  type SampleIdentity,
  type StorageUnitHoleSummary,
} from '@materialmule/shared';

// What a storage unit holds as one line of text (MM-T36); rendered by UnitContents.tsx.

export interface UnitContentsSource {
  holes: StorageUnitHoleSummary[];
  sample: SampleIdentity | null;
  bulkGroup: BulkMembership | null;
  /** Core boxes: 1–3 runs of 1.52 m. */
  coreRunCount?: number | null;
}

/** Every summary as one comma-separated line (compact rows and titles). */
export function unitContentsText(unit: UnitContentsSource): string {
  if (unit.sample) {
    const identity = formatSampleIdentity(unit.sample);
    return unit.bulkGroup ? `${identity} · ${formatBucketPosition(unit.bulkGroup)}` : identity;
  }
  const holes = unit.holes
    .map((hole) => `${hole.testHoleName}: ${formatStorageUnitHoleSummary(hole)}`)
    .join(', ');
  return unit.coreRunCount ? `${holes} · ${formatCoreRuns(unit.coreRunCount)}` : holes;
}
