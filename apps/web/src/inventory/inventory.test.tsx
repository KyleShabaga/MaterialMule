import type {
  InventoryItem,
  InventoryPage,
  MeResponse,
  StorageUnitDetail,
  StorageUnitHistoryPage,
} from '@trapezoid/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { inventorySearchParams, readInventoryQuery } from './url-state';

// Fictional data only (TRP-T12): DEMO-2601, TH26-01, receiver AT.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const WAREHOUSE = {
  id: '00000000-0000-4000-8000-000000000401',
  code: 'WH-C2',
  name: 'Warehouse C2',
};

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

function item(readableId: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `id-${readableId}`,
    readableId,
    unitType: 'bucket',
    status: 'in_stock',
    project: PROJECT,
    holes: [
      {
        testHoleId: 'th1',
        testHoleName: 'TH26-01',
        type: 'sample_range',
        sampleFrom: 'G1',
        sampleTo: 'S12',
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
        customText: null,
        note: null,
      },
    ],
    location: WAREHOUSE,
    receivedDate: '2026-10-23',
    ...overrides,
  };
}

const page = (items: InventoryItem[], total = items.length, pageNumber = 1): InventoryPage => ({
  items,
  total,
  page: pageNumber,
  pageSize: 25,
});

const DETAIL: StorageUnitDetail = {
  id: '00000000-0000-4000-8000-000000000501',
  readableId: 'BKT-2026-000014',
  unitType: 'bucket',
  status: 'in_stock',
  note: 'Lid taped',
  receivedDate: '2026-10-23',
  project: PROJECT,
  holes: item('x').holes.concat({
    testHoleId: 'th2',
    testHoleName: 'TH26-02',
    type: 'depth_range',
    sampleFrom: null,
    sampleTo: null,
    depthFrom: 0,
    depthTo: 1.5,
    depthUnit: 'm',
    customText: null,
    note: 'Wet',
  }),
  location: { id: 'loc-r', code: 'RECEIVING', name: 'Receiving lab' },
  receipt: {
    id: 'r1',
    receivedDate: '2026-10-23',
    receiver: { initials: 'AT', name: 'Alex Tester' },
    account: { initials: null, name: 'LAB' },
    description: 'Two buckets',
    quantity: 2,
    confirmedAt: '2026-10-23T16:00:00.000Z',
  },
};

