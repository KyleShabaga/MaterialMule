import type {
  InventoryItem,
  InventoryListPage,
  InventoryPage,
  MeResponse,
  StorageUnitDetail,
  StorageUnitHistoryPage,
} from '@materialmule/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { clearedParams, inventoryRequest, inventoryRequestParams, readStage } from './url-state';

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

const COUNTS = {
  all: 42,
  in_lab: 3,
  short_term: 20,
  long_term: 12,
  retention_due: 4,
  disposed: 2,
  conflicts: 1,
};

const listPage = (
  items: InventoryItem[],
  total = items.length,
  pageNumber = 1,
  stageCounts = COUNTS,
): InventoryListPage => ({ ...page(items, total, pageNumber), stageCounts });

const lastRequest = (fetchMock: ReturnType<typeof stubApi>) =>
  Object.fromEntries(inventoryCalls(fetchMock).at(-1)!.searchParams);

const query = (location: { search: string }) =>
  Object.fromEntries(new URLSearchParams(location.search));

describe('inventory URL state (STRATA-79)', () => {
  it('reads the tab, opening older conflict and disposed links on their tabs', () => {
    expect(readStage(new URLSearchParams(''))).toBe('all');
    expect(readStage(new URLSearchParams('stage=long_term'))).toBe('long_term');
    expect(readStage(new URLSearchParams('conflict=open'))).toBe('conflicts');
    expect(readStage(new URLSearchParams('status=disposed'))).toBe('disposed');
    expect(readStage(new URLSearchParams('stage=in_storage'))).toBe('all');
  });

  it('builds the request with the tab and counts, and drops invalid values from a hand-edited link', () => {
    const ok = inventoryRequest(
      new URLSearchParams('stage=in_lab&type=bucket&sort=id&dir=desc&page=2&filter=project'),
      'TH26-01',
    );
    expect(ok.ignored).toBe(false);
    expect(Object.fromEntries(inventoryRequestParams(ok.query))).toEqual({
      stage: 'in_lab',
      counts: '1',
      search: 'TH26-01',
      type: 'bucket',
      sort: 'id',
      dir: 'desc',
      page: '2',
    });
    const bad = inventoryRequest(new URLSearchParams('type=crate&page=-1'), '');
    expect(bad.ignored).toBe(true);
    expect(Object.fromEntries(inventoryRequestParams(bad.query))).toEqual({
      stage: 'all',
      counts: '1',
    });
  });

  it('Clear filters keeps the tab, sort and an open drawer', () => {
    const cleared = clearedParams(
      new URLSearchParams(
        'stage=long_term&search=x&projectId=p&type=bucket&filter=location&sort=id&dir=asc&open=BKT-2026-000014&page=3',
      ),
    );
    expect(cleared.toString()).toBe('stage=long_term&sort=id&dir=asc&open=BKT-2026-000014');
  });
});

