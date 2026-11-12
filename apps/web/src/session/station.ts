// What this browser knows about the computer it runs on. Two separate, non-secret markers in
// localStorage; neither holds an identity, token or password, and neither authorizes anything
// (the server checks every request against the session):
//
// * The station kind (STRATA-18): an administrator marks a computer as the shared LAB station, in
//   that browser. The sign-in page then opens straight to the LAB form. Signing out keeps it; only
//   the setting itself (or clearing the browser's storage) removes it.
// * The last-used marker (MM-T06): the browser was last signed in as LAB, so the sign-in page can
//   explain an expired LAB session. A deliberate sign-out clears it.

const LAST_USED_KEY = 'materialmule.station';
const KIND_KEY = 'materialmule.stationKind';

export type StationKind = 'lab' | 'personal';

export function rememberStation(isLab: boolean): void {
  try {
    if (isLab) {
      window.localStorage.setItem(LAST_USED_KEY, 'lab');
    } else {
      window.localStorage.removeItem(LAST_USED_KEY);
    }
  } catch {
    // Storage blocked: the generic expiry message is shown instead.
  }
}

export function wasLabStation(): boolean {
  try {
    return window.localStorage.getItem(LAST_USED_KEY) === 'lab';
  } catch {
    return false;
  }
}

/** True when an administrator marked this computer (this browser) as the shared LAB station. */
export function isLabStationComputer(): boolean {
  try {
    return window.localStorage.getItem(KIND_KEY) === 'lab';
  } catch {
    return false;
  }
}

/**
 * Marks or unmarks this computer as the shared LAB station (the admin setting, saved in this
 * browser). Returns false when the browser refuses storage, so the setting can say it didn't
 * stick; the sign-in page then falls back to the normal form with its "Sign in as LAB" link.
 */
export function setLabStationComputer(isStation: boolean): boolean {
  try {
    if (isStation) {
      window.localStorage.setItem(KIND_KEY, 'lab');
    } else {
      window.localStorage.removeItem(KIND_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Which sign-in form this computer opens on: LAB when it is the marked station, or when its last
 * LAB session ran out (it is evidently used as the station, and "Sign in to confirm" should land
 * on the LAB form). Everything else opens on Microsoft sign-in.
 */
export function stationKind(): StationKind {
  return isLabStationComputer() || wasLabStation() ? 'lab' : 'personal';
}
