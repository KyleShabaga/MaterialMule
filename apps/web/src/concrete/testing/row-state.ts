import {
  concreteStrengthRelativeFlags,
  concreteTestResultChanges,
  parseConcreteReadings,
  type ConcreteTestResult,
  type ConcreteTestResultSaveRequest,
  type ConcreteTestResultValues,
  type ConcreteTestingTableResult,
  type ConcreteTestingTableRow,
} from '@materialmule/shared';

// MM-V2-C23: one testing-table row's local state, kept apart from the page so the rules (what a
// save sends, when a reason is needed, what the status says) are plain functions.

/** What is typed in the row's cells (text, exactly as typed). */
export interface RowEdit {
  testedOn: string;
  maxLoad: string;
  height: string;
  diameter: string;
  reason: string;
}

export type RowStatus = 'empty' | 'pending' | 'saving' | 'saved' | 'failed' | 'reason';

export interface RowState {
  row: ConcreteTestingTableRow;
  /** The attempt this row saves to: the latest one, or a new client-chosen ID. */
  resultId: string;
  edit: RowEdit;
  status: RowStatus;
  message: string | null;
  /** The last request sent, so a retry of the same save reuses its idempotency key. */
  lastSent: { key: string; body: string } | null;
}

const formatReadings = (values: readonly number[]) => values.join(' ');

export function editOf(result: ConcreteTestingTableResult | null): RowEdit {
  return {
    testedOn: result?.testedOn ?? '',
    maxLoad:
      result?.maxLoad === null || result?.maxLoad === undefined ? '' : String(result.maxLoad),
    height: formatReadings(result?.heightReadings ?? []),
    diameter: formatReadings(result?.diameterReadings ?? []),
    reason: '',
  };
}

export function initialRowState(row: ConcreteTestingTableRow, newId: () => string): RowState {
  return {
    row,
    resultId: row.result?.id ?? newId(),
    edit: editOf(row.result),
    status: row.result ? 'saved' : 'empty',
    message: null,
    lastSent: null,
  };
}

/**
 * The table's copy of a saved result (the save answer carries the full C07 result, with its
 * stored calculation). MM-V2-C24: the flags against f′c come from the row's specification, and
 * the exclusion stays as the table read it (only a reviewer changes it).
 */
export function tableResultOf(
  result: ConcreteTestResult,
  row: Pick<ConcreteTestingTableRow, 'specifiedStrengthMpa' | 'result'>,
): ConcreteTestingTableResult {
  const calculation = result.calculation;
  return {
    id: result.id,
    attemptNo: result.attemptNo,
    version: result.version,
    testedOn: result.testedOn,
    tester: result.tester,
    maxLoad: result.maxLoad,
    heightReadings: result.heightReadings,
    diameterReadings: result.diameterReadings,
    units: result.units,
    enteredAt: result.revisions.at(-1)?.at ?? result.updatedAt,
    calculation,
    strengthFlags: calculation
      ? [
          ...calculation.flags,
          ...concreteStrengthRelativeFlags(calculation.strength, row.specifiedStrengthMpa),
        ]
      : [],
    excluded: row.result?.id === result.id ? row.result.excluded : false,
  };
}

