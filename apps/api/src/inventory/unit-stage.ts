import {
  storageUnitLifecycleStep,
  storageUnitStage,
  type InventoryItem,
  type StorageTerm,
  type StorageUnitLifecycleStep,
  type StorageUnitStage,
  type StorageUnitStatusFacts,
} from '@materialmule/shared';

/** What the inventory query reads about one unit to derive its record status (STRATA-58). */
export interface UnitStageInput {
  status: InventoryItem['status'];
  openConflict: boolean;
  /** `location.kind` of the unit's saved location. */
  locationKind: string;
  /**
   * The saved location's effective storage term (view location_effective_storage_term, STRATA-106);
   * null while no location in its chain has one.
   */
  storageTerm: StorageTerm | null;
  /** From unit_retention (MM-T29); undefined only if the view has no row for the unit. */
  retention?: { effectiveRetainUntil: string; onHold: boolean; retentionExempt: boolean };
  /** Today in the business time zone (America/Edmonton), YYYY-MM-DD. */
  today: string;
}

/**
 * The facts `storageUnitStage` needs, each from the database:
 * - disposed: the unit's status;
 * - openConflict: an open location_conflict (MM-T81);
 * - inLab: the saved location is a lab location (`kind = 'lab'`), the same signal Units to pull
 *   uses to treat a unit as already pulled. A unit covered by a submitted program but still on its
 *   shelf is not in the lab yet;
 * - awaitingPutAway: still at the receiving location (`kind = 'receiving_lab'`, the system
 *   Receiving lab);
 * - storageTerm: the saved location's effective term (own, else the nearest ancestor's, STRATA-106);
 *   null while unset, which reads Short-term (DESIGN.md › Choices made);
 * - retentionDue / retentionOverdue: the effective retain-until date (unit_retention) on or before
 *   today is due, the same "eligible by date" rule as MM-T29 and the Retention page; before today
 *   is overdue (no grace period exists). Units on an active hold or exempt as tested units are
 *   neither: retention is paused or doesn't apply to them.
 */
export function unitStageFacts(input: UnitStageInput): StorageUnitStatusFacts {
  const retention = input.retention;
  const retentionApplies = Boolean(retention && !retention.onHold && !retention.retentionExempt);
  const retainUntil = retention?.effectiveRetainUntil ?? '';
  return {
    disposed: input.status === 'disposed',
    openConflict: input.openConflict,
    inLab: input.locationKind === 'lab',
    awaitingPutAway: input.locationKind === 'receiving_lab',
    storageTerm: input.storageTerm,
    retentionDue: retentionApplies && retainUntil <= input.today,
    retentionOverdue: retentionApplies && retainUntil < input.today,
  };
}

/** Record status, stage and lifecycle step: one derivation for every surface that shows a unit. */
export function unitStage(
  input: UnitStageInput,
): StorageUnitStage & { lifecycleStep: StorageUnitLifecycleStep } {
  const facts = unitStageFacts(input);
  return { ...storageUnitStage(facts), lifecycleStep: storageUnitLifecycleStep(facts) };
}
