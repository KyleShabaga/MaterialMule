import type {
  ActivityItem,
  InventoryPage,
  MeResponse,
  ProjectSummary,
  RecentlyReceivedItem,
  RecentlyReceivedResponse,
  StorageLocation,
  Worklist,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDraft } from '../receiving/draft';
import { newRecord } from '../receiving/drafts/record';
import { indexedDbDraftStore } from '../receiving/drafts/store';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { receivedWhen } from './format';
import { loadMoreCounts } from './more-counts';
import { byUrgency, firstName, greeting, listNames, todayLine, type NeedsItem } from './today';
import { locationCells, ROOM_CELLS_MAX } from './TodayPage';

// Today (Field Ledger, canvas Main and PhoneToday). Fictional data only: DEMO-2601, TH26-01,
// Alex Tester.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'receipt.confirm'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  leadProjectEngineer: {
    id: '00000000-0000-4000-8000-000000000101',
    displayName: 'Pat Example',
    initials: 'PE',
  },
};

const LOCATION_ID = '00000000-0000-4000-8000-000000000701';

function unit(n: number, overrides: Partial<RecentlyReceivedItem> = {}): RecentlyReceivedItem {
  return {
    id: `00000000-0000-4000-8000-0000000010${String(n).padStart(2, '0')}`,
    readableId: `BKT-2026-0000${String(n).padStart(2, '0')}`,
    unitType: 'bucket',
    status: 'in_stock',
    project: { id: project.id, projectNumber: 'DEMO-2601', name: project.name, client: 'Example' },
    sample: null,
    bulkGroup: null,
    holes: [],
    location: { id: LOCATION_ID, code: 'WH-C2', name: 'Warehouse C2' },
    receivedDate: '2026-10-20',
    receivedAt: '2026-10-20T20:32:00.000Z',
    receiver: { initials: 'JS', name: 'Jordan Smith' },
    latestPrint: null,
    ...overrides,
  };
}

const noLabels: RecentlyReceivedResponse = {
  items: [],
  total: 0,
  receivedThisWeek: 0,
  labelsToCheck: 0,
};

const emptyPage: InventoryPage = { items: [], total: 0, page: 1, pageSize: 25 };

function location(overrides: Partial<StorageLocation> = {}): StorageLocation {
  return {
    id: LOCATION_ID,
    code: 'WH-C2',
    name: 'Warehouse C2',
    kind: 'warehouse',
    area: null,
    active: true,
    isSystem: false,
    retiredAt: null,
    retiredReason: null,
    codeLocked: true,
    labelPrintedAt: null,
    inStockCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
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
    '/api/activity/recent': () => json(200, []),
    '/api/inventory/recently-received': () => json(200, noLabels),
    '/api/inventory': () => json(200, emptyPage),
    '/api/locations': () => json(200, []),
    '/api/worklist': () => json(200, { items: [], total: 0, page: 1, pageSize: 25, projects: [] }),
    ...api,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const handler = handlers[url.pathname];
    return handler ? handler(url) : json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { router, fetchMock };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const { drafts } = await indexedDbDraftStore.list();
  for (const draft of drafts) await indexedDbDraftStore.remove(draft.draftId);
});

describe('receivedWhen', () => {
  const now = new Date('2026-10-27T18:00:00Z'); // 12:00 p.m. on Oct 27 in Edmonton
  it('shows the time today, "Yesterday", then the date', () => {
    expect(receivedWhen('2026-10-27', '2026-10-27T17:32:00Z', now)).toMatch(/^11:32\sa\.m\.$/);
    expect(receivedWhen('2026-10-26', '2026-10-26T22:00:00Z', now)).toBe('Yesterday');
    expect(receivedWhen('2026-10-22', '2026-10-22T22:00:00Z', now)).toBe('2026-10-22');
  });
});