function savedValues(result: ConcreteTestingTableResult | null): ConcreteTestResultValues | null {
  if (!result) return null;
  return {
    testedOn: result.testedOn,
    tester: result.tester?.userId ?? null,
    maxLoad: result.maxLoad,
    heightReadings: result.heightReadings,
    diameterReadings: result.diameterReadings,
    notes: null,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export type CellField = 'testedOn' | 'maxLoad' | 'height' | 'diameter';

export type SavePlan =
  | { kind: 'none' }
  | { kind: 'invalid'; field: CellField | 'tester'; message: string }
  | { kind: 'reason'; corrections: string[] }
  | { kind: 'send'; body: Omit<ConcreteTestResultSaveRequest, 'idempotencyKey'> };

/** Parse the typed cells; null fields mean "invalid", reported by `planSave`. */
function parsed(edit: RowEdit) {
  const load = edit.maxLoad.trim();
  const loadValue = load === '' ? null : /^\d+(\.\d+)?$|^\.\d+$/.test(load) ? Number(load) : NaN;
  return {
    testedOn: edit.testedOn.trim(),
    maxLoad: loadValue,
    height: parseConcreteReadings(edit.height),
    diameter: parseConcreteReadings(edit.diameter),
  };
}

/** Whether the typed cells differ from what is saved (or anything is typed on a new row). */
export function isDirty(state: Pick<RowState, 'row' | 'edit'>): boolean {
  const saved = editOf(state.row.result);
  return (
    saved.testedOn !== state.edit.testedOn.trim() ||
    saved.maxLoad !== state.edit.maxLoad.trim() ||
    formatReadings(parseConcreteReadings(state.edit.height) ?? [NaN]) !== saved.height ||
    formatReadings(parseConcreteReadings(state.edit.diameter) ?? [NaN]) !== saved.diameter
  );
}

/**
 * What saving the row would do (the same entry/correction rule the API applies):
 * - nothing typed or nothing changed: none;
 * - a cell that isn't a valid value: invalid (nothing is sent);
 * - a change to a saved value without a reason: reason (refused, the edit is kept; AC3);
 * - otherwise the request body. A new attempt records the page's tester and, when the test date
 *   is blank, today's date (editable later for delayed entry). An existing attempt sends only
 *   the changed fields and never its tester, so it keeps the one it was saved with (AC1).
 */
export function planSave(
  state: Pick<RowState, 'row' | 'edit'>,
  context: { today: string; pageTesterId: string | null; sharedStation: boolean },
): SavePlan {
  const result = state.row.result;
  if (!isDirty(state)) return { kind: 'none' };
  const values = parsed(state.edit);
  if (values.testedOn !== '' && !validDate(values.testedOn)) {
    return { kind: 'invalid', field: 'testedOn', message: 'Enter the test date as YYYY-MM-DD' };
  }
  if (Number.isNaN(values.maxLoad) || (values.maxLoad !== null && values.maxLoad <= 0)) {
    return { kind: 'invalid', field: 'maxLoad', message: 'Enter the maximum load as a number' };
  }
  if (values.height === null) {
    return { kind: 'invalid', field: 'height', message: 'Enter heights as numbers' };
  }
  if (values.diameter === null) {
    return { kind: 'invalid', field: 'diameter', message: 'Enter diameters as numbers' };
  }
  if ((!result || context.sharedStation) && !context.pageTesterId) {
    return { kind: 'invalid', field: 'tester', message: 'Choose Tested by first' };
  }
  const isNew = result === null;
  const proposed: Partial<ConcreteTestResultValues> = {
    testedOn: values.testedOn === '' ? (isNew ? context.today : null) : values.testedOn,
    maxLoad: values.maxLoad,
    heightReadings: values.height,
    diameterReadings: values.diameter,
  };
  const { changed, corrections } = concreteTestResultChanges(savedValues(result), proposed);
  if (!isNew && changed.length === 0) return { kind: 'none' };
  const reason = state.edit.reason.trim();
  if (corrections.length > 0 && reason === '') return { kind: 'reason', corrections };

  const body: Omit<ConcreteTestResultSaveRequest, 'idempotencyKey'> = {
    version: result?.version ?? 0,
  };
  for (const field of changed) {
    if (field === 'testedOn') body.testedOn = proposed.testedOn ?? null;
    if (field === 'maxLoad') body.maxLoad = proposed.maxLoad ?? null;
    if (field === 'heightReadings') body.heightReadings = proposed.heightReadings ?? [];
    if (field === 'diameterReadings') body.diameterReadings = proposed.diameterReadings ?? [];
  }
  if (isNew) body.testerUserId = context.pageTesterId;
  if (context.sharedStation && context.pageTesterId) body.enteredByUserId = context.pageTesterId;
  if (corrections.length > 0) body.reason = reason;
  return { kind: 'send', body };
}

/** Whether the typed values would correct a saved value (the reason field shows). */
export function needsReason(state: Pick<RowState, 'row' | 'edit'>, today: string): boolean {
  const plan = planSave(
    { ...state, edit: { ...state.edit, reason: '' } },
    { today, pageTesterId: 'any', sharedStation: false },
  );
  return plan.kind === 'reason';
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  empty: 'Not entered',
  pending: 'Not saved',
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Failed',
  reason: 'Reason needed',
};
