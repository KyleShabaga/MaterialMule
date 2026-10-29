import type {
  MeResponse,
  ReceiptDetail,
  ReceiptLogItem,
  ReceiptLogPage,
} from '@materialmule/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { readReceiptLogQuery, receiptLogSearchParams, withFilters } from './url-state';

// Receiving Log list and receipt detail (MM-T51, card test T6). Fictional data only:
// DEMO-2601 / DEMO-2602, TH26-01, receivers AT and two people sharing the initials JS.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const OTHER_PROJECT = {
  ...PROJECT,
  id: '00000000-0000-4000-8000-000000000202',
  projectNumber: 'DEMO-2602',
};
const JORDAN = '00000000-0000-4000-8000-000000000301';
const RECEIPT_ID = '00000000-0000-4000-8000-000000000601';

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

function receipt(id: string, overrides: Partial<ReceiptLogItem> = {}): ReceiptLogItem {
  return {
    id,
    receivedDate: '2026-01-15',
    project: PROJECT,
    receiver: { userId: JORDAN, initials: 'JS', name: 'Jordan Smith' },
    account: { initials: null, name: 'LAB', sharedStation: true },
    quantity: 2,
    confirmedAt: '2026-01-15T21:05:00.000Z',
    ...overrides,
  };
}

const page = (items: ReceiptLogItem[], total = items.length, pageNumber = 1): ReceiptLogPage => ({
  items,
  total,
  page: pageNumber,
  pageSize: 25,
});

const holes = [
  {
    testHoleId: 'th1',
    testHoleName: 'TH26-01',
    type: 'sample_range' as const,
    sampleFrom: 'G1',
    sampleTo: 'S12',
    depthFrom: null,
    depthTo: null,
    depthUnit: null,
    customText: null,
    note: null,
  },
];
const location = { id: 'loc-r', code: 'RECEIVING', name: 'Receiving lab' };

const DETAIL: ReceiptDetail = {
  ...receipt(RECEIPT_ID),
  description: 'Two buckets from TH26-01',
  units: [
    {
      id: 'su-1',
      readableId: 'BKT-2026-000014',
      unitType: 'bucket',
      status: 'in_stock',
      receivedDate: '2026-01-17',
      project: OTHER_PROJECT,
      sample: null,
      bulkGroup: null,
      holes,
      location,
    },
    {
      id: 'su-2',
      readableId: 'BKT-2026-000015',
      unitType: 'bucket',
      status: 'disposed',
      receivedDate: '2026-01-15',
      project: PROJECT,
      sample: null,
      bulkGroup: null,
      holes,
      location,
    },
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    return (await handler(url, init)) ?? json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string, user = me()) {
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
    </SessionContext.Provider>,
  );
  return router;
}

const logCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/receipts');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('receiving log URL state (MM-T51 T1)', () => {
  it('round-trips filters and leaves defaults out of the URL', () => {
    const { query, ignored } = readReceiptLogQuery(
      new URLSearchParams(`search=DEMO-2601&receiverUserId=${JORDAN}&page=2&pageSize=25`),
    );
    expect(ignored).toEqual([]);
    expect(receiptLogSearchParams(query).toString()).toBe(
      `search=DEMO-2601&receiverUserId=${JORDAN}&page=2`,
    );
  });

  it('leaves out invalid values from a hand-edited link and says which', () => {
    const { query, ignored } = readReceiptLogQuery(
      new URLSearchParams('receivedFrom=2026-02-30&receiverUserId=JS&page=-1&search=bkt'),
    );
    expect(query).toEqual({ search: 'bkt', page: 1, pageSize: 25 });
    expect(ignored.sort()).toEqual(['Page', 'Received by', 'Received from']);
  });

  it('a filter change goes back to page 1; a reversed range keeps the newest date', () => {
    const prev = new URLSearchParams('page=3&receivedFrom=2026-01-10&receivedTo=2026-01-20');
    expect(withFilters(prev, { search: 'js' }).get('page')).toBeNull();
    const later = withFilters(prev, { receivedFrom: '2026-02-01' });
    expect(later.get('receivedFrom')).toBe('2026-02-01');
    expect(later.get('receivedTo')).toBeNull();
  });
});

