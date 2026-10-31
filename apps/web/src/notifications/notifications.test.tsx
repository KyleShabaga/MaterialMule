import type { MeResponse, Notification } from '@materialmule/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { NOTIFICATIONS_CHANGED_EVENT } from './api';

// MM-T91 UI: the header Notifications control beside Pending actions (separate labels and
// counts), the notification center (filters, live request status, read/dismiss/restore/mark all
// read) and LAB without either. Fictional data only (DEMO-2601, LP-2026-0001).

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

const note = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'n-1',
  kind: 'action_request.opened',
  title: 'Closure requested for LP-2026-0001',
  projectId: 'p1',
  projectNumber: 'DEMO-2601',
  href: '/action-requests',
  createdAt: '2026-10-01T16:00:00.000Z',
  readAt: null,
  dismissedAt: null,
  linkedRequest: {
    id: 'ai-1',
    kind: 'closure_request',
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    stillYours: true,
  },
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

function posts(fetchMock: ReturnType<typeof renderAt>): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url]) => String(url));
}

/** Records every NOTIFICATIONS_CHANGED_EVENT fired during the test. */
function listenForChanges() {
  const seen = vi.fn();
  window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, seen);
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('Header controls (MM-T91)', () => {
  it('AC10: Notifications and Pending actions are separate controls with their own counts', async () => {
    renderAt('/projects', me(), (url) => {
      if (url.startsWith('/api/notifications/count')) return json(200, { unread: 3 });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 2 });
      if (url.startsWith('/api/projects')) return json(200, { items: [] });
      return json(404, {});
    });
    const notifications = await screen.findByRole('link', { name: 'Notifications, 3 unread' });
    const pending = await screen.findByRole('button', {
      name: 'Pending actions, 2 waiting on you',
    });
    expect(notifications).toHaveAttribute('href', '/notifications');
    expect(notifications).toHaveTextContent('3');
    expect(pending).toHaveTextContent('2');
    // Never added together.
    expect(screen.queryByText('5')).toBeNull();
    // Both sit to the right of the user area.
    const identity = screen.getByLabelText('Signed in user');
    expect(identity.nextElementSibling).toContainElement(notifications);
    expect(identity.nextElementSibling).toContainElement(pending);
  });

  it('says none unread at 0 and refreshes when notifications change', async () => {
    let unread = 0;
    renderAt('/projects', me(), (url) => {
      if (url.startsWith('/api/notifications/count')) return json(200, { unread });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/projects')) return json(200, { items: [] });
      return json(404, {});
    });
    const link = await screen.findByRole('link', { name: 'Notifications, none unread' });
    expect(link.querySelector('.action-bell-count')).toBeNull();
    unread = 4;
    act(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)));
    expect(await screen.findByRole('link', { name: 'Notifications, 4 unread' })).toBeVisible();
    // The pending count is its own.
    expect(screen.getByRole('button', { name: 'Pending actions, 1 waiting on you' })).toBeVisible();
  });

  it('shows each control only with its own permission', async () => {
    renderAt('/projects', me({ permissions: ['inventory.read', 'action_item.read'] }), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/projects')) return json(200, { items: [] });
      return json(404, {});
    });
    expect(
      await screen.findByRole('button', { name: 'Pending actions, 1 waiting on you' }),
    ).toBeVisible();
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
    expect(screen.queryByRole('button', { name: /^Pending actions/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/notifications'))).toBe(
      false,
    );
  });
});

