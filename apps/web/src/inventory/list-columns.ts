import {
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  type InventoryItem,
  type StageKey,
  type StorageUnitRecordStatus,
} from '@materialmule/shared';

// Inventory list columns and row status helpers (STRATA-79), beside StorageUnitTable.

/** The columns in order; ID, project and stage are always shown (View › Columns locks them). */
export const STORAGE_UNIT_COLUMNS = [
  { id: 'id', label: 'ID', locked: true },
  { id: 'project', label: 'Project', locked: true },
  { id: 'hole', label: 'Test hole' },
  { id: 'type', label: 'Type' },
  { id: 'where', label: 'Where' },
  { id: 'stage', label: 'Stage', locked: true },
  { id: 'received', label: 'Received' },
  { id: 'retain', label: 'Retain until' },
] as const;

/**
 * The record status a row shows: the server's (STRATA-58), else, for an older response without
 * it, what the saved facts allow (disposed, an open conflict), else null.
 */
export function rowRecordStatus(item: InventoryItem): StorageUnitRecordStatus | null {
  if (item.recordStatus) return item.recordStatus;
  if (item.status === 'disposed') return 'disposed';
  if (item.openConflict) return 'location_conflict';
  return null;
}

export function rowStage(item: InventoryItem): StageKey {
  const status = rowRecordStatus(item);
  return item.stage ?? (status ? STORAGE_UNIT_RECORD_STATUS_STAGE[status] : 'storage');
}
