import type { InventoryItem, InventoryPage, MeResponse } from '@materialmule/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScanPage } from '../scanning/ScanPage';
import { SessionContext } from '../session/context';
import { CommandMenuProvider, useCommandMenu } from './command-menu';
import { NO_MATCH, normalizeQuery } from './menu-behaviour';
import { matchesLabel, menuActions, menuPages, quickActionItems } from './menu-items';
import { QuickActions } from './QuickActions';
import { testHoleRows, unitStage } from './rows';
import { isEditableOrDialogTarget, useOwnScans, WedgeDetector } from './scan-anywhere';
import { SearchPage } from './SearchPage';

// Strata search: the Ctrl K menu, scan-anywhere, Quick actions and /search. Fictional data only:
// DEMO-2601, TH26-01/02, Alex Tester.

const ALL = [
  'inventory.read',
  'receipt.draft',
  'project.create',
  'storage_unit.move',
  'label.print',
  'action_item.read',
];

const me = (permissions: string[] = ALL): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions,
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  profileRefreshFailed: false,
});

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};

function unit(n: number, hole = 'TH26-02', extra: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `00000000-0000-4000-8000-0000000010${String(n).padStart(2, '0')}`,
    readableId: `BKT-2026-0001${String(n).padStart(2, '0')}`,
    unitType: 'bucket',
    status: 'in_stock',
    project: PROJECT,
    sample: null,
    bulkGroup: null,
    holes: [
      {
        testHoleId: `00000000-0000-4000-8000-0000000009${hole.slice(-2)}`,
        testHoleName: hole,
        type: 'all',
        sampleFrom: null,
        sampleTo: null,
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
        customText: null,
        note: null,
      },
    ],
    location: { id: 'loc', code: 'WH-C2', name: 'Warehouse C2' },
    receivedDate: '2026-10-20',
    ...extra,
  };
}

const page = (items: InventoryItem[], total = items.length): InventoryPage => ({
  items,
  total,
  page: 1,
  pageSize: 50,
});

function json(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

type Api = Record<string, (url: URL) => Response | Promise<Response>>;

const EMPTY_API: Api = {
  '/api/inventory': () => json(200, page([])),
  '/api/projects/search': () => json(200, []),
  '/api/locations': () => json(200, []),
  '/api/receipts': () => json(200, { items: [], total: 0, page: 1, pageSize: 5 }),
  '/api/lab-programs': () => json(200, { items: [], total: 0 }),
  '/api/concrete/search': () =>
    json(200, { q: '', letter: null, total: 0, page: 1, pageSize: 5, projectCount: 0, items: [] }),
  '/api/scan/resolve': () => json(200, { type: 'unknown', reason: 'not_recognised' }),
};

function stubFetch(api: Api) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const handler = api[url.pathname] ?? EMPTY_API[url.pathname];
    return handler ? handler(url) : json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Shell() {
  return (
    <CommandMenuProvider>
      <QuickActions />
      <OpenButton />
      <Outlet />
    </CommandMenuProvider>
  );
}

function OpenButton() {
  const menu = useCommandMenu();
  return (
    <button type="button" onClick={() => menu.open('dem')}>
      Sidebar search
    </button>
  );
}

/** A page with its own scan field (as useScanner's pages are), here with that field unfocused. */
function OwnsScans() {
  useOwnScans();
  return <h1>Move</h1>;
}

function renderAt(path: string, api: Api = {}, permissions: string[] = ALL) {
  const fetchMock = stubFetch(api);
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          {
            path: '/',
            element: (
              <div>
                <h1>Today</h1>
                <input aria-label="Notes" />
              </div>
            ),
          },
          { path: '/search', element: <SearchPage /> },
          { path: '/sample-storage', element: <h1>Inventory</h1> },
          { path: '/sample-storage/scan', element: <ScanPage /> },
          { path: '/sample-storage/locations/:code', element: <h1>Shelf</h1> },
          { path: '/sample-storage/:id', element: <h1>Unit page</h1> },
          { path: '/receiving-log/new', element: <h1>Receive</h1> },
          { path: '/owns-scans', element: <OwnsScans /> },
          { path: '*', element: <h1>Elsewhere</h1> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: me(permissions) },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { router, fetchMock };
}

const menuDialog = () => screen.queryByRole('dialog', { name: 'Search or scan' });
const menuInput = () => screen.getByRole('combobox', { name: 'Search or scan a label' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rows', () => {
  it('finds test holes through their units, once each, with a unit count', () => {
    const rows = testHoleRows([unit(1), unit(2), unit(3, 'TH26-01')], 'th26-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'TH26-02',
      title: 'Test hole on DEMO-2601',
      sub: '2 storage units found',
    });
    expect(rows[0]!.href).toContain('testHoleId=');
  });

  it("takes the unit's stage and status words from the server (STRATA-58)", () => {
    expect(
      unitStage(unit(1, 'TH26-02', { recordStatus: 'retention_overdue', stage: 'danger' })),
    ).toEqual({ label: 'Retention overdue', stage: 'danger' });
    expect(unitStage(unit(1, 'TH26-02', { recordStatus: 'in_lab', stage: 'lab' }))).toEqual({
      label: 'In lab',
      stage: 'lab',
    });
    expect(unitStage(unit(1, 'TH26-02', { recordStatus: 'long_term' }))).toEqual({
      label: 'Long-term',
      stage: 'storage',
    });
    // Nothing guessed from other fields: an open conflict without a server status stays plain.
    expect(unitStage(unit(1, 'TH26-02', { openConflict: true }))).toEqual({
      label: 'In storage',
      stage: 'storage',
    });
    expect(unitStage(unit(1, 'TH26-02', { status: 'disposed' }))).toEqual({
      label: 'Disposed',
      stage: 'closed',
    });
  });
});

