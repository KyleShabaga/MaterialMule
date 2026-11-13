import {
  REQUEST_TASK_LABELS,
  UPDATE_TASK_LABELS,
  requestTitle,
  type InboxItem,
  type InboxSummary,
  type MeResponse,
} from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { NOTIFICATIONS_CHANGED_EVENT } from './api';
import { useInboxUnreadCount } from './inbox-count';
import { bellBadgeText, inboxHeading } from './inbox-feed';
import { NotificationsBell } from './NotificationsBell';

// STRATA-13: the bell is a link to Inbox with a count badge and a hover preview; one shared
// unread count (lane 1C's badge-eligible count from GET /api/inbox/summary) drives the badge, the
// preview heading and the sidebar's Inbox badge. Fictional data only (DEMO-2601, LP-2026-0001,
// Pat Example, Sam Sample).

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'notification.read'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

const base = {
  sourceId: 'a-1',
  projectId: 'p1',
  jobNumber: 'DEMO-2601',
  record: null,
  from: { userId: 'u-sam', initials: 'SS', name: 'Sam Sample' },
  receivedAt: '2026-10-01T16:00:00.000Z',
  unread: true,
  domain: 'lab',
} as const;

const NEWEST: InboxItem[] = [
  {
    ...base,
    key: 'request:a-1',
    type: 'request',
    kind: 'closure_request',
    task: REQUEST_TASK_LABELS.closure_request,
    title: requestTitle({
      kind: 'closure_request',
      projectNumber: 'DEMO-2601',
      programNumber: 'LP-2026-0001',
    }),
    stage: 'due',
    href: '/action-requests',
    status: 'open',
    resolution: null,
    waitingOnMe: true,
    raisedByMe: false,
    reason: 'All tests reported.',
  },
  {
    ...base,
    key: 'update:n-2',
    sourceId: 'n-2',
    type: 'update',
    kind: 'action_request.decided',
    task: UPDATE_TASK_LABELS['action_request.decided'],
    title: requestTitle({
      kind: 'cancellation_request',
      projectNumber: 'DEMO-2601',
      programNumber: 'LP-2026-0002',
    }),
    stage: 'closed',
    href: '/lab-testing/programs/p2',
    dismissed: false,
    aboutMyRequest: true,
    linkedRequestStatus: 'resolved',
  },
  {
    ...base,
    key: 'update:n-3',
    sourceId: 'n-3',
    type: 'update',
    kind: 'concrete_test.failed',
    task: UPDATE_TASK_LABELS['concrete_test.failed'],
    title: 'Failed concrete test',
    stage: 'danger',
    domain: 'concrete',
    href: '/concrete',
    unread: false,
    dismissed: false,
    aboutMyRequest: false,
    linkedRequestStatus: null,
  },
];

const summary = (badge: number, preview: InboxItem[] = []): InboxSummary => ({
  counts: {
    badge,
    unread: badge,
    unreadRequests: badge,
    unreadUpdates: 0,
    openRequests: badge,
  },
  preview,
});

const SUMMARY = '/api/inbox/summary';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Shows the shared count the way the shell's sidebar badge reads it. */
function SidebarProbe() {
  const count = useInboxUnreadCount();
  return <output aria-label="Sidebar Inbox count">{count === null ? 'hidden' : count}</output>;
}

function renderBell(
  user: MeResponse,
  api: (url: string, init?: RequestInit) => Response | Promise<Response>,
  { probe = false }: { probe?: boolean } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    api(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  const element = (
    <>
      <NotificationsBell />
      {probe ? <SidebarProbe /> : null}
    </>
  );
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider
        router={createMemoryRouter([{ path: '*', element }], { initialEntries: ['/projects'] })}
      />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

function countCalls(fetchMock: ReturnType<typeof renderBell>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url) === SUMMARY).length;
}

afterEach(() => vi.unstubAllGlobals());

describe('bell badge text', () => {
  it('counts up to nine, then says 9+', () => {
    expect(bellBadgeText(1)).toBe('1');
    expect(bellBadgeText(9)).toBe('9');
    expect(bellBadgeText(10)).toBe('9+');
    expect(bellBadgeText(250)).toBe('9+');
  });

  it('heads the preview with the same count', () => {
    expect(inboxHeading(3)).toBe('Inbox · 3 unread');
    expect(inboxHeading(0)).toBe('Inbox');
    expect(inboxHeading(null)).toBe('Inbox');
  });
});

