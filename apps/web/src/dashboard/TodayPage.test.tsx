import { formatClockTime } from '@materialmule/shared';
import type {
  MeResponse,
  NeedsYouItem,
  NeedsYouResponse,
  ScopedActivityItem,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { PERSONAL_CONTROLLER, RecordingPersonContext } from '../session/recording-person-store';
import { TodayPage } from './TodayPage';

// Today with an own account. The Needs you and scoped activity routes are mocked (the API is
// built in parallel). Fictional data only: Alex Tester, Pat Example, DEMO-2601.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'receipt.draft', 'storage_unit.move', 'label.print'],
  sessionExpiresAt: '2026-11-14T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function need(n: number, overrides: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    key: `system:retention_due:${n}`,
    source: 'system',
    task: 'Retention',
    title: `Decide on ${n} units at end of retention`,
    detail: `DEMO-2601 · BKT-2026-0001${String(n).padStart(2, '0')} and ${n} more`,
    ids: ['DEMO-2601'],
    stage: 'due',
    domain: 'retention',
    action: 'Decide',
    href: `/disposal-retention?n=${n}`,
    count: n,
    since: null,
    ...overrides,
  };
}

function needs(items: NeedsYouItem[], extra: Partial<NeedsYouResponse> = {}): NeedsYouResponse {
  return {
    items,
    total: items.length,
    fromInbox: items.filter((i) => i.source === 'request').length,
    unavailable: [],
    ...extra,
  };
}

