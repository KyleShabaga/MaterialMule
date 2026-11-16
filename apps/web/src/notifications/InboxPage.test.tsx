import {
  DEFAULT_USER_PREFERENCES,
  REQUEST_TASK_LABELS,
  UPDATE_TASK_LABELS,
  requestTitle,
  type InboxItem,
  type InboxPage,
  type MeResponse,
  type UserPreferences,
} from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { StrataToaster } from '../components/strata/toast';
import { pickStationPerson } from '../session/station-test-person';
import { forgetInboxItems } from './inbox-api';
import { dayHeading, groupedSections, inboxSort, streamSections } from './inbox-model';

// STRATA-24, 26, 64, 48: the Inbox page. Tabs with counts, the table tools, three views, the drawer
// (URL ?open=, K/J, marking read), request vs update never by colour alone, empty and error
// states, the Table view's columns with the drawer open, and checked rows. Fictional data only
// (DEMO-2601, LP-2026-0001, Pat Example, Sam Sample, Alex Tester).

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'action_item.read', 'notification.read'],
  sessionExpiresAt: '2030-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const CLOSURE_TITLE = requestTitle({
  kind: 'closure_request',
  projectNumber: 'DEMO-2601',
  programNumber: 'LP-2026-0001',
});

const REQUEST: InboxItem = {
  key: 'request:a-1',
  sourceId: 'a-1',
  type: 'request',
  kind: 'closure_request',
  task: REQUEST_TASK_LABELS.closure_request,
  title: CLOSURE_TITLE,
  projectId: 'p1',
  jobNumber: 'DEMO-2601',
  record: { kind: 'lab_program', id: 'lp1', label: 'LP-2026-0001' },
  from: { userId: 'u-sam', initials: 'SS', name: 'Sam Sample' },
  receivedAt: minutesAgo(3),
  unread: true,
  stage: 'due',
  domain: 'lab',
  href: '/lab-testing/programs/lp1',
  status: 'open',
  resolution: null,
  resolvedBy: null,
  waitingOnMe: true,
  raisedByMe: false,
  reason: 'All tests reported.',
};

const UPDATE: InboxItem = {
  key: 'update:n-2',
  sourceId: 'n-2',
  type: 'update',
  kind: 'action_request.decided',
  task: UPDATE_TASK_LABELS['action_request.decided'],
  title: 'Hold requested for DEMO-2601 · whole project',
  projectId: 'p1',
  jobNumber: 'DEMO-2601',
  record: { kind: 'project', id: 'p1', label: 'DEMO-2601' },
  from: { userId: 'u-pe2', initials: 'AT', name: 'Alex Tester' },
  // Newer than the request: on the same day, requests still come first.
  receivedAt: minutesAgo(1),
  unread: false,
  stage: 'closed',
  domain: 'project',
  href: '/projects/p1/retention',
  dismissed: false,
  aboutMyRequest: true,
  linkedRequestStatus: 'resolved',
  linkedResolution: 'approved',
};

const summary = (unread = 1) => ({
  counts: { badge: unread, unread, unreadRequests: unread, unreadUpdates: 0, openRequests: 1 },
  preview: [],
});

