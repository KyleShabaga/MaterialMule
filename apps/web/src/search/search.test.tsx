import type { InventoryItem, InventoryPage, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { testHoleRows } from './rows';

// Field Ledger search (top bar and /search). Fictional data only: DEMO-2601, TH26-02.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};

function unit(n: number, hole = 'TH26-02'): InventoryItem {
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
  };
}

function json(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

type Api = Record<string, (url: URL) => Response>;

function renderAt(path: string, api: Api) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const handler = api[url.pathname];
    return handler ? handler(url) : json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: me() },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { router, fetchMock };
}

const page = (items: InventoryItem[]): InventoryPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 50,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('testHoleRows', () => {
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
});

describe('top-bar search', () => {
  it('opens the unit straight away when the text is exactly one unit ID', async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/receiving-log', {
      '/api/scan/resolve': () =>
        json(200, {
          type: 'storage_unit',
          storageUnit: { id: unit(1).id, readableId: 'BKT-2026-000101' },
        }),
      '/api/receipts': () => json(200, { items: [], total: 0, page: 1, pageSize: 25 }),
    });
    const box = await screen.findByRole('textbox', { name: 'Search' });
    await user.type(box, 'bkt-2026-000101{Enter}');
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/sample-storage/BKT-2026-000101'),
    );
  });

  it('lands anything else on /search with grouped results', async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/receiving-log', {
      '/api/scan/resolve': () => json(200, { type: 'unknown', reason: 'not_recognised' }),
      '/api/receipts': () => json(200, { items: [], total: 0, page: 1, pageSize: 25 }),
    });
    await user.type(await screen.findByRole('textbox', { name: 'Search' }), 'TH26-02{Enter}');
    await vi.waitFor(() => expect(router.state.location.search).toBe('?q=TH26-02'));
    expect(router.state.location.pathname).toBe('/search');
  });
});

describe('search results', () => {
  it('groups test holes, units, projects and shelves, each row one link', async () => {
    renderAt('/search?q=TH26-02', {
      '/api/inventory': () => json(200, page([unit(1), unit(2)])),
      '/api/projects/search': () => json(200, []),
      '/api/locations': () => json(200, []),
      '/api/receipts': () => json(200, { items: [], total: 0, page: 1, pageSize: 5 }),
      '/api/lab-programs': () => json(403, {}),
    });
    expect(await screen.findByRole('heading', { level: 1, name: '3 results' })).toBeInTheDocument();
    const holes = screen.getByRole('region', { name: 'Test holes' });
    expect(within(holes).getByRole('link', { name: /TH26-02/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/sample-storage?projectId='),
    );
    const units = screen.getByRole('region', { name: 'Storage units' });
    expect(within(units).getByText('2 MATCHES')).toBeInTheDocument();
    expect(within(units).getByRole('link', { name: /BKT-2026-000101/ })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000101',
    );
    expect(within(units).getAllByText('In stock')).toHaveLength(2);
    // A refused kind (no lab access) is left out, not shown as an error.
    expect(screen.queryByRole('region', { name: 'Lab programs' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The top-bar field shows what was searched for.
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('TH26-02');
  });

  it('says plainly when nothing matches', async () => {
    renderAt('/search?q=DEMO-2699', {
      '/api/inventory': () => json(200, page([])),
      '/api/projects/search': () => json(200, []),
      '/api/locations': () => json(200, []),
      '/api/receipts': () => json(200, { items: [], total: 0, page: 1, pageSize: 5 }),
      '/api/lab-programs': () => json(200, { items: [], total: 0 }),
    });
    expect(await screen.findByText('Nothing matches.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '0 results' })).toBeInTheDocument();
  });

  it('says what could not load and keeps the rest', async () => {
    renderAt('/search?q=DEMO-2601', {
      '/api/inventory': () => json(500, {}),
      '/api/projects/search': () => json(200, [{ ...PROJECT, leadProjectEngineer: null }]),
      '/api/locations': () => json(200, []),
      '/api/receipts': () => json(200, { items: [], total: 0, page: 1, pageSize: 5 }),
      '/api/lab-programs': () => json(200, { items: [], total: 0 }),
    });
    expect(await screen.findByText("Storage units couldn't load. Try again.")).toBeInTheDocument();
    const projects = screen.getByRole('region', { name: 'Projects' });
    expect(within(projects).getByRole('link', { name: /DEMO-2601/ })).toHaveAttribute(
      'href',
      `/projects/${PROJECT.id}`,
    );
  });
});