describe('Receiving Log list (MM-T51)', () => {
  it('AC1: one row per receipt with received-by name and initials and the confirming account', async () => {
    stubApi((url) =>
      url.pathname === '/api/receipts' ? json(200, page([receipt(RECEIPT_ID)], 1)) : undefined,
    );
    renderAt('/receiving-log');
    expect(await screen.findByText('1 receipt')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Confirmed receipts' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('JS · Jordan Smith')).toBeInTheDocument();
    expect(within(table).getByText('by LAB (shared station)')).toBeInTheDocument();
    expect(within(table).getByText('Jan 15, 2026, 2:05 p.m.')).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Open receipt: DEMO-2601, received 2026-01-15 by JS · Jordan Smith',
      }),
    ).toHaveAttribute('href', `/receiving-log/${RECEIPT_ID}`);
    // Receive samples and the local drafts flow are separate entries; drafts aren't listed.
    expect(screen.getByRole('link', { name: 'Drafts on this computer' })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
  });

  it('shows "No receipts yet" with Receive samples when nothing has been confirmed', async () => {
    stubApi((url) => (url.pathname === '/api/receipts' ? json(200, page([], 0)) : undefined));
    renderAt('/receiving-log');
    expect(await screen.findByText('No receipts yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Receive samples' })).toHaveLength(2);
  });

  it('shows "No receipts match these filters" with Clear filters', async () => {
    stubApi((url) => (url.pathname === '/api/receipts' ? json(200, page([], 0)) : undefined));
    const router = renderAt('/receiving-log?search=nothing');
    expect(await screen.findByText('No receipts match these filters.')).toBeInTheDocument();
    expect(screen.queryByText('No receipts yet.')).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(router.state.location.search).toBe('');
  });

  it('AC10: a server error shows Retry, never an empty history', async () => {
    let fail = true;
    stubApi((url) =>
      url.pathname === '/api/receipts'
        ? fail
          ? json(500, { code: 'internal' })
          : json(200, page([receipt(RECEIPT_ID)], 1))
        : undefined,
    );
    renderAt('/receiving-log');
    expect(
      await screen.findByText('Material Mule had a problem loading receipts. Try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No receipts/)).not.toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 receipt')).toBeInTheDocument();
  });

  it('AC10: a lost connection says so instead of showing no receipts', async () => {
    stubApi((url) => {
      if (url.pathname === '/api/receipts') throw new TypeError('Failed to fetch');
      return undefined;
    });
    renderAt('/receiving-log');
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t be reached|offline/);
    expect(screen.queryByText(/No receipts/)).not.toBeInTheDocument();
  });

  it('a refused read says permission is needed', async () => {
    stubApi((url) =>
      url.pathname === '/api/receipts' ? json(403, { code: 'forbidden' }) : undefined,
    );
    renderAt('/receiving-log');
    expect(
      await screen.findByText("You don't have permission to see receipts."),
    ).toBeInTheDocument();
  });

  it('AC10: an invalid link value is left out with a notice and not sent', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/receipts' ? json(200, page([receipt(RECEIPT_ID)], 1)) : undefined,
    );
    renderAt('/receiving-log?receivedFrom=2026-02-30&search=js');
    expect(
      await screen.findByText('Part of this link wasn’t valid and was left out: Received from.'),
    ).toBeInTheDocument();
    await screen.findByText('1 receipt');
    expect(Object.fromEntries(logCalls(fetchMock).at(-1)!.searchParams)).toEqual({ search: 'js' });
  });

  it('AC3: a reload restores filters from the URL, including the receiver by user ID', async () => {
    const fetchMock = stubApi((url) => {
      if (url.pathname === '/api/receipts') return json(200, page([receipt(RECEIPT_ID)], 1));
      if (url.pathname === '/api/receipts/receivers' && url.searchParams.get('id') === JORDAN) {
        return json(200, [
          { id: JORDAN, initials: 'JS', displayName: 'Jordan Smith', position: null },
        ]);
      }
      if (url.pathname === `/api/projects/${PROJECT.id}`) {
        return json(200, {
          ...PROJECT,
          leadProjectEngineer: { id: 'pe', displayName: 'Pat Example', initials: 'PE' },
        });
      }
      return undefined;
    });
    renderAt(
      `/receiving-log?search=demo&projectId=${PROJECT.id}&receiverUserId=${JORDAN}` +
        '&receivedFrom=2026-01-01&receivedTo=2026-01-31&page=2',
    );
    const chips = await screen.findByRole('list', { name: 'Active filters' });
    expect(await within(chips).findByText('Received by: JS · Jordan Smith')).toBeInTheDocument();
    expect(await within(chips).findByText('Project: DEMO-2601')).toBeInTheDocument();
    expect(within(chips).getByText('Received from 2026-01-01')).toBeInTheDocument();
    expect(Object.fromEntries(logCalls(fetchMock).at(-1)!.searchParams)).toEqual({
      search: 'demo',
      projectId: PROJECT.id,
      receiverUserId: JORDAN,
      receivedFrom: '2026-01-01',
      receivedTo: '2026-01-31',
      page: '2',
    });
  });

  it('AC3: two date filters set in quick succession are both kept', async () => {
    stubApi((url) =>
      url.pathname === '/api/receipts' ? json(200, page([receipt(RECEIPT_ID)], 1)) : undefined,
    );
    const router = renderAt('/receiving-log?search=js&page=2');
    await screen.findByText('1 receipt');
    act(() => {
      fireEvent.change(screen.getByLabelText('Received from'), { target: { value: '2026-01-01' } });
      fireEvent.change(screen.getByLabelText('Received through'), {
        target: { value: '2026-01-31' },
      });
    });
    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
        search: 'js',
        receivedFrom: '2026-01-01',
        receivedTo: '2026-01-31',
      }),
    );
  });

  it('T6: a slower answer for older filters never replaces the newer one', async () => {
    let releaseOld: (response: Response) => void = () => undefined;
    stubApi((url) => {
      if (url.pathname !== '/api/receipts') return undefined;
      if (url.searchParams.get('search') === 'old') {
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      }
      return json(200, page([receipt(RECEIPT_ID, { receivedDate: '2026-03-03' })], 1));
    });
    renderAt('/receiving-log?search=old');
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'new');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('2026-03-03')).toBeInTheDocument();
    await act(async () => {
      releaseOld(json(200, page([receipt('old', { receivedDate: '2025-12-12' })], 1)));
      await Promise.resolve();
    });
    expect(screen.queryByText('2025-12-12')).not.toBeInTheDocument();
    expect(screen.getByText('2026-03-03')).toBeInTheDocument();
  });

  it('pages with Previous and Next', async () => {
    stubApi((url) =>
      url.pathname === '/api/receipts'
        ? json(200, page([receipt(RECEIPT_ID)], 60, Number(url.searchParams.get('page') ?? 1)))
        : undefined,
    );
    const router = renderAt('/receiving-log');
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?page=2');
  });
});

