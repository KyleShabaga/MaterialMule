import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyStoredTheme,
  chooseTheme,
  currentTheme,
  currentThemeChoice,
  followSystemTheme,
  readStoredTheme,
} from './theme';

// MISC-09: an explicit light/dark choice wins over the OS setting and survives a reload.

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('theme choice', () => {
  it('stores the choice and applies it to <html>', () => {
    chooseTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    document.documentElement.removeAttribute('data-theme');
    applyStoredTheme();
    expect(currentTheme()).toBe('dark');
  });

  it('ignores unknown stored values and follows the OS', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(readStoredTheme()).toBeNull();
    applyStoredTheme();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(currentTheme()).toBe('light');
  });

  it('still switches when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => chooseTheme('light')).not.toThrow();
    expect(currentTheme()).toBe('light');
    expect(readStoredTheme()).toBeNull();
  });

  it('System clears the stored choice so the OS setting applies again (STRATA-7)', () => {
    chooseTheme('dark');
    expect(currentThemeChoice()).toBe('dark');
    followSystemTheme();
    expect(currentThemeChoice()).toBe('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(currentTheme()).toBe('light');
  });
});
