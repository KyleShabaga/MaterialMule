import {
  formatBucketPosition,
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
}

/** Every summary as one comma-separated line (compact rows and titles). */
export function unitContentsText(unit: UnitContentsSource): string {
  if (unit.sample) {
    const identity = formatSampleIdentity(unit.sample);
    return unit.bulkGroup ? `${identity} · ${formatBucketPosition(unit.bulkGroup)}` : identity;
  }
  return unit.holes
    .map((hole) => `${hole.testHoleName}: ${formatStorageUnitHoleSummary(hole)}`)
    .join(', ');
}