describe('scan-anywhere detection', () => {
  const feed = (detector: WedgeDetector, text: string, start: number, gap: number) => {
    let at = start;
    for (const key of text) {
      detector.feed({ key, at });
      at += gap;
    }
    return detector.feed({ key: 'Enter', at });
  };

  it('a fast burst ending in Enter is a scan; slow typing never is', () => {
    expect(feed(new WedgeDetector(), 'BKT-2026-000101', 0, 8)).toBe('BKT-2026-000101');
    expect(feed(new WedgeDetector(), 'BKT-2026-000101', 0, 120)).toBeNull();
  });

  it('ignores short bursts, modifiers and IME composition', () => {
    expect(feed(new WedgeDetector(), 'jk', 0, 5)).toBeNull();
    const detector = new WedgeDetector();
    detector.feed({ key: 'B', at: 0 });
    detector.feed({ key: 'k', at: 2, ctrlKey: true });
    expect(feed(detector, 'KT', 4, 2)).toBeNull();
    const ime = new WedgeDetector();
    feed(ime, 'BKT-20', 0, 5);
    expect(ime.feed({ key: 'Process', at: 40, isComposing: true })).toBeNull();
    expect(ime.feed({ key: 'Enter', at: 41 })).toBeNull();
  });

  it('a pause restarts the buffer, Shift does not break a burst', () => {
    const detector = new WedgeDetector();
    feed(detector, 'xyz', 0, 200);
    detector.feed({ key: 'Shift', at: 1000 });
    expect(feed(detector, 'LOC-A1', 1001, 5)).toBe('LOC-A1');
  });

  it('treats fields, editable content and dialogs as their own', () => {
    document.body.innerHTML = `
      <input id="i" /><textarea id="t"></textarea><div contenteditable="true" id="c"></div>
      <div role="dialog"><button id="d">x</button></div><button id="b">y</button>`;
    for (const id of ['i', 't', 'c', 'd']) {
      expect(isEditableOrDialogTarget(document.getElementById(id)), id).toBe(true);
    }
    expect(isEditableOrDialogTarget(document.getElementById('b'))).toBe(false);
    expect(isEditableOrDialogTarget(document.body)).toBe(false);
    document.body.innerHTML = '';
  });

  it('opens a scanned unit from anywhere, but leaves a focused field alone', async () => {
    const { router } = renderAt('/', {
      '/api/scan/resolve': () =>
        json(200, {
          type: 'storage_unit',
          storageUnit: { id: unit(1).id, readableId: 'BKT-2026-000101' },
        }),
    });
    await screen.findByRole('heading', { name: 'Today' });
    // Typed into a field: the field keeps it, nothing is looked up.
    const notes = screen.getByRole('textbox', { name: 'Notes' });
    for (const key of 'BKT-2026-000101') fireEvent.keyDown(notes, { key });
    fireEvent.keyDown(notes, { key: 'Enter' });
    expect(router.state.location.pathname).toBe('/');

    notes.blur();
    for (const key of 'BKT-2026-000101') fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sample-storage/BKT-2026-000101'),
    );
  });

  it('stands down while a page with its own scan field is open, even unfocused', async () => {
    const { router, fetchMock } = renderAt('/owns-scans', {
      '/api/scan/resolve': () =>
        json(200, {
          type: 'storage_unit',
          storageUnit: { id: unit(1).id, readableId: 'BKT-2026-000101' },
        }),
    });
    await screen.findByRole('heading', { name: 'Move' });
    const resolves = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/scan/resolve')).length;
    for (const key of 'BKT-2026-000102') fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });

    await act(() => router.navigate('/'));
    await screen.findByRole('heading', { name: 'Today' });
    for (const key of 'BKT-2026-000101') fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sample-storage/BKT-2026-000101'),
    );
    // Only the read made outside the scanning page was looked up.
    expect(resolves()).toBe(1);
  });

  it('ignores the same label again within 2 s (its QR after its Code 128)', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5));
    const { fetchMock } = renderAt('/');
    await screen.findByRole('heading', { name: 'Today' });
    const resolves = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/scan/resolve')).length;
    for (let i = 0; i < 2; i += 1) {
      for (const key of 'BKT-2026-000101') fireEvent.keyDown(document.body, { key });
      fireEvent.keyDown(document.body, { key: 'Enter' });
    }
    await waitFor(() => expect(resolves()).toBe(1));
    clock += 2_500;
    for (const key of 'BKT-2026-000101') fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(resolves()).toBe(2));
  });

  it('a slow typist on the page is never treated as a scanner', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
    const { router, fetchMock } = renderAt('/');
    await screen.findByRole('heading', { name: 'Today' });
    for (const key of 'BKT-2026-000101') fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(router.state.location.pathname).toBe('/');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/scan/resolve'))).toBe(
      false,
    );
  });
});