function json(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

type Api = Record<string, (url: URL) => Response>;

function renderToday(session: MeResponse, api: Api = {}) {
  const handlers: Api = {
    '/api/today/needs-you': () => json(200, needs([])),
    '/api/activity/recent': () => json(200, []),
    '/api/projects': () => json(200, { items: [], total: 0, page: 1, pageSize: 100 }),
    '/api/me/preferences': () => json(404, {}),
    ...api,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const handler = handlers[url.pathname];
    return handler ? handler(url) : json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RecordingPersonContext.Provider value={PERSONAL_CONTROLLER}>
        <MemoryRouter>
          <TodayPage />
        </MemoryRouter>
      </RecordingPersonContext.Provider>
    </SessionContext.Provider>,
  );
  return { fetchMock };
}

function activityCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes('/api/activity/recent'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Today with an own account', () => {
  it('welcomes the person, summarises Needs you and links its heading to the Inbox', async () => {
    renderToday(me(), {
      '/api/today/needs-you': () =>
        json(
          200,
          needs([
            need(4),
            need(2, { key: 'request:a1', source: 'request', task: 'Close a program' }),
          ]),
        ),
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /^Good (morning|afternoon|evening), Alex$/,
    );
    expect(
      await screen.findByText('2 things need you. 1 is a request in your Inbox.'),
    ).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Needs you' });
    expect(within(section).getByRole('link', { name: 'Open Inbox' })).toHaveAttribute(
      'href',
      '/inbox',
    );
  });

  it('gives an account without roles or leads the technician shortcuts and its own activity', async () => {
    const { fetchMock } = renderToday(me());
    const nav = await screen.findByRole('navigation', { name: 'Shortcuts' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Receive', 'Move storage units', 'Print labels']);
    await vi.waitFor(() =>
      expect(activityCalls(fetchMock)).toEqual([
        '/api/activity/recent?hours=24&limit=12&scope=mine',
      ]),
    );
  });

  it('gives a project lead the lead shortcuts and activity on their projects', async () => {
    const { fetchMock } = renderToday(
      me({
        permissions: ['inventory.read', 'lab_program.manage', 'receipt.draft', 'project.create'],
      }),
      {
        '/api/projects': () =>
          json(200, {
            items: [
              {
                id: '00000000-0000-4000-8000-000000000201',
                projectNumber: 'DEMO-2601',
                name: 'Riverbank investigation',
                client: 'Example Client',
                leadProjectEngineer: null,
                involvement: ['lead_project_engineer'],
                testHoleCount: 2,
                inStockUnitCount: 3,
                lastReceiptDate: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 100,
          }),
      },
    );
    const nav = await screen.findByRole('navigation', { name: 'Shortcuts' });
    expect(within(nav).getByRole('link', { name: 'Request lab testing' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'My projects' })).toHaveAttribute(
      'href',
      '/projects?tab=mine',
    );
    await vi.waitFor(() =>
      expect(activityCalls(fetchMock)).toEqual([
        '/api/activity/recent?hours=24&limit=12&scope=projects',
      ]),
    );
  });

  it('gives a Lab Manager the lab set and the whole lab, without asking about projects', async () => {
    const { fetchMock } = renderToday(
      me({ roles: ['lab_manager'], permissions: ['inventory.read', 'lab_program.read'] }),
    );
    const nav = await screen.findByRole('navigation', { name: 'Shortcuts' });
    expect(within(nav).getByRole('link', { name: 'Workboard' })).toHaveAttribute(
      'href',
      '/lab-testing',
    );
    await vi.waitFor(() =>
      expect(activityCalls(fetchMock)).toEqual([
        '/api/activity/recent?hours=24&limit=12&scope=lab',
      ]),
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/projects'))).toBe(
      false,
    );
  });

  it('shows the first six, then Show all expands in place and moves focus to the seventh', async () => {
    const items = Array.from({ length: 9 }, (_, i) => need(i + 1));
    renderToday(me(), { '/api/today/needs-you': () => json(200, needs(items)) });
    const section = screen.getByRole('region', { name: 'Needs you' });
    const list = await within(section).findByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    // Only the first row's action is primary.
    const actions = within(list).getAllByRole('link');
    expect(actions[0]).toHaveAttribute('data-variant', 'default');
    expect(actions[1]).toHaveAttribute('data-variant', 'outline');
    expect(actions[0]).toHaveAccessibleName('Decide: Decide on 1 units at end of retention');
    // IDs in the detail line are mono.
    expect(within(list).getAllByText('DEMO-2601')[0]).toHaveClass('font-mono');

    await userEvent.click(within(section).getByRole('button', { name: 'Show all 9' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    expect(within(section).queryByRole('button', { name: /Show all/ })).toBeNull();
    expect(within(list).getAllByRole('link')[6]).toHaveFocus();
  });

  it('marks requests with the Request pill and their kind', async () => {
    renderToday(me(), {
      '/api/today/needs-you': () =>
        json(
          200,
          needs([
            need(1, {
              key: 'request:a1',
              source: 'request',
              task: 'Close a program',
              title: 'Close lab program',
              action: 'Open',
            }),
            need(2, {
              key: 'system:concrete_holds',
              stage: 'danger',
              domain: 'hold',
              task: 'Hold',
            }),
          ]),
        ),
    });
    const list = await within(screen.getByRole('region', { name: 'Needs you' })).findByRole('list');
    const [request, hold] = within(list).getAllByRole('listitem');
    expect(within(request!).getByText('Request')).toBeInTheDocument();
    expect(within(request!).getByText('Due · Close a program')).toBeInTheDocument();
    expect(within(hold!).queryByText('Request')).toBeNull();
    expect(within(hold!).getByText('Urgent · Hold')).toBeInTheDocument();
  });

  it('shows a calm panel on a clear day', async () => {
    renderToday(me());
    const section = screen.getByRole('region', { name: 'Needs you' });
    expect(await within(section).findByText('Nothing needs you right now.')).toBeInTheDocument();
    expect(
      within(section).getByText(
        'Tests assigned to you, units to pull and drafts to finish show up here.',
      ),
    ).toBeInTheDocument();
  });

  it('when Needs you fails, says the rest still works and tries again', async () => {
    let calls = 0;
    renderToday(me(), {
      '/api/today/needs-you': () => (++calls === 1 ? json(500, {}) : json(200, needs([need(3)]))),
    });
    const section = screen.getByRole('region', { name: 'Needs you' });
    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent('Needs you couldn’t load.');
    expect(alert).toHaveTextContent('Shortcuts and the last 24 hours still work.');
    // The shortcuts and the last 24 hours are unaffected.
    expect(screen.getByRole('navigation', { name: 'Shortcuts' })).toBeInTheDocument();
    expect(
      await within(screen.getByRole('region', { name: 'Last 24 hours' })).findByText(
        'Nothing recorded in the last 24 hours.',
      ),
    ).toBeInTheDocument();

    await userEvent.click(within(section).getByRole('button', { name: 'Try again' }));
    expect(
      await within(section).findByText('Decide on 3 units at end of retention'),
    ).toBeInTheDocument();
  });

  it('names the sources that couldn’t load and still lists the rest', async () => {
    renderToday(me(), {
      '/api/today/needs-you': () => json(200, needs([need(2)], { unavailable: ['breaks_due'] })),
    });
    const section = screen.getByRole('region', { name: 'Needs you' });
    expect(
      await within(section).findByText(
        'Couldn’t load breaks due today. Everything else here is up to date.',
      ),
    ).toBeInTheDocument();
    expect(within(section).getByText('Decide on 2 units at end of retention')).toBeInTheDocument();
  });

  it('lists the last 24 hours in the second person, with yesterday under its label', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T17:00:00Z')); // morning in Edmonton
    const rows: ScopedActivityItem[] = [
      {
        id: 'e1',
        occurredAt: '2026-11-13T16:42:00.000Z',
        action: 'receipt.confirmed',
        actorInitials: 'AT',
        actorName: 'Alex Tester',
        summary: 'AT received BKT-2026-000142 and 1 more for DEMO-2601',
        ref: 'DEMO-2601',
        href: '/sample-storage?receiptId=r1&status=all',
        byMe: true,
      },
      {
        id: 'e2',
        occurredAt: '2026-11-12T23:50:00.000Z',
        action: 'storage_unit.moved',
        actorInitials: 'PE',
        actorName: 'Pat Example',
        summary: 'PE moved BKT-2026-000019 to Shelf A3',
        ref: 'BKT-2026-000019',
        href: null,
        byMe: false,
      },
    ];
    renderToday(me(), { '/api/activity/recent': () => json(200, rows) });
    const section = screen.getByRole('region', { name: 'Last 24 hours' });
    const link = await within(section).findByRole('link', {
      name: 'You received BKT-2026-000142 and 1 more for DEMO-2601',
    });
    expect(link).toHaveAttribute('href', '/sample-storage?receiptId=r1&status=all');
    const items = within(section).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Clock times with AM or PM in the lab's time zone.
    expect(items[0]!.querySelector('time')).toHaveTextContent(formatClockTime(rows[0]!.occurredAt));
    expect(items[0]!.querySelector('time')).toHaveTextContent(/^\d{1,2}:42\sAM$/);
    // Yesterday's line says so to screen readers; the visible label is decoration.
    expect(items[1]!.querySelector('time')).toHaveTextContent(
      `Yesterday ${formatClockTime(rows[1]!.occurredAt)}`,
    );
    expect(items[1]).toHaveTextContent('PE moved BKT-2026-000019 to Shelf A3');
    expect(within(section).getByText('Yesterday', { selector: 'li' })).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('shows a retryable error when the last 24 hours fail, leaving Needs you', async () => {
    renderToday(me(), {
      '/api/activity/recent': () => json(500, {}),
      '/api/today/needs-you': () => json(200, needs([need(1)])),
    });
    const section = screen.getByRole('region', { name: 'Last 24 hours' });
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'The last 24 hours couldn’t load.',
    );
    expect(within(section).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(await screen.findByText('Decide on 1 units at end of retention')).toBeInTheDocument();
  });
});

describe('Today on a LAB station', () => {
  it('renders the station Today, not the personal one', () => {
    renderToday(me({ accountType: 'shared_lab', displayName: 'Lab (test)' }));
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Shortcuts' })).toBeNull();
  });
});
