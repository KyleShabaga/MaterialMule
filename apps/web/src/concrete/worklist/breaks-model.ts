import {
  CONCRETE_HOLD_AGE,
  type ConcreteWorklistGroup,
  type ConcreteWorklistRow,
} from '@materialmule/shared';
import { specimenText, splitSpecimenId } from './specimen-text';

// Breaks variant A (STRATA-95): one row per set and test, a set checkbox (all/some/none) and one
// checkbox per due specimen. Pure helpers so the rules are tested without layout.

/** The specimens of one set due at one age on one date: one Breaks row. */
export interface SetRow {
  key: string;
  setId: string;
  /** The set's working label: its permanent ID, else its temporary ID. */
  setLabel: string;
  numbered: boolean;
  assignedAge: ConcreteWorklistRow['assignedAge'];
  targetDate: string | null;
  castingDate: string;
  daysOverdue: number | null;
  holdExpiresOn: string | null;
  rows: ConcreteWorklistRow[];
}

export const specimenLabel = (row: ConcreteWorklistRow) => specimenText(row.identity, row.letter);

/** "7-day", "28-day" or "HOLD". */
export const ageText = (age: ConcreteWorklistRow['assignedAge']) =>
  age === CONCRETE_HOLD_AGE ? 'HOLD' : `${age}-day`;

function setLabelOf(row: ConcreteWorklistRow): string {
  const id = row.identity.permanentId ?? row.identity.temporaryId;
  return id ? splitSpecimenId(id, row.letter).set : 'Unnumbered set';
}

/** Groups a project's rows (server order) into set rows, keeping the order of first appearance. */
export function setRowsOf(group: ConcreteWorklistGroup): SetRow[] {
  const byKey = new Map<string, SetRow>();
  for (const row of group.rows) {
    const key = `${row.setId}|${row.assignedAge}|${row.targetDate ?? row.holdExpiresOn ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    byKey.set(key, {
      key,
      setId: row.setId,
      setLabel: setLabelOf(row),
      numbered: row.identity.permanentId !== null,
      assignedAge: row.assignedAge,
      targetDate: row.targetDate,
      castingDate: row.castingDate,
      daysOverdue: row.daysOverdue,
      holdExpiresOn: row.holdExpiresOn,
      rows: [row],
    });
  }
  return [...byKey.values()];
}

/** How many of a set row's specimens are ticked: the set checkbox's state. */
export function setCheckState(
  set: SetRow,
  selected: ReadonlySet<string>,
): boolean | 'indeterminate' {
  const ticked = set.rows.filter((row) => selected.has(row.specimenId)).length;
  if (ticked === 0) return false;
  return ticked === set.rows.length ? true : 'indeterminate';
}

/** Ticking the set checkbox ticks every specimen unless all are ticked, which clears them. */
export function toggleSet(set: SetRow, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (setCheckState(set, selected) === true) {
    for (const row of set.rows) next.delete(row.specimenId);
  } else {
    for (const row of set.rows) next.add(row.specimenId);
  }
  return next;
}

/** An unnumbered set on a report past draft: rescheduling waits for its permanent number. */
export function needsNumber(row: ConcreteWorklistRow): boolean {
  return (
    !row.reschedulable &&
    row.identity.permanentId === null &&
    row.reportState !== 'draft' &&
    row.assignedAge !== CONCRETE_HOLD_AGE
  );
}

export interface Picked {
  row: ConcreteWorklistRow;
  group: ConcreteWorklistGroup;
}

/** Why a picked specimen can't be rescheduled, or null when it can. */
export function rescheduleBlock({ row, group }: Picked): string | null {
  if (!group.canReschedule) {
    return `you can’t reschedule specimens on ${group.projectNumber}`;
  }
  if (row.reschedulable) return null;
  if (row.reportState === 'draft') {
    return 'its field report is still a draft, so its technician changes the age there';
  }
  if (needsNumber(row)) return 'its set isn’t numbered yet; number the set first';
  return 'it can’t be rescheduled from here';
}

/** Why a picked specimen can't be put on HOLD until a date, or null (the server rechecks). */
export function holdBlock({ row, group }: Picked): string | null {
  if (!group.canHoldUntil) return `you can’t put specimens on ${group.projectNumber} on HOLD`;
  if (row.identity.permanentId === null) return 'its set isn’t numbered yet';
  return null;
}

/** "4 specimens · 3 sets". */
export function selectionSummary(picked: readonly Picked[]): string {
  const sets = new Set(picked.map((p) => p.row.setId)).size;
  const specimens = `${picked.length} ${picked.length === 1 ? 'specimen' : 'specimens'}`;
  return `${specimens} · ${sets} ${sets === 1 ? 'set' : 'sets'}`;
}