describe('command menu controller and shortcuts', () => {
  it('Ctrl K toggles, ⌘K too; the input has focus with the right placeholder', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { name: 'Today' });
    expect(menuDialog()).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Search or scan' })).toBeVisible();
    expect(menuInput()).toHaveFocus();
    expect(menuInput()).toHaveAttribute('placeholder', 'Search or scan a label…');
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(menuDialog()).toBeNull());
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search or scan' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(menuDialog()).toBeNull());
  });

  it('"/" opens the menu, but not while typing in a field', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { name: 'Today' });
    await user.click(screen.getByRole('textbox', { name: 'Notes' }));
    await user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('/');
    expect(menuDialog()).toBeNull();
    act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard('/');
    expect(await screen.findByRole('dialog', { name: 'Search or scan' })).toBeVisible();
    expect(menuInput()).toHaveValue('');
  });

  it('"?" opens the keyboard shortcuts', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { name: 'Today' });
    await user.keyboard('?');
    expect(await screen.findByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  it('open(query) starts with that query and lists units, projects and the menu groups', async () => {
    const user = userEvent.setup();
    renderAt('/', {
      '/api/inventory': () => json(200, page([unit(1)])),
      '/api/projects/search': () => json(200, [{ ...PROJECT, leadProjectEngineer: null }]),
    });
    await user.click(await screen.findByRole('button', { name: 'Sidebar search' }));
    expect(menuInput()).toHaveValue('dem');
    const units = await screen.findByRole('group', { name: 'Storage units' });
    const option = within(units).getByRole('option', { name: /BKT-2026-000101/ });
    expect(option).toHaveTextContent('In storage');
    expect(
      within(screen.getByRole('group', { name: 'Projects' })).getByRole('option'),
    ).toHaveTextContent('DEMO-2601Riverbank investigation');
    expect(screen.getByRole('option', { name: /Show all results for/ })).toBeInTheDocument();
  });

  it('with no query it lists Actions, Go to and Help, only what this person may do', async () => {
    const user = userEvent.setup();
    renderAt('/', {}, ['inventory.read']);
    await screen.findByRole('heading', { name: 'Today' });
    await user.keyboard('{Control>}k{/Control}');
    const actions = screen.queryByRole('group', { name: 'Actions' });
    expect(actions).toBeNull();
    expect(screen.getByRole('group', { name: 'Go to' })).toBeInTheDocument();
    const help = screen.getByRole('group', { name: 'Help' });
    expect(within(help).getByRole('option', { name: /Keyboard shortcuts/ })).toBeInTheDocument();
    expect(within(help).getByRole('option', { name: /Help and how-tos/ })).toBeInTheDocument();
  });

  it('Enter on a typed ID opens the exact unit; anything else goes to the results', async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/', {
      '/api/scan/resolve': (url) =>
        url.searchParams.get('payload') === 'bkt-2026-000101'
          ? json(200, {
              type: 'storage_unit',
              storageUnit: { id: unit(1).id, readableId: 'BKT-2026-000101' },
            })
          : json(200, { type: 'unknown', reason: 'not_recognised' }),
    });
    await screen.findByRole('heading', { name: 'Today' });
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('bkt-2026-000101{Enter}');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sample-storage/BKT-2026-000101'),
    );
    await waitFor(() => expect(menuDialog()).toBeNull());

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('TH26-02{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toBe('?q=TH26-02');
  });

  it('says plainly when nothing matches', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { name: 'Today' });
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('zzz-nothing');
    expect(await screen.findByText(NO_MATCH)).toBeInTheDocument();
  });

  it('shows the newest query only: a late answer to an older query is dropped', async () => {
    const user = userEvent.setup();
    const pending = new Map<string, (r: Response) => void>();
    renderAt('/', {
      '/api/inventory': (url) =>
        new Promise<Response>((resolve) => pending.set(url.searchParams.get('search')!, resolve)),
    });
    await screen.findByRole('heading', { name: 'Today' });
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('TH26-01');
    await waitFor(() => expect(pending.has('TH26-01')).toBe(true));
    await user.keyboard('{Backspace}2');
    await waitFor(() => expect(pending.has('TH26-02')).toBe(true));
    pending.get('TH26-02')!(json(200, page([unit(2)])));
    expect(await screen.findByRole('option', { name: /BKT-2026-000102/ })).toBeInTheDocument();
    pending.get('TH26-01')!(json(200, page([unit(1, 'TH26-01')])));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('option', { name: /BKT-2026-000101/ })).toBeNull();
  });

  it('shows a genuine source failure, but not a refusal', async () => {
    const user = userEvent.setup();
    renderAt('/', {
      '/api/inventory': () => json(500, {}),
      '/api/projects/search': () => json(403, {}),
    });
    await screen.findByRole('heading', { name: 'Today' });
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('DEMO');
    expect(await screen.findByText("Storage units couldn't load. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/Projects couldn't load/)).toBeNull();
  });

  it('normalizes queries: trimmed, single spaces, at most 100 characters', () => {
    expect(normalizeQuery('  TH26-01   G1 ')).toBe('TH26-01 G1');
    expect(normalizeQuery('x'.repeat(150))).toHaveLength(100);
  });
});

