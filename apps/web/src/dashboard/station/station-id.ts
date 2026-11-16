import { stationIdSchema } from '@materialmule/shared';

// The LAB station's identity (STRATA-21): a random ID made once on this computer and kept in this
// browser. It belongs to the computer, not to a person, so it is not under the
// `materialmule.person.` prefix that signing off clears. It is not a secret and authorizes
// nothing: the server checks every request against the session.

export const STATION_ID_KEY = 'materialmule.station.id';

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only for a session where storage is blocked: one ID for as long as the page stays open. */
let fallback: string | null = null;

/**
 * This computer's station ID, made on first use. When the browser refuses storage, an ID lasts
 * until the page reloads (the station then shows the defaults, which is safe).
 */
export function stationId(): string {
  try {
    const stored = window.localStorage.getItem(STATION_ID_KEY);
    if (stored && stationIdSchema.safeParse(stored).success) return stored;
    const made = randomId();
    window.localStorage.setItem(STATION_ID_KEY, made);
    return made;
  } catch {
    fallback ??= randomId();
    return fallback;
  }
}
