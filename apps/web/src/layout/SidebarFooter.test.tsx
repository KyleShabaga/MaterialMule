import type { MeResponse } from '@materialmule/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { ServerHealth, SidebarFooter, ThemeSwitch } from './SidebarFooter';

// MISC-09: rail footer — Pending actions, Settings, Help & Feedback, the account row, the dark
// mode switch and server health in words, not colour alone.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

describe('ThemeSwitch', () => {
  it('is a labelled switch that flips the theme and remembers it', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    const toggle = screen.getByRole('switch', { name: 'Dark mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  /** A prefers-color-scheme query whose answer the test can change, like the OS switching. */
  function stubOsTheme(dark: boolean) {
    const listeners = new Set<() => void>();
    const query = {
      get matches() {
        return dark;
      },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => query),
    );
    return {
      listeners,
      set(next: boolean) {
        dark = next;
        act(() => listeners.forEach((listener) => listener()));
      },
    };
  }

  it('follows a live OS theme change while no choice is saved, so one click flips it', async () => {
    const user = userEvent.setup();
    const os = stubOsTheme(false);
    const { unmount } = render(<ThemeSwitch />);
    const toggle = screen.getByRole('switch', { name: 'Dark mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    os.set(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.dataset.theme).toBe('light');
    unmount();
    expect(os.listeners.size).toBe(0);
  });

  it('keeps an explicit choice when the OS theme changes', async () => {
    const user = userEvent.setup();
    const os = stubOsTheme(false);
    render(<ThemeSwitch />);
    const toggle = screen.getByRole('switch', { name: 'Dark mode' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    os.set(false);
    os.set(true);
    os.set(false);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('ServerHealth', () => {
  it('says the server is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { status: 'ok', version: '0.1.0', database: 'up' })),
    );
    render(<ServerHealth />);
    expect(screen.getByText('Checking server…')).toHaveAttribute('aria-live', 'polite');
    expect(await screen.findByText('Server connected')).toBeInTheDocument();
  });

  it('says when the database is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(503, { status: 'degraded', version: '0.1.0', database: 'down' })),
    );
    render(<ServerHealth />);
    expect(await screen.findByText('Server connected, database unavailable')).toBeInTheDocument();
  });

  it('says when the server is unreachable, and re-checks on window focus', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ServerHealth />);
    expect(await screen.findByText('Server unreachable')).toBeInTheDocument();
    fetchMock.mockImplementation(async () =>
      json(200, { status: 'ok', version: '0.1.0', database: 'up' }),
    );
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText('Server connected')).toBeInTheDocument();
  });
});

describe('SidebarFooter', () => {
  const person: MeResponse = {
    id: 'u2',
    displayName: 'Alex Tester',
    initials: null,
    accountType: 'personal',
    status: 'active',
    roles: ['lab_technician'],
    permissions: ['inventory.read', 'action_item.read'],
    sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  };

  function renderFooter(me: MeResponse, path = '/') {
    const signOut = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/action-items/count')) return json(200, { open: 3 });
        return json(200, { status: 'ok', version: '0.1.0', database: 'up' });
      }),
    );
    render(
      <SessionContext.Provider
        value={{ session: { status: 'active', me }, refresh: vi.fn(), signOut }}
      >
        <MemoryRouter initialEntries={[path]}>
          <SidebarFooter />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    return signOut;
  }

  it('links Pending actions with its count, Settings and Help & Feedback, then the account row', async () => {
    const user = userEvent.setup();
    const signOut = renderFooter(person, '/action-requests');
    const pending = await screen.findByRole('link', { name: 'Pending actions, 3 waiting on you' });
    expect(pending).toHaveAttribute('href', '/action-requests');
    expect(pending).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Help & Feedback' })).toHaveAttribute('href', '/help');
    const account = screen.getByRole('group', { name: 'Signed in user' });
    expect(account).toHaveTextContent('AT');
    expect(account).toHaveTextContent('Alex Tester');
    expect(account).toHaveTextContent('Lab Technician');
    // Personal accounts carry no tag and no Switch user.
    expect(within(account).queryByText('Personal')).toBeNull();
    expect(within(account).queryByRole('button', { name: 'Switch user' })).toBeNull();
    await user.click(within(account).getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledWith();
  });

  it('Help & Feedback carries the page it was opened from, for the feedback form', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { status: 'ok', version: '0.1.0', database: 'up' })),
    );
    function HelpProbe() {
      const { state } = useLocation();
      return <p>from: {(state as { from?: string } | null)?.from ?? 'none'}</p>;
    }
    render(
      <SessionContext.Provider
        value={{ session: { status: 'active', me: person }, refresh: vi.fn(), signOut: vi.fn() }}
      >
        <MemoryRouter initialEntries={['/sample-storage/move']}>
          <Routes>
            <Route path="/help" element={<HelpProbe />} />
            <Route path="*" element={<SidebarFooter />} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    await user.click(screen.getByRole('link', { name: 'Help & Feedback' }));
    expect(await screen.findByText('from: /sample-storage/move')).toBeInTheDocument();
  });

  it('LAB has no Pending actions; Switch user signs out to the account picker', async () => {
    const user = userEvent.setup();
    const signOut = renderFooter({
      ...person,
      displayName: 'LAB',
      accountType: 'shared_lab',
      roles: [],
      permissions: ['inventory.read'],
    });
    expect(screen.queryByRole('link', { name: /^Pending actions/ })).toBeNull();
    expect(screen.getByText('Shared station')).toBeInTheDocument();
    expect(screen.getByText(/Session ends/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch user' }));
    expect(signOut).toHaveBeenCalledWith('/sign-in?switch=1');
  });
});