describe('menu items', () => {
  it('Actions follow the permissions the pages use', () => {
    expect(menuActions(me()).map((a) => a.label)).toEqual([
      'Receive storage units',
      'Move storage units',
      'Print labels',
      'New project',
    ]);
    expect(menuActions(me(['inventory.read', 'storage_unit.move'])).map((a) => a.label)).toEqual([
      'Move storage units',
    ]);
  });

  it('Go to respects feature flags and includes sub-pages', () => {
    const off = {
      labTesting: false,
      disposalRetention: false,
      concreteReview: false,
      concreteLab: false,
    };
    const labels = menuPages(me(), off).map((p) => p.label);
    expect(labels).toContain('Inventory');
    expect(labels).not.toContain('Lab programs');
    expect(labels).not.toContain('Concrete');
    const on = {
      labTesting: true,
      disposalRetention: true,
      concreteReview: true,
      concreteLab: true,
    };
    expect(menuPages(me(), on).map((p) => p.label)).toContain('Retention › Disposal scan');
  });

  it('matches every word of the query', () => {
    expect(matchesLabel('Move storage units', 'move unit')).toBe(true);
    expect(matchesLabel('Move storage units', 'receive')).toBe(false);
  });
});

describe('Quick actions', () => {
  it('lists Scan, Receive and New project by permission', () => {
    expect(quickActionItems(ALL)).toEqual({ receive: true, newProject: true });
    expect(quickActionItems(['receipt.draft'])).toEqual({ receive: true, newProject: false });
    expect(quickActionItems(['inventory.read'])).toEqual({ receive: false, newProject: false });
  });

  it('Scan opens the command menu; items the person can’t use are hidden', async () => {
    const user = userEvent.setup();
    renderAt('/', {}, ['inventory.read']);
    const trigger = await screen.findByRole('button', { name: 'Quick actions' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['ScanCtrl K']);
    await user.click(within(menu).getByRole('menuitem', { name: /Scan/ }));
    expect(await screen.findByRole('dialog', { name: 'Search or scan' })).toBeVisible();
    await waitFor(() => expect(menuInput()).toHaveFocus());
  });

  it('Receive and New project lead into the receiving flow', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const trigger = await screen.findByRole('button', { name: 'Quick actions' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Receive' })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
    expect(within(menu).getByRole('menuitem', { name: 'New project' })).toHaveAttribute(
      'href',
      '/receiving-log/new?new=1&project=new',
    );
  });
});

describe('/sample-storage/scan (STRATA-81)', () => {
  it('on desktop lands on Inventory with the menu open, keeping the scanned code', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: fine'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { router } = renderAt('/sample-storage/scan?code=LOC-A1');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sample-storage'));
    expect(await screen.findByRole('dialog', { name: 'Search or scan' })).toBeVisible();
    expect(menuInput()).toHaveValue('LOC-A1');
    expect(screen.getByText(/Scan labels lives here now/)).toBeInTheDocument();
  });
});

