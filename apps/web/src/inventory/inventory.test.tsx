import type {
  InventoryItem,
  InventoryPage,
  MeResponse,
  StorageUnitDetail,
  StorageUnitHistoryPage,
} from '@materialmule/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { inventorySearchParams, readInventoryQuery } from './url-state';

// Fictional data only (MM-T12): DEMO-2601, TH26-01, receiver AT.

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
    sample: null,
    bulkGroup: null,
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
  minimumRetainUntil: '2027-10-23',
  version: 1,
  project: PROJECT,
  sample: null,
  bulkGroup: null,
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
    project: PROJECT,
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
  pickStationPerson(user);
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

describe('Sample Storage inventory (MM-T12)', () => {
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
    // MM-T50: the storage unit ID is the link; there is no View column.
    expect(within(table).queryByRole('columnheader', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'BKT-2026-000014' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000014',
    );
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search inventory' }),
      'TH26-01 warehouse',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?search=TH26-01+warehouse');

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Status' })).getByRole('button', {
        name: 'Disposed',
      }),
    );
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
    expect(screen.getByRole('searchbox', { name: 'Search inventory' })).toHaveValue('');
  });

  it('MM-T66 UI-10: switches between comfortable and compact with the same rows, and remembers it', async () => {
    window.localStorage.removeItem('materialmule:table-view:inventory');
    stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(200, page([item('BKT-2026-000014'), item('BKT-2026-000015')], 2))
        : undefined,
    );
    renderAt('/sample-storage');
    expect(await screen.findByText('2 storage units')).toBeInTheDocument();
    const views = screen.getByRole('group', { name: 'Table view' });
    const standard = within(views).getByRole('button', { name: 'Comfortable rows' });
    const compact = within(views).getByRole('button', { name: 'Compact rows' });
    expect(standard).toHaveAttribute('aria-pressed', 'true');
    expect(compact).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.inventory-table-compact')).toBeNull();

    await userEvent.click(compact);
    expect(compact).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.inventory-table-compact')).not.toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      '',
      'Unit ID',
      'Project',
      'Test holes · samples · depth',
      'Location',
      'Status',
      'Received',
      'Retain until',
    ]);
    // Same links and full values (long ones are only cut short visually; the title has them).
    expect(screen.getByRole('link', { name: 'BKT-2026-000015' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000015',
    );
    expect(within(table).getAllByTitle('TH26-01: G1–S12')).toHaveLength(2);
    expect(window.localStorage.getItem('materialmule:table-view:inventory')).toBe('compact');

    await userEvent.click(standard);
    expect(document.querySelector('.inventory-table-compact')).toBeNull();
    expect(window.localStorage.getItem('materialmule:table-view:inventory')).toBe('comfortable');
    window.localStorage.removeItem('materialmule:table-view:inventory');
  });

  it('Field Ledger: selecting rows shows the selection bar, and Move carries the units', async () => {
    stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(200, page([item('BKT-2026-000014'), item('BKT-2026-000015')], 2))
        : undefined,
    );
    const router = renderAt('/sample-storage');
    expect(await screen.findByText('2 storage units')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Selection' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select BKT-2026-000015' }));
    const bar = screen.getByRole('group', { name: 'Selection' });
    expect(bar).toHaveTextContent('1 selected');
    expect(within(bar).getByRole('button', { name: 'Add to lab request' })).toBeEnabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select every unit on this page' }));
    expect(bar).toHaveTextContent('2 selected');
    await userEvent.click(within(bar).getByRole('button', { name: 'Print labels' }));
    expect(router.state.location.pathname).toBe('/labels/print/units');
    expect(new URLSearchParams(router.state.location.search).get('ids')).toBe(
      'BKT-2026-000015,BKT-2026-000014',
    );
  });

  it('filters to one receipt (dashboard link) with a removable chip that Clear filters clears', async () => {
    const receiptId = '0b8f5e2a-4c1d-4e6f-9a3b-2d7c8e9f1a2b';
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(
            200,
            url.searchParams.get('receiptId')
              ? page([item('BKT-2026-000014')], 1)
              : page([item('BKT-2026-000014'), item('BKT-2026-000015')], 42),
          )
        : undefined,
    );
    const router = renderAt(`/sample-storage?receiptId=${receiptId}&status=all`);
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    expect(Object.fromEntries(inventoryCalls(fetchMock).at(-1)!.searchParams)).toEqual({
      receiptId,
      status: 'all',
    });
    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(within(chips).getByText('One receipt')).toBeInTheDocument();
    expect(within(chips).getByText('Status: All statuses')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove filter One receipt' }));
    expect(router.state.location.search).toBe('?status=all');
    expect(await screen.findByText('42 storage units')).toBeInTheDocument();

    await router.navigate(`/sample-storage?receiptId=${receiptId}`);
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(router.state.location.search).toBe('');
  });

  it('MM-T81: filters to open location conflicts with a removable chip', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(
            200,
            url.searchParams.get('conflict')
              ? page([{ ...item('BKT-2026-000014'), openConflict: true }], 1)
              : page([item('BKT-2026-000014'), item('BKT-2026-000015')], 42),
          )
        : undefined,
    );
    const router = renderAt('/sample-storage');
    expect(await screen.findByText('42 storage units')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Conflict'), 'Open location conflict');
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?conflict=open');
    expect(inventoryCalls(fetchMock).at(-1)!.searchParams.get('conflict')).toBe('open');
    expect(within(screen.getByRole('table')).getByText('Conflict')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Conflict: Open' }));
    expect(router.state.location.search).toBe('');
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

describe('Sample Storage rapid filter changes (MM-T46)', () => {
  const stubInventory = () =>
    stubApi((url) =>
      url.pathname === '/api/inventory' ? json(200, page([item('BKT-2026-000014')], 1)) : undefined,
    );

  it('T1/AC1: two filters chosen in quick succession during a search are both kept', async () => {
    stubInventory();
    const router = renderAt('/sample-storage?search=TH26-01');
    await screen.findByRole('option', { name: WAREHOUSE.name });
    await screen.findByText('1 storage unit');

    // Both picks land before the first navigation has rendered.
    act(() => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), {
        target: { value: 'bucket' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Location' }), {
        target: { value: WAREHOUSE.id },
      });
    });

    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
        search: 'TH26-01',
        type: 'bucket',
        locationId: WAREHOUSE.id,
      }),
    );
    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(within(chips).getByText('Search: TH26-01')).toBeInTheDocument();
    expect(within(chips).getByText('Type: Bucket')).toBeInTheDocument();
    expect(within(chips).getByText('Location: Warehouse C2')).toBeInTheDocument();
  });

  it('T1: rapid page turns and a sort change all build on each other', async () => {
    stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(200, page([item('BKT-2026-000014')], 120))
        : undefined,
    );
    const router = renderAt('/sample-storage?type=bucket');
    await screen.findByText('Page 1 of 5');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    });
    await waitFor(() => expect(router.state.location.search).toBe('?type=bucket&page=3'));

    act(() => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), {
        target: { value: 'id:asc' },
      });
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'All' }),
      );
    });
    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
        type: 'bucket',
        sort: 'id',
        dir: 'asc',
        status: 'all',
      }),
    );
  });

  it('AC2: a search typed right after Clear filters is kept', async () => {
    stubInventory();
    const router = renderAt('/sample-storage?search=TH26-01&type=bucket');
    await screen.findByText('1 storage unit');
    const box = screen.getByRole('searchbox', { name: 'Search inventory' });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      fireEvent.change(box, { target: { value: 'TH26-02' } });
      fireEvent.submit(screen.getByRole('search', { name: 'Search inventory' }));
    });

    await waitFor(() => expect(router.state.location.search).toBe('?search=TH26-02'));
    expect(screen.getByRole('searchbox', { name: 'Search inventory' })).toHaveValue('TH26-02');
    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(1);
  });

  it('AC2: text typed into Search before Clear filters has rendered is not wiped', async () => {
    stubInventory();
    const router = renderAt('/sample-storage?search=TH26-01');
    await screen.findByText('1 storage unit');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search inventory' }), {
        target: { value: 'TH26-02' },
      });
    });

    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByRole('searchbox', { name: 'Search inventory' })).toHaveValue('TH26-02');
  });
});

