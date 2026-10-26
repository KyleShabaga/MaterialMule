// Remembers, in this browser only, that it was last used as the shared LAB station (TRP-T06), so
// the sign-in page can explain an expired LAB session. Holds no identity, token or secret.

const KEY = 'trapezoid.station';

export function rememberStation(isLab: boolean): void {
  try {
    if (isLab) {
      window.localStorage.setItem(KEY, 'lab');
    } else {
      window.localStorage.removeItem(KEY);
    }
  } catch {
    // Storage blocked: the generic expiry message is shown instead.
  }
}

export function wasLabStation(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'lab';
  } catch {
    return false;
  }
}