describe('search results page', () => {
  it('groups units with their stage, test holes and projects, each row a link', async () => {
    renderAt('/search?q=TH26-02', {
      '/api/inventory': () =>
        json(200, page([unit(1), unit(2, 'TH26-02', { status: 'disposed' })])),
      '/api/lab-programs': () => json(403, {}),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Results for “TH26-02”' }),
    ).toBeInTheDocument();
    const units = await screen.findByRole('region', { name: 'Storage units' });
    expect(within(units).getByText('2 matches')).toBeInTheDocument();
    expect(within(units).getByRole('link', { name: 'BKT-2026-000101' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000101',
    );
    expect(within(units).getByText('In storage')).toHaveAttribute('data-stage', 'storage');
    expect(within(units).getByText('Disposed')).toHaveAttribute('data-stage', 'closed');
    const holes = screen.getByRole('region', { name: 'Test holes' });
    expect(within(holes).getByRole('link', { name: /TH26-02/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/sample-storage?projectId='),
    );
    // A refused kind (no lab access) is left out, not shown as an error.
    expect(screen.queryByRole('region', { name: 'Lab programs' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('labels a capped preview honestly instead of calling it the total', async () => {
    const items = Array.from({ length: 50 }, (_, i) => unit(i + 1));
    renderAt('/search?q=TH26-02', {
      '/api/inventory': () => json(200, page(items, 180)),
      '/api/projects/search': () =>
        json(
          200,
          Array.from({ length: 5 }, (_, i) => ({
            ...PROJECT,
            id: `p${i}`,
            projectNumber: `DEMO-26${10 + i}`,
            leadProjectEngineer: null,
          })),
        ),
    });
    const units = await screen.findByRole('region', { name: 'Storage units' });
    expect(within(units).getByText('180 matches')).toBeInTheDocument();
    expect(within(units).getByRole('link', { name: 'Show all in Inventory' })).toBeInTheDocument();
    const holes = screen.getByRole('region', { name: 'Test holes' });
    expect(within(holes).getByText('1 found so far')).toBeInTheDocument();
    const projects = screen.getByRole('region', { name: 'Projects' });
    expect(within(projects).getByText('First 5 shown')).toBeInTheDocument();
  });

  it('says plainly when nothing matches', async () => {
    renderAt('/search?q=DEMO-2699');
    expect(await screen.findByText('Nothing matches.')).toBeInTheDocument();
  });

  it('asks for a query when there is none', async () => {
    renderAt('/search');
    expect(await screen.findByText('Type what you are looking for.')).toBeInTheDocument();
  });

  it('shows loading, then says what could not load and keeps the rest', async () => {
    let release: (r: Response) => void = () => undefined;
    renderAt('/search?q=DEMO-2601', {
      '/api/inventory': () => json(500, {}),
      '/api/projects/search': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    expect(await screen.findByText('Searching…')).toBeInTheDocument();
    release(json(200, [{ ...PROJECT, leadProjectEngineer: null }]));
    expect(await screen.findByText("Storage units couldn't load. Try again.")).toBeInTheDocument();
    const projects = await screen.findByRole('region', { name: 'Projects' });
    expect(within(projects).getByRole('link', { name: /DEMO-2601/ })).toHaveAttribute(
      'href',
      `/projects/${PROJECT.id}`,
    );
  });
});