describe('storage unit detail (MM-T12)', () => {
  function stubDetail(history: StorageUnitHistoryPage = HISTORY, detail = DETAIL) {
    return stubApi((url) => {
      if (url.pathname === `/api/storage-units/${DETAIL.readableId}`) return json(200, detail);
      if (url.pathname === `/api/storage-units/${DETAIL.id}/history`) return json(200, history);
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
    expect(
      await screen.findByRole('heading', { level: 1, name: DETAIL.readableId }),
    ).toBeInTheDocument();
    // STRATA-72: the record tag (Strata record status words), the label block with the project.
    expect(document.querySelector('.unit-status-tags')).toHaveTextContent('Short-term');
    const label = document.querySelector('[data-slot="unit-label-block"]')!;
    expect(label).toHaveTextContent('DEMO-2601');
    expect(label).toHaveTextContent('Riverbank investigation');

    // One SAMPLE#/DEPTH summary per test hole, as a table; never individual samples.
    const summaries = screen.getByRole('region', { name: 'Test hole summaries' });
    const holes = within(summaries).getByRole('table', { name: 'Test hole summaries' });
    const row = (hole: string) => within(holes).getByRole('row', { name: new RegExp(hole) });
    expect(row('TH26-01')).toHaveTextContent('G1–S12');
    expect(row('TH26-02')).toHaveTextContent('0–1.5 m');
    expect(row('TH26-02')).toHaveTextContent('Wet');
    expect(within(summaries).getByText('Lid taped')).toBeInTheDocument();

    const receipt = screen.getByRole('region', { name: 'Receipt' });
    expect(within(receipt).getByText('AT · Alex Tester')).toBeInTheDocument();
    expect(within(receipt).getByText('Entered by LAB, for Alex Tester')).toBeInTheDocument();

    const location = screen.getByRole('region', { name: 'Where it is' });
    expect(
      within(location).getByRole('link', { name: 'Receiving lab (RECEIVING)' }),
    ).toHaveAttribute('href', '/sample-storage/locations/RECEIVING');

    const history = screen.getByRole('region', { name: 'History' });
    expect(await within(history).findByText('Storage unit created')).toBeInTheDocument();
    expect(within(history).getByText('by LAB for AT · Alex Tester')).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'Label' })).toBeInTheDocument();
    // The breadcrumb goes back to Inventory.
    const breadcrumb = screen.getByRole('navigation', { name: 'breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'Inventory' })).toHaveAttribute(
      'href',
      '/sample-storage',
    );
  });

  it('MISC-12: a disposed unit shows No location, though the API still sends its last one', async () => {
    stubDetail(HISTORY, { ...DETAIL, status: 'disposed' });
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    const location = await screen.findByRole('region', { name: 'Where it is' });
    expect(within(location).getByText('No location')).toBeInTheDocument();
    expect(within(location).queryByText(/Receiving lab/)).toBeNull();
  });

  it('MTR-64: a move names the locations it came from and went to', async () => {
    stubDetail({
      ...HISTORY,
      items: [
        {
          id: 'e2',
          occurredAt: '2026-10-24T16:00:00.000Z',
          action: 'storage_unit.moved',
          actor: { initials: 'AT', name: 'Alex Tester', accountType: 'test' },
          receiver: null,
          reason: null,
          before: { location: { code: 'RECEIVING', name: 'Receiving lab' } },
          after: { location: { code: 'WH-A1', name: 'Warehouse A1' } },
        },
        ...HISTORY.items,
      ],
      total: 2,
    });
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    const history = await screen.findByRole('list', { name: 'History events' });
    expect(history).toHaveTextContent('location: Receiving lab (RECEIVING) → Warehouse A1 (WH-A1)');
    expect(history).not.toHaveTextContent('[object Object]');
  });

  it('MTR-3: actions by a test account carry a TEST badge; others do not', async () => {
    stubDetail({
      ...HISTORY,
      items: [
        {
          id: 'e3',
          occurredAt: '2026-10-24T16:00:00.000Z',
          action: 'receipt.confirmed',
          actor: { initials: 'AT', name: 'Alex Tester', accountType: 'test' },
          receiver: null,
          reason: null,
          before: null,
          after: null,
        },
        ...HISTORY.items,
      ],
      total: 2,
    });
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    const history = await screen.findByRole('list', { name: 'History events' });
    const [testEvent, labEvent] = within(history).getAllByRole('listitem');
    expect(within(testEvent!).getByText('TEST')).toBeInTheDocument();
    expect(within(labEvent!).queryByText('TEST')).not.toBeInTheDocument();
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

  it('says no storage unit has an unknown ID, with the ID and Scan again', async () => {
    stubApi(() => json(404, { code: 'storage_unit_not_found' }));
    renderAt('/sample-storage/BKT-2026-999999');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No storage unit has this ID.' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('BKT-2026-999999').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Scan again' })).toBeInTheDocument();
  });

  it('redirects the card paths /inventory and /storage-units/:suNumber', async () => {
    stubDetail();
    const router = renderAt(`/storage-units/${DETAIL.readableId}`);
    expect(await screen.findByRole('region', { name: 'Test hole summaries' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/sample-storage/${DETAIL.readableId}`);
  });

  it('STRATA-72: leads with the label block and shows lab progress as n of m', async () => {
    stubApi((url) => {
      if (url.pathname === `/api/storage-units/${DETAIL.readableId}`) return json(200, DETAIL);
      if (url.pathname === `/api/storage-units/${DETAIL.id}/history`) return json(200, HISTORY);
      if (url.pathname === `/api/storage-units/${DETAIL.id}/lab-programs`) {
        return json(200, {
          programs: [
            {
              id: 'lp1',
              programNumber: 'LP-2026-0001',
              status: 'submitted',
              notStarted: 3,
              inProgress: 1,
              done: 2,
            },
          ],
        });
      }
      return undefined;
    });
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    const programs = await screen.findByRole('region', { name: 'Lab programs' });
    const heading = screen.getByRole('heading', { level: 1, name: DETAIL.readableId });
    expect(heading.closest('[data-slot="unit-label-block"]')).not.toBeNull();
    expect(await within(programs).findByRole('link', { name: 'LP-2026-0001' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/lp1',
    );
    expect(within(programs).getByText('2 of 6 tests')).toBeInTheDocument();
    expect(
      within(programs).getByRole('progressbar', {
        name: 'LP-2026-0001: 2 of 6 tests done, 1 in progress, 3 not started',
      }),
    ).toBeInTheDocument();
    // One primary action for a stored unit: Move.
    expect(screen.getByRole('link', { name: 'Move' })).toHaveAttribute(
      'href',
      '/sample-storage/move',
    );
  });

  it('STRATA-72: a disposed unit is read-only with no move or reprint', async () => {
    stubDetail(HISTORY, { ...DETAIL, status: 'disposed' });
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    expect(
      await screen.findByText('Read-only. Disposed units keep their ID and history.'),
    ).toBeInTheDocument();
    expect(document.querySelector('.unit-status-tags')).toHaveTextContent('Disposed');
    expect(screen.queryByRole('link', { name: 'Move' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Print label' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.keyboard('{Escape}');
    // The ID is never changed or reformatted.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('BKT-2026-000014');
  });
});

describe('shelf page (Field Ledger)', () => {
  const SHELF = {
    id: '00000000-0000-4000-8000-000000000401',
    code: 'WH-C2',
    name: 'Warehouse C2',
    kind: 'warehouse',
    area: 'Bay C',
    active: true,
    isSystem: false,
    retiredAt: null,
    retiredReason: null,
    codeLocked: true,
    labelPrintedAt: '2026-09-02T16:00:00.000Z',
    inStockCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };

  it('a scanned shelf code shows its cells, its units and its comings and goings', async () => {
    const due = item('BKT-2026-000061', {
      retention: {
        effectiveRetainUntil: '2026-10-01',
        eligibleByDate: true,
        onHold: false,
        retentionExempt: false,
      },
    } as Partial<InventoryItem>);
    const fetchMock = stubApi((url) => {
      if (url.pathname === '/api/scan/resolve') {
        return json(200, {
          type: 'location',
          location: {
            id: SHELF.id,
            code: 'WH-C2',
            name: SHELF.name,
            kind: 'warehouse',
            area: 'Bay C',
            active: true,
          },
        });
      }
      if (url.pathname === `/api/locations/${SHELF.id}`) {
        return json(200, { location: SHELF, events: [], printJobs: [] });
      }
      if (url.pathname === `/api/locations/${SHELF.id}/activity`) {
        return json(200, {
          movements: [
            {
              id: 'm1',
              occurredAt: '2026-11-10T16:42:00.000Z',
              direction: 'in',
              storageUnit: { id: 'id-BKT-2026-000014', readableId: 'BKT-2026-000014' },
              otherLocation: { id: 'loc-r', code: 'RECEIVING', name: 'Receiving lab' },
              actor: { initials: 'AT', name: 'Alex Tester' },
              mover: null,
            },
          ],
          arrivals: [
            { storageUnitId: 'id-BKT-2026-000014', arrivedAt: '2026-11-10T16:42:00.000Z' },
          ],
        });
      }
      if (url.pathname === '/api/inventory') return json(200, page([item('BKT-2026-000014'), due]));
      return undefined;
    });
    renderAt('/sample-storage/locations/WH-C2');
    // STRATA-74: the code is the heading; one counted cell per unit (no capacity set here).
    expect(await screen.findByRole('heading', { level: 1, name: 'WH-C2' })).toBeVisible();
    const places = screen.getByRole('list', { name: 'Places on this shelf' });
    expect(within(places).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(places).getByRole('link', { name: 'BKT-2026-000061, Retention due' }),
    ).toBeInTheDocument();
    const units = screen.getByRole('table', { name: 'Units here' });
    expect(within(units).getByRole('link', { name: 'BKT-2026-000061' })).toBeInTheDocument();
    expect(within(units).getByRole('row', { name: /BKT-2026-000061/ })).toHaveTextContent(
      'Retention due',
    );
    const activity = screen.getByRole('list', { name: 'Comings and goings' });
    expect(activity).toHaveTextContent('BKT-2026-000014 arrived');
    expect(activity).toHaveTextContent('from Receiving lab');
    expect(screen.getByRole('link', { name: /Move units here/ })).toHaveAttribute(
      'href',
      '/sample-storage/move?to=WH-C2',
    );
    const inventory = inventoryCalls(fetchMock).at(-1)!;
    expect(inventory.searchParams.get('locationId')).toBe(SHELF.id);
  });

  it('says so when no location has the code', async () => {
    stubApi((url) =>
      url.pathname === '/api/scan/resolve'
        ? json(200, { type: 'unknown', reason: 'location_not_found' })
        : undefined,
    );
    renderAt('/sample-storage/locations/WH-ZZ');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No location has this code.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Scan again' })).toBeInTheDocument();
  });
});
