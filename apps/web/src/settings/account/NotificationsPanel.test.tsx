import { DEFAULT_USER_PREFERENCES, type MeResponse } from '@materialmule/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import { NotificationsPanel } from './NotificationsPanel';

// STRATA-55 / STRATA-101: the bell count. Requests always count; Updates is the badgeUpdates
// preference. Nothing is emailed and the old email switch is gone. Fictional people only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_technician'],
  permissions: ['inventory.read', 'action_item.read'],
  sessionExpiresAt: '2026-11-12T23:00:00.000Z',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const prefsBody = (badgeUpdates: boolean, version: number) => ({
  preferences: { ...DEFAULT_USER_PREFERENCES, badgeUpdates },
  version,
  labTimeZone: 'America/Edmonton',
  readOnly: false,
});

function stub(handler: (url: string, method: string, body: unknown) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      return handler(url, method, body);
    }),
  );
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
      <NotificationsPanel />
    </SessionContext.Provider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Settings › Notifications (STRATA-101)', () => {
  it('locks Requests on, saves Updates as the badge preference, and says nothing is emailed', async () => {
    const calls = stub((url, method) =>
      method === 'PATCH' ? json(200, prefsBody(false, 2)) : json(200, prefsBody(true, 1)),
    );
    renderPanel();
    const user = userEvent.setup();

    const requests = await screen.findByRole('switch', { name: 'Requests, always on' });
    expect(requests).toBeChecked();
    expect(requests).toBeDisabled();
    expect(screen.getByText(/Always counted\./)).toBeInTheDocument();
    expect(screen.getByText('In the app only.')).toBeInTheDocument();
    expect(screen.queryByText(/email me/i)).not.toBeInTheDocument();

    const updates = screen.getByRole('switch', { name: 'Updates' });
    expect(updates).toBeChecked();
    await user.click(updates);
    expect(updates).not.toBeChecked();
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      url: '/api/me/preferences',
      body: { badgeUpdates: false, version: 1 },
    });
    expect(calls.some((c) => c.url.includes('notification-preferences'))).toBe(false);
  });

  it('LAB: a read-only note and no requests at all', () => {
    const calls = stub(() => json(404, {}));
    renderPanel(me({ id: 'lab', displayName: 'LAB', initials: null, accountType: 'shared_lab' }));

    expect(screen.getByText(/has no Inbox of its own/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});