describe('Notification center (MM-T91)', () => {
  it('shows what happened and the request’s live status in each case', async () => {
    renderAt('/notifications', me(), (url) => {
      if (url.startsWith('/api/notifications/count')) return json(200, { unread: 1 });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/notifications?filter=active')) {
        return json(200, {
          items: [
            note({ id: 'n-yours', title: 'Closure requested for LP-2026-0001' }),
            note({
              id: 'n-moved',
              title: 'Cancellation requested for LP-2026-0002',
              readAt: '2026-10-02T16:00:00.000Z',
              linkedRequest: { ...note().linkedRequest!, id: 'ai-2', stillYours: false },
            }),
            note({
              id: 'n-done',
              kind: 'action_request.decided',
              title: 'Closure requested for LP-2026-0003',
              readAt: '2026-10-02T16:00:00.000Z',
              linkedRequest: {
                ...note().linkedRequest!,
                id: 'ai-3',
                status: 'resolved',
                resolution: 'closed',
                resolvedBy: { userId: 'u-lm', initials: 'LM', name: 'Lee Manager' },
                resolvedAt: '2026-10-03T16:00:00.000Z',
                stillYours: false,
              },
            }),
            note({ id: 'n-none', title: 'Older notice', linkedRequest: null, projectNumber: null }),
          ],
        });
      }
      return json(404, {});
    });
    const yours = await screen.findByRole('listitem', {
      name: 'Closure requested for LP-2026-0001',
    });
    expect(yours).toHaveTextContent(
      'Unread Sent to you for action: Closure requested for LP-2026-0001',
    );
    expect(yours).toHaveTextContent('DEMO-2601');
    expect(yours).toHaveTextContent('Request status: Pending — waiting on you');
    expect(within(yours).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/action-requests',
    );
    expect(within(yours).getByRole('button', { name: 'Mark read' })).toBeVisible();

    const moved = screen.getByRole('listitem', { name: 'Cancellation requested for LP-2026-0002' });
    expect(moved).toHaveTextContent('No longer waiting on you');
    expect(moved).not.toHaveTextContent('Unread');
    expect(within(moved).queryByRole('button', { name: 'Mark read' })).toBeNull();

    const done = screen.getByRole('listitem', { name: 'Closure requested for LP-2026-0003' });
    expect(done).toHaveTextContent('Your request was decided: Closure requested for LP-2026-0003');
    expect(done).toHaveTextContent('Resolved by Lee Manager · Program closed');
    expect(done).not.toHaveTextContent('waiting on you');

    const none = screen.getByRole('listitem', { name: 'Older notice' });
    expect(none).not.toHaveTextContent('Request status');

    // Nothing on the page approves or resolves a request.
    expect(screen.queryByRole('button', { name: /approve|resolve|close/i })).toBeNull();
  });

  it('mark read, dismiss, restore and mark all read call their endpoints and announce it', async () => {
    const user = userEvent.setup();
    const changes = listenForChanges();
    const fetchMock = renderAt('/notifications', me(), (url, init) => {
      if (init?.method === 'POST') return json(200, { unread: 0 });
      if (url.startsWith('/api/notifications/count')) return json(200, { unread: 2 });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/notifications?filter=all')) {
        return json(200, {
          items: [
            note({
              id: 'n-hidden',
              title: 'Dismissed earlier',
              readAt: '2026-10-02T16:00:00.000Z',
              dismissedAt: '2026-10-02T16:00:00.000Z',
            }),
          ],
        });
      }
      if (url.startsWith('/api/notifications?filter=')) {
        return json(200, {
          items: [
            note({ id: 'n-1', title: 'First request' }),
            note({ id: 'n-2', title: 'Second request' }),
            note({ id: 'n-3', title: 'Third request' }),
          ],
        });
      }
      return json(404, {});
    });

    const first = await screen.findByRole('listitem', { name: 'First request' });
    await user.click(within(first).getByRole('button', { name: 'Mark read' }));
    expect(posts(fetchMock)).toEqual(['/api/notifications/n-1/read']);
    expect(changes).toHaveBeenCalledTimes(1);
    // Read is not resolved: the request still waits on you.
    expect(first).not.toHaveTextContent('Unread');
    expect(first).toHaveTextContent('Pending — waiting on you');
    expect(within(first).queryByRole('button', { name: 'Mark read' })).toBeNull();

    const second = screen.getByRole('listitem', { name: 'Second request' });
    await user.click(within(second).getByRole('button', { name: 'Dismiss' }));
    expect(posts(fetchMock)).toContain('/api/notifications/n-2/dismiss');
    expect(screen.queryByRole('listitem', { name: 'Second request' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Notification dismissed.');

    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(posts(fetchMock)).toContain('/api/notifications/read-all');
    expect(screen.getByRole('listitem', { name: 'Third request' })).not.toHaveTextContent('Unread');
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'All' }));
    const hidden = await screen.findByRole('listitem', { name: 'Dismissed earlier' });
    expect(hidden).toHaveTextContent('Dismissed');
    await user.click(within(hidden).getByRole('button', { name: 'Restore' }));
    expect(posts(fetchMock)).toContain('/api/notifications/n-hidden/restore');
    expect(within(hidden).getByRole('button', { name: 'Dismiss' })).toBeVisible();
    expect(changes).toHaveBeenCalledTimes(4);

    // Only notification endpoints were ever written to.
    expect(posts(fetchMock).every((url) => url.startsWith('/api/notifications/'))).toBe(true);
  });

  it('the Unread filter asks for unread rows and a read row leaves it', async () => {
    const user = userEvent.setup();
    const fetchMock = renderAt('/notifications', me(), (url, init) => {
      if (init?.method === 'POST') return json(200, { unread: 0 });
      if (url.startsWith('/api/notifications/count')) return json(200, { unread: 1 });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/notifications?filter=')) {
        return json(200, { items: [note({ title: 'Only request' })] });
      }
      return json(404, {});
    });
    await screen.findByRole('listitem', { name: 'Only request' });
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Unread' }));
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    const row = await screen.findByRole('listitem', { name: 'Only request' });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/notifications?filter=unread'),
    ).toBe(true);
    await user.click(within(row).getByRole('button', { name: 'Mark read' }));
    expect(screen.queryByRole('listitem', { name: 'Only request' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Notification marked read.');
    expect(screen.getByRole('status')).toHaveFocus();
  });

  it('Open marks the notification read and goes to the item without resolving it', async () => {
    const user = userEvent.setup();
    const changes = listenForChanges();
    const fetchMock = renderAt('/notifications', me(), (url, init) => {
      if (init?.method === 'POST') return json(200, { unread: 0 });
      if (url.startsWith('/api/notifications/count')) return json(200, { unread: 1 });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
      if (url.startsWith('/api/notifications?filter=')) return json(200, { items: [note()] });
      if (url.startsWith('/api/action-items?')) return json(200, { items: [] });
      return json(404, {});
    });
    const row = await screen.findByRole('listitem', { name: 'Closure requested for LP-2026-0001' });
    await user.click(within(row).getByRole('link', { name: 'Open' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Action requests' })).toBeVisible();
    await vi.waitFor(() => expect(changes).toHaveBeenCalled());
    expect(posts(fetchMock)).toEqual(['/api/notifications/n-1/read']);
  });

  it('says so when the list fails, and Retry reloads it', async () => {
    const user = userEvent.setup();
    let fail = true;
    renderAt('/notifications', me(), (url) => {
      if (url.startsWith('/api/notifications/count')) return json(200, { unread: 0 });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      if (url.startsWith('/api/notifications?filter=')) {
        return fail ? json(500, {}) : json(200, { items: [] });
      }
      return json(404, {});
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Notifications couldn’t load.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No notifications.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('a refused list says it is for personal accounts, with no Retry', async () => {
    renderAt('/notifications', me(), (url) => {
      if (url.startsWith('/api/notifications?filter=')) return json(403, { code: 'forbidden' });
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      return json(403, {});
    });
    expect(
      await screen.findByText(
        'Notifications are for personal accounts. Sign in with your own account.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('LAB gets a plain refusal without asking the server', async () => {
    const fetchMock = renderAt(
      '/notifications',
      me({ accountType: 'shared_lab', permissions: ['inventory.read'] }),
      () => json(403, {}),
    );
    expect(
      await screen.findByText(
        'Notifications are for personal accounts. Sign in with your own account.',
      ),
    ).toBeVisible();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/notifications'))).toBe(
      false,
    );
  });
});
