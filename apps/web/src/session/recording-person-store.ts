// State behind the shared LAB station's recording person (STRATA-16, 61, 125): the context, the
// per-tab storage of the pick and the constants. Components live in recording-person.tsx.
import type { MeResponse, StaffOption } from '@materialmule/shared';
import { createContext, useContext } from 'react';
import type { RecordingPerson } from './station-people';

/** The "Who is working here?" page (sign-in step 2 on LAB). */
export const WHO_IS_WORKING_PATH = '/who-is-working';

/** sessionStorage key of the picked person: this browser tab only, never a secret. */
export const RECORDING_PERSON_KEY = 'materialmule.recordingPerson';

/**
 * Prefix for private per-person view state (filters, a search in progress, opened panels) that a
 * screen keeps in sessionStorage or localStorage on a station. Signing off removes every key
 * that starts with it, so the next person never sees the previous one's view.
 */
export const PERSON_SCOPED_PREFIX = 'materialmule.person.';

/** How long the "Signed off" toast offers Undo (DESIGN.md › Signing off). */
export const SIGN_OFF_UNDO_MS = 8000;

export type StationPeople =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; people: RecordingPerson[]; staff: StaffOption[] };

export interface RecordingPersonController {
  /** True on a shared LAB station session; false for personal accounts (everything else is inert). */
  isStation: boolean;
  /** The picked person, or null when no one is picked yet ("Who is working here?"). */
  person: RecordingPerson | null;
  pick(person: RecordingPerson): void;
  /** Signs off the picked person (LAB stays signed in) and returns to "Who is working here?". */
  signOff(): void;
  /** The station's people (lab staff) and every active staff member, for pickers and checks. */
  people: StationPeople;
  /** Loads the people again (Try again). */
  reloadPeople(): void;
  /** Why the remembered person was dropped (disabled or no longer creditable), if they were. */
  notice: string | null;
}

export const RecordingPersonContext = createContext<RecordingPersonController | null>(null);

export const PERSONAL_CONTROLLER: RecordingPersonController = {
  isStation: false,
  person: null,
  pick: () => undefined,
  signOff: () => undefined,
  people: { state: 'ready', people: [], staff: [] },
  reloadPeople: () => undefined,
  notice: null,
};

export function useRecordingPerson(): RecordingPersonController {
  const value = useContext(RecordingPersonContext);
  if (!value) throw new Error('useRecordingPerson must be used inside <RecordingPersonProvider>');
  return value;
}

/** For shared components rendered both inside and outside the provider (e.g. ReceiverSelect). */
export function useOptionalRecordingPerson(): RecordingPersonController | null {
  return useContext(RecordingPersonContext);
}

interface StoredPerson {
  v: 1;
  /** The LAB session this pick belongs to: a new LAB sign-in never inherits an old pick. */
  session: string;
  person: RecordingPerson;
}

/** Identifies one LAB session: the account and its expiry (absolute: sessions never slide). */
export function stationSessionKey(me: Pick<MeResponse, 'id' | 'sessionExpiresAt'>): string {
  return `${me.id}|${me.sessionExpiresAt}`;
}

function isRecordingPerson(value: unknown): value is RecordingPerson {
  if (!value || typeof value !== 'object') return false;
  const person = value as Record<string, unknown>;
  return (
    typeof person.id === 'string' &&
    typeof person.displayName === 'string' &&
    typeof person.initials === 'string' &&
    typeof person.roleLine === 'string'
  );
}

export function readStoredPerson(sessionKey: string): RecordingPerson | null {
  try {
    const raw = window.sessionStorage.getItem(RECORDING_PERSON_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredPerson>;
    if (stored.v !== 1 || stored.session !== sessionKey || !isRecordingPerson(stored.person)) {
      return null;
    }
    return stored.person;
  } catch {
    return null;
  }
}

/**
 * Remembers the picked person for this LAB session in this tab, so a reload keeps it. Also what
 * tests use to start a station with someone picked.
 */
export function storeRecordingPerson(sessionKey: string, person: RecordingPerson | null): void {
  try {
    if (person) {
      const stored: StoredPerson = { v: 1, session: sessionKey, person };
      window.sessionStorage.setItem(RECORDING_PERSON_KEY, JSON.stringify(stored));
    } else {
      window.sessionStorage.removeItem(RECORDING_PERSON_KEY);
    }
  } catch {
    // Storage blocked: the pick lasts until the page reloads.
  }
}

function clearScopedKeys(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(PERSON_SCOPED_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/** Forgets the picked person and their private view state. End station session calls it too. */
export function clearRecordingPerson(): void {
  try {
    window.sessionStorage.removeItem(RECORDING_PERSON_KEY);
    clearScopedKeys(window.sessionStorage);
    clearScopedKeys(window.localStorage);
  } catch {
    // Storage blocked: nothing was kept.
  }
}
