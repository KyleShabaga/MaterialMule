import type {
  InventoryItem,
  LocationActivity,
  LocationDetail,
  MeResponse,
  StorageUnitDetail,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';

// STRATA-74: the shelf page's counted cells follow the location's real capacity. Fictional data
// only: shelf WH-A-B2-S3, DEMO-2601, TH26-01.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const LOCATION_ID = '00000000-0000-4000-8000-000000000701';
const LOC = { id: LOCATION_ID, code: 'WH-A-B2-S3', name: 'Warehouse A shelf 3' };

function item(n: number, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `00000000-0000-4000-8000-0000000008${String(n).padStart(2, '0')}`,
    readableId: `BKT-2026-0000${String(n).padStart(2, '0')}`,
    unitType: 'bucket',
    status: 'in_stock',
    project: PROJECT,
    holes: [
      {
        testHoleId: '00000000-0000-4000-8000-000000000301',
        testHoleName: 'TH26-01',
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
    sample: null,
    bulkGroup: null,
    location: LOC,
    receivedDate: '2026-10-14',
    recordStatus: 'short_term',
    stage: 'storage',
    lifecycleStep: 'short_term',
    retention: {
      effectiveRetainUntil: '2027-10-14',
      onHold: false,
      eligibleByDate: false,
      retentionExempt: false,
    },
    ...overrides,
  };
}

function detail(capacity: number | null): LocationDetail {
  return {
    location: {
      ...LOC,
      kind: 'warehouse',
      area: null,
      active: true,
      isSystem: false,
      retiredAt: null,
      retiredReason: null,
      codeLocked: true,
      labelPrintedAt: null,
      inStockCount: 3,
      parentId: null,
      storageTerm: 'short_term',
      effectiveStorageTerm: { term: 'short_term', source: 'own', fromLocation: LOC },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      capacity,
    },
    events: [],
    printJobs: [],
  };
}

const ACTIVITY: LocationActivity = { movements: [], arrivals: [] };

const me = (): MeResponse => ({
  id: 'u1',
  displayName: 'Kim Example',
  initials: 'KCS',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print', 'storage_unit.correct'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(items: InventoryItem[], capacity: number | null, unit?: StorageUnitDetail) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/health') return json(200, { status: 'ok' });
      if (url.pathname === '/api/scan/resolve') {
        const payload = url.searchParams.get('payload');
        return payload === `LOC-${LOC.code}`
          ? json(200, { type: 'location', location: { ...detail(null).location } })
          : json(200, { type: 'unknown', reason: 'location_not_found' });
      }
      if (url.pathname === `/api/locations/${LOCATION_ID}`) return json(200, detail(capacity));
      if (url.pathname === `/api/locations/${LOCATION_ID}/activity`) return json(200, ACTIVITY);
      if (url.pathname === '/api/inventory') {
        return json(200, { items, total: items.length, page: 1, pageSize: 100 });
      }
      if (unit && url.pathname === `/api/storage-units/${unit.readableId}`) return json(200, unit);
      return json(404, { code: 'not_found' });
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = me();
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

/** The drawer exists from 1024 px; jsdom has no matchMedia, so tests opt in. */
function wideScreen() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(min-width: 1024px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shelf page (STRATA-74)', () => {
  it('draws one cell per place from the real capacity, with empty places dashed', async () => {
    stubApi([item(1), item(2), item(3, { recordStatus: 'retention_due', stage: 'due' })], 6);
    renderAt(`/sample-storage/locations/${LOC.code}`);

    expect(await screen.findByRole('heading', { level: 1, name: LOC.code })).toBeInTheDocument();
    expect(screen.getAllByText('3 of 6 places used').length).toBeGreaterThan(0);
    expect(screen.getByText('Short-term storage')).toBeInTheDocument();
    const places = screen.getByRole('list', { name: 'Places on this shelf' });
    const cells = within(places).getAllByRole('listitem');
    expect(cells).toHaveLength(6);
    expect(within(places).getAllByText('Empty place')).toHaveLength(3);
    expect(
      within(places).getByRole('link', { name: 'BKT-2026-000003, Retention due' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Units here' });
    expect(within(table).getByRole('link', { name: 'BKT-2026-000001' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Move units here/ })).toHaveAttribute(
      'href',
      `/sample-storage/move?to=${LOC.code}`,
    );
  });

  it('with no capacity set shows only the occupants and says so', async () => {
    stubApi([item(1), item(2)], null);
    renderAt(`/sample-storage/locations/${LOC.code}`);
    const places = await screen.findByRole('list', { name: 'Places on this shelf' });
    expect(within(places).getAllByRole('listitem')).toHaveLength(2);
    expect(within(places).queryByText('Empty place')).toBeNull();
    expect(screen.getAllByText(/Capacity not set/).length).toBeGreaterThan(0);
  });

  it('says honestly when a shelf holds more units than it has places', async () => {
    stubApi([item(1), item(2), item(3)], 2);
    renderAt(`/sample-storage/locations/${LOC.code}`);
    expect(
      await screen.findByText('3 units are recorded on a shelf with 2 places.'),
    ).toBeInTheDocument();
    const places = screen.getByRole('list', { name: 'Places on this shelf' });
    expect(within(places).getAllByRole('listitem')).toHaveLength(3);
  });

  it('an empty shelf says so; an unknown code offers Scan again', async () => {
    stubApi([], 4);
    renderAt(`/sample-storage/locations/${LOC.code}`);
    expect((await screen.findAllByText('Nothing is stored here.')).length).toBeGreaterThan(0);
    vi.unstubAllGlobals();

    stubApi([], 4);
    renderAt('/sample-storage/locations/WH-A-B9-S9');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No location has this code.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Scan again' })).toBeInTheDocument();
  });

  it('a cell opens the unit drawer beside the shelf on a wide screen', async () => {
    wideScreen();
    const unit = {
      id: item(1).id,
      readableId: item(1).readableId,
      unitType: 'bucket',
      status: 'in_stock',
      note: null,
      receivedDate: '2026-10-14',
      minimumRetainUntil: '2027-10-14',
      version: 1,
      project: PROJECT,
      holes: item(1).holes,
      sample: null,
      bulkGroup: null,
      location: LOC,
      locationConflict: null,
      receipt: {
        id: 'r1',
        receivedDate: '2026-10-14',
        project: PROJECT,
        receiver: { initials: 'PE', name: 'Pat Example' },
        account: { initials: 'PE', name: 'Pat Example' },
        description: null,
        quantity: 1,
        confirmedAt: '2026-10-14T16:00:00.000Z',
      },
      recordStatus: 'short_term',
      stage: 'storage',
      lifecycleStep: 'short_term',
      storageTerm: { term: 'short_term', source: 'own', fromLocation: LOC },
      neverTested: true,
    } satisfies StorageUnitDetail;
    stubApi([item(1), item(2)], 4, unit);
    const router = renderAt(`/sample-storage/locations/${LOC.code}`);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', {
        name: 'BKT-2026-000001, Short-term. Open in the drawer',
      }),
    );
    expect(router.state.location.search).toContain('open=BKT-2026-000001');
    const drawer = await screen.findByRole('region', { name: 'BKT-2026-000001' });
    expect(within(drawer).getByRole('link', { name: 'Move' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Print label' })).toHaveAttribute(
      'href',
      '/labels/print/unit/BKT-2026-000001',
    );
    expect(within(drawer).getByRole('region', { name: 'Retention' })).toHaveTextContent(
      '2027-10-14',
    );
  });
});
