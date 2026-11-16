import {
  DEFAULT_USER_PREFERENCES,
  type MeResponse,
  type UserPreferencesResponse,
} from '@materialmule/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import { PreferencesPanel } from './PreferencesPanel';
import { CONFLICT_MESSAGE, SAVE_FAILED_MESSAGE } from './preferences-api';

// STRATA-29 / STRATA-119: Preferences save as they change (optimistic, rolled back on failure,
// the server's value on a 409) and the shared LAB account never saves. Fictional people only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_technician'],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-11-12T23:00:00.000Z',
  ...overrides,
});

const saved = (
  overrides: Partial<UserPreferencesResponse['preferences']> = {},
  version = 3,
): UserPreferencesResponse => ({
  preferences: { ...DEFAULT_USER_PREFERENCES, ...overrides },
  version,
  labTimeZone: 'America/Edmonton',
  readOnly: false,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

function stubApi(routes: { get?: Handler; patch?: Handler }) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/me/preferences' && method === 'GET' && routes.get) return routes.get(init);
    if (url === '/api/me/preferences' && method === 'PATCH' && routes.patch) {
      return routes.patch(init);
    }
    return json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPanel(user = me()) {
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <PreferencesPanel />
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('Settings › Preferences (STRATA-29)', () => {
  it('shows every group with the saved values and the lab time zone', async () => {
    stubApi({ get: () => json(200, saved({ weekStartsMonday: true, afterReceipt: 'put_away' })) });
    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    for (const group of [
      'Inbox',
      'Privacy',
      'Receiving',
      'Dates and time',
      'Scanning',
      'Sidebar',
    ]) {
      expect(screen.getByRole('heading', { name: group })).toBeInTheDocument();
    }
    expect(screen.getByRole('switch', { name: 'Weeks start on Monday' })).toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Show my Inbox on shared LAB computers' }),
    ).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Go straight to Put away/ })).toBeChecked();
    expect(screen.getByText('America/Edmonton')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset sidebar layout' })).toBeEnabled();
  });

  it('saves a change at once, sending only that field with the version last read', async () => {
    let resolvePatch: (r: Response) => void = () => undefined;
    const calls = stubApi({
      get: () => json(200, saved()),
      patch: () => new Promise<Response>((resolve) => (resolvePatch = resolve)),
    });
    renderPanel();
    const user = userEvent.setup();

    const collapsed = await screen.findByRole('switch', {
      name: 'Start with the sidebar collapsed',
    });
    await user.click(collapsed);

    // Optimistic: on screen before the server answers.
    expect(collapsed).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      sidebarStartCollapsed: true,
      version: 3,
    });

    resolvePatch(json(200, saved({ sidebarStartCollapsed: true }, 4)));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
    expect(collapsed).toBeChecked();
  });

  it('puts the saved value back with a plain error when the save fails', async () => {
    stubApi({ get: () => json(200, saved()), patch: () => json(500, {}) });
    renderPanel();
    const user = userEvent.setup();

    const scan = await screen.findByRole('switch', { name: 'Open a scanned label’s record' });
    expect(scan).toBeChecked();
    await user.click(scan);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVE_FAILED_MESSAGE));
    expect(scan).toBeChecked();
  });

  it('takes the server’s current preferences on a 409 and uses its version next time', async () => {
    let patches = 0;
    const calls = stubApi({
      get: () => json(200, saved()),
      patch: () => {
        patches += 1;
        return patches === 1
          ? json(409, {
              code: 'version_conflict',
              current: saved({ openScannedRecord: true, weekStartsMonday: true }, 7),
            })
          : json(200, saved({ weekStartsMonday: false }, 8));
      },
    });
    renderPanel();
    const user = userEvent.setup();

    const scan = await screen.findByRole('switch', { name: 'Open a scanned label’s record' });
    await user.click(scan);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(CONFLICT_MESSAGE));
    // The change was not applied; the latest saved values are shown.
    expect(scan).toBeChecked();
    const week = screen.getByRole('switch', { name: 'Weeks start on Monday' });
    expect(week).toBeChecked();

    await user.click(week);
    await waitFor(() => expect(patches).toBe(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({
      weekStartsMonday: false,
      version: 7,
    });
  });

  it('shows the saved theme choice', async () => {
    stubApi({ get: () => json(200, saved()), patch: () => json(200, saved({ theme: 'dark' }, 4)) });
    renderPanel();
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveTextContent('Use system setting');
  });

  it('LAB: shows the defaults read-only, says why, and never asks or saves', async () => {
    const calls = stubApi({});
    renderPanel(me({ id: 'lab', displayName: 'LAB', initials: null, accountType: 'shared_lab' }));
    const user = userEvent.setup();

    expect(screen.getByText(/This is the shared LAB account/)).toBeInTheDocument();
    const collapsed = screen.getByRole('switch', { name: 'Start with the sidebar collapsed' });
    expect(collapsed).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Open a scanned label’s record' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Show the done page/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset sidebar layout' })).toBeDisabled();

    await user.click(collapsed);
    expect(calls).toEqual([]);
  });
});