describe('NotificationsBell (STRATA-13)', () => {
  it('is a link to Inbox with a count badge', async () => {
    renderBell(me(), (url) => (url === SUMMARY ? json(200, summary(2)) : json(404, {})));
    const bell = await screen.findByRole('link', { name: 'Notifications, 2 unread' });
    expect(bell).toHaveAttribute('href', '/inbox');
    expect(bell.querySelector('[data-slot="bell-count"]')).toHaveTextContent('2');
  });

  it('shows 9+ past nine and no badge at zero', async () => {
    let unread = 12;
    renderBell(me(), (url) => (url === SUMMARY ? json(200, summary(unread)) : json(404, {})));
    const bell = await screen.findByRole('link', { name: 'Notifications, 12 unread' });
    expect(bell.querySelector('[data-slot="bell-count"]')).toHaveTextContent('9+');
    unread = 0;
    act(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)));
    const none = await screen.findByRole('link', { name: 'Notifications, none unread' });
    expect(none.querySelector('[data-slot="bell-count"]')).toBeNull();
  });

  it('shares one count fetch with the sidebar badge, and both follow a change', async () => {
    let unread = 4;
    const fetchMock = renderBell(
      me(),
      (url) => (url === SUMMARY ? json(200, summary(unread)) : json(404, {})),
      { probe: true },
    );
    expect(await screen.findByRole('link', { name: 'Notifications, 4 unread' })).toBeVisible();
    expect(screen.getByRole('status', { name: 'Sidebar Inbox count' })).toHaveTextContent('4');
    expect(countCalls(fetchMock)).toBe(1);

    unread = 1;
    act(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)));
    expect(await screen.findByRole('link', { name: 'Notifications, 1 unread' })).toBeVisible();
    expect(screen.getByRole('status', { name: 'Sidebar Inbox count' })).toHaveTextContent('1');
    expect(countCalls(fetchMock)).toBe(2);
  });

  it('keeps the count hidden on the shared LAB account and never asks for it', async () => {
    const fetchMock = renderBell(
      me({ accountType: 'shared_lab', permissions: ['inventory.read'] }),
      () => json(403, {}),
      { probe: true },
    );
    expect(screen.getByRole('status', { name: 'Sidebar Inbox count' })).toHaveTextContent('hidden');
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('previews the newest three on hover in Inbox words, then marks all read', async () => {
    let unread = 2;
    let items = NEWEST;
    const fetchMock = renderBell(me(), (url, init) => {
      if (url === SUMMARY) return json(200, summary(unread, items));
      if (url === '/api/inbox/read-all' && init?.method === 'POST') {
        unread = 0;
        items = [];
        return json(200, summary(0));
      }
      return json(404, {});
    });
    const bell = await screen.findByRole('link', { name: 'Notifications, 2 unread' });
    await userEvent.hover(bell);

    expect(await screen.findByText('Inbox · 2 unread')).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Newest in your Inbox' });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(3);
    // Request vs update from the item type, in the Inbox's Task words; unread rows say so.
    expect(rows[0]).toHaveTextContent(
      'RequestClose a programUnread: Closure requested for LP-2026-0001DEMO-2601',
    );
    expect(rows[0]).toHaveAttribute('href', '/action-requests');
    expect(rows[1]).toHaveTextContent(
      'Update:Your request was decidedUnread: Cancellation requested for LP-2026-0002',
    );
    expect(rows[1]).toHaveAttribute('href', '/lab-testing/programs/p2');
    expect(rows[2]).toHaveTextContent('Update:Failed testFailed concrete test');
    expect(rows[2]).not.toHaveTextContent('Unread');
    expect(screen.getByRole('link', { name: 'Open Inbox' })).toHaveAttribute('href', '/inbox');

    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByText('Nothing unread in your Inbox.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Notifications, none unread' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url),
    ).toEqual(['/api/inbox/read-all']);
  });

  it('says nothing is unread, and opens from the keyboard too', async () => {
    renderBell(me(), (url) => {
      if (url === SUMMARY) return json(200, summary(0));
      return json(404, {});
    });
    const bell = await screen.findByRole('link', { name: 'Notifications, none unread' });
    await userEvent.tab();
    expect(bell).toHaveFocus();

    expect(await screen.findByText('Nothing unread in your Inbox.')).toBeVisible();
    expect(screen.getByText('Inbox')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Inbox' })).toHaveAttribute('href', '/inbox');
  });

  it('closes the preview when the bell is clicked, until the pointer comes back', async () => {
    renderBell(me(), (url) => {
      if (url === SUMMARY) return json(200, summary(0));
      return json(404, {});
    });
    const bell = await screen.findByRole('link', { name: 'Notifications, none unread' });
    await userEvent.hover(bell);
    expect(await screen.findByLabelText('Inbox preview')).toBeVisible();

    // The Inbox opens; the preview would cover it.
    await userEvent.click(bell);
    await waitFor(() => expect(screen.queryByLabelText('Inbox preview')).toBeNull());

    await userEvent.unhover(bell);
    await userEvent.hover(bell);
    expect(await screen.findByLabelText('Inbox preview')).toBeVisible();
  });

  it('never opens the hover preview on a touch screen (no hover)', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(hover: none)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      renderBell(me(), (url) => (url === SUMMARY ? json(200, summary(2, NEWEST)) : json(404, {})));
      const bell = await screen.findByRole('link', { name: 'Notifications, 2 unread' });
      await userEvent.hover(bell);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(screen.queryByText('Inbox · 2 unread')).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });

  it('says so when the preview cannot load', async () => {
    // The count arrived; the preview's own read then fails.
    let calls = 0;
    renderBell(me(), (url) => {
      if (url === SUMMARY && (calls += 1) === 1) return json(200, summary(1));
      return json(500, {});
    });
    await userEvent.hover(await screen.findByRole('link', { name: 'Notifications, 1 unread' }));
    expect(
      await screen.findByText('Your Inbox couldn’t be loaded. Open Inbox to try again.'),
    ).toBeVisible();
  });
});
