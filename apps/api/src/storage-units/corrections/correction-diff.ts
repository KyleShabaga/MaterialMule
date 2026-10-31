import type {
  SampleIdentity,
  StorageUnitCorrectionField,
  StorageUnitHoleSummary,
  StorageUnitType,
} from '@materialmule/shared';

/** The correctable values of a storage unit (MM-T13). Everything else is never corrected. */
export interface CorrectableValues {
  unitType: StorageUnitType;
  receivedDate: string;
  project: { id: string; projectNumber: string };
  /** A Shelby tube's own sampling source (MM-T82); null for every other unit. */
  sample: SampleIdentity | null;
  /** A bulk soil bucket's group as audit events record it; null once it's an ordinary bucket. */
  bulkGroup: BulkGroupValue | null;
  holeSummaries: StorageUnitHoleSummary[];
  note: string | null;
}

/** The group's identity, with the bucket's "n of N" place, as the history shows it. */
export type BulkGroupValue = SampleIdentity & {
  id: string;
  description: string | null;
  memberNumber: number;
  memberCount: number;
};

export interface CorrectionDiff {
  /** Changed fields in display order. */
  fields: StorageUnitCorrectionField[];
  /** Old and new values of the changed fields only, for the audit event. */
  before: Partial<Record<StorageUnitCorrectionField, unknown>>;
  after: Partial<Record<StorageUnitCorrectionField, unknown>>;
}

/** Summaries compared as a set: order and display names don't matter, every value does. */
function summariesKey(summaries: StorageUnitHoleSummary[]): string {
  return JSON.stringify(
    summaries
      .map((s) => [
        s.testHoleId,
        s.type,
        s.sampleFrom,
        s.sampleTo,
        s.depthFrom,
        s.depthTo,
        s.depthUnit,
        s.customText,
        s.note,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/** Sources compared by value; the hole's display name doesn't matter. */
function sampleKey(sample: SampleIdentity | null): string {
  if (!sample) return 'null';
  const { source } = sample;
  return JSON.stringify([
    source.type,
    source.type === 'test_hole' ? source.testHoleId : source.locationReference,
    sample.sampleReference,
    sample.depthFrom,
    sample.depthTo,
    sample.depthUnit,
  ]);
}

/** Which correctable fields differ between the current and proposed values. */
export function diffCorrection(
  current: CorrectableValues,
  next: CorrectableValues,
): CorrectionDiff {
  const diff: CorrectionDiff = { fields: [], before: {}, after: {} };
  const changed = (field: StorageUnitCorrectionField, before: unknown, after: unknown) => {
    diff.fields.push(field);
    diff.before[field] = before;
    diff.after[field] = after;
  };
  if (current.unitType !== next.unitType) changed('unitType', current.unitType, next.unitType);
  if (current.receivedDate !== next.receivedDate) {
    changed('receivedDate', current.receivedDate, next.receivedDate);
  }
  if (current.project.id !== next.project.id) changed('project', current.project, next.project);
  if (sampleKey(current.sample) !== sampleKey(next.sample)) {
    changed('sample', current.sample, next.sample);
  }
  if ((current.bulkGroup?.id ?? null) !== (next.bulkGroup?.id ?? null)) {
    changed('bulkGroup', current.bulkGroup, next.bulkGroup);
  }
  if (summariesKey(current.holeSummaries) !== summariesKey(next.holeSummaries)) {
    changed('holeSummaries', current.holeSummaries, next.holeSummaries);
  }
  if (current.note !== next.note) changed('note', current.note, next.note);
  return diff;
}