const HISTORY: StorageUnitHistoryPage = {
  items: [
    {
      id: 'e1',
      occurredAt: '2026-10-23T16:00:00.000Z',
      action: 'storage_unit.created',
      actor: { initials: null, name: 'LAB', accountType: 'shared_lab' },
      receiver: { initials: 'AT', name: 'Alex Tester' },
      reason: null,
      before: null,
      after: { readableId: 'BKT-2026-000014' },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: URL) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/locations') return json(200, [{ ...WAREHOUSE, active: true }]);
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    return handler(url) ?? json(404, { code: 'not_found' });
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

const inventoryCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/inventory');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inventory URL state', () => {
  it('round-trips filters and leaves defaults out of the URL', () => {
    const query = readInventoryQuery(
      new URLSearchParams('search=TH26-01&status=all&page=2&sort=received&pageSize=25'),
    );
    expect(inventorySearchParams(query).toString()).toBe('search=TH26-01&status=all&page=2');
  });

  it('ignores invalid values from a hand-edited link', () => {
    const query = readInventoryQuery(new URLSearchParams('status=lost&page=-1&search=bkt'));
    expect(query).toMatchObject({ status: 'current', page: 1, search: 'bkt' });
  });
});

describe('Sample Storage inventory (TRP-T12)', () => {
  it('shows the count and rows, and sends search and filters to the server via the URL', async () => {
    const fetchMock = stubApi((url) => {
      if (url.pathname === '/api/inventory') {
        return json(
          200,
          url.searchParams.get('search')
            ? page([item('BKT-2026-000014')], 1)
            : page([item('BKT-2026-000014'), item('BKT-2026-000015')], 42),
        );
      }
      return undefined;
    });
    const router = renderAt('/sample-storage');

    expect(await screen.findByText('42 storage units')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getAllByText('TH26-01: G1–S12')).toHaveLength(2);
    expect(within(table).getAllByText('Warehouse C2')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'View BKT-2026-000014' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000014',
    );
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'TH26-01 warehouse');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?search=TH26-01+warehouse');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'disposed');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Location' }), WAREHOUSE.id);
    const last = inventoryCalls(fetchMock).at(-1)!;
    expect(Object.fromEntries(last.searchParams)).toEqual({
      search: 'TH26-01 warehouse',
      status: 'disposed',
      locationId: WAREHOUSE.id,
    });

    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(within(chips).getByText('Status: Disposed')).toBeInTheDocument();
    expect(within(chips).getByText('Location: Warehouse C2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Status: Disposed' }));
    expect(router.state.location.search).not.toContain('status');

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(router.state.location.search).toBe('');
    expect(await screen.findByText('42 storage units')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
  });

  it('shows a no-match state', async () => {
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, page([], 0)) : undefined));
    renderAt('/sample-storage?search=nothing');
    expect(await screen.findByText('0 storage units')).toBeInTheDocument();
    expect(
      screen.getByText('No storage units match this search and these filters.'),
    ).toBeInTheDocument();
  });

  it('pages with Previous and Next', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(200, page([item('BKT-2026-000014')], 120, Number(url.searchParams.get('page') ?? 1)))
        : undefined,
    );
    const router = renderAt('/sample-storage');
    expect(await screen.findByText('Page 1 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 5')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?page=2');
    expect(inventoryCalls(fetchMock).at(-1)!.searchParams.get('page')).toBe('2');
  });

  it('AC4: Look up ID opens the unit; an unknown ID says No storage unit found', async () => {
    const fetchMock = stubApi((url) => {
      if (url.pathname === '/api/inventory') return json(200, page([]));
      if (url.pathname === '/api/storage-units/lookup') {
        return url.searchParams.get('code') === 'bkt-2026-000014 '
          ? json(200, { id: DETAIL.id, readableId: DETAIL.readableId })
          : json(404, { code: 'storage_unit_not_found' });
      }
      if (url.pathname === `/api/storage-units/${DETAIL.readableId}`) return json(200, DETAIL);
      if (url.pathname === `/api/storage-units/${DETAIL.id}/history`) return json(200, HISTORY);
      if (url.pathname.endsWith('/print-history')) {
        return json(200, {
          storageUnit: { id: DETAIL.id, readableId: DETAIL.readableId },
          jobs: [],
        });
      }
      return undefined;
    });
    const router = renderAt('/sample-storage');
    const lookUp = await screen.findByRole('textbox', { name: 'Look up ID' });

    await userEvent.type(lookUp, 'BKT-2026-999999');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No storage unit found');

    await userEvent.clear(lookUp);
    await userEvent.type(lookUp, 'bkt-2026-000014 ');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'BKT-2026-000014' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sample-storage/BKT-2026-000014');
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('storage unit detail (TRP-T12)', () => {
  function stubDetail() {
    return stubApi((url) => {
      if (url.pathname === `/api/storage-units/${DETAIL.readableId}`) return json(200, DETAIL);
      if (url.pathname === `/api/storage-units/${DETAIL.id}/history`) return json(200, HISTORY);
      if (url.pathname.endsWith('/print-history')) {
        return json(200, {
          storageUnit: { id: DETAIL.id, readableId: DETAIL.readableId },
          jobs: [],
        });
      }
      return undefined;
    });
  }

  it('AC7: shows the receiver snapshot and account, every summary, location and history', async () => {
    stubDetail();
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    expect(await screen.findByText('In stock')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: DETAIL.readableId })).toBeInTheDocument();

    const summaries = screen.getByRole('region', { name: 'Summaries' });
    expect(within(summaries).getByText('DEMO-2601 — Riverbank investigation')).toBeInTheDocument();
    expect(within(summaries).getByText('Example Client')).toBeInTheDocument();
    const holes = within(summaries).getByRole('list', { name: 'Test hole summaries' });
    expect(holes).toHaveTextContent('TH26-01: G1–S12');
    expect(holes).toHaveTextContent('TH26-02: 0–1.5 m Note: Wet');
    expect(within(summaries).getByText('Lid taped')).toBeInTheDocument();

    const receipt = screen.getByRole('region', { name: 'Receipt' });
    expect(within(receipt).getByText('AT — Alex Tester')).toBeInTheDocument();
    expect(within(receipt).getByText('LAB')).toBeInTheDocument();

    const location = screen.getByRole('region', { name: 'Location and retention' });
    expect(within(location).getByText('Receiving lab (RECEIVING)')).toBeInTheDocument();

    const history = screen.getByRole('region', { name: 'History' });
    expect(await within(history).findByText('Storage unit created')).toBeInTheDocument();
    expect(within(history).getByText('by LAB for AT — Alex Tester')).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'Label' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to Sample Storage' })).toHaveAttribute(
      'href',
      '/sample-storage',
    );
  });

  it('AC6: a LAB session sees the detail with no edit actions', async () => {
    stubDetail();
    renderAt(
      `/sample-storage/${DETAIL.readableId}`,
      me({ accountType: 'shared_lab', displayName: 'LAB', initials: null }),
    );
    await screen.findByRole('button', { name: 'Print label' });
    const buttons = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    for (const label of buttons) {
      expect(label).not.toMatch(/edit|correct|move|dispose|delete/i);
    }
  });

  it('says No storage unit found for an unknown ID', async () => {
    stubApi(() => json(404, { code: 'storage_unit_not_found' }));
    renderAt('/sample-storage/BKT-2026-999999');
    expect(
      await screen.findByText('No storage unit found with ID BKT-2026-999999.'),
    ).toBeInTheDocument();
  });

  it('redirects the card paths /inventory and /storage-units/:suNumber', async () => {
    stubDetail();
    const router = renderAt(`/storage-units/${DETAIL.readableId}`);
    expect(await screen.findByRole('region', { name: 'Summaries' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/sample-storage/${DETAIL.readableId}`);
  });
});
