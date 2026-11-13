import type { MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { SessionContext } from '../session/context';
import { RECORDING_PERSON_KEY } from '../session/recording-person-store';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { ServerHealth, SidebarFooter } from './SidebarFooter';

// MISC-09 server health in words; STRATA-15 account row and menu (Theme, Settings, Help,
// Feedback & bugs, Sign out; End station session on LAB). Fictional people only.

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
  window.sessionStorage.clear();
});

describe('ServerHealth', () => {
  it('says the server is connected, for screen readers only while all is well', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { status: 'ok', version: '0.1.0', database: 'up' })),
    );
    render(<ServerHealth />);
    expect(screen.getByText('Checking server…').closest('p')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    const line = (await screen.findByText('Server connected')).closest('p')!;
    expect(line).toHaveClass('sr-only');
  });

  it('shows when the database is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(503, { status: 'degraded', version: '0.1.0', database: 'down' })),
    );
    render(<ServerHealth />);
    const line = (await screen.findByText('Server connected, database unavailable')).closest('p');
    expect(line).not.toHaveClass('sr-only');
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

describe('SidebarFooter account menu', () => {
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
  const lab: MeResponse = {
    ...person,
    id: 'lab',
    displayName: 'LAB',
    accountType: 'shared_lab',
    roles: [],
    permissions: ['inventory.read'],
  };

  function HelpProbe() {
    const { state } = useLocation();
    return <p>help from: {(state as { from?: string } | null)?.from ?? 'none'}</p>;
  }

  function renderFooter(me: MeResponse, path = '/') {
    const signOut = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { status: 'ok', version: '0.1.0', database: 'up' })),
    );
    render(
      <SessionContext.Provider
        value={{ session: { status: 'active', me }, refresh: vi.fn(), signOut }}
      >
        <MemoryRouter initialEntries={[path]}>
          <SidebarProvider>
            <Routes>
              <Route path="/help" element={<HelpProbe />} />
              <Route path="/settings" element={<p>settings page</p>} />
              <Route path="*" element={<SidebarFooter />} />
            </Routes>
          </SidebarProvider>
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    return signOut;
  }

  it('shows initials, name and role, and opens Theme, Settings, Help, Feedback & bugs, Sign out', async () => {
    const user = userEvent.setup();
    const signOut = renderFooter(person);
    const account = screen.getByRole('group', { name: 'Signed in user' });
    expect(account).toHaveTextContent('AT');
    expect(account).toHaveTextContent('Alex Tester');
    expect(account).toHaveTextContent('Lab Technician');
    expect(within(account).queryByText('TEST')).toBeNull();
    const trigger = within(account).getByRole('button', {
      name: 'Alex Tester, Lab Technician. Account menu',
    });
    // No session end time anywhere (D38 is deferred).
    expect(account).not.toHaveTextContent(/Session ends/);

    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(
      Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((item) => item.textContent),
    ).toEqual(['Light', 'Dark', 'System', 'Settings', 'Help', 'Feedback & bugs', 'Sign out']);
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    await user.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledWith();
  });

  it('Light / Dark / System sets the theme at once, remembers it, and System clears it', async () => {
    const user = userEvent.setup();
    renderFooter(person);
    const trigger = screen.getByRole('button', { name: /Account menu/ });
    await user.click(trigger);
    expect(await screen.findByRole('menuitemradio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    // The menu stays open, so the change can be seen and undone.
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('Help and Feedback & bugs carry the page they were opened from', async () => {
    const user = userEvent.setup();
    renderFooter(person, '/sample-storage/move');
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Feedback & bugs' }));
    expect(await screen.findByText('help from: /sample-storage/move')).toBeInTheDocument();
  });

  it('a TEST account carries its tag', () => {
    renderFooter({ ...person, accountType: 'test' });
    expect(screen.getByRole('group', { name: 'Signed in user' })).toHaveTextContent('TEST');
  });

  it('LAB reads as the station; End station session forgets the person, then signs out', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(RECORDING_PERSON_KEY, '{"id":"p1"}');
    const signOut = renderFooter(lab);
    const account = screen.getByRole('group', { name: 'Signed in user' });
    expect(account).toHaveTextContent('LAB station');
    expect(account).toHaveTextContent('Shared · Receiving lab');
    await user.click(within(account).getByRole('button', { name: /Account menu/ }));
    const menu = await screen.findByRole('menu');
    expect(
      Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((item) => item.textContent),
    ).toEqual(['Settings', 'Help', 'Feedback & bugs', 'End station session']);
    await user.click(within(menu).getByRole('menuitem', { name: 'End station session' }));
    expect(window.sessionStorage.getItem(RECORDING_PERSON_KEY)).toBeNull();
    expect(signOut).toHaveBeenCalledWith();
  });
});
