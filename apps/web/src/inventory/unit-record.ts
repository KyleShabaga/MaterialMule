import {
  DISPOSED_AFTER_TESTING_LABEL,
  STORAGE_TERM_LABELS,
  STORAGE_UNIT_RECORD_STATUS_LABELS,
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  formatClockTime,
  formatDepth,
  formatRecordDate,
  formatStorageUnitHoleSummary,
  storageUnitRecordStatus,
  type EffectiveStorageTerm,
  type InventoryItem,
  type StageKey,
  type StorageUnitDetail,
  type StorageUnitHoleSummary,
  type StorageUnitLifecycleStep,
  type StorageUnitRecordStatus,
} from '@materialmule/shared';

// The storage unit record pattern (STRATA-72/74): what the page, the shelf cells and the unit
// drawer derive from one unit. The server sends recordStatus, stage and lifecycleStep
// (STRATA-106); these helpers only fall back honestly while an older API leaves them out.

/** Router state a link to a unit page may carry so its breadcrumb goes back where it came from. */
export interface UnitLinkState {
  /** Inventory's own state: the list's query string (InventoryPage `InventoryLinkState`). */
  from?: string;
  /** Any other page: its path and the breadcrumb word, e.g. a shelf code. */
  backTo?: string;
  backLabel?: string;
}

/** The shelf page a location's label lands on. */
export function shelfPath(code: string): string {
  return `/sample-storage/locations/${encodeURIComponent(code)}`;
}

export function unitPath(readableId: string): string {
  return `/sample-storage/${encodeURIComponent(readableId)}`;
}

/** Where Decide goes for a unit whose retention is due: the project's retention list. */
export function retentionDecidePath(projectId: string): string {
  return `/disposal-retention?${new URLSearchParams({ projectId }).toString()}`;
}

type StatusSource = Pick<StorageUnitDetail, 'status' | 'locationConflict' | 'storageTerm'> & {
  recordStatus?: StorageUnitRecordStatus;
};

/**
 * The unit's record status. The server's value when it sends one; otherwise only the facts this
 * page has (disposed, an open conflict, the effective term). In lab and retention due can't be
 * told without the server, so the fallback never claims them.
 */
export function unitRecordStatus(unit: StatusSource): StorageUnitRecordStatus {
  if (unit.recordStatus) return unit.recordStatus;
  return storageUnitRecordStatus({
    disposed: unit.status === 'disposed',
    openConflict: Boolean(unit.locationConflict),
    inLab: false,
    awaitingPutAway: false,
    storageTerm: unit.storageTerm?.term ?? null,
    retentionDue: false,
    retentionOverdue: false,
  });
}

/** The lifecycle step from the server, else from the record status (retention and conflicts never move a step). */
export function unitLifecycleStep(
  lifecycleStep: StorageUnitLifecycleStep | undefined,
  status: StorageUnitRecordStatus,
  term: EffectiveStorageTerm | undefined,
): StorageUnitLifecycleStep {
  if (lifecycleStep) return lifecycleStep;
  switch (status) {
    case 'received':
    case 'in_lab':
    case 'short_term':
    case 'long_term':
    case 'disposed':
      return status;
    default:
      return term?.term === 'long_term' ? 'long_term' : 'short_term';
  }
}

/** Steps a unit passed without doing: In lab, when it was never tested and is past that step. */
export function passedWithout(
  step: StorageUnitLifecycleStep,
  neverTested: boolean | undefined,
): string[] {
  const pastLab = step === 'short_term' || step === 'long_term' || step === 'disposed';
  return neverTested && pastLab ? ['in_lab'] : [];
}

export interface UnitTagWords {
  stage: StageKey;
  label: string;
}

/**
 * The record tag. A location conflict is shown as a second tag ("Urgent · Location"), so the first
 * tag keeps the physical step (Short-term, In lab…); a unit disposed after testing says so.
 */
export function unitTag(
  status: StorageUnitRecordStatus,
  step: StorageUnitLifecycleStep,
  testedRemoval: boolean,
): UnitTagWords {
  if (status === 'disposed' && testedRemoval) {
    return { stage: 'closed', label: DISPOSED_AFTER_TESTING_LABEL };
  }
  const shown: StorageUnitRecordStatus = status === 'location_conflict' ? step : status;
  return {
    stage: STORAGE_UNIT_RECORD_STATUS_STAGE[shown],
    label: STORAGE_UNIT_RECORD_STATUS_LABELS[shown],
  };
}

export type UnitPrimaryAction =
  | { kind: 'move'; label: 'Move' | 'Move back to storage' }
  | { kind: 'decide'; label: 'Decide' }
  | { kind: 'none' };

/** Exactly one main action, chosen by the stage (DESIGN.md › Round 1). */
export function unitPrimaryAction(status: StorageUnitRecordStatus): UnitPrimaryAction {
  switch (status) {
    case 'disposed':
      return { kind: 'none' };
    case 'in_lab':
      return { kind: 'move', label: 'Move back to storage' };
    case 'retention_due':
    case 'retention_overdue':
      return { kind: 'decide', label: 'Decide' };
    default:
      return { kind: 'move', label: 'Move' };
  }
}

/** "Short-term storage", "Long-term storage" or "Storage term not set". */
export function storageTermText(term: EffectiveStorageTerm | undefined | null): string {
  if (!term?.term) return 'Storage term not set';
  return STORAGE_TERM_LABELS[term.term];
}

/** "2026-11-07 10:12 AM" in the lab's time zone (shared date format helper). */
export function formatEventTime(iso: string): string {
  return `${formatRecordDate(iso)} ${formatClockTime(iso)}`.trim();
}

/** A hole summary split into the table's Samples and Depth cells. */
export function holeSummaryCells(hole: StorageUnitHoleSummary): { samples: string; depth: string } {
  if (hole.type === 'depth_range') {
    // A depth summary names no samples, so the Samples cell stays empty rather than guessing.
    return { samples: '', depth: formatDepth(hole.depthFrom, hole.depthTo, hole.depthUnit) };
  }
  return { samples: formatStorageUnitHoleSummary(hole), depth: '' };
}

/** A location's place count, once the API sends it (STRATA-106: `capacity`, null = not set). */
export function locationCapacity(location: object): number | null {
  const value = (location as { capacity?: unknown }).capacity;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** The unit drawer's title (its label block heading), which names the drawer region. */
export const UNIT_DRAWER_TITLE_ID = 'unit-drawer-title';

/** A shelf row's record status: the server's, else what the row itself says (never In lab). */
export function itemRecordStatus(
  item: Pick<InventoryItem, 'recordStatus' | 'status' | 'openConflict' | 'retention'>,
  term: EffectiveStorageTerm | undefined,
): StorageUnitRecordStatus {
  if (item.recordStatus) return item.recordStatus;
  const retention = item.retention;
  return storageUnitRecordStatus({
    disposed: item.status === 'disposed',
    openConflict: Boolean(item.openConflict),
    inLab: false,
    awaitingPutAway: false,
    storageTerm: term?.term ?? null,
    retentionDue: Boolean(retention && !retention.retentionExempt && retention.eligibleByDate),
    retentionOverdue: false,
  });
}

/** "12 of 16 places used", or the honest wording when over capacity or capacity is not set. */
export function placesUsedText(count: number, capacity: number | null): string {
  if (capacity === null) return `${count} ${count === 1 ? 'unit' : 'units'} here`;
  if (count > capacity) {
    return `${count} units on ${capacity} places: ${count - capacity} over capacity`;
  }
  return `${count} of ${capacity} places used`;
}