describe('Receipt detail (MM-T51)', () => {
  it('AC5: shows the original header and every unit, marking corrected values', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === `/api/receipts/${RECEIPT_ID}` ? json(200, DETAIL) : undefined,
    );
    renderAt(`/receiving-log/${RECEIPT_ID}`);
    expect(
      await screen.findByRole('heading', { name: 'Receipt DEMO-2601 · 2026-01-15' }),
    ).toBeInTheDocument();
    const header = screen.getByRole('region', { name: 'Original receipt record' });
    expect(within(header).getByText('JS · Jordan Smith')).toBeInTheDocument();
    expect(within(header).getByText('LAB (shared station)')).toBeInTheDocument();
    expect(within(header).getByText('Two buckets from TH26-01')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Storage units in this receipt' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Open BKT-2026-000014' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000014',
    );
    // The corrected unit shows its current project and date, marked in words.
    expect(within(table).getAllByText('Corrected')).toHaveLength(2);
    expect(within(table).getByText('Receipt: DEMO-2601.')).toBeInTheDocument();
    expect(within(table).getByText('2026-01-17')).toBeInTheDocument();
    // The disposed unit is still listed, with its status in words.
    expect(within(table).getByText('Disposed')).toBeInTheDocument();

    // Opening the receipt queues nothing; Print leaves out the disposed unit.
    expect(screen.getByRole('button', { name: 'Print 1 label' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => (init?.method ?? 'GET') !== 'GET')).toBe(false);
  });

  it('AC10: an unknown receipt says No receipt found', async () => {
    stubApi((url) =>
      url.pathname.startsWith('/api/receipts/')
        ? json(404, { code: 'receipt_not_found' })
        : undefined,
    );
    renderAt(`/receiving-log/${RECEIPT_ID}`);
    expect(
      await screen.findByText('No receipt found. Find it in the Receiving Log instead.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to Receiving Log' })).toHaveAttribute(
      'href',
      '/receiving-log',
    );
  });

  it('a server error offers Retry', async () => {
    let fail = true;
    stubApi((url) =>
      url.pathname === `/api/receipts/${RECEIPT_ID}`
        ? fail
          ? json(503, { code: 'unavailable' })
          : json(200, DETAIL)
        : undefined,
    );
    renderAt(`/receiving-log/${RECEIPT_ID}`);
    await screen.findByRole('alert');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('heading', { name: 'Original receipt record' }),
    ).toBeInTheDocument();
  });
});
