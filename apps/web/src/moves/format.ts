import {
  formatClockTime,
  storageUnitTypeLabel,
  type StorageUnitDetail,
} from '@materialmule/shared';
import type { PlaceRef, QueuedMove } from './store';

// Wording and formats shared by the Move screen and its tests (MM-T28, STRATA-80).

/** Local time with its UTC offset, e.g. 2026-10-27T09:15:00.000-06:00. */
export function isoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

export type MoveBadgeVariant = 'draft' | 'storage' | 'lab' | 'due' | 'danger' | 'closed';

/**
 * A queued row's state in the round 3 words: "Not moved yet" until the server answers (offline,
 * or not sent yet), "Moved 10:42 AM" once saved, and the problem otherwise.
 */
export function moveStatus(
  move: QueuedMove | undefined,
  syncingId: string | null,
  online: boolean,
): { label: string; variant: MoveBadgeVariant } {
  if (!move) return { label: 'Not moved yet', variant: 'due' };
  if (move.state === 'pending' && move.clientMoveId === syncingId && online) {
    return { label: 'Saving…', variant: 'draft' };
  }
  switch (move.state) {
    case 'pending':
      return { label: 'Not moved yet', variant: 'due' };
    case 'waiting':
      return { label: 'Waiting for earlier move', variant: 'due' };
    case 'saved':
      return {
        label: move.result?.savedAt ? `Moved ${formatClockTime(move.result.savedAt)}` : 'Moved',
        variant: 'storage',
      };
    case 'conflict':
      return { label: 'Location conflict', variant: 'danger' };
    case 'attention':
      return { label: 'Needs attention', variant: 'danger' };
    case 'dismissed':
      return { label: 'Dismissed', variant: 'closed' };
  }
}

/** "DEMO-2615 · TH26-03 · Bucket": what a unit row says under its ID. */
export function unitDescription(
  unit: Pick<StorageUnitDetail, 'project' | 'holes' | 'unitType'>,
): string {
  const holes = unit.holes.map((hole) => hole.testHoleName).join(', ');
  return [unit.project.projectNumber, holes, storageUnitTypeLabel(unit.unitType)]
    .filter(Boolean)
    .join(' · ');
}

/** "Warehouse A · Bay 2 · Shelf 3": the place's names from the top of its hierarchy. */
export function placePath(
  place: PlaceRef,
  byId: ReadonlyMap<string, { name: string; parentId?: string | null }>,
): string {
  const names = [place.name];
  let parent = byId.get(place.id)?.parentId ?? null;
  for (let depth = 0; parent && depth < 6; depth++) {
    const next = byId.get(parent);
    if (!next) break;
    names.unshift(next.name);
    parent = next.parentId ?? null;
  }
  return names.join(' · ');
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The shelf preview line: "Shelf after this move: 14 of 16 places", honest when the capacity
 * isn't set ("14 units · places not set") or the shelf would hold more than its places.
 */
export function shelfAfterText(
  thereNow: number,
  coming: number,
  capacity: number | null,
): { line: string; over: number } {
  const after = thereNow + coming;
  if (capacity === null) {
    return {
      line: `Shelf after this move: ${plural(after, 'unit')} · places not set`,
      over: 0,
    };
  }
  const over = Math.max(0, after - capacity);
  return {
    line: `Shelf after this move: ${after} of ${plural(capacity, 'place')}${over > 0 ? ` · ${over} over` : ''}`,
    over,
  };
}