describe('Sample Storage inventory (STRATA-79)', () => {
  const twoRows = () => listPage([item('BKT-2026-000014'), item('BKT-2026-000015')], 42);

  it('shows the stage tabs with server counts, the rows, and asks the server for each tab', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined,
    );
    const router = renderAt('/sample-storage');

    expect(await screen.findByText('42 storage units')).toBeInTheDocument();
    expect(lastRequest(fetchMock)).toEqual({ stage: 'all', counts: '1' });
    const tabs = screen.getByRole('tablist', { name: 'Stage' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual([
      'All 42',
      'In lab 3',
      'Short-term 20',
      'Long-term 12',
      'Retention due 4',
      'Disposed 2',
      'Conflicts 1',
    ]);
    expect(within(tabs).getByRole('tab', { name: 'All 42' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const table = screen.getByRole('table', { name: 'Storage units' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      '',
      'ID',
      'Project',
      'Test hole',
      'Type',
      'Where',
      'Stage',
      'Received',
      'Retain until',
    ]);
    expect(within(table).getAllByTitle('TH26-01: G1–S12')).toHaveLength(2);
    expect(within(table).getAllByText('Warehouse C2')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'BKT-2026-000014' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000014',
    );
    // The chip row is always there, with + Add filter and no Clear filters yet.
    const chips = screen.getByRole('group', { name: 'Filters' });
    expect(within(chips).getByRole('button', { name: 'Add filter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();

    await userEvent.click(within(tabs).getByRole('tab', { name: 'Long-term 12' }));
    await waitFor(() => expect(router.state.location.search).toBe('?stage=long_term'));
    await waitFor(() =>
      expect(lastRequest(fetchMock)).toEqual({ stage: 'long_term', counts: '1' }),
    );
  });

  it('searches on the server from the toolbar, debounced, kept in the URL', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(
            200,
            url.searchParams.get('search') ? listPage([item('BKT-2026-000014')], 1) : twoRows(),
          )
        : undefined,
    );
    const router = renderAt('/sample-storage');
    await screen.findByText('42 storage units');
    const tools = screen.getByRole('toolbar', { name: 'Storage unit tools' });
    await userEvent.click(within(tools).getByRole('button', { name: 'Search' }));
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search storage units' }),
      'TH26-01 warehouse',
    );
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    expect(query(router.state.location)).toEqual({ search: 'TH26-01 warehouse' });
    expect(lastRequest(fetchMock)).toEqual({
      stage: 'all',
      counts: '1',
      search: 'TH26-01 warehouse',
    });
  });

  it('keeps every character of fast, key-by-key typing (a wedge scanner) in the search box', async () => {
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined));
    const router = renderAt('/sample-storage');
    await screen.findByText('42 storage units');
    const user = userEvent.setup({ delay: null });
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Storage unit tools' })).getByRole('button', {
        name: 'Search',
      }),
    );
    const box = screen.getByRole('searchbox', { name: 'Search storage units' });
    await user.type(box, 'BKT-2024-309942');
    expect(box).toHaveValue('BKT-2024-309942');
    await waitFor(() =>
      expect(query(router.state.location)).toEqual({ search: 'BKT-2024-309942' }),
    );
    expect(box).toHaveValue('BKT-2024-309942');
  });

  it('adds filter chips with their own pickers, removes them with ×, and clears them all', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined,
    );
    const router = renderAt('/sample-storage');
    await screen.findByText('42 storage units');

    await userEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Bucket' }));
    await waitFor(() => expect(query(router.state.location)).toEqual({ type: 'bucket' }));
    expect(screen.getByRole('group', { name: 'Filter Type' })).toHaveTextContent('TypeBucket');

    await userEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Location' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Warehouse C2' }));
    await waitFor(() =>
      expect(query(router.state.location)).toEqual({ type: 'bucket', locationId: WAREHOUSE.id }),
    );
    expect(screen.getByRole('group', { name: 'Filter Location' })).toHaveTextContent(
      'Warehouse C2',
    );
    await waitFor(() =>
      expect(lastRequest(fetchMock)).toEqual({
        stage: 'all',
        counts: '1',
        type: 'bucket',
        locationId: WAREHOUSE.id,
      }),
    );
    // The toolbar's Filter button counts them.
    expect(screen.getByRole('button', { name: 'Filter, 2 on' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Type' }));
    await waitFor(() => expect(query(router.state.location)).toEqual({ locationId: WAREHOUSE.id }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('a picker that just opened stays open when an earlier chip gets its focus back late', async () => {
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined));
    renderAt(`/sample-storage?locationId=${WAREHOUSE.id}`);
    await screen.findByText('42 storage units');
    const location = within(screen.getByRole('group', { name: 'Filter Location' })).getAllByRole(
      'button',
    )[0]!;
    await userEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Type' }));
    expect(await screen.findByRole('option', { name: 'Bucket' })).toBeInTheDocument();
    // The Location picker's delayed focus return (after its exit animation) lands on its chip.
    act(() => location.focus());
    expect(screen.getByRole('option', { name: 'Bucket' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Bucket' }));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Filter Type' })).toHaveTextContent('Bucket'),
    );
  });

  it('a picker opened from "+ Add filter" opens once the menu has finished closing, and stays open', async () => {
    // Radix keeps a closing menu (with its focus trap) and popover mounted until the exit
    // animation ends. jsdom has no animations, so give menus and popovers an enter and an exit
    // animation, read live: Radix keeps the style object from mount and reads it on each change.
    const realStyle = window.getComputedStyle.bind(window);
    const animated = new Set(['popover-content', 'dropdown-menu-content']);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = realStyle(element, pseudo);
      if (!(element instanceof HTMLElement) || !animated.has(element.dataset.slot ?? '')) {
        return style;
      }
      return new Proxy(style, {
        get: (target, key) =>
          key === 'animationName'
            ? element.dataset.state === 'closed'
              ? 'exit'
              : 'enter'
            : Reflect.get(target, key, target),
      });
    });
    const finishAnimations = () =>
      act(() => {
        for (const closing of document.querySelectorAll(
          '[data-state="closed"][data-slot$="-content"]',
        )) {
          // jsdom's events carry no animationName; Radix matches it to the running animation.
          const end = new Event('animationend', { bubbles: true });
          Object.defineProperty(end, 'animationName', { value: 'exit' });
          closing.dispatchEvent(end);
        }
      });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined));
    const router = renderAt(`/sample-storage?locationId=${WAREHOUSE.id}`);
    await screen.findByText('42 storage units');

    await userEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Type' }));
    // The menu is still closing; then its animation ends.
    finishAnimations();
    expect(await screen.findByRole('option', { name: 'Bucket' })).toBeInTheDocument();
    finishAnimations();
    expect(screen.getByRole('option', { name: 'Bucket' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Bucket' }));
    await waitFor(() =>
      expect(query(router.state.location)).toEqual({ locationId: WAREHOUSE.id, type: 'bucket' }),
    );
  });

  it('filters by received dates as you type', async () => {
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined));
    const router = renderAt('/sample-storage');
    await screen.findByText('42 storage units');
    await userEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Received' }));
    const picker = await screen.findByRole('group', { name: 'Received between' });
    fireEvent.change(within(picker).getByLabelText('Received from'), {
      target: { value: '2026-10-01' },
    });
    await waitFor(() =>
      expect(query(router.state.location)).toEqual({ receivedFrom: '2026-10-01' }),
    );
    fireEvent.change(
      within(await screen.findByRole('group', { name: 'Received between' })).getByLabelText(
        'Received through',
      ),
      { target: { value: '2026-10-23' } },
    );
    await waitFor(() =>
      expect(query(router.state.location)).toEqual({
        receivedFrom: '2026-10-01',
        receivedTo: '2026-10-23',
      }),
    );
    expect(screen.getByRole('group', { name: 'Filter Received' })).toHaveTextContent(
      '2026-10-01 – 2026-10-23',
    );
  });

  it('selection bar: Move takes the exact ticked units, kept across pages, without disposed ones', async () => {
    stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(
            200,
            url.searchParams.get('page') === '2'
              ? listPage([item('BKT-2026-000031')], 42, 2)
              : listPage(
                  [
                    item('BKT-2026-000014'),
                    item('BKT-2026-000015'),
                    item('BKT-2026-000016', { status: 'disposed' }),
                  ],
                  42,
                ),
          )
        : undefined,
    );
    const user = me({ permissions: ['inventory.read', 'label.print', 'storage_unit.move'] });
    const router = renderAt('/sample-storage', user);
    await screen.findByText('42 storage units');
    expect(screen.queryByRole('group', { name: 'Selection' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select BKT-2026-000015' }));
    expect(screen.getByRole('group', { name: 'Selection' })).toHaveTextContent('1 selected');

    // Page 2 keeps the selection; tick one there too.
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('link', { name: 'BKT-2026-000031' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select BKT-2026-000031' }));
    expect(screen.getByRole('group', { name: 'Selection' })).toHaveTextContent('2 selected');
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByRole('link', { name: 'BKT-2026-000014' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select BKT-2026-000016' }));
    expect(screen.getByRole('group', { name: 'Selection' })).toHaveTextContent('3 selected');

    // Disposed units are left out of Move. The Move screen takes the units out of its URL once
    // applied, so the link it was opened with is read from the navigation itself.
    const opened: { pathname: string; search: string; state: unknown }[] = [];
    const unsubscribe = router.subscribe((state) => opened.push(state.location));
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Selection' })).getByRole('button', {
        name: 'Move',
      }),
    );
    unsubscribe();
    const move = opened.find((location) => location.pathname === '/sample-storage/move')!;
    expect(new URLSearchParams(move.search).get('units')).toBe('BKT-2026-000015,BKT-2026-000031');
    expect(move.state).toEqual({ units: ['BKT-2026-000015', 'BKT-2026-000031'] });
  });

  it('Print labels goes to the chosen-units print view; a tab change clears the selection', async () => {
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined));
    const router = renderAt('/sample-storage');
    await screen.findByText('42 storage units');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    const bar = screen.getByRole('group', { name: 'Selection' });
    expect(bar).toHaveTextContent('2 selected');
    // Without storage_unit.move there is no Move.
    expect(within(bar).queryByRole('button', { name: 'Move' })).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'In lab 3' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selection' })).toBeNull());
    await userEvent.click(screen.getByRole('tab', { name: 'All 42' }));
    await screen.findByRole('link', { name: 'BKT-2026-000014' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Selection' })).getByRole('button', {
        name: 'Print labels',
      }),
    );
    expect(router.state.location.pathname).toBe('/labels/print/units');
    expect(new URLSearchParams(router.state.location.search).get('ids')).toBe(
      'BKT-2026-000014,BKT-2026-000015',
    );
  });

  it('Clear in the selection bar and Esc both clear the selection', async () => {
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, twoRows()) : undefined));
    renderAt('/sample-storage');
    await screen.findByText('42 storage units');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select BKT-2026-000014' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('group', { name: 'Selection' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select BKT-2026-000014' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Selection' })).toBeNull();
  });

  it('filters to one receipt (dashboard link) with a removable chip that Clear filters clears', async () => {
    const receiptId = '0b8f5e2a-4c1d-4e6f-9a3b-2d7c8e9f1a2b';
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(
            200,
            url.searchParams.get('receiptId') ? listPage([item('BKT-2026-000014')], 1) : twoRows(),
          )
        : undefined,
    );
    const router = renderAt(`/sample-storage?receiptId=${receiptId}&status=all`);
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    expect(lastRequest(fetchMock)).toEqual({ stage: 'all', counts: '1', receiptId });
    expect(screen.getByRole('group', { name: 'Filter Receipt' })).toHaveTextContent('One receipt');

    await userEvent.click(screen.getByRole('button', { name: 'Remove filter One receipt' }));
    expect(router.state.location.search).toBe('?status=all');
    expect(await screen.findByText('42 storage units')).toBeInTheDocument();

    await router.navigate(`/sample-storage?receiptId=${receiptId}`);
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(router.state.location.search).toBe('');
  });

  it('MM-T81: an older conflict=open link opens the Conflicts tab, which replaces the Conflict filter', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(
            200,
            url.searchParams.get('stage') === 'conflicts'
              ? listPage([item('BKT-2026-000014', { openConflict: true })], 1)
              : twoRows(),
          )
        : undefined,
    );
    const router = renderAt('/sample-storage?conflict=open');
    expect(await screen.findByText('1 storage unit')).toBeInTheDocument();
    expect(lastRequest(fetchMock)).toEqual({ stage: 'conflicts', counts: '1' });
    expect(screen.getByRole('tab', { name: 'Conflicts 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByText('Each unit has two places recorded. Scan it where it really is to fix it.'),
    ).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Location conflict')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'All 42' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('shows a no-match state with Clear filters, and the empty state with Receive', async () => {
    stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(200, listPage([], 0, 1, { ...COUNTS, all: 0, short_term: 0, in_lab: 0 }))
        : undefined,
    );
    const router = renderAt('/sample-storage?search=nothing');
    const noMatch = await screen.findByText(
      'No storage units match this search and these filters.',
    );
    const empty = noMatch.closest<HTMLElement>('[data-slot=empty]')!;
    await userEvent.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No storage units yet.')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
    expect(screen.getByText(/Receive samples to add the first\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Receive samples' })).toHaveAttribute(
      'href',
      '/receiving-log/new?new=1',
    );
  });

  it('says when storage units could not load, with Try again', async () => {
    let fail = true;
    stubApi((url) =>
      url.pathname === '/api/inventory'
        ? fail
          ? json(500, { code: 'internal' })
          : json(200, twoRows())
        : undefined,
    );
    renderAt('/sample-storage');
    expect(await screen.findByText('Storage units couldn’t load.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('42 storage units')).toBeInTheDocument();
  });

  it('pages with Previous and Next, sorts from a heading, and hides a column from View', async () => {
    window.localStorage.removeItem('materialmule:inventory-hidden-columns');
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(
            200,
            listPage([item('BKT-2026-000014')], 120, Number(url.searchParams.get('page') ?? 1)),
          )
        : undefined,
    );
    const router = renderAt('/sample-storage');
    expect(await screen.findByText('Page 1 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 2 of 5')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?page=2');
    expect(lastRequest(fetchMock).page).toBe('2');

    const idHeading = screen.getByRole('columnheader', { name: 'ID' });
    await userEvent.click(within(idHeading).getByRole('button'));
    await waitFor(() => expect(query(router.state.location)).toEqual({ sort: 'id', dir: 'asc' }));
    expect(lastRequest(fetchMock)).toMatchObject({ sort: 'id', dir: 'asc' });

    await userEvent.click(screen.getByRole('button', { name: 'View, Comfortable' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'ID' })).toHaveAttribute(
      'data-disabled',
    );
    await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Type' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('columnheader', { name: 'Type' })).toBeNull();
    expect(window.localStorage.getItem('materialmule:inventory-hidden-columns')).toBe('["type"]');
    window.localStorage.removeItem('materialmule:inventory-hidden-columns');
  });
});

