/**
 * Router state for opening Move units with units already chosen (Inventory selection bar, a
 * unit's "Move unit"). The units wait in the batch panel until a destination is scanned; nothing
 * is queued until the person confirms the move.
 */
export interface MoveLinkState {
  units?: string[];
}

/** `?to=<location code>` opens Move units with that destination looked up (a shelf's page). */
export function moveToPath(locationCode: string) {
  return `/sample-storage/move?${new URLSearchParams({ to: locationCode }).toString()}`;
}

export function readMoveLinkState(state: unknown): string[] {
  if (!state || typeof state !== 'object' || !('units' in state)) return [];
  const units = (state as MoveLinkState).units;
  return Array.isArray(units) ? units.filter((id): id is string => typeof id === 'string') : [];
}