describe('Today wording', () => {
  const morning = new Date('2026-11-10T16:00:00Z'); // 09:00 in Edmonton
  const evening = new Date('2026-11-11T02:00:00Z'); // 19:00 on Nov 10 in Edmonton

  it('greets the person by first name and says how many things need them', () => {
    expect(greeting('Dana', 5, morning)).toBe('Good morning, Dana. Five things need you today.');
    expect(greeting('Dana', 1, morning)).toBe('Good morning, Dana. One thing needs you today.');
    expect(greeting(null, 0, evening)).toBe('Good evening. Nothing needs you today.');
    expect(greeting('Dana', 12, morning)).toBe('Good morning, Dana. 12 things need you today.');
  });

  it('takes the first name and writes the date line in the lab time zone', () => {
    expect(firstName('Dana Tester (Lab)')).toBe('Dana');
    expect(firstName('')).toBeNull();
    expect(todayLine(morning)).toBe('TUE 10 NOV 2026');
    expect(todayLine(evening)).toBe('TUE 10 NOV 2026');
  });

  it('orders the queue by urgency and lists names briefly', () => {
    const item = (key: NeedsItem['key']): NeedsItem => ({
      key,
      tag: { label: key, tone: 'waiting' },
      title: key,
      sub: '',
      action: 'Open',
      href: '/',
      lead: key,
      why: key,
    });
    expect(
      byUrgency([item('lab'), item('drafts'), item('labels'), item('print-queue')]).map(
        (i) => i.key,
      ),
    ).toEqual(['print-queue', 'labels', 'drafts', 'lab']);
    expect(listNames(['DEMO-2611', 'DEMO-2613', 'DEMO-2611'])).toBe('DEMO-2611 and DEMO-2613');
    expect(listNames(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
  });

  it('draws one cell per unit, flagged for retention due, capped', () => {
    expect(locationCells(3, 1)).toEqual(['current', 'done', 'done']);
    expect(locationCells(0, 0)).toEqual([]);
    expect(locationCells(500, 2)).toHaveLength(ROOM_CELLS_MAX);
  });
});

describe('Today', () => {
  it('opens with the greeting, Receive samples and an empty queue', async () => {
    renderToday(me());
    const greetingBlock = await screen.findByRole('region', {
      name: /^Good (morning|afternoon|evening), Alex\./,
    });
    expect(within(greetingBlock).getByRole('heading', { level: 1 })).toHaveTextContent(
      /Nothing needs you today\.$/,
    );
    expect(screen.getByRole('link', { name: 'Receive samples' })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
    expect(screen.getByRole('link', { name: 'Scan label' })).toHaveAttribute(
      'href',
      '/sample-storage/scan',
    );
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(await within(needs).findByText('Nothing needs you.')).toBeInTheDocument();
  });

  it('lists what needs the person, most urgent first, each linking to the screen that clears it', async () => {
    const mine = newRecord({ ...newDraft(null, '2026-10-26'), project }, me());
    const someoneElse = newRecord(newDraft(null, '2026-10-26'), me({ id: 'someone-else' }));
    for (const record of [mine, someoneElse]) await indexedDbDraftStore.put(record);
    renderToday(me({ permissions: ['inventory.read', 'receipt.confirm', 'action_item.read'] }), {
      '/api/action-items/count': () => json(200, { open: 2 }),
      '/api/inventory/recently-received': () =>
        json(200, { ...noLabels, items: [unit(19)], labelsToCheck: 1 }),
      '/api/inventory': (url) =>
        url.searchParams.get('retention') === 'eligible_by_date'
          ? json(200, { ...emptyPage, items: [unit(7)], total: 1 })
          : json(200, emptyPage),
    });
    const needs = screen.getByRole('region', { name: 'Needs you' });
    const rows = await within(needs).findAllByRole('listitem');
    await vi.waitFor(() => expect(within(needs).getAllByRole('listitem')).toHaveLength(4));
    expect(rows[0]).toBeDefined();
    const titles = within(needs)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.today-task-title')?.textContent);
    expect(titles).toEqual([
      '2 action requests wait on you',
      '1 label to check',
      'A receipt for DEMO-2601 is waiting to be confirmed',
      '1 storage unit has reached the end of retention',
    ]);
    expect(
      within(needs).getByRole('link', { name: 'Open: 2 action requests wait on you' }),
    ).toHaveAttribute('href', '/action-requests');
    expect(within(needs).getByRole('link', { name: 'Check: 1 label to check' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000019',
    );
    expect(
      within(needs).getByRole('link', {
        name: 'Continue: A receipt for DEMO-2601 is waiting to be confirmed',
      }),
    ).toHaveAttribute('href', `/receiving-log/new?draft=${mine.draftId}`);

    // The greeting counts them and flags the first one, saying why it is first.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/Four things need you today\.$/);
    expect(screen.getByRole('link', { name: 'Start with your action requests' })).toHaveAttribute(
      'href',
      '/action-requests',
    );
    expect(screen.getByText('ROUTED TO YOU BY NAME')).toBeInTheDocument();

    // The counts link to the same screens.
    const counts = screen.getByRole('list', { name: 'Counts' });
    expect(within(counts).getByRole('link', { name: /^labels to check: 1/ })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000019',
    );
  });

  it('shows the last 24 hours in the ledger, linking each record', async () => {
    const item: ActivityItem = {
      id: 'e1',
      occurredAt: '2026-10-25T16:42:00.000Z',
      action: 'storage_unit.moved',
      actorInitials: 'AT',
      actorName: 'Alex Tester',
      summary: 'AT moved BKT-2026-000142 to Warehouse C2',
      ref: 'BKT-2026-000142',
      href: '/sample-storage/BKT-2026-000142',
    };
    const { fetchMock } = renderToday(me(), { '/api/activity/recent': () => json(200, [item]) });
    const ledger = screen.getByRole('region', { name: 'Ledger' });
    expect(
      await within(ledger).findByRole('link', { name: 'AT moved BKT-2026-000142 to Warehouse C2' }),
    ).toHaveAttribute('href', '/sample-storage/BKT-2026-000142');
    expect(within(ledger).getByText('BKT-2026-000142')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/api/activity/recent?limit=12&hours=24'),
      ),
    ).toBe(true);
  });

  it('shows a retryable error when the ledger fails', async () => {
    renderToday(me(), { '/api/activity/recent': () => json(500, {}) });
    const ledger = screen.getByRole('region', { name: 'Ledger' });
    expect(
      await within(ledger).findByText("The ledger couldn't load. Try again."),
    ).toBeInTheDocument();
    expect(within(ledger).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('draws the storage room as one cell per unit, flagging retention due', async () => {
    renderToday(me(), {
      '/api/locations': () =>
        json(200, [
          location(),
          location({ id: 'loc-2', name: 'Receiving lab', kind: 'receiving_lab', inStockCount: 0 }),
        ]),
      '/api/inventory': (url) =>
        url.searchParams.get('retention') === 'eligible_by_date'
          ? json(200, { ...emptyPage, items: [unit(7)], total: 1 })
          : json(200, emptyPage),
    });
    const room = screen.getByRole('region', { name: 'Storage room' });
    const cells = await within(room).findByRole('img', {
      name: 'Warehouse C2: 3 storage units, 1 with retention due',
    });
    expect(cells.querySelectorAll('.counted-cell-current')).toHaveLength(1);
    expect(cells.querySelectorAll('.counted-cell-done')).toHaveLength(2);
    expect(within(room).getByRole('link', { name: /Warehouse C2/ })).toHaveAttribute(
      'href',
      `/sample-storage?locationId=${LOCATION_ID}`,
    );
    expect(within(room).getByText('Empty')).toBeInTheDocument();
    // The receiving lab names the lab on the greeting's date line.
    expect(await screen.findByText(/· RECEIVING LAB$/)).toBeInTheDocument();
  });
});

describe('More sheet counts', () => {
  it('reads one count per destination and leaves out what it cannot read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/inventory') {
          return json(200, {
            ...emptyPage,
            total: url.searchParams.get('retention') ? 9 : 212,
          });
        }
        if (url.pathname === '/api/projects') {
          return json(200, { items: [], total: 7, page: 1, pageSize: 1 });
        }
        if (url.pathname === '/api/worklist') {
          const worklist: Worklist = { items: [], total: 3, page: 1, pageSize: 25, projects: [] };
          return json(200, worklist);
        }
        return json(403, {});
      }),
    );
    const counts = await loadMoreCounts(
      me({ permissions: ['inventory.read', 'lab_program.read'] }),
    );
    expect(counts.inventory).toBe(212);
    expect(counts.projects).toBe(7);
    expect(counts.concrete).toBeUndefined();
    expect(counts.receive).toBe(0);
  });
});
