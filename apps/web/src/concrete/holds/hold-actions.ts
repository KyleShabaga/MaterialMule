import {
  type ConcreteHoldRow,
  type ConcreteHoldStatus,
  type ConcreteHoldStatusFilter,
  type StageKey,
} from '@materialmule/shared';
import { specimenText } from '../worklist/specimen-text';

// Concrete holds (STRATA-95 part B, canvas R7Holds*): the four states, the tabs and filters, and
// why an action is offered or not for a selection. Every answer reads what the server returned
// for each row (its status, kind and the `actions` it says the caller has now); the server checks
// again on submit.

export type HoldAction = 'schedule_test' | 'authorize_disposal' | 'record_disposal';

export const HOLD_ACTIONS: readonly HoldAction[] = [
  'schedule_test',
  'authorize_disposal',
  'record_disposal',
];

export const HOLD_ACTION_LABEL: Record<HoldAction, string> = {
  schedule_test: 'Schedule test',
  authorize_disposal: 'Authorize disposal',
  record_disposal: 'Record disposal',
};

const ACTION_KEY: Record<HoldAction, keyof ConcreteHoldRow['actions']> = {
  schedule_test: 'scheduleTest',
  authorize_disposal: 'authorizeDisposal',
  record_disposal: 'recordDisposal',
};

/**
 * The four hold states (Kyle, 2026-11-11): Inside the hold period and Hold period has ended
 * (danger), Disposal authorized (due: it already means waiting for removal), Disposed (closed).
 */
export const HOLD_STATE: Record<ConcreteHoldStatus, { label: string; stage: StageKey }> = {
  held: { label: 'Inside the hold period', stage: 'danger' },
  review_due: { label: 'Hold period has ended', stage: 'danger' },
  disposal_authorized: { label: 'Disposal authorized', stage: 'due' },
  disposed: { label: 'Disposed', stage: 'closed' },
};

export type HoldTab = 'all' | 'failed' | 'ordinary';
export const HOLD_TABS: readonly { id: HoldTab; label: string }[] = [
  { id: 'all', label: 'All holds' },
  { id: 'failed', label: 'Failed-specimen holds' },
  { id: 'ordinary', label: 'Ordinary HOLD' },
];
export const readHoldTab = (value: string | null): HoldTab =>
  value === 'failed' || value === 'ordinary' ? value : 'all';

/** Filter menu ids for the two closed states; the page opens on open holds only. */
export const STATUS_FILTERS = [
  { id: 'status:disposal_authorized', label: 'Disposal authorized' },
  { id: 'status:disposed', label: 'Disposed' },
] as const;

/** The server's status filter from the active filter chips (one at a time). */
export function statusFilterOf(filters: readonly string[]): ConcreteHoldStatusFilter {
  if (filters.includes('status:disposal_authorized')) return 'disposal_authorized';
  if (filters.includes('status:disposed')) return 'disposed';
  return 'open';
}

export const holdName = (row: Pick<ConcreteHoldRow, 'identity' | 'letter'>) =>
  specimenText(row.identity, row.letter);

const names = (rows: readonly ConcreteHoldRow[]) => rows.map(holdName).join(', ');
const isAre = (rows: readonly unknown[]) => (rows.length === 1 ? 'is' : 'are');

/**
 * Why `action` is not offered for these selected rows, in words built from what the server said
 * about each row; null when every selected specimen allows it.
 */
export function blockedReason(action: HoldAction, rows: readonly ConcreteHoldRow[]): string | null {
  if (rows.length === 0) return null;
  const refused = rows.filter((r) => !r.actions[ACTION_KEY[action]]);
  if (refused.length === 0) return null;
  const disposed = refused.filter((r) => r.status === 'disposed');
  const authorized = refused.filter((r) => r.status === 'disposal_authorized');
  if (action === 'schedule_test') {
    const failed = refused.filter((r) => r.holdKind === 'failed');
    if (failed.length > 0) {
      return `${names(failed)} ${isAre(failed)} ${failed.length === 1 ? 'a failed-specimen hold' : 'failed-specimen holds'}: no test can be scheduled.`;
    }
    if (authorized.length > 0)
      return `${names(authorized)} ${isAre(authorized)} already authorized for disposal.`;
    if (disposed.length > 0) return `${names(disposed)} ${isAre(disposed)} already disposed.`;
    return 'Scheduling a test needs the project lead or a Lab Manager.';
  }
  if (action === 'authorize_disposal') {
    if (authorized.length > 0)
      return `${names(authorized)} ${isAre(authorized)} already authorized for disposal.`;
    if (disposed.length > 0) return `${names(disposed)} ${isAre(disposed)} already disposed.`;
    if (refused.some((r) => r.holdKind === 'failed')) {
      return 'Releasing a failed-specimen hold needs the project lead or a Lab Manager with the project’s concrete authority.';
    }
    return 'Authorizing disposal needs the project lead or a Lab Manager.';
  }
  if (disposed.length > 0) return `${names(disposed)} ${isAre(disposed)} already disposed.`;
  const notYet = refused.filter((r) => r.status !== 'disposal_authorized');
  if (notYet.length === rows.length) return 'None is authorized for disposal yet.';
  if (notYet.length > 0)
    return `${names(notYet)} ${isAre(notYet)} not authorized for disposal yet.`;
  return 'Recording a disposal needs lab staff (a Lab Technician, a Lab Manager or the LAB station).';
}

/** Whether the row allows at least one action (else its checkbox is disabled). */
export const selectable = (row: ConcreteHoldRow) =>
  row.actions.scheduleTest || row.actions.authorizeDisposal || row.actions.recordDisposal;
