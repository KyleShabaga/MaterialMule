import { useCallback, useEffect, useState } from 'react';

// MISC-09: light/dark choice. Without one, the OS setting applies (styles.css). The choice is
// stored per browser and set as data-theme on <html>; index.html applies it before first paint.
export const THEME_STORAGE_KEY = 'materialmule:theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export type Theme = 'light' | 'dark';
/** STRATA-7: what the person picked; 'system' means no stored choice, so the OS setting applies. */
export type ThemeChoice = Theme | 'system';

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
  return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
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

/** Clears the stored choice so the operating system setting applies again (STRATA-7). */
export function followSystemTheme(): void {
  document.documentElement.removeAttribute('data-theme');
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage blocked: the page follows the OS until reload, then the old choice (if any) returns.
  }
}

/** The person's pick: light, dark, or system when nothing is stored. */
export function currentThemeChoice(): ThemeChoice {
  const explicit = document.documentElement.getAttribute('data-theme');
  return isTheme(explicit) ? explicit : 'system';
}

/** The pick (for a Light / Dark / System control) and a setter. */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(currentThemeChoice);
  const set = useCallback((next: ThemeChoice) => {
    if (next === 'system') followSystemTheme();
    else chooseTheme(next);
    setChoice(next);
  }, []);
  return [choice, set];
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  // While no explicit choice is set, follow live OS changes so the switch matches what is shown.
  // An explicit data-theme wins in currentTheme, so a chosen theme stays put.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = () => setTheme(currentTheme());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const set = useCallback((next: Theme) => {
    chooseTheme(next);
    setTheme(next);
  }, []);
  return [theme, set];
}
