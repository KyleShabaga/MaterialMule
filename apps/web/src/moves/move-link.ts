/**
 * Router state for opening Move with units already chosen (Inventory selection bar, a unit's
 * Move, the receipt done page's Put away). Kept working beside the linkable `?units=` param.
 */
export interface MoveLinkState {
  units?: string[];
}

export const MOVE_PATH = '/sample-storage/move';

/** `?to=<location code>` opens Move with that destination looked up (a shelf's page). */
export function moveToPath(locationCode: string) {
  return `${MOVE_PATH}?${new URLSearchParams({ to: locationCode }).toString()}`;
}

/**
 * `?units=ID1,ID2`: readable IDs joined by commas, each URI-encoded (agreed with Inventory's
 * selection bar). Put away adds `&receipt=<receipt ID>` so the screen can name the receipt.
 */
export function movePathForUnits(ids: readonly string[], receiptId?: string): string {
  const parts: string[] = [];
  if (ids.length > 0) parts.push(`units=${ids.map((id) => encodeURIComponent(id)).join(',')}`);
  if (receiptId) parts.push(`receipt=${encodeURIComponent(receiptId)}`);
  return parts.length > 0 ? `${MOVE_PATH}?${parts.join('&')}` : MOVE_PATH;
}

export function readMoveLinkState(state: unknown): string[] {
  if (!state || typeof state !== 'object' || !('units' in state)) return [];
  const units = (state as MoveLinkState).units;
  return Array.isArray(units) ? units.filter((id): id is string => typeof id === 'string') : [];
}

/** Readable IDs from `?units=` (comma-separated), trimmed, de-duplicated, in link order. */
export function readUnitsParam(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    let id = part.trim();
    try {
      id = decodeURIComponent(id);
    } catch {
      // Already decoded by URLSearchParams; keep it as it is.
    }
    id = id.trim().toUpperCase();
    if (id && id.length <= 40) seen.add(id);
  }
  return [...seen];
}

/** Units from the link: the query first, then router state, without repeats. */
export function linkedUnits(search: URLSearchParams, state: unknown): string[] {
  return [...new Set([...readUnitsParam(search.get('units')), ...readMoveLinkState(state)])];
}
