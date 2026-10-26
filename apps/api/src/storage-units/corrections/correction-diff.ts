import type {
  StorageUnitCorrectionField,
  StorageUnitHoleSummary,
  StorageUnitType,
} from '@trapezoid/shared';

/** The correctable values of a storage unit (TRP-T13). Everything else is never corrected. */
export interface CorrectableValues {
  unitType: StorageUnitType;
  receivedDate: string;
  project: { id: string; projectNumber: string };
  holeSummaries: StorageUnitHoleSummary[];
  note: string | null;
}

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
  if (summariesKey(current.holeSummaries) !== summariesKey(next.holeSummaries)) {
    changed('holeSummaries', current.holeSummaries, next.holeSummaries);
  }
  if (current.note !== next.note) changed('note', current.note, next.note);
  return diff;
}