function page(items: InboxItem[], overrides: Partial<InboxPage> = {}): InboxPage {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
    tabCounts: { all: 2, requests: 1, updates: 1, done: 4 },
    summary: summary(),
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Api = (url: string, init?: RequestInit) => Response | undefined;

function prefsBody(change: Partial<UserPreferences> = {}) {
  return {
    preferences: { ...DEFAULT_USER_PREFERENCES, ...change },
    version: 1,
    labTimeZone: 'America/Edmonton',
    readOnly: false,
  };
}

/** Renders the app at `path` with a fetch that answers `api` first, then sensible defaults. */
function renderAt(path: string, api: Api = () => undefined, user: MeResponse = me()) {
  pickStationPerson(user);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const answer = api(url, init);
    if (answer) return answer;
    if (url.startsWith('/api/inbox/summary')) return json(200, summary());
    if (url.startsWith('/api/inbox?')) return json(200, page([REQUEST, UPDATE]));
    if (url.startsWith('/api/me/preferences')) {
      return init?.method === 'PATCH'
        ? json(200, {
            ...prefsBody(JSON.parse(String(init.body)) as Partial<UserPreferences>),
            version: 2,
          })
        : json(200, prefsBody());
    }
    if (url.startsWith('/api/me/table-columns')) {
      return json(200, { tables: { inbox: { hidden: [] } }, version: 0, readOnly: false });
    }
    if (url.startsWith('/api/inbox/requests/')) return json(200, summary(0));
    if (url.startsWith('/api/notifications/')) return json(200, { unread: 0 });
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
      <StrataToaster />
    </SessionContext.Provider>,
  );
  return { fetchMock, router };
}

function calls(fetchMock: ReturnType<typeof vi.fn>, method = 'GET'): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method)
    .map(([url]) => String(url));
}

/** The drawer exists from 1024 px; jsdom has no matchMedia, so tests opt in. */
function screenWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: wide && query === '(min-width: 1024px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

const list = () => screen.getByRole('region', { name: 'Today' });

beforeEach(() => {
  forgetInboxItems();
  screenWidth(true);
});

afterEach(() => vi.unstubAllGlobals());

describe('Inbox rules (inbox-model)', () => {
  it('maps the URL sort to the server sort; Received ascending is oldest first', () => {
    expect(inboxSort(null)).toBe('newest');
    expect(inboxSort({ key: 'received', dir: 'asc' })).toBe('oldest');
    expect(inboxSort({ key: 'received', dir: 'desc' })).toBe('newest');
    expect(inboxSort({ key: 'requests_first', dir: 'asc' })).toBe('requests_first');
    expect(inboxSort({ key: 'job_number', dir: 'desc' })).toBe('job_number_desc');
    expect(inboxSort({ key: 'nonsense', dir: 'asc' })).toBe('newest');
  });

  it('names days Today, then weekdays, then the date', () => {
    const now = new Date('2026-11-13T18:00:00Z');
    expect(dayHeading('2026-11-13T17:00:00Z', now)).toBe('Today');
    expect(dayHeading('2026-11-11T18:00:00Z', now)).toBe('Wednesday');
    expect(dayHeading('2026-10-01T18:00:00Z', now)).toBe('2026-10-01');
  });

  it('puts requests above updates on the same day, and groups needs action first', () => {
    const sections = streamSections([UPDATE, REQUEST], 'newest', new Date());
    expect(sections).toHaveLength(1);
    expect(sections[0]!.items.map((i) => i.key)).toEqual(['request:a-1', 'update:n-2']);
    expect(groupedSections([UPDATE, REQUEST], 'all').map((s) => s.heading)).toEqual([
      'Needs action · 1',
      'Updates · 1',
    ]);
  });
});

