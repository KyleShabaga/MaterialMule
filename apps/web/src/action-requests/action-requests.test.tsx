import type { MeResponse } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';

// MM-T27 settings that outlive the Action requests page (now the Inbox, STRATA-24; its tests are
// notifications/InboxPage.test.tsx): LAB has no Inbox or preference card, and Settings ›
// Notifications has no Email me opt-in (MISC-11). Fictional data only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'action_item.read'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAt(
  path: string,
  user: MeResponse,
  api: (url: string, init?: RequestInit) => Response,
) {
  pickStationPerson(user);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    api(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('Action requests settings (MM-T27)', () => {
  it('LAB has no bell and no preference card', async () => {
    renderAt(
      '/settings/profile',
      me({ accountType: 'shared_lab', permissions: ['inventory.read'] }),
      (url) => {
        if (url.startsWith('/api/me/notification-preferences')) return json(403, {});
        if (url.startsWith('/api/me/profile')) {
          return json(200, {
            displayName: 'LAB',
            givenName: null,
            surname: null,
            workEmail: null,
            signInUsername: null,
            jobTitle: null,
            jobTitleOverride: null,
            effectiveJobTitle: null,
            department: null,
            officeLocation: null,
            officialInitials: 'LAB',
            initialsConfirmed: true,
            position: null,
            source: null,
            refreshedAt: null,
            refreshFailedAt: null,
            canRefresh: false,
          });
        }
        return json(404, {});
      },
    );
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Action requests/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Inbox' })).toBeNull();
    // The shell has no bell (the Settings nav's own Notifications section doesn't count).
    const bell = screen
      .queryAllByRole('link', { name: /^Notifications/, hidden: true })
      .filter((link) => !link.closest('[role="dialog"]'));
    expect(bell).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Notifications' })).toBeNull();
  });

  it('MISC-11: Settings › Notifications has no Email me opt-in', async () => {
    const fetchMock = renderAt('/settings/notifications', me(), (url, init) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      if (url.startsWith('/api/me/notification-preferences')) {
        return init?.method === 'PUT'
          ? json(200, {
              emailActionRequests: true,
              emailSendingEnabled: false,
              hasWorkEmail: true,
              version: 1,
            })
          : json(200, {
              emailActionRequests: false,
              emailSendingEnabled: false,
              hasWorkEmail: true,
              version: 0,
            });
      }
      if (url.startsWith('/api/me/profile')) {
        return json(200, {
          displayName: 'Pat Example',
          givenName: 'Pat',
          surname: 'Example',
          workEmail: 'pat@example.test',
          signInUsername: null,
          jobTitle: null,
          jobTitleOverride: null,
          effectiveJobTitle: null,
          department: null,
          officeLocation: null,
          officialInitials: 'PE',
          initialsConfirmed: true,
          position: 'engineer',
          source: 'seed',
          refreshedAt: null,
          refreshFailedAt: null,
          canRefresh: false,
        });
      }
      return json(404, {});
    });
    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByText(/Email me|switched off for everyone|work email/)).toBeNull();
    // UI only: nothing reads or writes the stored preference from this page any more.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('notification-preferences')),
    ).toBe(false);
  });
});