describe('Sample Storage rapid changes (MM-T46)', () => {
  const stubInventory = () =>
    stubApi((url) =>
      url.pathname === '/api/inventory'
        ? json(200, listPage([item('BKT-2026-000014')], 120))
        : undefined,
    );

  it('T1: rapid page turns, then a sort and a tab change, all build on each other', async () => {
    stubInventory();
    const router = renderAt('/sample-storage?type=bucket');
    await screen.findByText('Page 1 of 5');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    });
    await waitFor(() => expect(router.state.location.search).toBe('?type=bucket&page=3'));

    act(() => {
      fireEvent.click(within(screen.getByRole('columnheader', { name: 'ID' })).getByRole('button'));
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Short-term 20' }));
    });
    await waitFor(() =>
      expect(query(router.state.location)).toEqual({
        type: 'bucket',
        sort: 'id',
        dir: 'asc',
        stage: 'short_term',
      }),
    );
  });

  it('AC2: a search typed right after Clear filters is kept', async () => {
    stubInventory();
    const router = renderAt('/sample-storage?search=TH26-01&type=bucket');
    await screen.findByText('Page 1 of 5');
    const box = screen.getByRole('searchbox', { name: 'Search storage units' });

    act(() => {
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', {
          name: 'Clear filters',
        }),
      );
      fireEvent.change(box, { target: { value: 'TH26-02' } });
    });

    await waitFor(() => expect(router.state.location.search).toBe('?search=TH26-02'));
    expect(screen.getByRole('searchbox', { name: 'Search storage units' })).toHaveValue('TH26-02');
    expect(screen.queryByRole('group', { name: 'Filter Type' })).toBeNull();
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