describe('Inbox page (STRATA-24)', () => {
  it('lists requests and updates told apart without colour, with tab counts', async () => {
    renderAt('/inbox');
    const today = await screen.findByRole('list', { name: 'Today' });
    const rows = within(today).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      CLOSURE_TITLE,
      UPDATE.title,
    ]);
    // Request: the filled pill and its kind; unread: sr-only "Unread" and a bold title.
    expect(within(rows[0]!).getByText('Request')).toBeVisible();
    expect(within(rows[0]!).getByText('Close a program')).toBeVisible();
    expect(within(rows[0]!).getByText('Unread:')).toHaveClass('sr-only');
    expect(within(rows[0]!).getByText(CLOSURE_TITLE)).toHaveClass('font-semibold');
    // Update: no pill, "Update" for screen readers, its kind.
    expect(within(rows[1]!).queryByText('Request')).toBeNull();
    expect(within(rows[1]!).getByText('Update:')).toHaveClass('sr-only');
    expect(within(rows[1]!).getByText('Your request was decided')).toBeVisible();
    expect(within(rows[1]!).queryByText('Unread:')).toBeNull();
    // Tabs with counts.
    const tabs = screen.getByRole('tablist', { name: 'Inbox' });
    expect(within(tabs).getByRole('tab', { name: /^All\s*2$/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: /^Done\s*4$/ })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
    expect(list()).toBeInTheDocument();
  });

  it('a tab asks the server for that tab; empty Requests and Updates say so', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt('/inbox', (url) =>
      /tab=(requests|updates)/.test(url)
        ? json(200, page([], { tabCounts: { all: 2, requests: 0, updates: 0, done: 4 } }))
        : undefined,
    );
    await screen.findByRole('list', { name: 'Today' });
    await user.click(screen.getByRole('tab', { name: /^Requests/ }));
    expect(await screen.findByText('Nothing is waiting on you.')).toBeVisible();
    expect(calls(fetchMock).some((url) => url.includes('tab=requests'))).toBe(true);
    await user.click(screen.getByRole('tab', { name: /^Updates/ }));
    expect(await screen.findByText('You have read every notification.')).toBeVisible();
  });

  it('a load error shows a red alert, and Try again asks again', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { fetchMock } = renderAt('/inbox', (url) =>
      url.startsWith('/api/inbox?') && fail ? json(500, {}) : undefined,
    );
    expect(await screen.findByText('Inbox couldn’t load')).toBeVisible();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Today' })).toBeVisible();
    expect(calls(fetchMock).filter((url) => url.startsWith('/api/inbox?'))).toHaveLength(2);
  });

  it('opens a request in the drawer, marks it read, and never resolves it', async () => {
    const user = userEvent.setup();
    const { fetchMock, router } = renderAt('/inbox');
    await screen.findByRole('list', { name: 'Today' });
    await user.click(
      within(screen.getByRole('listitem', { name: CLOSURE_TITLE })).getByRole('button'),
    );
    expect(router.state.location.search).toContain('open=request%3Aa-1');
    const drawer = await screen.findByRole('region', { name: CLOSURE_TITLE });
    expect(
      within(drawer).getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          /^From Sam Sample · .+ · waiting on you$/.test(el.textContent ?? ''),
      ),
    ).toBeVisible();
    expect(within(drawer).getByRole('link', { name: 'Review the closure' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/lp1',
    );
    expect(
      within(drawer).getByText('This request closes on its own when the program is closed.'),
    ).toBeVisible();
    expect(within(drawer).getByText('LP-2026-0001')).toHaveClass('font-mono');
    expect(within(drawer).getByText('1 of 2')).toBeVisible();
    await waitFor(() => expect(calls(fetchMock, 'POST')).toContain('/api/inbox/requests/a-1/read'));
    expect(
      within(drawer).queryByRole('button', { name: /approve|resolve|close program/i }),
    ).toBeNull();

    // Mark unread puts it back; opening again doesn't undo that.
    await user.click(await within(drawer).findByRole('button', { name: 'Mark unread' }));
    await waitFor(() =>
      expect(calls(fetchMock, 'POST')).toContain('/api/inbox/requests/a-1/unread'),
    );
    expect(calls(fetchMock, 'POST').filter((u) => u.endsWith('/a-1/read'))).toHaveLength(1);

    // Close (Esc) removes ?open= and the drawer.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.search).not.toContain('open='));
    expect(screen.queryByRole('region', { name: CLOSURE_TITLE })).toBeNull();
  });

  it('J and K move through the shown order; the update drawer marks read, dismisses and restores', async () => {
    const user = userEvent.setup();
    const unreadUpdate = { ...UPDATE, unread: true } as InboxItem;
    const { fetchMock, router } = renderAt('/inbox?open=request%3Aa-1', (url) =>
      url.startsWith('/api/inbox?') ? json(200, page([REQUEST, unreadUpdate])) : undefined,
    );
    await screen.findByRole('region', { name: CLOSURE_TITLE });
    await user.keyboard('j');
    await waitFor(() => expect(router.state.location.search).toContain('open=update%3An-2'));
    const drawer = await screen.findByRole('region', { name: UPDATE.title });
    expect(within(drawer).getByText('2 of 2')).toBeVisible();
    expect(within(drawer).getByText('Resolved by Alex Tester · Approved')).toBeVisible();
    expect(within(drawer).getByRole('link', { name: 'Open the project' })).toHaveAttribute(
      'href',
      '/projects/p1/retention',
    );
    await waitFor(() => expect(calls(fetchMock, 'POST')).toContain('/api/notifications/n-2/read'));
    await user.click(within(drawer).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(calls(fetchMock, 'POST')).toContain('/api/notifications/n-2/dismiss'),
    );
    await user.click(await within(drawer).findByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(calls(fetchMock, 'POST')).toContain('/api/notifications/n-2/restore'),
    );
    await user.keyboard('k');
    await waitFor(() => expect(router.state.location.search).toContain('open=request%3Aa-1'));
  });

  it('Grouped shows Needs action then Updates', async () => {
    renderAt('/inbox?view=grouped');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Needs action · 1' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Updates · 1' })).toBeVisible();
  });

  it('the view starts from the person’s preference, and changing it saves it', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt('/inbox', (url, init) =>
      url.startsWith('/api/me/preferences') && init?.method !== 'PATCH'
        ? json(200, prefsBody({ inboxView: 'table' }))
        : undefined,
    );
    expect(await screen.findByRole('table', { name: 'Inbox' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'View, Table' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'One stream' }));
    expect(await screen.findByRole('list', { name: 'Today' })).toBeVisible();
    const patch = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/api/me/preferences' && init?.method === 'PATCH',
    );
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ inboxView: 'stream', version: 1 });
  });

  it('Table: headings sort, and with the drawer open only the kind, Title and Job number stay', async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/inbox?view=table');
    const table = await screen.findByRole('table', { name: 'Inbox' });
    const headers = () =>
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent);
    expect(headers()).toEqual(
      expect.arrayContaining(['Task', 'Title', 'Job number', 'Record', 'From', 'Received']),
    );
    await user.click(within(table).getByRole('button', { name: 'Received' }));
    expect(router.state.location.search).toContain('sort=received');
    expect(router.state.location.search).toContain('dir=asc');

    await user.click(within(table).getByText(CLOSURE_TITLE));
    await screen.findByRole('region', { name: CLOSURE_TITLE });
    const open = screen.getByRole('table', { name: 'Inbox' });
    const names = within(open)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    for (const gone of ['Task', 'Record', 'From', 'Received']) expect(names).not.toContain(gone);
    expect(names).toEqual(expect.arrayContaining(['Title', 'Job number']));
    // Task folds into the kind icon; Job number hides below a 30rem list.
    expect(within(open).getAllByText('Request · Close a program')[0]).toHaveClass('sr-only');
    expect(within(open).getByRole('columnheader', { name: /Job number/ }).className).toContain(
      '@max-[30rem]/table:hidden',
    );
  });

  it('Columns hides Record and saves it; Task, Title and Job number are always shown', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt('/inbox?view=table', (url, init) =>
      url === '/api/me/table-columns/inbox' && init?.method === 'PUT'
        ? json(200, { tables: { inbox: { hidden: ['record'] } }, version: 1, readOnly: false })
        : undefined,
    );
    const table = await screen.findByRole('table', { name: 'Inbox' });
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Task, always shown' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() =>
      expect(within(menu).getByRole('menuitemcheckbox', { name: 'Record' })).not.toHaveAttribute(
        'aria-disabled',
      ),
    );
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Record' }));
    await waitFor(() =>
      expect(within(table).queryByRole('columnheader', { name: /Record/ })).toBeNull(),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ hidden: ['record'], version: 0 });
  });

  it('checked rows: Mark read in bulk; Dismiss only when every checked row is an update', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt('/inbox?view=table', (url) =>
      url === '/api/inbox/bulk'
        ? json(200, { updated: 1, failed: ['request:a-1'], summary: summary(0) })
        : undefined,
    );
    const table = await screen.findByRole('table', { name: 'Inbox' });
    await user.click(within(table).getByRole('checkbox', { name: `Select ${CLOSURE_TITLE}` }));
    const bar = screen.getByRole('toolbar', { name: 'Checked rows' });
    expect(within(bar).getByText('1 checked')).toBeVisible();
    // Only requests: Mark unread yes, Dismiss no.
    expect(within(bar).getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: 'Mark unread' })).toBeEnabled();
    await user.click(within(table).getByRole('checkbox', { name: `Select ${UPDATE.title}` }));
    // Mixed: neither, each with its reason; Mark read always.
    expect(within(bar).getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: 'Mark unread' })).toBeDisabled();
    expect(within(bar).getByText('Updates stay read once opened.')).toBeVisible();
    expect(within(bar).getByRole('button', { name: 'Mark read' })).toBeEnabled();
    await user.click(within(table).getByRole('checkbox', { name: `Select ${CLOSURE_TITLE}` }));
    // Only updates: Dismiss yes, Mark unread no.
    expect(within(bar).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    expect(within(bar).getByRole('button', { name: 'Mark unread' })).toBeDisabled();
    await user.click(within(table).getByRole('checkbox', { name: `Select ${CLOSURE_TITLE}` }));
    await user.click(within(bar).getByRole('button', { name: 'Mark read' }));
    const post = fetchMock.mock.calls.find(([url]) => String(url) === '/api/inbox/bulk');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      action: 'read',
      keys: ['request:a-1', 'update:n-2'],
    });
    // Partial failure says how many.
    expect(await screen.findByText('1 of 2 updated')).toBeVisible();
  });

  it('Mark all read posts read-all', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt('/inbox', (url) =>
      url === '/api/inbox/read-all' ? json(200, summary(0)) : undefined,
    );
    await screen.findByRole('list', { name: 'Today' });
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(calls(fetchMock, 'POST')).toContain('/api/inbox/read-all'));
  });

  it('under 1024 px a row opens the full page instead of the drawer', async () => {
    screenWidth(false);
    const user = userEvent.setup();
    const { router, fetchMock } = renderAt('/inbox');
    await screen.findByRole('list', { name: 'Today' });
    await user.click(
      within(screen.getByRole('listitem', { name: CLOSURE_TITLE })).getByRole('button'),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox/request%3Aa-1'));
    expect(await screen.findByRole('heading', { level: 2, name: CLOSURE_TITLE })).toBeVisible();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'href',
      '/inbox',
    );
    await waitFor(() => expect(calls(fetchMock, 'POST')).toContain('/api/inbox/requests/a-1/read'));
  });

  it('the old pages redirect: Action requests to the Requests tab, ?id= to ?open=', async () => {
    const { router } = renderAt('/action-requests?id=a-1');
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox'));
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('requests');
    expect(new URLSearchParams(router.state.location.search).get('open')).toBe('request:a-1');
    await act(() => router.navigate('/notifications'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox'));
    expect(router.state.location.search).toBe('');
  });

  it('a LAB station shows the station Inbox and never reads a personal Inbox', async () => {
    const { fetchMock } = renderAt(
      '/inbox',
      undefined,
      me({ id: 'u-lab', accountType: 'shared_lab', permissions: ['inventory.read'] }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The personal page (its tabs) never renders on a station.
    expect(screen.queryByRole('tablist', { name: 'Inbox' })).toBeNull();
    expect(calls(fetchMock).some((url) => url.startsWith('/api/inbox?'))).toBe(false);
  });
});
