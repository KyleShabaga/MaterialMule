import type { MeResponse } from '@materialmule/shared';
import { act, render, screen, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { NOTIFICATIONS_CHANGED_EVENT } from './api';

// MM-T91 header controls with the single Inbox (STRATA-24): the bell (top bar) and the sidebar's
// Inbox row both open /inbox; the old Action requests sub-row is gone; LAB has neither. The Inbox
// page itself is tested in InboxPage.test.tsx. Fictional data only (DEMO-2601).

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'action_item.read', 'notification.read'],
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
  api: (url: string, init?: RequestInit) => Response | Promise<Response>,
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

/** GET /api/inbox/summary with `badge` unread (lane 1C's one count the bell shows). */
const inboxSummary = (badge: number) => ({
  counts: { badge, unread: badge, unreadRequests: 0, unreadUpdates: badge, openRequests: 0 },
  preview: [],
});

describe('Header controls (MM-T91)', () => {
  it('AC10: the bell and the sidebar Inbox row both open /inbox; there is no Action requests row', async () => {
    renderAt('/projects', me(), (url) => {
      if (url.startsWith('/api/inbox/summary')) return json(200, inboxSummary(3));
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 2 });
      if (url.startsWith('/api/projects')) return json(200, { items: [] });
      return json(404, {});
    });
    const notifications = await screen.findByRole('link', { name: 'Notifications, 3 unread' });
    const inbox = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: 'Inbox',
    });
    expect(notifications).toHaveAttribute('href', '/inbox');
    expect(notifications).toHaveTextContent('3');
    expect(inbox).toHaveAttribute('href', '/inbox');
    expect(screen.queryByRole('link', { name: 'Action requests' })).toBeNull();
    // The pending-actions count is never added to the Inbox count.
    expect(screen.queryByText('5')).toBeNull();
    expect(screen.getByRole('banner')).toContainElement(notifications);
  });

  it('says none unread at 0 and refreshes when notifications change', async () => {
    let unread = 0;
    renderAt('/projects', me(), (url) => {
      if (url.startsWith('/api/inbox/summary')) return json(200, inboxSummary(unread));
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/projects')) return json(200, { items: [] });
      return json(404, {});
    });
    const link = await screen.findByRole('link', { name: 'Notifications, none unread' });
    expect(link.querySelector('[data-slot="bell-count"]')).toBeNull();
    unread = 4;
    act(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)));
    expect(await screen.findByRole('link', { name: 'Notifications, 4 unread' })).toBeVisible();
    // No Action requests row any more; its requests are in the Inbox.
    expect(screen.queryByRole('link', { name: 'Action requests' })).toBeNull();
  });

  it('shows each control only with its own permission', async () => {
    renderAt('/projects', me({ permissions: ['inventory.read', 'action_item.read'] }), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/projects')) return json(200, { items: [] });
      return json(404, {});
    });
    // Without notification.read the Inbox row still opens /inbox, and there is no bell.
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/inbox');
    expect(screen.queryByRole('link', { name: /^Notifications/ })).toBeNull();
  });

  it('LAB sees neither control and never asks for notifications', async () => {
    const fetchMock = renderAt(
      '/projects',
      me({ accountType: 'shared_lab', permissions: ['inventory.read'] }),
      (url) => {
        if (url.startsWith('/api/projects')) return json(200, { items: [] });
        return json(403, {});
      },
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /^Notifications/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Action requests/ })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) => /^\/api\/(notifications|inbox)/.test(String(url))),
    ).toBe(false);
  });
});
