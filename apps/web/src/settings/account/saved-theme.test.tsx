import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '@materialmule/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseTheme, THEME_STORAGE_KEY } from '../../theme/theme';
import { useSavedTheme } from './preferences-api';

// STRATA-101: the person's saved theme applies once the session is known; until then the
// browser's own choice stays (no flash), a change made meanwhile wins, and the shared LAB account
// reads and saves nothing.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers GET /api/me/preferences with `theme` once `release` is called. */
function stubPreferences(theme: UserPreferences['theme'], readOnly = false) {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  const fetchMock = vi.fn(async () => {
    await ready;
    return json(200, {
      preferences: { ...DEFAULT_USER_PREFERENCES, theme },
      version: 3,
      readOnly,
      labTimeZone: 'America/Edmonton',
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

describe('useSavedTheme', () => {
  it('keeps the browser’s choice until /api/me/preferences answers, then applies the saved one', async () => {
    chooseTheme('light');
    const { fetchMock, release } = stubPreferences('dark');
    renderHook(() => useSavedTheme({ accountId: 'u1', station: false }));
    expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', expect.anything());
    // Not yet answered: nothing changes (no flash to the default).
    expect(document.documentElement.dataset.theme).toBe('light');
    release();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('a saved System clears the browser’s explicit choice', async () => {
    chooseTheme('dark');
    const { release } = stubPreferences('system');
    renderHook(() => useSavedTheme({ accountId: 'u1', station: false }));
    release();
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('a change made before the saved value arrives wins', async () => {
    const { fetchMock, release } = stubPreferences('dark');
    renderHook(() => useSavedTheme({ accountId: 'u1', station: false }));
    chooseTheme('light');
    release();
    // The answer arrives (and its body is read) before the check.
    const response = (await fetchMock.mock.results[0]!.value) as Response;
    await act(async () => {
      await response.clone().json();
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('the shared LAB account reads nothing and keeps the browser’s theme', () => {
    chooseTheme('light');
    const { fetchMock, release } = stubPreferences('dark');
    renderHook(() => useSavedTheme({ accountId: 'lab', station: true }));
    release();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
