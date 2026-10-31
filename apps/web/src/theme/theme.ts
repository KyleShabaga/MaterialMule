import { useCallback, useState } from 'react';

// MISC-09: light/dark choice. Without one, the OS setting applies (styles.css). The choice is
// stored per browser and set as data-theme on <html>; index.html applies it before first paint.
export const THEME_STORAGE_KEY = 'materialmule:theme';

export type Theme = 'light' | 'dark';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** The stored choice, or null when there is none or storage can't be read. */
export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** The theme in effect: an explicit choice, else what the operating system asks for. */
export function currentTheme(): Theme {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (isTheme(explicit)) return explicit;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Re-applies the stored choice (index.html normally did so already). */
export function applyStoredTheme(): void {
  const stored = readStoredTheme();
  if (stored) document.documentElement.setAttribute('data-theme', stored);
}

export function chooseTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private window, policy): the choice lasts for this page only.
  }
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const set = useCallback((next: Theme) => {
    chooseTheme(next);
    setTheme(next);
  }, []);
  return [theme, set];
}
