import {
  CONCRETE_HOLD_AGE,
  type ConcreteSetReceiving,
  type ConcreteSpecimenSetDetail,
  type ConcreteTestingTableRow,
  type StageKey,
} from '@materialmule/shared';

// The set page's state (STRATA-95 part B, canvas R7Set*): one tag, the lifecycle step and one
// main action, all read from the records the server returned (set, receiving, testing rows).
// Order: Void, then awaiting receiving, then breaks due, then a hold past its date, then a hold
// inside its period, then curing; a set whose scheduled breaks are all entered says so.

export type SetMainAction =
  { kind: 'receive' } | { kind: 'breaks'; specimenIds: string[] } | { kind: 'hold' } | null;

export interface SetRecordState {
  key: 'void' | 'awaiting' | 'due' | 'hold_ended' | 'on_hold' | 'curing' | 'entered';
  tag: { stage: StageKey; label: string } | { neutral: true; label: string };
  /** CONCRETE_SET_STEPS key. */
  step: 'cast' | 'received' | 'testing';
  main: SetMainAction;
  /** Specimens on HOLD whose hold-until date is reached (a flag only). */
  holdEnded: string[];
  /** Received of expected (resolved-missing specimens aren't expected). */
  received: number;
  expected: number;
}

/** Whether the specimen is still due a break: scheduled, target reached, entry not complete. */
export function isDue(
  specimen: ConcreteSpecimenSetDetail['specimens'][number],
  testing: ReadonlyMap<string, ConcreteTestingTableRow>,
  today: string,
): boolean {
  if (specimen.assignedAge === CONCRETE_HOLD_AGE || !specimen.targetDate) return false;
  if (specimen.targetDate > today) return false;
  const row = testing.get(specimen.id);
  return !row?.complete;
}

export function setRecordState(input: {
  set: ConcreteSpecimenSetDetail;
  receiving: ConcreteSetReceiving;
  testing: ReadonlyMap<string, ConcreteTestingTableRow>;
  today: string;
}): SetRecordState {
  const { set, receiving, testing, today } = input;
  const expectedSpecimens = receiving.specimens.filter((s) => s.state !== 'missing_resolved');
  const received = expectedSpecimens.filter((s) => s.state === 'received').length;
  const base = { received, expected: expectedSpecimens.length };
  const holds = set.specimens.filter((s) => s.assignedAge === CONCRETE_HOLD_AGE);
  const holdEnded = holds
    .filter((s) => s.holdExpiresOn !== null && s.holdExpiresOn <= today)
    .map((s) => s.id);

  if (set.void) {
    return {
      ...base,
      key: 'void',
      tag: { stage: 'closed', label: 'Void' },
      step: 'cast',
      main: null,
      holdEnded,
    };
  }
  if (received < expectedSpecimens.length) {
    return {
      ...base,
      key: 'awaiting',
      tag: { stage: 'draft', label: 'Draft · Receiving' },
      step: 'cast',
      main: { kind: 'receive' },
      holdEnded,
    };
  }
  const due = set.specimens.filter((s) => isDue(s, testing, today)).map((s) => s.id);
  if (due.length > 0) {
    return {
      ...base,
      key: 'due',
      tag: { stage: 'lab', label: 'In lab · Breaks' },
      step: 'testing',
      main: { kind: 'breaks', specimenIds: due },
      holdEnded,
    };
  }
  if (holdEnded.length > 0) {
    return {
      ...base,
      key: 'hold_ended',
      tag: { stage: 'danger', label: 'Hold period has ended' },
      step: 'testing',
      main: { kind: 'hold' },
      holdEnded,
    };
  }
  const scheduled = set.specimens.filter(
    (s) => s.assignedAge !== CONCRETE_HOLD_AGE && s.targetDate !== null,
  );
  const entered = scheduled.filter((s) => testing.get(s.id)?.complete).length;
  const tested = scheduled.length > 0 && entered === scheduled.length;
  if (holds.length > 0 && tested) {
    return {
      ...base,
      key: 'on_hold',
      tag: { neutral: true, label: 'Inside the hold period' },
      step: 'testing',
      main: { kind: 'hold' },
      holdEnded,
    };
  }
  if (tested) {
    return {
      ...base,
      key: 'entered',
      tag: { stage: 'storage', label: 'Breaks entered' },
      step: 'testing',
      main: null,
      holdEnded,
    };
  }
  return {
    ...base,
    key: 'curing',
    tag: { stage: 'storage', label: 'Stored · Curing' },
    step: entered > 0 ? 'testing' : 'received',
    main: null,
    holdEnded,
  };
}
